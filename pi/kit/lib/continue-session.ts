/**
 * Continue session — the handoff v2 rules (map C23, ticket 11): what counts
 * as a handoff document, what the harness appends to it, what the new
 * session's first message says, and which entries of the old session file
 * the new one carries. Pure over session entries; `extensions/continue-session.ts`
 * is the shell that runs these at pi's events, and `lib/agent-runtime.ts`
 * uses the detector to know a child is about to switch sessions.
 *
 * The design is Joel's manual pattern, automated: the model writes a plain
 * assistant message that starts `# Handoff`; the harness starts a linked new
 * session (`ctx.newSession({ parentSession, setup })`) whose first user
 * message is "Continue session `<old file>`." followed by the document and
 * a generated block; the old file is the record. No tool, no summariser, no
 * compaction — so pi's cut-point rules (which refused the 2026-09-03 handoff
 * at 153k because the last entry was a tool result) have nothing to say.
 */

import { AGENT_RECORD_ENTRY, type AgentRecord, agentIsSettled, parseAgentRecord, readAgentRegistry } from "./agent-registry.ts";
import { HANDOFF_HEADING, k, type Thresholds } from "./handoff-ladder.ts";
import { shared } from "./shared.ts";

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/** The slice of an assistant message the detector reads. */
export interface AssistantMessageShape {
	role?: string | undefined;
	content?: string | ReadonlyArray<{ type?: string; text?: string }> | undefined;
}

/** The text blocks of a message joined, or the string itself. */
export function messageText(message: AssistantMessageShape | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * The handoff document in an assistant message, or undefined. A document is
 * detected by its first non-empty line being exactly `# Handoff` (trimmed):
 * a mention of the heading inside prose is not a handoff.
 *
 * Recorded, because it is a magic string in model output used as a control
 * signal and has no type (38's finding 4): an agent whose *own reply* opens
 * with that heading — a review of this subsystem, a skill, a report — is read
 * as handing off. C23 buys more than it costs (the handoff is plain text, not
 * a tool call), and the failure is bounded by construction: a child that
 * claims a switch and does not start one is finished after
 * `HANDOFF_SWITCH_GRACE_MS`, so the cost is a 3s stall and never a lost run.
 */
export function handoffDocumentOf(message: AssistantMessageShape | undefined): string | undefined {
	if (message?.role !== "assistant") return undefined;
	const text = messageText(message);
	return isHandoffDocumentText(text) ? text.trim() : undefined;
}

/** Whether a text is a handoff document: first non-empty line is the heading. */
export function isHandoffDocumentText(text: string): boolean {
	const first = text.split("\n").find((line) => line.trim() !== "");
	return first !== undefined && first.trim() === HANDOFF_HEADING;
}

// ---------------------------------------------------------------------------
// The generated block
// ---------------------------------------------------------------------------

/** Everything the harness knows is in flight, gathered from the session. */
export interface HandoffFacts {
	/** Agents whose latest run is queued or running. */
	readonly liveAgents: ReadonlyArray<{ name: string; type: string; status: string }>;
	/** Agents that settled and whose result the model has not read. */
	readonly unreadResults: ReadonlyArray<{ name: string; status: string; firstLine: string }>;
	/** Background bash tasks started this session and not yet reported finished. */
	readonly backgroundTasks: ReadonlyArray<{ id: number; command: string; logPath: string }>;
	readonly filesRead: ReadonlyArray<string>;
	readonly filesChanged: ReadonlyArray<string>;
}

/** The slice of a session entry the fact gatherers read. */
export interface SessionEntryShape {
	type: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	details?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		content?: unknown;
		details?: unknown;
	};
}

/** The agent facts: live runs and unread results, from the registry entries of this owner. */
export function agentFactsFromEntries(entries: ReadonlyArray<SessionEntryShape>, ownerSessionId: string): Pick<HandoffFacts, "liveAgents" | "unreadResults"> {
	const registry = readAgentRegistry(entries, ownerSessionId);
	const liveAgents: Array<{ name: string; type: string; status: string }> = [];
	const unreadResults: Array<{ name: string; status: string; firstLine: string }> = [];
	for (const record of [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		// The fold reports an unsettled record as `lost` because no live session
		// answers for it in a fresh process; here the process is the same one,
		// so what the file says (queued/running) is what the block says.
		const live = liveStatusOf(entries, record);
		if (live !== undefined) liveAgents.push({ name: record.name, type: record.type, status: live });
		else if (agentIsSettled(record.status) && record.readBy === undefined) unreadResults.push({ name: record.name, status: record.status, firstLine: firstLineOf(record.result ?? record.error) });
	}
	return { liveAgents, unreadResults };
}

/** The persisted status of the record's latest run when it is queued or running. */
function liveStatusOf(entries: ReadonlyArray<SessionEntryShape>, record: AgentRecord): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY) continue;
		const parsed = parseAgentRecord(entry.data);
		if (parsed === undefined || parsed.name !== record.name || parsed.ownerSessionId !== record.ownerSessionId) continue;
		return agentIsSettled(parsed.status) ? undefined : parsed.status;
	}
	return undefined;
}

function firstLineOf(text: string | undefined): string {
	return (text ?? "").split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * The wording `lib/bash.ts` appends to a backgrounded command's result:
 * "… as task N. Output continues at <path> — `read` it …". The task id and
 * log path are recovered from that sentence, which the kit owns.
 */
const BACKGROUNDED_RESULT = /as task (\d+)[.;].*?Output continues at (\S+) —/s;

/** The custom message type `extensions/bash.ts` sends when a background task ends (`lib/bash.ts`). */
const BACKGROUND_NOTIFICATION_TYPE = "background-task-notification";

/**
 * Background tasks started by the kit's `bash` tool and not reported finished:
 * the backgrounded results, minus those with a completion notification. The
 * command is the tool call's argument, read from the assistant message that
 * made the call.
 */
export function backgroundTasksFromEntries(entries: ReadonlyArray<SessionEntryShape>): HandoffFacts["backgroundTasks"] {
	const commands = new Map<string, string>();
	const started = new Map<number, { id: number; command: string; logPath: string }>();
	const finished = new Set<number>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content as ReadonlyArray<{ type?: string; id?: string; name?: string; arguments?: { command?: unknown } }>) {
				if (block?.type === "toolCall" && block.name === "bash" && typeof block.id === "string") commands.set(block.id, typeof block.arguments?.command === "string" ? block.arguments.command : "");
			}
			continue;
		}
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "bash") {
			// SAFETY: a tool result's content is pi's content block list; the reader only looks at text blocks and ignores any other shape.
			const match = BACKGROUNDED_RESULT.exec(messageText({ role: "toolResult", content: entry.message.content as AssistantMessageShape["content"] }));
			if (match === null) continue;
			const id = Number(match[1]);
			const toolCallId = (entry.message as { toolCallId?: unknown }).toolCallId;
			started.set(id, { id, command: typeof toolCallId === "string" ? (commands.get(toolCallId) ?? "") : "", logPath: match[2] ?? "" });
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === BACKGROUND_NOTIFICATION_TYPE) {
			const details = entry.details as { id?: unknown; stalled?: unknown } | undefined;
			if (typeof details?.id === "number" && details.stalled !== true) finished.add(details.id);
		}
	}
	return [...started.values()].filter((task) => !finished.has(task.id)).sort((a, b) => a.id - b.id);
}

/** Tool names that read a file, and those that change one, as the kit registers them. */
const READ_TOOLS = new Set(["read"]);
const CHANGE_TOOLS = new Set(["edit", "write", "multi_edit"]);

/** Files read and changed this session, as paths only, in first-seen order. Changed files are not repeated under read. */
export function filesFromEntries(entries: ReadonlyArray<SessionEntryShape>): Pick<HandoffFacts, "filesRead" | "filesChanged"> {
	const read = new Set<string>();
	const changed = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content as ReadonlyArray<{ type?: string; name?: string; arguments?: Record<string, unknown> }>) {
			if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
			const args = block.arguments ?? {};
			const paths: string[] = [];
			for (const key of ["path", "file_path"]) if (typeof args[key] === "string") paths.push(args[key] as string);
			if (Array.isArray(args.files)) for (const file of args.files as ReadonlyArray<{ path?: unknown }>) if (typeof file?.path === "string") paths.push(file.path);
			if (READ_TOOLS.has(block.name)) for (const p of paths) read.add(p);
			if (CHANGE_TOOLS.has(block.name)) for (const p of paths) changed.add(p);
		}
	}
	for (const p of changed) read.delete(p);
	return { filesRead: [...read], filesChanged: [...changed] };
}

/** The heading of the generated block, so the next context knows the harness wrote it. */
export const HANDOFF_BLOCK_HEADING = "## In flight (generated by the harness)";

/**
 * The generated block: one line per live agent, unread result and background
 * task; files as paths. Token-concise, no prose. Empty when
 * there is nothing to say, so a quiet session's handoff is the document alone.
 */
export function renderHandoffBlock(facts: HandoffFacts): string {
	const lines: string[] = [];
	for (const agent of facts.liveAgents) lines.push(`- agent ${agent.name} · ${agent.type} · ${agent.status}`);
	for (const result of facts.unreadResults) lines.push(`- unread result ${result.name} · ${result.status}${result.firstLine ? ` · ${result.firstLine}` : ""}`);
	for (const task of facts.backgroundTasks) lines.push(`- background task ${task.id}${task.command ? ` · ${task.command}` : ""} · log ${task.logPath}`);
	if (facts.filesChanged.length > 0) lines.push(`- files changed: ${facts.filesChanged.join(", ")}`);
	if (facts.filesRead.length > 0) lines.push(`- files read: ${facts.filesRead.join(", ")}`);
	if (lines.length === 0) return "";
	return `${HANDOFF_BLOCK_HEADING}\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// The handoff the harness writes for itself
// ---------------------------------------------------------------------------

/** The entry type the harness's own handoff is persisted under when the stop fires. */
export const GENERATED_HANDOFF_ENTRY = "handoff-generated";

/**
 * The handoff the harness writes when the model never did — the graceful half
 * of the stop. A partial, honest record beats silence: the session ends with a
 * document of the right shape, saying plainly which parts of it nobody can
 * know from outside the model's head. It carries no history of its own,
 * because the generated block that follows it is everything the harness has.
 */
export function generatedHandoff(input: { tokens: number; thresholds: Thresholds }): string {
	return [
		HANDOFF_HEADING,
		"## Intent",
		"Not recorded: the harness wrote this document, the model did not.",
		"## State",
		`The session was stopped at ${k(input.tokens)} tokens with no handoff written (stop at ${k(input.thresholds.stop)}). What was in flight is listed below; nothing else about this session is written down here.`,
		"## Next",
		"Read the old session before continuing — it holds the intent, the decisions and the state of the work. Then finish whatever the list below says is unfinished.",
		"## Open",
		"Everything the model knew and had not written down when the stop fired.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// What a stopped child leaves for its parent
// ---------------------------------------------------------------------------

/** What the ladder's stop leaves behind for a parent to read: why the child died, and what it recorded. */
export interface ContextStop {
	/** The context size the stop fired at. */
	readonly tokens: number;
	/** The threshold it crossed. */
	readonly stop: number;
	/** The handoff document reached the child's session file. */
	readonly recorded: boolean;
	/** The model wrote that document in its granted last turn; otherwise the harness did. */
	readonly byModel: boolean;
}

const CONTEXT_STOP_SEAM = "__piKitContextStops";

/**
 * child session id -> the stop that ended it.
 *
 * A child's ladder aborts the child's own run, and the only thing its parent
 * could see was pi's `aborted` — indistinguishable from a crash, and pointing
 * at nothing (ticket 51 §2). The child writes the fact here; the parent's
 * `#settle` reads it, names the cause and deletes the entry, which is the
 * whole of its lifetime: one writer, one reader, no eviction rule to get
 * wrong. Only a child seat writes one, because only a child has a settle to
 * read it.
 */
const contextStops = (): Map<string, ContextStop> => shared(CONTEXT_STOP_SEAM, () => new Map<string, ContextStop>());

/** Record that this session was stopped by the ladder, for its parent's settle. */
export function markContextStop(sessionId: string, stop: ContextStop): void {
	contextStops().set(sessionId, stop);
}

/** The ladder stop that ended this session, if one did. */
export function contextStopOf(sessionId: string): ContextStop | undefined {
	return contextStops().get(sessionId);
}

/** The parent has read it; the entry dies with the run it described. */
export function forgetContextStop(sessionId: string): void {
	contextStops().delete(sessionId);
}

/**
 * What the parent is told in place of `aborted`: the cause, the numbers, where
 * the record is, and that resuming this agent only stops it again — its
 * session is full, so `SendMessage` would spend one request to reach the same
 * limit. The way on is a fresh agent handed that file.
 */
export function contextStopError(stop: ContextStop, sessionFile: string | undefined): string {
	const where = sessionFile === undefined ? "its own session, which is not on disk" : `\`${sessionFile}\``;
	const record = stop.recorded
		? `${stop.byModel ? "Its own handoff" : "The harness's handoff of what it could see"} is the last \`${GENERATED_HANDOFF_ENTRY}\` entry of ${where}.`
		: `Nothing could be recorded; ${where} is the whole record.`;
	return `stopped at its context limit: ${k(stop.tokens)} tokens of a ${k(stop.stop)} stop. ${record} Do not resume it — that session is full and would stop again at its first turn; spawn a fresh agent and give it that file.`;
}

// ---------------------------------------------------------------------------
// The seat the handoff carries
// ---------------------------------------------------------------------------

/** The entry both sessions of a handoff write their seat in; `pi-recall <file> seat` reads it back. */
export const HANDOFF_SEAT_ENTRY = "handoff-seat";

/** A seat: the model it runs on as `provider/id`, and its thinking level. */
export interface SeatSnapshot {
	readonly model: string | null;
	readonly thinking: string;
}

/** One phrase naming a seat, for a warning or a recall line. */
export function seatText(seat: SeatSnapshot): string {
	return `${seat.model ?? "an unknown model"} at ${seat.thinking}`;
}

/**
 * What Joel is told when the continuation is not the seat it left. Naming both
 * seats is the whole point: on 2026-09-05 a handoff moved Opus at high onto
 * the default model at medium and said nothing, so every judgment after it was
 * made by a weaker reader than the one he chose (ticket 64).
 */
export function seatCarryWarning(input: { wanted: SeatSnapshot; got: SeatSnapshot; reason: string }): string {
	return `handoff: the continuation is not on the seat it left — it wanted ${seatText(input.wanted)} and runs on ${seatText(input.got)}: ${input.reason}.`;
}

// ---------------------------------------------------------------------------
// The first message of the new session
// ---------------------------------------------------------------------------

/**
 * "Continue session `<old file>`." then the document, then the generated
 * block, then one line on the way back to the raw history. This is the new
 * session's first user message — the only message on its first request, so
 * the cached system+tools prefix is read and only this is written.
 */
export function continueSessionMessage(input: { oldSessionFile: string; document: string; block: string; recallCommand: string }): string {
	const parts = [`Continue session \`${input.oldSessionFile}\`.`, input.document.trim()];
	if (input.block.trim() !== "") parts.push(input.block.trim());
	parts.push(`Earlier history: \`${input.recallCommand} ${input.oldSessionFile} list | grep <word> | show <n>\`.`);
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// What the new session file carries from the old one
// ---------------------------------------------------------------------------

/** One custom entry to append to the new session, in order. */
export interface CarriedEntry {
	readonly customType: string;
	readonly data: unknown;
}

/**
 * The custom entry type `extensions/session-mode.ts` persists its launch
 * choice under. Carried so the continuation keeps the run's cache policy
 * instead of asking the launch question again (the TTL is a property of the
 * run — ticket 10).
 */
export const CACHE_MODE_ENTRY = "cache-mode";

/**
 * The entries the new session starts with: every agent record this session
 * owns, rewritten to the new owner so the names resolve there (ticket 19,
 * open question 6 — a fork's inherited records are deliberately not its
 * own), in file order so latest-wins folds the same way; then the latest
 * cache-mode choice. Records owned by another session are not carried.
 */
export function carriedEntries(entries: ReadonlyArray<SessionEntryShape>, oldOwnerSessionId: string, newOwnerSessionId: string): CarriedEntry[] {
	const carried: CarriedEntry[] = [];
	let cacheMode: CarriedEntry | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === AGENT_RECORD_ENTRY) {
			const record = parseAgentRecord(entry.data);
			if (record === undefined || record.ownerSessionId !== oldOwnerSessionId) continue;
			carried.push({ customType: AGENT_RECORD_ENTRY, data: { ...record, ownerSessionId: newOwnerSessionId } });
		} else if (entry.customType === CACHE_MODE_ENTRY) {
			cacheMode = { customType: CACHE_MODE_ENTRY, data: entry.data };
		}
	}
	if (cacheMode !== undefined) carried.push(cacheMode);
	return carried;
}
