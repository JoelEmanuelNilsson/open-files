/**
 * The background agents this session launched, kept as a list the dock can
 * count and the modal can show.
 *
 * The engine publishes five lifecycle events on `pi.events`. A nested child
 * reports through whoever owns it and never reaches this bus at all
 * (`SA/docs/rpc.md`, "Ownership"); a workflow's agent does reach it, carrying
 * `workflowChild`, and is kept out of {@link AgentTaskRegistry.list} and out of
 * the count — it is waited on by its run, and the run is the row. It is still
 * held here, because the run's view is drawn from these very facts: the model,
 * the tokens, the tool calls and the activity of each of a run's agents. So
 * the list is exactly "the agents this seat is waiting on", which is the thing
 * the count in the bottom rule claims to be, and the map behind it is every
 * agent this seat can see.
 *
 * Two facts shape the reducer. An RPC-spawned agent emits no
 * `subagents:created`, so the first event for one is `subagents:started` and a
 * task has to be creatable from any event. A `SendMessage` resume arrives on
 * `subagents:resumed` under the agent's own id and *replaces* its row rather
 * than adding a second one — one agent, one row, for the agent's whole life.
 * And the payloads arrive as `unknown`
 * off an event bus, so they are parsed here rather than read field by field at
 * the call site: a payload without a string id is not an agent and is dropped.
 *
 * A fifth channel, `subagents:progress`, carries no status: it only refreshes
 * what a live run knows and the record does not learn until it settles — the
 * tool count, the time of the agent's last step, and the line for the call
 * that has just started, which is kept as a tail so a settled agent can still
 * show what it last did.
 */

import { ACTIVITY_TAIL_LIMIT } from "../../lib/tool-activity-line.ts";

/** How far along one agent is. `queued` and `running` are the live states. */
export type AgentTaskStatus = "queued" | "running" | "completed" | "failed";

/** One background agent, as much of it as the lifecycle events reveal. */
export interface AgentTask {
	readonly id: string;
	/** The name the engine issued, e.g. `worker-2` — what `SendMessage` addresses. Empty when the event did not name one. */
	readonly name: string;
	/** Agent type, e.g. `worker`. Empty when the event did not name one. */
	readonly type: string;
	/** What the agent was asked to do, as given to the `Agent` tool. */
	readonly description: string;
	/** The model this agent runs on, as `provider/id`. Empty when the event did not name one. */
	readonly model: string;
	/** An agent a workflow run spawned. Its row belongs to the run's view, not to the seat's list. */
	readonly workflowChild: boolean;
	/**
	 * The run this task *is*, on a workflow run's own row: what its view is
	 * opened with. How many agents that run has is the run store's answer, not a
	 * number copied onto the row — one that could go stale between events.
	 */
	readonly runId: string | undefined;
	readonly status: AgentTaskStatus;
	/** Epoch ms this task was first seen by the dock, not by the manager. */
	readonly startedAt: number;
	/** Epoch ms it settled, or undefined while it is live. */
	readonly settledAt: number | undefined;
	/** Run duration as reported by the engine, which knows when it really started. */
	readonly durationMs: number | undefined;
	readonly toolUses: number | undefined;
	/**
	 * Epoch ms of the last event this agent's session produced, off
	 * `subagents:progress`. Undefined until the first one lands — a child that
	 * has done nothing observable yet has no last activity to report.
	 */
	readonly lastActivityAt: number | undefined;
	/** The context the agent is carrying, off `subagents:progress`. Undefined until its first billed message. */
	readonly totalTokens: number | undefined;
	/**
	 * Dollars this agent's whole run cost, off the settling event's
	 * `usage.cost.total`. Undefined while it is running and on a model pi has no
	 * prices for — never zero, which would read as "free" (C15).
	 */
	readonly costUsd: number | undefined;
	/**
	 * The last {@link ACTIVITY_TAIL_LIMIT} tool calls, oldest first, one line
	 * each (`Bash(npm test)`). Kept past settle: what an agent last did is a fact
	 * about the finished run, not a live reading.
	 */
	readonly activity: readonly string[];
	/** The agent's final answer, present on a completed task. */
	readonly result: string | undefined;
	readonly error: string | undefined;
	/**
	 * The engine's own word for how it ended (`completed`, `steered`, `stopped`,
	 * `aborted`, `error`), so the modal and the transcript row say the same thing
	 * about the same stop.
	 */
	readonly outcome: string | undefined;
	/** A stop has been asked for over the bus and the agent has not settled yet. */
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

/**
 * The channel a running agent's tool count and last-activity time arrive on
 * (`lib/agent-runtime.ts`). Separate from the lifecycle channels because it
 * carries no status: progress never moves a task between states.
 */
export const AGENT_PROGRESS_CHANNEL = "subagents:progress";

/** Settled tasks kept for the modal. Older ones fall off; the count only ever holds live ones. */
export const SETTLED_TASK_LIMIT = 20;

/**
 * Settled workflow children kept, over and above the list's own limit.
 *
 * They are not rows in the list; they are the rows of a run's view, and that
 * view has to stay whole for as long as the run does. Twenty is the size of a
 * list a human scrolls; this is the size of a fan-out, which is the run's
 * scale and not the list's.
 */
export const SETTLED_WORKFLOW_CHILD_LIMIT = 200;

/**
 * How long a just-settled row is safe from the trim, whatever the limit says.
 *
 * Twenty siblings landing together could drop a row before any human had a
 * chance to look at it, while `ListAgents` still listed the agent — the dock
 * and the registry disagreeing about the same child. Claude Code's
 * `PANEL_GRACE_MS`; the invariant is theirs, the mechanism is ours.
 */
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
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Dollars off a settling payload's `usage.cost.total`.
 *
 * The engine hands the whole run over as a pi `Usage` — pi's own convention
 * for spend in anything given to a consumer — so this reads the field pi
 * itself reads and nothing else. The flat `tokens` beside it answers a
 * different question (display tokens, `cacheRead` excluded) and is not money.
 *
 * Undefined rather than zero when the model has no prices: a run that cost an
 * unknown amount and a run that cost nothing are different facts, and only one
 * of them should print `$0.00`.
 */
function readCostUsd(source: Record<string, unknown>): number | undefined {
	const usage = source.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const cost = (usage as Record<string, unknown>).cost;
	if (typeof cost !== "object" || cost === null) return undefined;
	return readNumber(cost as Record<string, unknown>, "total");
}

/**
 * Parse a `subagents:*` payload, or undefined when it is not one.
 *
 * The id is the whole contract: without it there is nothing to key a task on,
 * and a payload shaped differently by a future engine is dropped rather
 * than half-read.
 */
export function parseAgentLifecyclePayload(raw: unknown): AgentLifecycleFields | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
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
	};
}

/** What a `subagents:progress` payload says about a running agent. */
export interface AgentProgressFields {
	readonly id: string;
	readonly toolUses: number | undefined;
	readonly totalTokens: number | undefined;
	readonly lastActivityAt: number | undefined;
	/** The call that has just started, one line. Present on exactly the events a tool call forces. */
	readonly activity: string | undefined;
}

/** Parse a `subagents:progress` payload, or undefined when it is not one. The id is the whole contract, as for lifecycle. */
export function parseAgentProgressPayload(raw: unknown): AgentProgressFields | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const source = raw as Record<string, unknown>;
	const id = readString(source, "id");
	if (id === undefined) return undefined;
	return { id, toolUses: readNumber(source, "toolUses"), totalTokens: readNumber(source, "totalTokens"), lastActivityAt: readNumber(source, "lastActivityAt"), activity: readString(source, "activity") };
}

/** Whether a task is still being waited on. The count in the bottom rule is exactly these. */
export function isLiveAgentTask(task: AgentTask): boolean {
	return task.status === "queued" || task.status === "running";
}

/** A workflow run's own row: the one task that opens a run view instead of a conversation box. */
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

/**
 * The session's background agents.
 *
 * One registry per session: `session_start` clears it, because a `/new`,
 * `/resume` or `/fork` is a different conversation and the agents the last one
 * launched are not this one's tasks.
 */
export class AgentTaskRegistry {
	private readonly tasks = new Map<string, AgentTask>();

	/**
	 * Fold one lifecycle event in. Returns whether anything changed, so a caller
	 * can skip republishing a count that did not move.
	 */
	public applyLifecycleEvent(kind: AgentLifecycleKind, raw: unknown, now: number): boolean {
		const fields = parseAgentLifecyclePayload(raw);
		if (fields === undefined) return false;
		const status = STATUS_OF[kind];
		const existing = this.tasks.get(fields.id);
		// Events can arrive out of order across two producers; never walk a task
		// backwards, or a late `started` would resurrect a settled agent and the
		// count would never come back down. `resumed` is the one event that means
		// exactly that — this agent is alive again — so it is the one exemption,
		// which is why it has a channel of its own.
		if (kind !== "resumed" && existing !== undefined && STATUS_ORDER[status] < STATUS_ORDER[existing.status]) return false;
		const settled = status === "completed" || status === "failed";
		// A resume replaces the agent's row rather than adding a second one under
		// the same name, so the previous run's answer goes: a running agent has none.
		const carried = kind === "resumed" ? undefined : existing;
		const next: AgentTask = {
			id: fields.id,
			name: fields.name ?? existing?.name ?? "",
			type: fields.type ?? existing?.type ?? "",
			description: fields.description ?? existing?.description ?? "",
			model: fields.model ?? existing?.model ?? "",
			workflowChild: fields.workflowChild || (existing?.workflowChild ?? false),
			runId: fields.runId ?? existing?.runId,
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
			// A stop that has landed is no longer pending, whichever way it settled.
			stopRequested: settled ? false : (existing?.stopRequested ?? false),
		};
		this.tasks.set(fields.id, next);
		this.trimSettled(now);
		return true;
	}

	/**
	 * Fold one progress event in: the running agent's tool count and the moment
	 * of its last step. Returns whether anything changed.
	 *
	 * A settled task is left alone: its counts are the record's, and a progress
	 * event still in flight when it settled must not walk them back.
	 */
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

	/** Note that a stop has been asked for, so the row can say so before the event lands. */
	public markStopRequested(id: string, requested = true): boolean {
		const task = this.tasks.get(id);
		if (task === undefined || !isLiveAgentTask(task) || task.stopRequested === requested) return false;
		this.tasks.set(id, { ...task, stopRequested: requested });
		return true;
	}

	/** Agents still being waited on — what `N tasks ↓` counts. A run's children are waited on by the run. */
	public liveCount(): number {
		let live = 0;
		for (const task of this.tasks.values()) if (isLiveAgentTask(task) && !task.workflowChild) live++;
		return live;
	}

	/**
	 * The modal's rows: live agents in the order they were launched, then settled
	 * ones most recent first. Live work is what a list of tasks is *for*, and a
	 * result that just landed is the one most likely to be wanted after it.
	 */
	public list(): AgentTask[] {
		const all = [...this.tasks.values()].filter((task) => !task.workflowChild);
		const live = all.filter(isLiveAgentTask).sort((a, b) => a.startedAt - b.startedAt);
		const settled = all.filter((task) => !isLiveAgentTask(task)).sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
		return [...live, ...settled];
	}

	public get(id: string): AgentTask | undefined {
		return this.tasks.get(id);
	}

	public clear(): void {
		this.tasks.clear();
	}

	private trimSettled(now: number): void {
		this.trimBucket(now, false, SETTLED_TASK_LIMIT);
		this.trimBucket(now, true, SETTLED_WORKFLOW_CHILD_LIMIT);
	}

	private trimBucket(now: number, workflowChild: boolean, limit: number): void {
		const settled = [...this.tasks.values()]
			.filter((task) => !isLiveAgentTask(task) && task.workflowChild === workflowChild)
			.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
		for (const task of settled.slice(limit)) {
			if (task.settledAt !== undefined && now - task.settledAt < SETTLED_TASK_GRACE_MS) continue;
			this.tasks.delete(task.id);
		}
	}
}
