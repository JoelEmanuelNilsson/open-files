/**
 * The agent registry: a named, session-lifetime record per agent (map C2),
 * persisted as custom entries in the parent's session file so it survives
 * `/resume`, `/fork` and handoff.
 *
 * One entry per status change, `appendEntry("agent-record", record)`; the
 * registry is the fold over them, latest wins per name. Two rules fall out of
 * "latest wins": reusing a name starts a new agent under it and the old one is
 * only reachable through its own record's `taskId`; and a record whose
 * session is not this one — pi's `/fork` copies the whole file — is not
 * this seat's agent, so the fold is scoped to an owner.
 *
 * The record holds the facts the tools read (name, type, status, result) and
 * the facts a resume needs (the child's session file, its cwd, its branch).
 * Nothing in it is a live object: the live session is the runtime's, and a
 * record read back after a restart is exactly as resumable as one written a
 * second ago — `SendMessage` reopens the file.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { shared } from "./shared.ts";

/** The custom entry type the registry is persisted under. */
export const AGENT_RECORD_ENTRY = "agent-record";

const NAME_COUNTER_SEAM = "__piKitAgentNameCounters";

/**
 * type -> the highest `${type}-${n}` number handed out anywhere in this
 * process, on `globalThis` like the kit's other cross-session seams.
 *
 * A registry is scoped to one owner session, so a per-registry counter
 * restarts at 1 in every seat: on 2026-09-03 a chain of nested workers
 * produced two live agents both called `worker-1`, one per branch of the
 * tree, and a name that is spoken between seats — in a report, in the dock,
 * in a worktree branch — stopped identifying one agent. Children run in this
 * process (in-process pi sessions), so the process is the scope a name has
 * to be unique in, and one counter per type makes it so by construction
 * rather than by a collision check.
 */
const nameCounters = (): Map<string, number> => shared(NAME_COUNTER_SEAM, () => new Map<string, number>());

/**
 * Raise the counter past a name that already exists, so an auto-generated
 * name never lands on one a caller chose (`name: "worker-9"`) or one read
 * back from a session file.
 */
function observeAgentName(name: string): void {
	const match = /^(.+)-(\d+)$/.exec(name);
	if (match === null) return;
	const type = match[1] as string;
	const n = Number(match[2]);
	const counters = nameCounters();
	if (n > (counters.get(type) ?? 0)) counters.set(type, n);
}

/**
 * A name a spawn asks for, as the engine names the child: trimmed, and a blank
 * one as none, for the engine to name. The one rule, so a caller that keys
 * anything on the name before the spawn returns keys it on the child's name.
 */
export function agentNameOf(asked: string | undefined): string | undefined {
	const name = asked?.trim();
	return name === "" ? undefined : name;
}

/** Forget every auto-name issued in this process. For tests, which build many registries. */
export function resetAgentNameCounters(): void {
	nameCounters().clear();
}

/**
 * How a settled result reached a reader — the only claim the system makes
 * about where the text is.
 *
 * One boolean used to carry all four, and three of them are not "the parent
 * read it": `handed` is a message given to pi's queue, which appends at the
 * *end* of the turn in flight and so may be minutes away from any transcript;
 * `spawner` is a workflow child's result, which never enters a conversation at
 * all. On 2026-09-05 `TaskOutput` read the one bit and told a seat to scroll
 * back to text that did not exist yet. Splitting it is what lets each tool say
 * only what it can check.
 *
 * Transitions, and there are only these: `undefined` → any; `handed` →
 * `conversation`, when the harness has observed the message in the session file.
 */
export type AgentReadBy = "conversation" | "tool" | "spawner" | "handed";

/** Where an agent is in its life. `lost` is a run the process ended under. */
export type AgentStatus = "queued" | "running" | "completed" | "error" | "stopped" | "lost";

/**
 * Who stopped a run. On 2026-09-04 two agents died with an aborted turn and the
 * session file recorded only that they were `stopped` — every path leads to the
 * same status, so the file could not say which one ran (issues/31 (h)). Naming
 * the caller is what makes the next occurrence answerable instead of arguable.
 */
export type StopCause = "TaskStop" | "dock" | "cascade" | "workflow" | "shutdown" | "max-turns" | "orphaned" | "context";

/** Terminal statuses: the record will not change until someone resumes it. */
export function agentIsSettled(status: AgentStatus): boolean {
	return status !== "queued" && status !== "running";
}

/** One agent, as persisted. Mutated only through {@link AgentRegistry}. */
export interface AgentRecord {
	/** The address (C2). */
	readonly name: string;
	/** Unique per run: every spawn and every resume gets a fresh one. The dock keys on it. */
	readonly taskId: string;
	/** The session that owns this record; a record copied into another session's file is not that session's. */
	readonly ownerSessionId: string;
	/** Type name from disk. */
	readonly type: string;
	/** The 3–5 word task description. */
	readonly description: string;
	readonly status: AgentStatus;
	/** Set the moment a stop begins, naming its caller; undefined on a run nobody stopped. */
	readonly stoppedBy: StopCause | undefined;
	/** 1 for a child of the main seat. */
	readonly depth: number;
	/** The child's session file, when persisted — what a resume reopens. */
	readonly sessionFile: string | undefined;
	/** The child's session id, for the seat seam and the wire headers. */
	readonly sessionId: string;
	readonly cwd: string;
	/** Worktree branch when isolated (C19). */
	readonly branch: string | undefined;
	/** The model the child runs on, as `provider/id`. */
	readonly model: string;
	/**
	 * The thinking level the child runs at, after the clamp to its model's level
	 * map — so any level pi has, not only the ones a spawn may ask for. Persisted beside the model for the
	 * same reason: a resume must run the agent the human is still talking to, and
	 * recomputing the level from the type file loses whatever the spawn asked for.
	 * `undefined` on a record written before this field existed.
	 */
	readonly thinking: ThinkingLevel | undefined;
	/** The final reply of the latest run, whole (C7). */
	readonly result: string | undefined;
	readonly error: string | undefined;
	/** How the result reached a reader, undefined while nobody has taken it: delivered exactly once (C7). */
	readonly readBy: AgentReadBy | undefined;
	/** Epoch ms {@link AgentRecord.readBy} was set, so a tool can say *when* without guessing. */
	readonly readAt: number | undefined;
	readonly toolUses: number;
	/** Dollars the child's runs cost so far, off pi's usage. */
	readonly costUsd: number;
	/** Context size: the last message's billed total, not the sum of every message's (issues/31 (d)). */
	readonly totalTokens: number;
	/** Tokens the child wrote, summed over its run — how much work it did. */
	readonly outputTokens: number;
	readonly startedAt: number;
	readonly completedAt: number | undefined;
	/** The `Agent` call's tool call id, for the rows that look one up. */
	readonly toolCallId: string | undefined;
	/** A workflow's child (ticket 23): its result is the workflow's to read, never this seat's conversation's. */
	readonly workflowChild: boolean;
}

/**
 * Fold persisted entries into the registry for one owner. Entries are read in
 * file order, so the last one per name wins. Runs the process ended under
 * (`queued`/`running` in the file, no live session now) are reported `lost`.
 */
export function readAgentRegistry(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>, ownerSessionId: string): Map<string, AgentRecord> {
	const byName = new Map<string, AgentRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY) continue;
		const record = parseAgentRecord(entry.data);
		if (record === undefined || record.ownerSessionId !== ownerSessionId) continue;
		byName.set(record.name, agentIsSettled(record.status) ? record : { ...record, status: "lost" });
	}
	return byName;
}

/** Shape-check a persisted record; a malformed one is skipped, never half-read. */
export function parseAgentRecord(data: unknown): AgentRecord | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const raw = data as Record<string, unknown>;
	const str = (key: string): string | undefined => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
	const num = (key: string, fallback: number): number => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : fallback);
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
		result: str("result"),
		error: str("error"),
		// A file written before the split says only `resultRead: true`, and the one
		// thing that was reliably true of it is that some reader had taken the text.
		readBy: isReadBy(raw.readBy) ? raw.readBy : raw.resultRead === true ? "conversation" : undefined,
		readAt: typeof raw.readAt === "number" ? (raw.readAt as number) : undefined,
		toolUses: num("toolUses", 0),
		costUsd: num("costUsd", 0),
		totalTokens: num("totalTokens", 0),
		outputTokens: num("outputTokens", 0),
		startedAt: num("startedAt", 0),
		completedAt: typeof raw.completedAt === "number" ? (raw.completedAt as number) : undefined,
		toolCallId: str("toolCallId"),
		workflowChild: raw.workflowChild === true,
	};
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

/**
 * The in-memory registry for one owner, backed by a persist callback so every
 * change is one entry in the session file. Latest wins by name; every run
 * ever made stays reachable by `taskId` for the dock's stop button.
 */
export class AgentRegistry {
	readonly #byName = new Map<string, AgentRecord>();
	readonly #byTaskId = new Map<string, AgentRecord>();
	readonly #persist: (record: AgentRecord) => void;

	constructor(persist: (record: AgentRecord) => void, initial?: Iterable<AgentRecord>) {
		this.#persist = persist;
		for (const record of initial ?? []) {
			this.#byName.set(record.name, record);
			this.#byTaskId.set(record.taskId, record);
			observeAgentName(record.name);
		}
	}

	/** The same records, every run included, writing through `persist` instead; this registry is left as it was. */
	redirect(persist: (record: AgentRecord) => void): AgentRegistry {
		const copy = new AgentRegistry(persist);
		for (const [name, record] of this.#byName) copy.#byName.set(name, record);
		for (const [taskId, record] of this.#byTaskId) copy.#byTaskId.set(taskId, record);
		return copy;
	}

	/** The newest record under a name, or undefined. */
	byName(name: string): AgentRecord | undefined {
		return this.#byName.get(name);
	}

	/** Any run, by its task id — including runs whose name has since been reused. */
	byTaskId(taskId: string): AgentRecord | undefined {
		return this.#byTaskId.get(taskId);
	}

	/** Every current record, in name order. */
	all(): AgentRecord[] {
		return [...this.#byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Names whose current run is queued or running. */
	live(): AgentRecord[] {
		return this.all().filter((record) => !agentIsSettled(record.status));
	}

	/** Write a record (new or changed) and persist it. Returns the stored record. */
	put(record: AgentRecord): AgentRecord {
		observeAgentName(record.name);
		this.#byName.set(record.name, record);
		this.#byTaskId.set(record.taskId, record);
		this.#persist(record);
		return record;
	}

	/**
	 * Apply a change to the newest record under `name`; a no-op for an unknown
	 * name.
	 *
	 * `readBy` is not changeable here, by type: a result is consumed exactly
	 * where it is handed back, and the only setter is {@link markRead}, called
	 * by `AgentRuntime.takeUnread` (C7).
	 */
	update(name: string, change: Partial<Omit<AgentRecord, "readBy" | "readAt">>): AgentRecord | undefined {
		const current = this.#byName.get(name);
		if (current === undefined) return undefined;
		return this.put({ ...current, ...change, readBy: current.readBy, readAt: current.readAt });
	}

	/**
	 * Record that the run `taskId` under `name` reached a reader, and how (C7:
	 * delivered once).
	 *
	 * Call this from `AgentRuntime.takeUnread` and nowhere else — it is the
	 * step *after* the text has been handed to a reader, so a path that
	 * consumes a result without printing it cannot be written. A stale task id
	 * (the name has since been reused) is ignored: that run is nobody's to read.
	 *
	 * The only re-mark allowed is `handed` → `conversation`: a message given to
	 * pi's queue whose arrival in the session file the harness has since seen.
	 * Every other second call is a no-op, so a record cannot be talked out of
	 * the strongest claim already made about it.
	 */
	markRead(name: string, taskId: string, by: AgentReadBy, at: number): void {
		const current = this.#byName.get(name);
		if (current === undefined || current.taskId !== taskId) return;
		if (current.readBy !== undefined && !(current.readBy === "handed" && by === "conversation")) return;
		this.put({ ...current, readBy: by, readAt: at });
	}

	/**
	 * A fresh name under a type: `worker-1`, `worker-2`, … The counter is one
	 * per type for the whole process ({@link nameCounters}), so two seats on
	 * different branches of the agent tree can never issue the same name, and
	 * a name a caller chose is never issued again. Short enough to type into
	 * `SendMessage`, unique by construction rather than by a retry.
	 */
	nextName(type: string): string {
		const counters = nameCounters();
		const n = (counters.get(type) ?? 0) + 1;
		counters.set(type, n);
		return `${type}-${n}`;
	}
}
