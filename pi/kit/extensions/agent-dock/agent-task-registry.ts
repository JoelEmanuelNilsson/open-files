import { ACTIVITY_TAIL_LIMIT } from "../../lib/agents/tool-activity-line.ts";

/** How far along one agent is. `queued` and `running` are the live states. */
export type AgentTaskStatus = "queued" | "running" | "completed" | "failed";

/** One background agent, as much of it as the lifecycle events reveal. */
export interface AgentTask {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly description: string;
	readonly model: string;
	readonly workflowChild: boolean;
	readonly runId: string | undefined;
	readonly parentId: string | undefined;
	readonly status: AgentTaskStatus;
	readonly startedAt: number;
	readonly settledAt: number | undefined;
	readonly durationMs: number | undefined;
	readonly toolUses: number | undefined;
	readonly lastActivityAt: number | undefined;
	readonly totalTokens: number | undefined;
	readonly costUsd: number | undefined;
	readonly activity: readonly string[];
	readonly result: string | undefined;
	readonly error: string | undefined;
	readonly outcome: string | undefined;
	readonly stopRequested: boolean;
}

/** Which lifecycle event a payload arrived on. */
export type AgentLifecycleKind = "created" | "started" | "completed" | "failed" | "resumed";

/** The event channels this registry listens to, in the order they fire. */
export const AGENT_LIFECYCLE_CHANNELS: ReadonlyArray<readonly [string, AgentLifecycleKind]> = [
	["subagents:created", "created"],
	["subagents:started", "started"],
	["subagents:completed", "completed"],
	["subagents:failed", "failed"],
	["subagents:resumed", "resumed"],
];

export const AGENT_PROGRESS_CHANNEL = "subagents:progress";

/** Settled agents trimmed off the list: how many, and their dollars. */
export interface TrimmedSpend {
	readonly agents: number;
	readonly dollars: number;
}

/** Settled tasks kept for the modal. Older ones fall off; the count only ever holds live ones. */
export const SETTLED_TASK_LIMIT = 20;

export const SETTLED_WORKFLOW_CHILD_LIMIT = 200;

export const SETTLED_TASK_GRACE_MS = 30_000;

/** The fields the dock reads off a lifecycle payload, once it is known to be one. */
export interface AgentLifecycleFields {
	readonly id: string;
	readonly name: string | undefined;
	readonly type: string | undefined;
	readonly description: string | undefined;
	readonly model: string | undefined;
	readonly durationMs: number | undefined;
	readonly toolUses: number | undefined;
	readonly costUsd: number | undefined;
	readonly result: string | undefined;
	readonly error: string | undefined;
	readonly outcome: string | undefined;
	readonly workflowChild: boolean;
	readonly runId: string | undefined;
	readonly parentId: string | undefined;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCostUsd(source: Record<string, unknown>): number | undefined {
	const usage = source.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	// SAFETY: usage was checked to be a non-null object on the previous line
	const cost = (usage as Record<string, unknown>).cost;
	if (typeof cost !== "object" || cost === null) return undefined;
	// SAFETY: cost was checked to be a non-null object on the previous line
	return readNumber(cost as Record<string, unknown>, "total");
}

export function parseAgentLifecyclePayload(raw: unknown): AgentLifecycleFields | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	// SAFETY: raw was checked to be a non-null object on the previous line
	const source = raw as Record<string, unknown>;
	const id = readString(source, "id");
	if (id === undefined) return undefined;
	return {
		id,
		name: readString(source, "name"),
		type: readString(source, "type"),
		description: readString(source, "description"),
		model: readString(source, "model"),
		durationMs: readNumber(source, "durationMs"),
		toolUses: readNumber(source, "toolUses"),
		costUsd: readCostUsd(source),
		result: readString(source, "result"),
		error: readString(source, "error"),
		outcome: readString(source, "status"),
		workflowChild: source.workflowChild === true,
		runId: readString(source, "runId"),
		parentId: readString(source, "parentId"),
	};
}

/** What a `subagents:progress` payload says about a running agent. */
export interface AgentProgressFields {
	readonly id: string;
	readonly toolUses: number | undefined;
	readonly totalTokens: number | undefined;
	readonly lastActivityAt: number | undefined;
	readonly activity: string | undefined;
}

/** Parse a `subagents:progress` payload, or undefined when it is not one. The id is the whole contract, as for lifecycle. */
export function parseAgentProgressPayload(raw: unknown): AgentProgressFields | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	// SAFETY: raw was checked to be a non-null object on the previous line
	const source = raw as Record<string, unknown>;
	const id = readString(source, "id");
	if (id === undefined) return undefined;
	return { id, toolUses: readNumber(source, "toolUses"), totalTokens: readNumber(source, "totalTokens"), lastActivityAt: readNumber(source, "lastActivityAt"), activity: readString(source, "activity") };
}

/** Whether a task is still being waited on. The count in the bottom rule is exactly these. */
export function isLiveAgentTask(task: AgentTask): boolean {
	return task.status === "queued" || task.status === "running";
}

/** A workflow run's own row: the one task that opens a run view instead of focusing the agent view. */
export function isWorkflowRunTask(task: AgentTask): boolean {
	return task.runId !== undefined;
}

const STATUS_ORDER: Record<AgentTaskStatus, number> = { queued: 0, running: 1, completed: 2, failed: 2 };

const STATUS_OF: Record<AgentLifecycleKind, AgentTaskStatus> = {
	created: "queued",
	started: "running",
	completed: "completed",
	failed: "failed",
	resumed: "running",
};

export class AgentTaskRegistry {
	private readonly tasks = new Map<string, AgentTask>();
	private trimmed: TrimmedSpend = { agents: 0, dollars: 0 };

	public applyLifecycleEvent(kind: AgentLifecycleKind, raw: unknown, now: number): boolean {
		const fields = parseAgentLifecyclePayload(raw);
		if (fields === undefined) return false;
		const status = STATUS_OF[kind];
		const existing = this.tasks.get(fields.id);
		if (kind !== "resumed" && existing !== undefined && STATUS_ORDER[status] < STATUS_ORDER[existing.status]) return false;
		const settled = status === "completed" || status === "failed";
		const carried = kind === "resumed" ? undefined : existing;
		const next: AgentTask = {
			id: fields.id,
			name: fields.name ?? existing?.name ?? "",
			type: fields.type ?? existing?.type ?? "",
			description: fields.description ?? existing?.description ?? "",
			model: fields.model ?? existing?.model ?? "",
			workflowChild: fields.workflowChild || (existing?.workflowChild ?? false),
			runId: fields.runId ?? existing?.runId,
			parentId: existing?.parentId ?? fields.parentId,
			status,
			startedAt: existing?.startedAt ?? now,
			settledAt: settled ? now : undefined,
			durationMs: fields.durationMs ?? carried?.durationMs,
			toolUses: fields.toolUses ?? carried?.toolUses,
			lastActivityAt: carried?.lastActivityAt,
			totalTokens: carried?.totalTokens,
			activity: carried?.activity ?? [],
			costUsd: fields.costUsd ?? existing?.costUsd,
			result: fields.result ?? carried?.result,
			error: fields.error ?? carried?.error,
			outcome: fields.outcome ?? carried?.outcome,
			stopRequested: settled ? false : (existing?.stopRequested ?? false),
		};
		this.tasks.set(fields.id, next);
		this.trimSettled(now);
		return true;
	}

	public applyProgressEvent(raw: unknown, now: number): boolean {
		const fields = parseAgentProgressPayload(raw);
		if (fields === undefined) return false;
		const task = this.tasks.get(fields.id);
		if (task === undefined || !isLiveAgentTask(task)) return false;
		const next: AgentTask = {
			...task,
			toolUses: fields.toolUses ?? task.toolUses,
			totalTokens: fields.totalTokens ?? task.totalTokens,
			lastActivityAt: fields.lastActivityAt ?? now,
			activity: fields.activity === undefined ? task.activity : [...task.activity, fields.activity].slice(-ACTIVITY_TAIL_LIMIT),
		};
		if (next.toolUses === task.toolUses && next.totalTokens === task.totalTokens && next.lastActivityAt === task.lastActivityAt && next.activity === task.activity) return false;
		this.tasks.set(fields.id, next);
		return true;
	}

	public markStopRequested(id: string, requested = true): boolean {
		const task = this.tasks.get(id);
		if (task === undefined || !isLiveAgentTask(task) || task.stopRequested === requested) return false;
		this.tasks.set(id, { ...task, stopRequested: requested });
		return true;
	}

	public liveCount(): number {
		let live = 0;
		for (const task of this.tasks.values()) if (isLiveAgentTask(task) && !task.workflowChild && task.parentId === undefined) live++;
		return live;
	}

	public list(): AgentTask[] {
		const all = [...this.tasks.values()].filter((task) => !task.workflowChild);
		const live = all.filter(isLiveAgentTask).sort((a, b) => a.startedAt - b.startedAt);
		const settled = all.filter((task) => !isLiveAgentTask(task)).sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
		return [...live, ...settled];
	}

	public get(id: string): AgentTask | undefined {
		return this.tasks.get(id);
	}

	public trimmedSpend(): TrimmedSpend {
		return this.trimmed;
	}

	public clear(): void {
		this.tasks.clear();
		this.trimmed = { agents: 0, dollars: 0 };
	}

	private trimSettled(now: number): void {
		this.trimBucket(now, (task) => !task.workflowChild && task.parentId === undefined, SETTLED_TASK_LIMIT, true);
		this.trimBucket(now, (task) => !task.workflowChild && task.parentId !== undefined, SETTLED_TASK_LIMIT, false);
		this.trimBucket(now, (task) => task.workflowChild, SETTLED_WORKFLOW_CHILD_LIMIT, false);
	}

	private trimBucket(now: number, inBucket: (task: AgentTask) => boolean, limit: number, ownSpend: boolean): void {
		const settled = [...this.tasks.values()]
			.filter((task) => !isLiveAgentTask(task) && inBucket(task))
			.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
		for (const task of settled.slice(limit)) {
			if (task.settledAt !== undefined && now - task.settledAt < SETTLED_TASK_GRACE_MS) continue;
			this.tasks.delete(task.id);
			if (ownSpend) this.trimmed = { agents: this.trimmed.agents + 1, dollars: this.trimmed.dollars + (task.costUsd ?? 0) };
		}
	}
}
