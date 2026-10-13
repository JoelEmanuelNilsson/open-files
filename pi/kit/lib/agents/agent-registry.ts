import { randomBytes } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS } from "../models/model-label.ts";
import { processShared } from "../process/process-shared-state.ts";

/** The custom entry type the registry is persisted under. */
export const AGENT_RECORD_ENTRY = "agent-record";

const NAME_COUNTER_SEAM = "__piKitAgentNameCounters";

const nameCounters = (): Map<string, number> => processShared(NAME_COUNTER_SEAM, () => new Map<string, number>());

function observeAgentName(name: string): void {
	const match = /^(.+)-(\d+)$/.exec(name);
	if (match === null) return;
	// SAFETY: match[1] is a required capture group of the regex, so it is always a string
	const type = match[1] as string;
	const n = Number(match[2]);
	const counters = nameCounters();
	if (n > (counters.get(type) ?? 0)) counters.set(type, n);
}

export function agentNameOf(asked: string | undefined): string | undefined {
	const name = asked?.trim();
	return name === "" ? undefined : name;
}

/** Forget every auto-name issued in this process. For tests, which build many registries. */
export function resetAgentNameCounters(): void {
	nameCounters().clear();
}

export type AgentReadBy = "conversation" | "tool" | "spawner" | "handed";

/** Where an agent is in its life. `lost` is a run the process ended under. */
export type AgentStatus = "queued" | "running" | "completed" | "error" | "stopped" | "lost";

export type StopCause = "TaskStop" | "dock" | "cascade" | "workflow" | "shutdown" | "max-turns" | "orphaned" | "context";

/** Terminal statuses: the record will not change until someone resumes it. */
export function agentIsSettled(status: AgentStatus): boolean {
	return status !== "queued" && status !== "running";
}

/** One agent, as persisted. Mutated only through {@link AgentRegistry}. */
export interface AgentRecord {
	readonly name: string;
	readonly taskId: string;
	readonly ownerSessionId: string;
	readonly type: string;
	readonly description: string;
	readonly status: AgentStatus;
	readonly stoppedBy: StopCause | undefined;
	readonly depth: number;
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly cwd: string;
	readonly branch: string | undefined;
	readonly model: string;
	readonly thinking: ThinkingLevel | undefined;
	readonly result: string | undefined;
	readonly error: string | undefined;
	readonly readBy: AgentReadBy | undefined;
	readonly readAt: number | undefined;
	readonly toolUses: number;
	readonly costUsd: number;
	readonly totalTokens: number;
	readonly outputTokens: number;
	readonly startedAt: number;
	readonly completedAt: number | undefined;
	readonly toolCallId: string | undefined;
	readonly workflowChild: boolean;
	readonly workflows?: boolean;
	readonly brief: string | undefined;
	readonly laterMessages: readonly AgentLaterMessage[];
}

/** One message delivered to an agent after its brief. */
export interface AgentLaterMessage {
	readonly from: string;
	readonly text: string;
	readonly at: number;
}

/** Every run the owner persisted, latest record per task id. */
export function readAgentRuns(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>, ownerSessionId: string): Map<string, AgentRecord> {
	const byTask = new Map<string, AgentRecord>();
	for (const record of agentRecordWrites(entries, ownerSessionId)) byTask.set(record.taskId, agentIsSettled(record.status) ? record : { ...record, status: "lost" });
	return byTask;
}

/** The run holding each name, folded over the writes in order by the rule the live registry applies. */
export function readAgentRegistry(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>, ownerSessionId: string): Map<string, AgentRecord> {
	const holders = new Map<string, AgentRecord>();
	for (const record of agentRecordWrites(entries, ownerSessionId)) if (takesName(record, holders.get(record.name))) holders.set(record.name, record);
	const runs = readAgentRuns(entries, ownerSessionId);
	return new Map([...holders].map(([name, holder]) => [name, runs.get(holder.taskId) ?? holder]));
}

function* agentRecordWrites(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>, ownerSessionId: string): Generator<AgentRecord> {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY) continue;
		const record = parseAgentRecord(entry.data);
		if (record !== undefined && record.ownerSessionId === ownerSessionId) yield record;
	}
}

function takesName(written: AgentRecord, holder: AgentRecord | undefined): boolean {
	return holder === undefined || written.taskId === holder.taskId || written.startedAt >= holder.startedAt;
}

/** Shape-check a persisted record; a malformed one is skipped, never half-read. */
export function parseAgentRecord(data: unknown): AgentRecord | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	// SAFETY: data was checked to be a non-null object on the previous line
	const raw = data as Record<string, unknown>;
	const str = (key: string): string | undefined => {
		const value = raw[key];
		return typeof value === "string" ? value : undefined;
	};
	const num = (key: string, fallback: number): number => {
		const value = raw[key];
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};
	const name = str("name");
	const taskId = str("taskId");
	const ownerSessionId = str("ownerSessionId");
	const sessionId = str("sessionId");
	const status = str("status");
	if (!name || !taskId || !ownerSessionId || !sessionId || !isAgentStatus(status)) return undefined;
	return {
		name,
		taskId,
		ownerSessionId,
		type: str("type") ?? "worker",
		description: str("description") ?? "",
		status,
		stoppedBy: isStopCause(raw.stoppedBy) ? raw.stoppedBy : undefined,
		depth: num("depth", 1),
		sessionFile: str("sessionFile"),
		sessionId,
		cwd: str("cwd") ?? "",
		branch: str("branch"),
		model: str("model") ?? "",
		thinking: isThinkingLevel(raw.thinking) ? raw.thinking : undefined,
		result: str("result"),
		error: str("error"),
		readBy: isReadBy(raw.readBy) ? raw.readBy : raw.resultRead === true ? "conversation" : undefined,
		readAt: typeof raw.readAt === "number" ? raw.readAt : undefined,
		toolUses: num("toolUses", 0),
		costUsd: num("costUsd", 0),
		totalTokens: num("totalTokens", 0),
		outputTokens: num("outputTokens", 0),
		startedAt: num("startedAt", 0),
		completedAt: typeof raw.completedAt === "number" ? raw.completedAt : undefined,
		toolCallId: str("toolCallId"),
		workflowChild: raw.workflowChild === true,
		workflows: typeof raw.workflows === "boolean" ? raw.workflows : undefined,
		brief: str("brief"),
		laterMessages: Array.isArray(raw.laterMessages) ? raw.laterMessages.filter(isLaterMessage) : [],
	};
}

function isLaterMessage(value: unknown): value is AgentLaterMessage {
	if (typeof value !== "object" || value === null) return false;
	// SAFETY: raw is checked field by field on this line
	const raw = value as Record<string, unknown>;
	return typeof raw.from === "string" && typeof raw.text === "string" && typeof raw.at === "number";
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	// SAFETY: includes accepts only the element type; the readonly array is widened to unknown[] to test an unknown value
	return (THINKING_LEVELS as readonly unknown[]).includes(value);
}

function isReadBy(value: unknown): value is AgentReadBy {
	return value === "conversation" || value === "tool" || value === "spawner" || value === "handed";
}

function isStopCause(value: unknown): value is StopCause {
	return value === "TaskStop" || value === "dock" || value === "cascade" || value === "workflow" || value === "shutdown" || value === "max-turns" || value === "orphaned" || value === "context";
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return value === "queued" || value === "running" || value === "completed" || value === "error" || value === "stopped" || value === "lost";
}

export class AgentRegistry {
	readonly #byName = new Map<string, AgentRecord>();
	readonly #byTaskId = new Map<string, AgentRecord>();
	readonly #persist: (record: AgentRecord) => void;

	constructor(persist: (record: AgentRecord) => void, initial?: Iterable<AgentRecord>) {
		this.#persist = persist;
		for (const record of initial ?? []) this.#index(record);
	}

	#index(record: AgentRecord): void {
		observeAgentName(record.name);
		if (takesName(record, this.#byName.get(record.name))) this.#byName.set(record.name, record);
		this.#byTaskId.set(record.taskId, record);
	}

	byName(name: string): AgentRecord | undefined {
		return this.#byName.get(name);
	}

	byTaskId(taskId: string): AgentRecord | undefined {
		return this.#byTaskId.get(taskId);
	}

	all(): AgentRecord[] {
		return [...this.#byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	live(): AgentRecord[] {
		return this.all().filter((record) => !agentIsSettled(record.status));
	}

	put(record: AgentRecord): AgentRecord {
		this.#index(record);
		this.#persist(record);
		return record;
	}

	#reindex(record: AgentRecord): void {
		this.#byTaskId.set(record.taskId, record);
		if (this.#byName.get(record.name)?.taskId === record.taskId) this.#byName.set(record.name, record);
	}

	update(name: string, change: Partial<Omit<AgentRecord, "readBy" | "readAt">>): AgentRecord | undefined {
		const current = this.#byName.get(name);
		if (current === undefined) return undefined;
		return this.put({ ...current, ...change, readBy: current.readBy, readAt: current.readAt });
	}

	markHandedSeen(name: string, taskId: string, at: number): void {
		const current = this.#byName.get(name);
		if (current?.taskId !== taskId || current.readBy !== "handed") return;
		this.put({ ...current, readBy: "conversation", readAt: at });
	}

	consume(records: readonly AgentRecord[], by: AgentReadBy, at: number, hand: () => boolean | void): boolean {
		const marks: { readonly prior: AgentRecord; readonly mark: AgentRecord }[] = [];
		let taken = false;
		try {
			for (const record of records) {
				const prior = this.#byTaskId.get(record.taskId);
				if (prior === undefined) continue;
				if (prior.readBy !== undefined && !(prior.readBy === "handed" && by === "conversation")) continue;
				const mark = { ...prior, readBy: by, readAt: at };
				this.#reindex(mark);
				marks.push({ prior, mark });
			}
			taken = hand() !== false;
		} finally {
			for (const { prior, mark } of marks) {
				const current = this.#byTaskId.get(mark.taskId);
				if (current === undefined) continue;
				const newest = this.#byName.get(mark.name)?.taskId === mark.taskId;
				if (taken) {
					if (current === mark && newest) this.#persist(mark);
					continue;
				}
				if (current.readBy !== mark.readBy || current.readAt !== mark.readAt) continue;
				const restored = { ...current, readBy: prior.readBy, readAt: prior.readAt };
				if (current === mark || !newest) this.#reindex(restored);
				else this.put(restored);
			}
		}
		return taken;
	}

	nextName(type: string): string {
		const counters = nameCounters();
		const n = (counters.get(type) ?? 0) + 1;
		counters.set(type, n);
		return `${type}-${n}`;
	}
}

export function mintAgentTaskId(): string {
	return `a${randomBytes(6).toString("hex")}`;
}
