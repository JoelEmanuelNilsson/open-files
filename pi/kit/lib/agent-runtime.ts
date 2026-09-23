/**
 * The agent runtime: one per seat, the thing every agent tool calls into.
 *
 * It starts children as in-process pi sessions (`createAgentSession`, ticket
 * 05), keeps the registry (`lib/agent-registry.ts`) current in the seat's
 * session file, emits the four `subagents:*` events the dock reads, waits
 * with yield-on-input (`lib/agent-wait.ts`), and delivers results exactly
 * once (C7) through {@link AgentRuntime.publishSettled}, the process's only
 * delivery site.
 *
 * One kind of child (C3, as amended by ticket 29 §3): its own session, its
 * parent's owned prompt bytes (or its type's body), the role tail in its
 * first user message, any model.
 *
 * A child is done when its session is idle *and* it owns no live agents: a
 * lead that has started workers and gone quiet is waiting, not finished.
 * Every finished child then delivers to its seat (ticket 09, ruled
 * 2026-09-04), so the loop terminates with or without a Joel to type.
 *
 * Resume-by-name (C2, Claude Code's "a send resumes it from its transcript"):
 * the child's session file is reopened and prompted again, a new run under
 * the same name with a fresh task id. Latest wins on name reuse.
 *
 * **The assumption everything here rests on** (38's review asked for it in
 * writing): *the process is exactly one seat's lifetime* — wide enough that
 * every child runs in-process, and short enough that no seam needs an
 * eviction policy. The width is real: children are in-process pi sessions, so
 * a `globalThis` map is the only place a fact can cross the module registry
 * each session's loader creates (`lib/agent-live-count.ts`). The shortness is
 * an assumption, and it is only safe because every seam entry now has a
 * counterpart that runs on a session event rather than on a clock: a live
 * mark ends at {@link AgentRuntime.publishSettled}, a runtime publication at
 * `session_shutdown` (`forgetAgentRuntime`), a detached runtime at its attach or
 * its own deadline, a stopper at the settle, a child seat and a context stop
 * at the settle that reads them. The one deliberate exception is
 * `__piKitAgentNameCounters`: it must outlive every session in the process,
 * because that is what makes a name unique across the whole agent tree.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionCommandContextActions, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { type AgentSessionRuntime, createAgentSession, createAgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_NOTIFICATION_TYPE } from "./agent-notification.ts";
import { forgetSessionStopping, isSessionStopping, liveAgentCount, liveAgentsOf, markAgentLive, markAgentSettled, markSessionStopping, watchLiveAgentsOf } from "./agent-live-count.ts";
import { AgentRegistry, type AgentReadBy, type AgentRecord, type AgentStatus, type StopCause, agentIsSettled, agentNameOf } from "./agent-registry.ts";
import { type AgentFilesMode, type AgentRole, renderChildFirstMessage } from "./agent-role-tails.ts";
import { ADVISOR_AGENT_TYPE, ADVISOR_MAIN_THREAD_ONLY, AGENT_DEPTH_CAP, DEFAULT_AGENT_TYPE, DELIVERED_RESULT_INSTRUCTION, DEPTH_LIMIT_ERROR, EXPLORE_AGENT_TYPE, thinkingLevelError } from "./agent-tool-text.ts";
import { contextStopError, contextStopOf, forgetContextStop, handoffDocumentOf } from "./continue-session.ts";
import { type AgentType, CHILD_THINKING, isAgentThinkingLevel } from "./agent-types.ts";
import type { AgentWaitBoard, AgentWaitOutcome } from "./agent-wait.ts";
import { type AgentWorktree, type AgentWorktreeSettlement, createAgentWorktree, settleAgentWorktree, type WorktreeExec, worktreeReportLine } from "./agent-worktree.ts";
import { childSeatOf, declareChildSeat, type EngineChildSeat, forgetChildSeat, seatCarriesWorkflows } from "./seat.ts";
import { shared } from "./shared.ts";
import { toolActivityLine } from "./tool-activity-line.ts";

/** After the wrap-up steer at `max_turns`, how many more turns before the run is stopped. */
const MAX_TURNS_GRACE = 2;

/**
 * The channel a running child's progress goes out on: tool count and the
 * moment of its last step, which live in `LiveRun` memory and reach the record
 * only at settle. Without it a running dock row can only say `running`, and a
 * wedged child looks exactly like a working one.
 */
export const AGENT_PROGRESS_CHANNEL = "subagents:progress";

/** Floor between two progress emissions, so a streaming child does not flood the bus. */
const PROGRESS_MIN_INTERVAL_MS = 1000;

/** How often a runner re-checks a quiet child for live descendants, as a backstop to the wake. */
const QUIET_POLL_MS = 5000;

/** The wrap-up steer, the vendor's wording. */
const WRAP_UP_STEER = "You have reached your turn limit. Wrap up immediately — provide your final answer now.";

/**
 * A child that wrote a handoff document (map C23) is about to replace its
 * session; this is how long the runner waits for that switch to begin
 * before treating the idle child as finished. The continuation extension
 * asks for the switch one macrotask after the child settles.
 */
const HANDOFF_SWITCH_GRACE_MS = 3000;

/** After a child's session switch, how long to wait for the new session's first turn to start. */
const SWITCHED_SESSION_START_MS = 2000;

/**
 * A cold fan-out: N children launched in one message all miss the cache and
 * each writes the whole prefix. Every sibling past the first holds its *first
 * prompt* by one step — not its creation, so the dock shows it at once — so
 * one writes the prefix and the rest read it (issues/31 (i)).
 *
 * The batch is the runs that have not ended a turn yet, not every concurrent
 * run (38's finding 8): a child spawned an hour into a session, beside three
 * long-running ones, waited 3s for a prefix written an hour ago.
 */
const SIBLING_STAGGER_STEP_MS = 1000;

/** The stagger never grows past Claude Code's five seconds, however wide the fan-out. */
const SIBLING_STAGGER_CAP_MS = 5000;

/**
 * What the runtime needs that outlives any one session of the seat: nothing
 * here may reach a session's `pi` or `ctx`, because the runtime keeps these
 * across a handoff and pi invalidates both at the old session's shutdown.
 */
export interface AgentProcessDeps {
	readonly cwd: string;
	readonly agentDir: string;
	/** Run a command as this process, never through `pi.exec`, which goes stale with its session. */
	readonly exec: WorktreeExec;
	/** Build a child's resource loader. Production loads the seat's extensions minus the vendor. */
	readonly childLoader: (options: { cwd: string; systemPrompt: string | undefined }) => Promise<ResourceLoader>;
	readonly now?: () => number;
	/** Injected so the sibling stagger is scripted in a test rather than slept through. */
	readonly sleep?: (ms: number) => Promise<void>;
	readonly waitBoard: AgentWaitBoard;
}

/** One session of the seat, as the runtime reaches it: valid from that session's start until its shutdown handlers return. */
export interface SeatPort {
	readonly sessionId: string;
	/** The seat's session file, for a child's `parentSession`. Undefined in memory. */
	readonly sessionFile: string | undefined;
	/** Where the seat's sessions live; children are filed there too, so `/resume` nests them. */
	readonly sessionDir: string;
	/** 0 on the main seat. */
	readonly depth: number;
	readonly role: "main" | AgentRole;
	/**
	 * The agent types this session read at its start. A port fact, not a process
	 * one (a deviation from the design's deps): each session rereads the type
	 * files, and its `Agent` description lists what it read, so after a handoff
	 * a type added meanwhile must be spawnable, not "Unknown subagent_type".
	 */
	readonly types: readonly AgentType[];
	/** Append a record to this session's file. */
	readonly persist: (record: AgentRecord) => void;
	readonly emit: (channel: string, payload: unknown) => void;
	/** Put a notification in this seat's conversation: a turn of its own when idle, appended to the turn in flight otherwise; false when no turn may start, and the result stays unread. */
	readonly deliver: (notification: AgentNotification) => boolean;
	readonly log: (message: string, level: "info" | "warning" | "error") => void;
	readonly hasPendingInput: () => boolean;
	readonly model: () => Model<Api> | undefined;
	/** Resolve an alias (`luna`) or id (`openai-codex/gpt-6-luna`) to an enabled model; throws {@link AgentSpawnRefused} when two providers carry the family. */
	readonly resolveModel: (spec: string) => Model<Api> | undefined;
	/**
	 * This session's model runtime, shared with the children it spawns. A port
	 * fact, not a process one: pi builds a new `ModelRuntime` for every session
	 * it creates (`createAgentSessionServices` unless one is passed in), so the
	 * next session's providers live in a different one.
	 */
	readonly modelRuntime: unknown;
}

/** A port's plain facts: what a detached runtime still knows about the session it left. */
type SeatFacts = Pick<SeatPort, "sessionId" | "sessionFile" | "sessionDir" | "depth" | "role">;

/**
 * The runtime's one tie to a session. `attached`: every write, event, delivery
 * and log goes to the port. `detached` (a handoff in flight): records and logs
 * are held for the session that attaches, events are dropped, nothing is
 * delivered. `retired`: no session will own the runs again, and nothing goes
 * anywhere; the facts stay so a late settle can still clear its marks.
 */
type SeatLink =
	| { readonly state: "attached"; readonly port: SeatPort }
	| { readonly state: "detached"; readonly facts: SeatFacts; readonly pending: Map<string, AgentRecord>; readonly logs: [string, "info" | "warning" | "error"][] }
	| { readonly state: "retired"; readonly facts: SeatFacts };

/** How long {@link AgentRuntime.retire} waits for aborted runs to settle on their own. */
const RETIRE_BOUND_MS = 2000;

/** The seat as a run started outside the runtime sees it; every member goes through the runtime's link. */
export interface LinkedSeat {
	readonly sessionId: string;
	readonly cwd: string;
	readonly depth: number;
	/** Throws while no session is attached. */
	model(): Model<Api> | undefined;
	emit(channel: string, payload: unknown): void;
	log(message: string, level: "info" | "warning" | "error"): void;
}

/** One result, as the parent's conversation receives it. */
export interface AgentNotification {
	readonly content: string;
	/** Always present: a notification the row renderer cannot draw falls back to pi's text box, which shows the seat's internal XML on screen. */
	readonly details: AgentNotificationDetails;
}

/** `agent-rows`' `SubagentNotificationDetails`, plus the agent's name. */
export interface AgentNotificationDetails {
	id: string;
	name: string;
	description: string;
	status: string;
	toolUses: number;
	totalTokens: number;
	outputTokens: number;
	totalCost: number;
	durationMs: number;
	/** How long this result sat between settling and reaching a reader. */
	waitedMs: number;
	error?: string;
	resultPreview?: string;
	others?: AgentNotificationDetails[];
}

/** What `Agent` accepts, after the tool's schema. */
export interface SpawnRequest {
	readonly description: string;
	readonly prompt: string;
	readonly subagentType?: string;
	readonly name?: string;
	readonly model?: string;
	readonly isolation?: "worktree";
	readonly maxTurns?: number;
	readonly toolCallId?: string;
	/** Unparsed: the spawn refuses anything outside `AGENT_THINKING_LEVELS`. */
	readonly thinking?: string;
	/**
	 * A workflow's child (ticket 23): the tail says its reply is a program's
	 * return value, and the result is consumed by the workflow — never
	 * delivered to this seat's conversation and never waking it.
	 */
	readonly workflowChild?: boolean;
	/** Called as the engine sends the child its first prompt, after every hold: the moment the child starts acting on the world. */
	readonly onFirstPrompt?: () => void;
}


/** Expected spawn failures, as values. */
export class AgentSpawnRefused extends Error {
	readonly _tag = "AgentSpawnRefused" as const;
	constructor(
		readonly reason: "depth" | "unknown-type" | "no-model" | "worktree" | "thinking" | "main-thread-only" | "retiring",
		message: string,
	) {
		super(message);
	}
}

/** The live half of a record: the session and what the runner learned. */
interface LiveRun {
	/** The record this run is the live half of; `#runs` is keyed by it. */
	readonly taskId: string;
	/** The child's current session: replaced in place when the child hands off (C18). */
	session: AgentSession;
	/** pi's own session-replacement flow, so `ctx.newSession` works on a child seat. */
	readonly sessionRuntime: AgentSessionRuntime;
	readonly worktree: AgentWorktree | undefined;
	/** Ends the stagger a run holds its first prompt for, so a stop never waits on that timer. */
	stopSignal: (() => void) | undefined;
	/** Until this run has ended a turn it is still in its launch batch, racing to write the cache prefix. */
	firstTurnDone: boolean;
	/** The child's last message was a handoff document; a session switch is expected. */
	handoffPending: boolean;
	/** A session switch is in progress: the child is not done while this holds. */
	switching: boolean;
	/** Wakes the quiet loop when `handoffPending` or `switching` changes. */
	switchWatchers: Set<() => void>;
	/** The result is read by its spawner (a workflow), not by this seat's conversation. */
	silent: boolean;
	interruptWith: string | undefined;
	lastText: string;
	toolUses: number;
	costUsd: number;
	/** The last message's billed total: the context the child ended up carrying. */
	totalTokens: number;
	/** Every message's output side, summed: what the child wrote. */
	outputTokens: number;
	turns: number;
	wrapUpSent: boolean;
	/** Resolves once the run has settled and its record is final. */
	done: Promise<void>;
	/**
	 * `stopping` once a stop was asked while it ran: it is still live, and it
	 * settles `stopped`.
	 * `settling` from the first step of its settle, which awaits the worktree:
	 * from then on no message enters the run and no stop is written onto it, and
	 * its outcome is fixed, so the bound writes the same outcome the settle would.
	 * `settled` once that settle has written the final record; `cut off` when
	 * {@link AgentRuntime.retire} wrote it at the bound instead.
	 */
	phase: { readonly at: "running" } | { readonly at: "stopping" } | { readonly at: "settling"; readonly outcome: RunOutcome } | { readonly at: "settled" } | { readonly at: "cut off" };
}

/** Running or stopping: its child has not ended, so a stop or a message still reaches it. */
function runIsLive(run: LiveRun): boolean {
	return run.phase.at === "running" || run.phase.at === "stopping";
}

interface RunOutcome {
	readonly status: AgentStatus;
	readonly error: string | undefined;
	/** The child's report, without the worktree line the settle adds once the worktree is settled. */
	readonly result: string | undefined;
	readonly stoppedBy: "context" | undefined;
}

/** The last non-empty assistant text of a session, for a stopped run's partial result. */
function lastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/**
 * Everything the child wrote after its last tool call, in order.
 *
 * The window closes at the last tool call and at the last thing the child was
 * *asked*, so it holds the answer to that question and nothing written before
 * more work happened — a resumed run never drags the report it already
 * delivered along with its new answer. A result delivered to the child does not
 * close it: a child answering one of its own children after writing its report
 * is exactly how the report stopped being the last message (ticket 57).
 */
function closingTexts(session: AgentSession): string[] {
	const texts: string[] = [];
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role === "custom") continue;
		if (message?.role !== "assistant") break;
		if (message.content.some((block) => block.type === "toolCall")) break;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) texts.unshift(text);
	}
	return texts;
}

/** Said at the end of a report the child did not end with, so the seat knows why it has two messages. */
export const SIGN_OFF_NOTE = "[report taken from the message before the sign-off]";

/**
 * What a child delivers: everything it wrote in its closing breath, not only
 * its last message.
 *
 * A worker wrote its report and then signed off — "that data was already in the
 * report above" — and the sign-off alone was delivered, because the seam takes
 * the last assistant text (ticket 57). Nothing ran between the two, so both are
 * the answer to the same question and both go. A length threshold would have to
 * guess: measured over this machine's sessions, real reports run from 137
 * characters up, so no number tells a short report from a sign-off. The
 * relation does — a closing message shorter than one the child already wrote in
 * the same breath is not the report.
 */
export function childReport(session: AgentSession, lastText: string): string | undefined {
	const closing = closingTexts(session);
	const tail = lastText || closing[closing.length - 1] || lastAssistantText(session);
	if (tail === "") return undefined;
	if (closing[closing.length - 1] !== tail) return tail;
	if (!closing.some((text) => text.length > tail.length)) return tail;
	return [...closing, SIGN_OFF_NOTE].join("\n\n");
}

/**
 * The most of a child's report that reaches the seat that spawned it. A
 * report written to its shape is a few hundred characters (C27: a worker is
 * ≤8 lines), so this only ever cuts a runaway one — and a runaway one is the
 * jump the handoff ladder cannot survive: a single delivery can cross the
 * gate and the stop together, and then no turn exists in which to write a
 * handoff. Every other large input the harness owns is already bounded (bash
 * output, a file read); this was the one that was not.
 */
export const MAX_REPORT_CHARS = 20_000;

/** A child's report, bounded, saying where the whole of it can still be read. */
export function boundReport(text: string | undefined, sessionFile: string | undefined): string | undefined {
	if (text === undefined || text.length <= MAX_REPORT_CHARS) return text;
	const where = sessionFile === undefined ? "the agent's own session" : `\`${sessionFile}\``;
	return `${text.slice(0, MAX_REPORT_CHARS)}\n\n[report truncated: ${text.length} characters, ${MAX_REPORT_CHARS} kept. The whole of it is the last assistant message of ${where}.]`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Claude Code's `<task-notification>` shape; the result whole (C7).
 *
 * A transcript is not a clock: a seat asked "how late was this?" has no source
 * but where the message sits among other messages, and on 2026-09-05 one
 * guessed "an hour" for a gap under two minutes. So a delivery that lands where
 * it is rendered — a tool result, a turn's own message — carries one relative
 * number, which needs no clock to read. A delivery handed to pi's queue cannot:
 * its text is frozen at hand-off and the turn in flight decides when it lands,
 * so it says when it settled and when it was queued, both true whenever they
 * are read. `read-at` is the seat's present, stamped where the text enters the
 * conversation: it is what lets a reader date the frozen deliveries already
 * above it in the transcript, which carry no clock of their own (ticket 60).
 * `session-file` rides every delivery, not only a truncated one, so no tool
 * ever has to tell a model to scroll back for the whole of a result.
 */
export function renderTaskNotification(record: AgentRecord, now: number, by: AgentReadBy): string {
	const duration = record.completedAt !== undefined ? record.completedAt - record.startedAt : 0;
	return [
		"<task-notification>",
		`<task-id>${escapeXml(record.taskId)}</task-id>`,
		`<agent-name>${escapeXml(record.name)}</agent-name>`,
		record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
		`<status>${record.status}</status>`,
		`<summary>Agent "${escapeXml(record.description)}" ${record.status}${record.error ? `: ${escapeXml(record.error)}` : ""}</summary>`,
		record.sessionFile !== undefined ? `<session-file>${escapeXml(record.sessionFile)}</session-file>` : null,
		record.completedAt !== undefined ? `<settled-at>${new Date(record.completedAt).toISOString()}</settled-at>` : null,
		by === "handed" ? `<queued-at>${new Date(now).toISOString()}</queued-at>` : `<read-at>${new Date(now).toISOString()}</read-at>`,
		by !== "handed" && record.completedAt !== undefined ? `<settled-ago>${formatWaited(waitedMsOf(record, now))} before you read this</settled-ago>` : null,
		`<result>${escapeXml(record.result ?? "No output.")}</result>`,
		`<usage><total_tokens>${record.totalTokens}</total_tokens><output_tokens>${record.outputTokens}</output_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${duration}</duration_ms></usage>`,
		"</task-notification>",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

/** How long this result waited between settling and reaching a reader. */
function waitedMsOf(record: AgentRecord, now: number): number {
	return record.completedAt === undefined ? 0 : Math.max(0, now - record.completedAt);
}

/** A wait, as a reader reads it: seconds under a minute, then minutes and seconds. */
function formatWaited(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function notificationDetails(record: AgentRecord, now: number): AgentNotificationDetails {
	return {
		id: record.taskId,
		name: record.name,
		description: record.description,
		status: record.status,
		toolUses: record.toolUses,
		totalTokens: record.totalTokens,
		outputTokens: record.outputTokens,
		totalCost: record.costUsd,
		durationMs: record.completedAt !== undefined ? record.completedAt - record.startedAt : 0,
		waitedMs: waitedMsOf(record, now),
		...(record.error !== undefined ? { error: record.error } : {}),
		...(record.result !== undefined ? { resultPreview: record.result.length > 300 ? `${record.result.slice(0, 300)}…` : record.result } : {}),
	};
}

/** One message carrying every result in `records`, for a turn to read at once. */
export function batchNotification(records: readonly AgentRecord[], now: number, by: AgentReadBy): AgentNotification {
	const [first, ...rest] = records;
	if (first === undefined) throw new Error("batchNotification: no records");
	const details = notificationDetails(first, now);
	if (rest.length > 0) details.others = rest.map((record) => notificationDetails(record, now));
	const body = records.map((record) => renderTaskNotification(record, now, by)).join("\n\n");
	const header = records.length === 1 ? "" : `${records.length} agents finished.\n\n`;
	// The instruction rides every delivery, not just the ones that start a turn:
	// the failure it prevents — summarising the result back, re-reading what the
	// child read — is the same wherever the text lands (ticket 09).
	return { content: `${header}${body}\n\n${DELIVERED_RESULT_INSTRUCTION}`, details };
}

/**
 * A task id: `a` and twelve hex, one minter for the process.
 *
 * `Math.random().toString(16).slice(2, 10)` was **variable length** — a draw of
 * `0.5` renders `"a8"` — over ~32 bits of non-crypto entropy, in a keyspace
 * that is `globalThis`-wide (`descendantStoppers`).
 */
export function shortId(): string {
	return `a${randomBytes(6).toString("hex")}`;
}

/** Resolves when the session starts an agent run, or after `ms` if it never does. */
function firstRunStarted(session: AgentSession, ms: number): Promise<void> {
	if (session.isStreaming) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(finish, ms);
		(timer as { unref?: () => void }).unref?.();
		const off = session.subscribe((event) => {
			if (event.type === "agent_start") finish();
		});
		function finish() {
			clearTimeout(timer);
			off();
			resolve();
		}
	});
}

/** The dock's `subagents:*` payloads (ticket 05 §6): `status`, never `outcome`. */
function lifecyclePayload(record: AgentRecord): Record<string, unknown> {
	return {
		id: record.taskId,
		name: record.name,
		type: record.type,
		description: record.description,
		// The row's model column. It is settled at spawn and never changes, so it
		// rides every event rather than being looked up: the dock knows the model
		// from `subagents:created` onward, with nothing to poll and nothing to miss.
		model: record.model,
		// A workflow's agent reports through its run, not through the seat: the
		// dock keeps it out of the top-level list and out of the count, and shows
		// it inside the run's own view. Without this flag on the wire the list
		// floods with twenty rows the seat is not waiting on.
		workflowChild: record.workflowChild,
		status: record.status,
		toolUses: record.toolUses,
		durationMs: record.completedAt !== undefined ? record.completedAt - record.startedAt : 0,
		...(record.result !== undefined ? { result: record.result } : {}),
		...(record.error !== undefined ? { error: record.error } : {}),
		usage: { cost: { total: record.costUsd } },
	};
}

/** What a {@link AgentRuntime.watchProgress} watcher is told: tokens streamed, a turn ended, or a tool call started or ended, by call id. */
export type AgentProgressEvent = { readonly type: "message_update" | "turn_end" } | { readonly type: "tool_execution_start" | "tool_execution_end"; readonly toolCallId: string };

/**
 * The runtime. Construct one per seat with the records read back from the
 * session file; every tool then goes through these methods.
 */
export class AgentRuntime {
	/** The seat's registry, an index in memory whose every write goes through the link; replaced by {@link attach} with the claiming session's. */
	registry: AgentRegistry;
	readonly waits: AgentWaitBoard;
	/**
	 * The seat as a run started outside this class sees it: a workflow (ticket
	 * 23) reads `model()`, `depth`, `cwd` and `emit` here. Every member goes
	 * through the link, so no holder keeps a session's closures past its shutdown.
	 *
	 * The seam for a second kind of in-process run: a workflow orchestrator whose
	 * progress, notify and run store go through this link can attach to it without
	 * touching engine internals. Follow-up: workflow runs carry across a handoff
	 * via the runtime's link, pending feat/workflow-parity.
	 */
	readonly host: LinkedSeat;
	readonly #deps: AgentProcessDeps;
	#link: SeatLink;
	readonly #runs = new Map<string, LiveRun>();
	/** Keyed by task id, so a watcher survives the run's session being replaced. */
	readonly #progressWatchers = new Map<string, Set<(event: AgentProgressEvent) => void>>();
	/**
	 * The waits in flight right now, each holding the names it will consume
	 * (`undefined`: any name). A settle whose name is claimed leaves its result
	 * unread for the wait to return — see {@link #claimed}.
	 */
	readonly #claims = new Set<{ readonly names: ReadonlySet<string> | undefined }>();
	/** Spawns and resumes that have not reached `#start` yet, for {@link retire} to wait on. */
	readonly #starting = new Set<Promise<unknown>>();
	/** Set once {@link retire} begins: every run that starts after it starts stopped, by this cause. */
	#retiring: StopCause | undefined;

	constructor(deps: AgentProcessDeps, port: SeatPort, records: Iterable<AgentRecord>) {
		this.#deps = deps;
		this.#link = { state: "attached", port };
		this.registry = new AgentRegistry((record) => this.#persist(record), records);
		this.waits = deps.waitBoard;
		const facts = () => this.#facts();
		this.host = {
			get sessionId() {
				return facts().sessionId;
			},
			get depth() {
				return facts().depth;
			},
			cwd: deps.cwd,
			model: () => this.#port("the seat's model").model(),
			emit: (channel, payload) => this.#emit(channel, payload),
			log: (message, level) => this.#log(message, level),
		};
	}

	#facts(): SeatFacts {
		const link = this.#link;
		if (link.state !== "attached") return link.facts;
		const { sessionId, sessionFile, sessionDir, depth, role } = link.port;
		return { sessionId, sessionFile, sessionDir, depth, role };
	}

	/** The attached session's port; refuses, naming `what`, while none is attached. */
	#port(what: string): SeatPort {
		const link = this.#link;
		if (link.state === "attached") return link.port;
		const why = link.state === "detached" ? "is detached for a session replacement" : "is retired";
		throw new Error(`agent runtime of session ${link.facts.sessionId} ${why}: ${what} needs a session attached`);
	}

	#persist(record: AgentRecord): void {
		const link = this.#link;
		if (link.state === "attached") link.port.persist(record);
		else if (link.state === "detached") link.pending.set(record.taskId, record);
	}

	/** Dropped unless attached: {@link attach} announces every carried run to the new dock. */
	#emit(channel: string, payload: unknown): void {
		const link = this.#link;
		if (link.state === "attached") link.port.emit(channel, payload);
	}

	/** False unless attached, so the result stays unread for the next session's first turn. */
	#deliver(notification: AgentNotification): boolean {
		const link = this.#link;
		return link.state === "attached" && link.port.deliver(notification);
	}

	#log(message: string, level: "info" | "warning" | "error"): void {
		const link = this.#link;
		if (link.state === "attached") link.port.log(message, level);
		else if (link.state === "detached") link.logs.push([message, level]);
	}

	/**
	 * The seat's session is being replaced by its continuation (a handoff, map
	 * C23): let go of its port. pi invalidates the outgoing session's `pi` and
	 * `ctx` once the shutdown handlers return, and a child still streaming kept
	 * calling them (2026-09-23: `host.emit` ← `publishProgress` threw "extension
	 * ctx is stale" and killed the run). Until {@link attach} or {@link retire},
	 * writes and logs are held, events are dropped, and a settle leaves its
	 * result unread. `lib/agent-runtime-handover.ts` owns the claim deadline.
	 *
	 * Stated limit: a quit while detached, before the continuation attaches,
	 * writes nothing — the held writes go with the process — so the old file's
	 * runs keep their last records and read `lost`.
	 */
	detach(): void {
		if (this.#link.state !== "attached") return;
		this.#link = { state: "detached", facts: this.#facts(), pending: new Map(), logs: [] };
	}

	/**
	 * Follow the seat into the session that continues it (map C23): the runs
	 * stay live and settle into the new session's registry and file. What was
	 * written while detached is replayed as written — a run that settled then
	 * lands terminal, unread, and the new dock is told its verdict. The live
	 * marks move to the new owner; a carried copy the fold read as `lost`,
	 * because a file alone cannot know the process still holds the run, goes
	 * back to `running`; and the dock is told about each live run as if it had
	 * just started. A run whose record the new registry does not hold is
	 * stopped — nobody would read its result. Stated limit: only writes for task
	 * ids the new registry already holds are replayed, so a run the handoff did
	 * not carry is never adopted by its own write.
	 *
	 * What moves is read off the **live seam**, not off `#runs`, because `#runs`
	 * is only the runs this class drives: a workflow's run (ticket 23) is in the
	 * same registry and the same stopper map but has no `LiveRun` here, and
	 * walking `#runs` left its mark under the dead session id — invisible to
	 * `liveAgentsOf` and unreachable by the stop cascade (38's finding 2). The
	 * invariant is *a live run is reachable from its owner session*, and the seam
	 * is the one place that knows what is live.
	 */
	attach(port: SeatPort, carried: Iterable<AgentRecord>): void {
		const link = this.#link;
		if (link.state !== "detached") throw new Error(`agent runtime of session ${this.#facts().sessionId} is ${link.state}: only a detached runtime can be attached`);
		const previous = link.facts.sessionId;
		this.#link = { state: "attached", port };
		const registry = new AgentRegistry((record) => this.#persist(record), carried);
		this.registry = registry;
		// Writes made while detached are newer than the copies the handoff carried.
		for (const record of link.pending.values()) {
			if (registry.byTaskId(record.taskId) === undefined) continue;
			const stored = registry.put({ ...record, ownerSessionId: port.sessionId });
			if (!agentIsSettled(stored.status)) continue;
			port.emit("subagents:created", lifecyclePayload(stored));
			port.emit(stored.status === "completed" ? "subagents:completed" : "subagents:failed", lifecyclePayload(stored));
		}
		for (const [message, level] of link.logs) port.log(message, level);
		for (const taskId of [...liveAgentsOf(previous)]) {
			const record = registry.byTaskId(taskId);
			markAgentSettled(previous, taskId);
			const run = this.#runs.get(taskId);
			if (record === undefined || run?.phase.at === "stopping") {
				// Not awaited: pi's abort waits for idle, and a child that ignores it would hold this session's start forever.
				if (run !== undefined) {
					this.#markStopping(run, "orphaned");
					void run.session.abort().catch(() => {});
				} else {
					// A foreign run — a workflow's — stops through the map it registered in.
					void descendantStoppers().get(taskId)?.().catch(() => {});
				}
				continue;
			}
			markAgentLive(port.sessionId, taskId);
			const live = record.status === "lost" ? registry.put({ ...record, status: "running" }) : record;
			port.emit("subagents:created", lifecyclePayload(live));
			port.emit("subagents:started", lifecyclePayload(live));
		}
	}

	/**
	 * No session will own these runs again: stop them, then let go of the
	 * session. Awaited in the seat's shutdown handler at quit, `/new`, resume,
	 * fork and reload, while the port can still write; also called when a
	 * detached runtime's claim deadline passes.
	 *
	 * Each run is aborted and settles on the normal path, so the file reads
	 * `stopped` with its final cost and its worktree outcome; a spawn or resume
	 * in flight starts its run already stopping, and is waited for too, while one
	 * that begins after this call is refused. A run is finished only once its
	 * own settle has written. The wait is bounded at
	 * {@link RETIRE_BOUND_MS} because pi's abort waits for the session to go
	 * idle, which a child that ignores the abort never does. Stated limit: a run
	 * still unfinished at the bound delays quit by the bound. One whose child had
	 * ended (its worktree removal ran long) is written with the outcome its settle
	 * fixed; one whose child never ended is written `stopped` with the cost
	 * counted so far. Either way its worktree outcome is not recorded, and its
	 * own late settle writes nothing. A spawn still in flight at the bound (a
	 * slow child loader, say) starts its run stopped after the link has retired:
	 * the child never prompts and its worktree is settled, but its record stays
	 * `queued` in the file and reads `lost`. Retired from detached, everything the
	 * settles write is dropped with the held writes: the session they belonged
	 * to is gone.
	 */
	async retire(by: StopCause): Promise<void> {
		if (this.#retiring !== undefined) return;
		this.#retiring = by;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, RETIRE_BOUND_MS);
		});
		// A foreign run (a workflow's) is stopped first, through the map it registered in: its stopper ends it before any child of it settles, so no child reads as dead.
		const foreign = [...liveAgentsOf(this.#facts().sessionId)].filter((taskId) => !this.#runs.has(taskId)).map((taskId) => descendantStoppers().get(taskId)?.());
		void this.#stopEach(by).catch(() => {});
		// A spawn or resume in flight starts its run already stopping (`#start`); waited for, so that run settles on the normal path too.
		await Promise.race([Promise.allSettled([...this.#starting]), bound]);
		const runs = [...this.#runs.values()];
		await Promise.race([Promise.allSettled([...runs.map((run) => run.done), ...foreign]), bound]);
		clearTimeout(timer);
		for (const run of runs) {
			const phase = run.phase;
			if (phase.at === "settled") continue;
			run.phase = { at: "cut off" };
			if (this.#runs.get(run.taskId) === run) this.#runs.delete(run.taskId);
			descendantStoppers().delete(run.taskId);
			const record = this.registry.byTaskId(run.taskId);
			if (record === undefined) {
				markAgentSettled(this.#facts().sessionId, run.taskId);
				continue;
			}
			const outcome: RunOutcome =
				phase.at === "settling" ? phase.outcome : { status: "stopped", error: undefined, result: boundReport(childReport(run.session, run.lastText), record.sessionFile), stoppedBy: undefined };
			const ended = this.#endedRecord(record, run, outcome);
			this.publishSettled(this.registry.byName(record.name)?.taskId === record.taskId ? this.registry.put(ended) : ended);
		}
		this.#link = { state: "retired", facts: this.#facts() };
	}

	/** Task ids of the runs this runtime still holds live. */
	liveTaskIds(): string[] {
		return [...this.#runs.keys()];
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}

	#sleep(ms: number): Promise<void> {
		if (this.#deps.sleep !== undefined) return this.#deps.sleep(ms);
		return new Promise<void>((resolve) => {
			setTimeout(resolve, ms);
		});
	}

	/**
	 * How long this run holds its first prompt so a sibling writes the cache
	 * prefix and it reads one. Zero when this is the only child session the seat
	 * has in flight: a lone child never waits.
	 */
	#firstPromptDelayMs(): number {
		let batch = 0;
		for (const run of this.#runs.values()) if (!run.firstTurnDone) batch++;
		const siblings = batch - 1;
		return siblings > 0 ? Math.min(siblings * SIBLING_STAGGER_STEP_MS, SIBLING_STAGGER_CAP_MS) : 0;
	}

	/** Hold this run's first prompt for `ms`, or until it is told to stop. */
	async #stagger(run: LiveRun, ms: number): Promise<void> {
		await Promise.race([this.#sleep(ms), new Promise<void>((resolve) => (run.stopSignal = resolve))]);
		run.stopSignal = undefined;
	}

	/**
	 * Tell a run to stop: the flag every step checks, the end of any wait before
	 * its first prompt, and the name of whoever asked. `by` is required because
	 * the one time this mattered, the session file said `stopped` and nothing
	 * else, and five callers could each have written that (issues/31 (h)).
	 *
	 * It also says so on the screen as it happens: (h) is still open because the
	 * stop that killed two children on 2026-09-04 was found in the record hours
	 * later, with no way back to who pressed what. A live line makes the next one
	 * identify itself while Joel is watching.
	 */
	#markStopping(run: LiveRun, by: StopCause): void {
		// A settling run's outcome is decided: a stop written now would sit on a completed record.
		if (!runIsLive(run)) return;
		run.phase = { at: "stopping" };
		run.stopSignal?.();
		const name = this.registry.byTaskId(run.taskId)?.name;
		if (name !== undefined) this.registry.update(name, { stoppedBy: by });
		this.#log(`agent ${name ?? run.taskId}: stopping — asked by ${by}`, "info");
	}

	/** A live run's session, for tests and for the stop path. */
	liveRun(taskId: string): AgentSession | undefined {
		return this.#runs.get(taskId)?.session;
	}

	/** Call `onProgress` on each streamed delta, tool call start and end, and turn end of a live run; returns the unsubscribe. */
	watchProgress(taskId: string, onProgress: (event: AgentProgressEvent) => void): () => void {
		const watchers = this.#progressWatchers.get(taskId) ?? new Set<(event: AgentProgressEvent) => void>();
		this.#progressWatchers.set(taskId, watchers);
		watchers.add(onProgress);
		return () => {
			watchers.delete(onProgress);
			if (watchers.size === 0) this.#progressWatchers.delete(taskId);
		};
	}


	/**
	 * Is a wait in flight going to deliver this name's result?
	 *
	 * Without this the two deliveries raced and the caller lost: a wake marks
	 * the record read inside `#settle`, synchronously, before the wait that was
	 * blocked on that very name resumes — so `TaskOutput` drained nothing and
	 * said "Nothing to report" while `ListAgents` showed the fresh completion
	 * (observed 2026-09-03 under nested workers, where every headless parent
	 * wakes). A wait *is* the seat being awake for the result, so when one
	 * claims the name the wake stands down and the wait delivers it: exactly
	 * once (C7), to the caller that asked.
	 */
	#claimed(name: string): boolean {
		for (const claim of this.#claims) if (claim.names === undefined || claim.names.has(name)) return true;
		return false;
	}

	/**
	 * Records settled and not yet read, in the order they settled.
	 *
	 * A workflow's child is never in this queue, by its record rather than by a
	 * flag set at the right moment (38's finding 5): its result belongs to the
	 * spawner, which reads it through `registry.byTaskId`, and it never enters
	 * anyone's conversation.
	 */
	unread(): AgentRecord[] {
		return this.registry
			.all()
			.filter((record) => agentIsSettled(record.status) && record.readBy === undefined && record.status !== "lost" && !record.workflowChild)
			.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
	}

	/**
	 * Hand every unread result under `names` (all of them when `names` is
	 * undefined) to `hand` as one message, marked read while it runs and kept
	 * read only when it takes them. Undefined when nothing is unread.
	 *
	 * This is the engine's only path from unread to read (`AgentRegistry.update`
	 * cannot set `readBy`; `AgentRegistry.consume` is called from here), so a result
	 * cannot be consumed by a path that does not deliver it — the 2026-09-03
	 * shape where `TaskOutput` said "Nothing to report" while `ListAgents`
	 * showed the completion. A `hand` that throws or returns false leaves every
	 * record unread for the next reader: full result delivered once, never lost (C7).
	 *
	 * `by` is what the reader can honestly claim afterwards: `"tool"` when the
	 * text is in a tool result, `"handed"` when it has only been given to pi's
	 * message queue.
	 */
	takeUnread(names: readonly string[] | undefined, hand: (notification: AgentNotification) => boolean | void, by: AgentReadBy): AgentNotification | undefined {
		const records = this.unread().filter((record) => names === undefined || names.includes(record.name));
		return this.#take(records, hand, by);
	}

	/**
	 * What this seat's next turn carries, and the one place the harness learns
	 * whether a hand-off ever landed: `seen` answers whether a task's
	 * notification is in the session file.
	 *
	 * A `followUp` is appended at the *end* of the turn in flight, so between
	 * `port.deliver` and the text appearing there is a gap as long as the seat
	 * keeps working — and on 2026-09-05 a delivery crossed a whole turn while
	 * `TaskOutput` insisted it was already in the conversation. So a handed
	 * result is marked read only against what `seen` reports, and one that never
	 * arrived rides this turn instead, on the one path that provably lands.
	 *
	 * It is also the seat's only present: this runs where the queued text is
	 * read, so the notification it carries is stamped `read-at` — the clock a
	 * seat otherwise has no source for (ticket 60).
	 */
	takeForTurn(seen: (taskId: string) => boolean, hand: (notification: AgentNotification) => void): AgentNotification | undefined {
		const at = this.#now();
		const missing: AgentRecord[] = [];
		for (const record of this.registry.all()) {
			if (record.readBy !== "handed") continue;
			if (!seen(record.taskId)) {
				missing.push(record);
				continue;
			}
			this.registry.markHandedSeen(record.name, record.taskId, at);
		}
		const records = [...this.unread(), ...missing].sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
		return this.#take(records, hand, "conversation", at);
	}

	#take(records: readonly AgentRecord[], hand: (notification: AgentNotification) => boolean | void, by: AgentReadBy, when?: number): AgentNotification | undefined {
		const at = when ?? this.#now();
		if (records.length === 0) return undefined;
		const notification = batchNotification(records, at, by);
		return this.registry.consume(records, by, at, () => hand(notification)) ? notification : undefined;
	}

	/**
	 * This seat's own name first, then its ancestors' — read off the child-seat
	 * seam every seat in the process declares. Empty on the main seat, which
	 * has no name.
	 */
	#seatChain(): string[] {
		const names: string[] = [];
		let sessionId: string | undefined = this.#facts().sessionId;
		for (let hop = 0; hop <= AGENT_DEPTH_CAP && sessionId !== undefined; hop++) {
			const seat = childSeatOf(sessionId);
			if (seat === undefined) break;
			names.push(seat.name);
			sessionId = seat.parentSessionId;
		}
		return names;
	}

	/**
	 * A name must never mean the caller or one of its ancestors.
	 *
	 * On 2026-09-03 a seat called `worker-1` ran `TaskOutput ["worker-1"]` and
	 * was told "Still running: worker-1" — it had matched itself. Unique auto
	 * names make that collision impossible, but a caller can still *choose* an
	 * ancestor's name, so the ambiguity is refused where it would be created
	 * (the spawn) and where it would be read (address a name), with an error
	 * rather than a silent skip: a seat that thinks it is waiting for itself
	 * waits forever.
	 */
	/** Refuse any of `names` that means this seat or a seat above it. See {@link AgentAddressRefused}. */
	checkAddressable(names: readonly string[]): void {
		for (const name of names) this.#refuseSelfOrAncestor(name);
	}

	#refuseSelfOrAncestor(name: string): void {
		const [own, ...ancestors] = this.#seatChain();
		if (name === own) {
			throw new AgentAddressRefused("self", `"${name}" is this seat's own name: an agent can neither be named after you nor addressed as you. Run ListAgents to see the agents you started.`);
		}
		if (ancestors.includes(name)) {
			throw new AgentAddressRefused("ancestor", `"${name}" is a seat above you in the agent tree, not an agent you started. Run ListAgents to see the agents you started.`);
		}
	}

	// ---- spawn ------------------------------------------------------------------

	/** Start a child. Returns its record at `queued`; the run proceeds in the background. */
	spawn(request: SpawnRequest): Promise<AgentRecord> {
		return this.#tracked(this.#spawn(request));
	}

	#tracked<T>(starting: Promise<T>): Promise<T> {
		this.#starting.add(starting);
		const untrack = () => this.#starting.delete(starting);
		starting.then(untrack, untrack);
		return starting;
	}

	async #spawn(request: SpawnRequest): Promise<AgentRecord> {
		if (this.#retiring !== undefined) throw new AgentSpawnRefused("retiring", "The seat is shutting down: no agent can start now.");
		const port = this.#port("spawning an agent");
		if (port.depth >= AGENT_DEPTH_CAP) throw new AgentSpawnRefused("depth", DEPTH_LIMIT_ERROR);
		const typeName = request.subagentType ?? DEFAULT_AGENT_TYPE;
		if (typeName === ADVISOR_AGENT_TYPE && port.depth > 0) throw new AgentSpawnRefused("main-thread-only", ADVISOR_MAIN_THREAD_ONLY);
		const type = port.types.find((candidate) => candidate.name === typeName);
		if (type === undefined && typeName !== DEFAULT_AGENT_TYPE) {
			throw new AgentSpawnRefused("unknown-type", `Unknown subagent_type "${typeName}". Available: ${port.types.map((t) => t.name).join(", ") || "(none on disk)"}.`);
		}
		const role: AgentRole = typeName === "lead" ? "lead" : "worker";
		const model = this.#resolveChildModel(port, request.model ?? type?.model);
		if (model === undefined) throw new AgentSpawnRefused("no-model", `No model for agent type "${typeName}"${request.model ? ` (asked for "${request.model}")` : ""}. Enable one in settings or pick another.`);
		const asked = request.thinking ?? type?.thinking ?? this.#childThinking();
		if (!isAgentThinkingLevel(asked)) throw new AgentSpawnRefused("thinking", thinkingLevelError(asked));
		// A real level the model lacks is the model's limit: clamp to its level map,
		// as pi does for the main seat, so the record shows what the child runs at.
		const thinking: ThinkingLevel = clampThinkingLevel(model, asked);
		const name = agentNameOf(request.name) ?? this.registry.nextName(typeName);
		this.#refuseSelfOrAncestor(name);
		const depth = port.depth + 1;

		let worktree: AgentWorktree | undefined;
		if (request.isolation === "worktree") {
			try {
				worktree = await createAgentWorktree(this.#deps.exec, this.#deps.cwd, name);
			} catch (error) {
				throw new AgentSpawnRefused("worktree", error instanceof Error ? error.message : String(error));
			}
		}
		const cwd = worktree?.path ?? this.#deps.cwd;
		const files: AgentFilesMode = worktree ? { kind: "worktree", branch: worktree.branch, path: worktree.path } : { kind: "shared" };

		const sessionManager = SessionManager.create(cwd, port.sessionDir, port.sessionFile !== undefined ? { parentSession: port.sessionFile } : {});
		const childSessionId = sessionManager.getSessionId();
		const liveCount = liveAgentCount() + 1;
		const seat: EngineChildSeat = {
			name,
			role,
			depth,
			parentSessionId: port.sessionId,
			workflowChild: request.workflowChild === true,
			// Inherited, not re-decided: a child of a seat with no workflows has none.
			workflows: seatCarriesWorkflows(port.sessionId),
			prompt: type?.prompt ? { kind: "own" } : { kind: "inherit" },
		};
		declareChildSeat(childSessionId, seat);

		const record = this.registry.put({
			name,
			taskId: shortId(),
			ownerSessionId: this.#facts().sessionId,
			type: typeName,
			description: request.description,
			status: "queued",
			stoppedBy: undefined,
			depth,
			sessionFile: sessionManager.getSessionFile(),
			sessionId: childSessionId,
			cwd,
			branch: worktree?.branch,
			model: `${model.provider}/${model.id}`,
			thinking,
			result: undefined,
			error: undefined,
			readBy: undefined,
			readAt: undefined,
			toolUses: 0,
			costUsd: 0,
			totalTokens: 0,
			outputTokens: 0,
			startedAt: this.#now(),
			completedAt: undefined,
			toolCallId: request.toolCallId,
			workflowChild: request.workflowChild === true,
		});
		this.#emit("subagents:created", lifecyclePayload(record));
		markAgentLive(this.#facts().sessionId, record.taskId);

		const facts = { role, name, depth, liveCount, files, workflowChild: request.workflowChild === true };
		const firstMessage = renderChildFirstMessage(facts, request.prompt);
		const sessionRuntime = await this.#createChildRuntime({
			sessionManager,
			cwd,
			model,
			thinking,
			systemPrompt: type?.prompt ? type.prompt : undefined,
			seat,
			sessionName: `${name}#${record.taskId.slice(1, 7)}`,
			modelRuntime: port.modelRuntime,
		});
		await this.#start(record.name, sessionRuntime, worktree, firstMessage, request.maxTurns, request.onFirstPrompt);
		return this.registry.byName(name) ?? record;
	}

	/**
	 * A child's session under pi's own `AgentSessionRuntime`, so the child can
	 * replace its session the way the main seat does (`ctx.newSession`, map
	 * C18/C23). The factory runs once now and again at every replacement: a
	 * fresh loader (fresh extension instances), the seat declared under the
	 * new session id before its extensions start, the same model, thinking and
	 * prompt source, and the session named after the agent.
	 */
	async #createChildRuntime(spec: {
		sessionManager: SessionManager;
		cwd: string;
		model: Model<Api>;
		thinking: ThinkingLevel;
		systemPrompt: string | undefined;
		seat: EngineChildSeat;
		sessionName: string;
		/** The spawning session's: a child keeps the ModelRuntime of the session that spawned it, across its own replacements and its parent's. */
		modelRuntime: unknown;
	}): Promise<AgentSessionRuntime> {
		const { childLoader, agentDir } = this.#deps;
		const modelRuntime = spec.modelRuntime;
		return createAgentSessionRuntime(
			async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
				declareChildSeat(sessionManager.getSessionId(), spec.seat);
				const loader = await childLoader({ cwd, systemPrompt: spec.systemPrompt });
				const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
					cwd,
					agentDir,
					model: spec.model,
					thinkingLevel: spec.thinking,
					sessionManager,
					resourceLoader: loader,
					...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
					// SAFETY: pi types `modelRuntime` as its `ModelRuntime` class; the seat reads it off
					// `ctx.modelRegistry`'s private field as `unknown` because the extension API exposes
					// only the registry facade. Passing the seat's own runtime is what the vendor does.
					...(modelRuntime !== undefined ? { modelRuntime: modelRuntime as never } : {}),
				});
				session.setSessionName(spec.sessionName);
				return {
					session,
					extensionsResult,
					...(modelFallbackMessage !== undefined ? { modelFallbackMessage } : {}),
					services: { cwd, agentDir, modelRuntime: session.modelRuntime, settingsManager: session.settingsManager, resourceLoader: loader, diagnostics: [] },
					diagnostics: [],
				};
			},
			{ cwd: spec.cwd, agentDir, sessionManager: spec.sessionManager },
		);
	}

	#resolveChildModel(port: SeatPort, spec: string | undefined): Model<Api> | undefined {
		if (spec === undefined || spec.trim() === "") return port.model();
		return port.resolveModel(spec.trim());
	}

	/**
	 * What a child runs at when nobody said: {@link CHILD_THINKING}, never the
	 * parent's level. A method rather than the constant inline because both the
	 * spawn path and the resume path answer this question, and they must answer it
	 * the same way.
	 */
	#childThinking(): ThinkingLevel {
		return CHILD_THINKING;
	}

	// ---- the run loop ---------------------------------------------------------------

	async #start(name: string, sessionRuntime: AgentSessionRuntime, worktree: AgentWorktree | undefined, prompt: string, maxTurns: number | undefined, onFirstPrompt?: () => void): Promise<void> {
		const record = this.registry.byName(name);
		if (record === undefined) return;
		const run: LiveRun = {
			taskId: record.taskId,
			session: sessionRuntime.session,
			sessionRuntime,
			worktree,
			stopSignal: undefined,
			firstTurnDone: false,
			handoffPending: false,
			switching: false,
			switchWatchers: new Set(),
			silent: record.workflowChild,
			interruptWith: undefined,
			lastText: "",
			toolUses: 0,
			costUsd: 0,
			totalTokens: 0,
			outputTokens: 0,
			turns: 0,
			wrapUpSent: false,
			done: Promise.resolve(),
			phase: { at: "running" },
		};
		let lastProgressAt = 0;
		// Any event at all is a sign of life, so the age of the last one is the
		// staleness a reader wants; a count that changed goes out at once.
		// One call's line rides the event that call forces, so each is published
		// exactly once and a reader can keep the tail (`lib/tool-activity-line.ts`).
		const publishProgress = (force: boolean, activity?: string) => {
			const at = this.#now();
			if (!force && at - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
			lastProgressAt = at;
			// The context the child is carrying: how close it is to burning its
			// window, which the record does not learn until settle.
			this.#emit(AGENT_PROGRESS_CHANNEL, { id: run.taskId, name, toolUses: run.toolUses, totalTokens: run.totalTokens, lastActivityAt: at, ...(activity !== undefined ? { activity } : {}) });
		};
		const listener = (event: AgentSessionEvent) => {
			if (event.type === "tool_execution_start") run.toolUses++;
			// The first answer is back, so this run is no longer racing its siblings
			// for the cache prefix: it has left the launch batch the stagger counts.
			if (event.type === "message_end" && event.message.role === "assistant") run.firstTurnDone = true;
			// `message_update` is one streamed delta — text, thinking or tool arguments.
			// A model thinking for minutes on one turn emits nothing else, and it is alive.
			const progress: AgentProgressEvent | undefined =
				event.type === "message_update" || event.type === "turn_end"
					? { type: event.type }
					: event.type === "tool_execution_start" || event.type === "tool_execution_end"
						? { type: event.type, toolCallId: event.toolCallId }
						: undefined;
			if (progress !== undefined) for (const watcher of this.#progressWatchers.get(record.taskId) ?? []) watcher(progress);
			if (event.type === "message_end" && event.message.role === "assistant" && run.phase.at !== "stopping") {
				const usage = (event.message as { usage?: { output?: number; totalTokens?: number; cost?: { total?: number } } }).usage;
				run.costUsd += usage?.cost?.total ?? 0;
				// The billed total is summed over cached reads, so adding it up counts
				// re-reads as work. The last reading is the context size (issues/31 (d));
				// a message that reports nothing — an error, an abort — leaves it alone.
				if (usage !== undefined && (usage.totalTokens ?? 0) > 0) run.totalTokens = usage.totalTokens ?? 0;
				run.outputTokens += usage?.output ?? 0;
				const text = event.message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
				if (text) run.lastText = text;
				// A handoff document (map C23): the child's continuation extension will
				// ask for a new session once this run settles, so idle is not done.
				if (handoffDocumentOf(event.message) !== undefined) {
					run.handoffPending = true;
					for (const wake of run.switchWatchers) wake();
				}
			}
			if (event.type === "turn_end" && maxTurns !== undefined) {
				run.turns++;
				if (!run.wrapUpSent && run.turns >= maxTurns) {
					run.wrapUpSent = true;
					void run.session.steer(WRAP_UP_STEER);
				} else if (run.wrapUpSent && run.turns >= maxTurns + MAX_TURNS_GRACE && run.phase.at !== "stopping") {
					this.#markStopping(run, "max-turns");
					void run.session.abort();
				}
			}
			publishProgress(
				event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "message_end",
				event.type === "tool_execution_start" ? toolActivityLine(event.toolName, event.args) : undefined,
			);
		};
		let unsubscribe = run.session.subscribe(listener);
		// What `ctx.newSession` does on this seat: pi's own replacement flow, with
		// the run marked as switching until the new session's first turn has begun.
		const actions: ExtensionCommandContextActions = {
			waitForIdle: () => run.session.waitForIdle(),
			newSession: async (options) => {
				run.switching = true;
				for (const wake of run.switchWatchers) wake();
				try {
					const result = await sessionRuntime.newSession(options);
					if (!result.cancelled) await firstRunStarted(run.session, SWITCHED_SESSION_START_MS);
					return result;
				} finally {
					run.switching = false;
					run.handoffPending = false;
					for (const wake of run.switchWatchers) wake();
				}
			},
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		};
		const bind = (session: AgentSession) => session.bindExtensions({ mode: "print", commandContextActions: actions });
		// After a replacement: follow the new session, keep the record pointing at
		// the newest file (what a resume reopens), retire the old seat declaration.
		sessionRuntime.setRebindSession(async (session) => {
			const previous = run.session;
			unsubscribe();
			run.session = session;
			unsubscribe = session.subscribe(listener);
			if (previous.sessionId !== session.sessionId) forgetChildSeat(previous.sessionId);
			this.registry.update(name, { sessionId: session.sessionId, sessionFile: session.sessionFile });
			await bind(session);
		});
		await bind(run.session);
		this.#runs.set(record.taskId, run);
		// The parent's cascade stops this run through the process-wide map; the
		// entry lives exactly as long as the run.
		descendantStoppers().set(record.taskId, async () => {
			try {
				await this.stop(record.taskId, "cascade");
			} catch {
				// Already settled; nothing to stop.
			}
		});
		// Its spawn was in flight when the seat retired: it never prompts, and settles stopped with its worktree.
		if (this.#retiring !== undefined) this.#markStopping(run, this.#retiring);
		this.registry.update(name, { status: "running" });
		this.#emit("subagents:started", lifecyclePayload(this.registry.byName(name) ?? record));

		run.done = (async () => {
			let error: string | undefined;
			try {
				const stagger = this.#firstPromptDelayMs();
				if (stagger > 0) await this.#stagger(run, stagger);
				if (run.phase.at !== "stopping") {
					onFirstPrompt?.();
					await run.session.prompt(prompt);
				}
				// A message sent with `interrupt: true` aborts the current turn; the
				// run continues with that message rather than settling.
				while (run.interruptWith !== undefined && run.phase.at !== "stopping") {
					const next = run.interruptWith;
					run.interruptWith = undefined;
					await run.session.prompt(next);
				}
				await this.#waitUntilQuiet(run);
			} catch (thrown) {
				error = thrown instanceof Error ? thrown.message : String(thrown);
			} finally {
				unsubscribe();
			}
			await this.#settle(record.taskId, run, error);
		})();
	}

	/**
	 * A child is done when idle and owning no live agents; a waiting lead is
	 * neither, and nor is a child that has written a handoff document: its
	 * session is about to be replaced, and the run follows the new session.
	 */
	async #waitUntilQuiet(run: LiveRun): Promise<void> {
		let handoffSeenAt: number | undefined;
		let releasedByPoll = false;
		for (;;) {
			const session = run.session;
			await session.waitForIdle();
			if (run.session !== session) continue;
			if (run.handoffPending && !run.switching) {
				// The switch is asked for a macrotask after the child settles; if it
				// never comes (no continuation extension on the child), the child is
				// what it looks like: finished, with the document as its result.
				handoffSeenAt ??= this.#now();
				if (this.#now() - handoffSeenAt >= HANDOFF_SWITCH_GRACE_MS) run.handoffPending = false;
			} else {
				handoffSeenAt = undefined;
			}
			if (!run.handoffPending && !run.switching && liveAgentsOf(session.sessionId).size === 0 && session.isIdle) {
				// The backstop poll is the only wake that is not an event, so a run it
				// releases is a settle the seam or the session should have announced
				// and did not. Saying so is the difference between a hole and a hole
				// nobody can find (38's deletion 4): the poll stays, and it reports.
				if (releasedByPoll) this.#log(`agent ${this.registry.byTaskId(run.taskId)?.name ?? run.taskId}: the quiet loop was released by its ${QUIET_POLL_MS}ms backstop poll, not by an event — a settle went unannounced`, "warning");
				return;
			}
			// Woken by the child's own settle (its runtime marks it on the seam), by
			// this session settling a turn, by a switch beginning or ending, or by
			// the backstop poll.
			releasedByPoll = await new Promise<boolean>((resolve) => {
				// While a switch is expected the timer is the grace deadline, not a
				// poll: it is the answer, so it reports nothing.
				const grace = run.handoffPending && !run.switching;
				const timer = setTimeout(() => finish(!grace), grace ? HANDOFF_SWITCH_GRACE_MS : QUIET_POLL_MS);
				(timer as { unref?: () => void }).unref?.();
				const wake = () => finish(false);
				const offSession = session.subscribe((event) => {
					if (event.type === "agent_settled") wake();
				});
				const offSeam = watchLiveAgentsOf(session.sessionId, wake);
				run.switchWatchers.add(wake);
				function finish(byPoll: boolean) {
					clearTimeout(timer);
					offSession();
					offSeam();
					run.switchWatchers.delete(wake);
					resolve(byPoll);
				}
			});
		}
	}

	async #settle(taskId: string, run: LiveRun, thrown: string | undefined): Promise<void> {
		const release = async () => {
			const childSessionId = run.session.sessionId;
			forgetChildSeat(childSessionId);
			forgetSessionStopping(childSessionId);
			forgetContextStop(childSessionId);
			try {
				// Through the runtime, not the session: its `session_shutdown` is what closes the child's extensions' scopes.
				await run.sessionRuntime.dispose();
			} catch {
				// A session that will not dispose is not worth failing the settle over.
			}
		};
		// {@link retire} cut this run off at its bound and wrote its record; the late settle only cleans up.
		if (run.phase.at === "cut off") return release();
		// Detached, this lands in the held writes and the delivery is refused: the result waits, unread, for the session that attaches.
		const record = this.registry.byTaskId(taskId);
		descendantStoppers().delete(taskId);
		markAgentSettled(this.#facts().sessionId, taskId);
		if (record === undefined) {
			run.phase = { at: "settled" };
			if (this.#runs.get(taskId) === run) this.#runs.delete(taskId);
			return release();
		}
		const last = run.session.messages[run.session.messages.length - 1];
		const stopReason = last?.role === "assistant" ? last.stopReason : undefined;
		const errorMessage = last?.role === "assistant" ? (last as { errorMessage?: string }).errorMessage : undefined;
		let status: AgentStatus = "completed";
		let error: string | undefined = thrown;
		// The child's own ladder stopped it (ticket 51 §2). Its abort is
		// indistinguishable from a crash to everything else here, so this fact is
		// the only thing that can tell the parent the truth — and it names the file
		// the child's handoff is in, which `aborted` never did.
		const contextStop = contextStopOf(record.sessionId);
		if (contextStop !== undefined) {
			status = "stopped";
			error = contextStopError(contextStop, record.sessionFile);
		} else if (run.phase.at === "stopping") {
			status = "stopped";
			error = error ?? (run.wrapUpSent ? `max_turns reached` : undefined);
		} else if (thrown !== undefined || stopReason === "error") {
			status = "error";
			error = error ?? errorMessage ?? "the model returned an error";
		} else if (stopReason === "aborted") {
			status = "error";
			error = errorMessage ?? "aborted";
		}
		const outcome: RunOutcome = { status, error, result: boundReport(childReport(run.session, run.lastText), record.sessionFile), stoppedBy: contextStop !== undefined ? "context" : undefined };
		run.phase = { at: "settling", outcome };
		let result = outcome.result;
		let settlement: AgentWorktreeSettlement | undefined;
		if (run.worktree !== undefined) {
			try {
				settlement = await settleAgentWorktree(this.#deps.exec, run.worktree);
				result = `${result ?? ""}\n\n${worktreeReportLine(settlement)}`.trim();
			} catch (worktreeError) {
				this.#log(`agent ${record.name}: worktree settle failed: ${worktreeError instanceof Error ? worktreeError.message : String(worktreeError)}`, "warning");
			}
		}
		// The worktree settle awaits: the bound may have cut this run off meanwhile, and the
		// check and the write below are one synchronous step, so exactly one of the two writes.
		if (run.phase.at === "cut off") return release();
		// Out of `#runs` only now, so a retire that begins mid-settle still finds this run and waits for this write.
		run.phase = { at: "settled" };
		if (this.#runs.get(taskId) === run) this.#runs.delete(taskId);
		// Read again after the await: an attach meanwhile moved the record to a new registry and owner.
		const base = this.registry.byTaskId(taskId) ?? record;
		// Only the newest run under the name updates the name's record; an
		// older run whose name was reused settles into its own task id only.
		const current = this.registry.byName(base.name);
		const settled = this.#endedRecord(base, run, { ...outcome, result });
		const stored = current?.taskId === base.taskId ? this.registry.put(settled) : settled;
		void release();
		this.publishSettled(stored);
	}

	#endedRecord(base: AgentRecord, run: LiveRun, outcome: RunOutcome): AgentRecord {
		const at = this.#now();
		return {
			...base,
			status: outcome.status,
			...(outcome.stoppedBy !== undefined ? { stoppedBy: outcome.stoppedBy } : {}),
			result: outcome.result,
			error: outcome.error,
			toolUses: run.toolUses,
			costUsd: run.costUsd,
			totalTokens: run.totalTokens,
			outputTokens: run.outputTokens,
			completedAt: at,
			// A silent run's result is the spawner's to read: marked here, at settle,
			// so no turn can drain it in the gap before the spawner does — and named
			// `spawner`, because it never enters anyone's conversation.
			readBy: run.silent ? "spawner" : undefined,
			readAt: run.silent ? at : undefined,
		};
	}

	/**
	 * A run has settled: announce it, release the waits, and deliver its result
	 * (ticket 09, ruled 2026-09-04). The one delivery site — this runtime's own
	 * children and the workflow runs that settle their own records both come
	 * through here, so "who arrives when" is written once.
	 *
	 * A worker or a lead delivers alone, the moment it lands, because its result
	 * needs a decision. Explorers hold until the last live explorer of this seat
	 * has settled and then leave together in one message: explorer output is
	 * reading material. A result a wait has claimed is left unread for that wait
	 * to return, and a silent run's is its spawner's — either way it is not this
	 * seat's conversation's (C7: once, to whoever asked).
	 */
	publishSettled(settled: AgentRecord): void {
		// The live mark ends where the result is delivered, so a run started outside
		// this class cannot leave one behind under a session id it captured before a
		// handoff (38's finding 2). Idempotent: this runtime's own settle clears it
		// first, because it must clear it even when the record is gone.
		markAgentSettled(this.#facts().sessionId, settled.taskId);
		this.#emit(settled.status === "completed" ? "subagents:completed" : "subagents:failed", lifecyclePayload(settled));
		this.waits.notify();
		this.#offer(settled);
	}

	/** Offer every unread result to the conversation again, as if it had just settled. */
	offerUnread(): void {
		// `unread()` is a snapshot, and one explorer batch marks the rest of it read.
		for (const record of this.unread()) {
			const current = this.registry.byTaskId(record.taskId);
			if (current !== undefined) this.#offer(current);
		}
	}

	#offer(settled: AgentRecord): void {
		if (settled.readBy !== undefined || this.#claimed(settled.name)) return;
		// An older run whose name has since been reused settles into its task id
		// only; nobody is waiting on it.
		if (this.registry.byName(settled.name)?.taskId !== settled.taskId) return;
		if (isSessionStopping(this.#facts().sessionId)) return;
		const batching = settled.type === EXPLORE_AGENT_TYPE;
		if (batching && this.registry.live().some((record) => record.type === EXPLORE_AGENT_TYPE)) return;
		const names = batching ? this.unread().filter((record) => record.type === EXPLORE_AGENT_TYPE && !this.#claimed(record.name)).map((record) => record.name) : [settled.name];
		// `deliver` hands the message to pi's queue and learns only whether it was
		// taken, so `handed` is the whole of what this path can claim;
		// `before_agent_start` is where it becomes `conversation` (or is delivered again).
		this.takeUnread(names, (notification) => this.#deliver(notification), "handed");
	}

	// ---- wait -------------------------------------------------------------------------

	/**
	 * Wait until every named agent has settled — or, with no names, until any
	 * agent of this seat has a result unread — then return. `names` that are
	 * not this seat's agents are reported in the outcome rather than waited on.
	 */
	async wait(names: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<{ outcome: AgentWaitOutcome; done: number; of: number; unknown: string[] }> {
		this.checkAddressable(names);
		const unknown = names.filter((name) => this.registry.byName(name) === undefined);
		const known = names.filter((name) => !unknown.includes(name));
		// A bare `TaskOutput` asks about everything this seat has in flight, so
		// that is what "N of M" counts: what was live plus what had settled unread
		// when the wait began. Named or not, the set is fixed here — an agent
		// spawned mid-wait would otherwise move the goalposts (issues/31 (g)).
		const watched = known.length > 0 ? known : [...new Set([...this.registry.live().map((record) => record.name), ...this.unread().map((record) => record.name)])];
		const settledCount = () => watched.filter((name) => agentIsSettled(this.registry.byName(name)?.status ?? "completed")).length;
		const condition =
			known.length > 0
				? () => settledCount() === known.length
				: () => this.unread().length > 0 || this.registry.live().length === 0;
		const link = this.#link;
		if (link.state === "attached" && link.port.hasPendingInput() && !condition()) {
			return { outcome: { kind: "interrupted", by: "Joel" }, done: settledCount(), of: watched.length, unknown };
		}
		// Claimed for the whole wait, so a result that settles mid-wait is this
		// caller's to read rather than the wake path's.
		const claim = { names: known.length > 0 ? new Set(known) : undefined };
		this.#claims.add(claim);
		try {
			const outcome = await this.waits.wait(condition, timeoutMs, signal);
			return { outcome, done: settledCount(), of: watched.length, unknown };
		} finally {
			this.#claims.delete(claim);
		}
	}

	/** Joel typed: every wait in flight returns now. */
	interruptWaits(by = "Joel"): void {
		this.waits.interrupt(by);
	}

	// ---- message and resume -------------------------------------------------------------

	/**
	 * Deliver a message to an agent by name. Running: at its next step, or now
	 * with `interrupt`. Finished or lost: resumed from its transcript as a new
	 * run under the same name.
	 */
	async send(name: string, message: string, interrupt: boolean, toolCallId?: string, signal?: AbortSignal): Promise<{ kind: "queued" | "interrupted" | "resumed"; record: AgentRecord }> {
		this.#refuseSelfOrAncestor(name);
		let record = this.registry.byName(name);
		if (record === undefined) throw new AgentSendRefused("unknown-agent", `No agent named "${name}" — run ListAgents to see targets.`);
		const run = this.#runs.get(record.taskId);
		if (run !== undefined && !runIsLive(run)) {
			// Its settle is writing the result: the message resumes the agent once that is on
			// record, instead of starting a turn that the settle's dispose would cut short.
			// The settle's git calls can take ~25 s, and pi's abort before shutdown waits for
			// this tool call, so the call's own abort ends the wait.
			let cancel = (): void => {};
			const aborted = new Promise<true>((resolve) => (cancel = () => resolve(true)));
			if (signal?.aborted) cancel();
			signal?.addEventListener("abort", cancel, { once: true });
			let cancelled: boolean;
			try {
				cancelled = await Promise.race([run.done.then(() => false), aborted]);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
			if (cancelled) {
				throw new AgentSendRefused("cancelled", `The message to "${name}" was cancelled while the agent was finishing; it was not delivered.`);
			}
			record = this.registry.byName(name) ?? record;
		} else if (run !== undefined && !agentIsSettled(record.status)) {
			if (interrupt) {
				run.interruptWith = message;
				await run.session.abort();
				return { kind: "interrupted", record };
			}
			if (run.session.isStreaming) await run.session.steer(message);
			else await run.session.prompt(message);
			return { kind: "queued", record };
		}
		return { kind: "resumed", record: await this.#tracked(this.#resume(record, message, toolCallId)) };
	}

	async #resume(record: AgentRecord, message: string, toolCallId: string | undefined): Promise<AgentRecord> {
		if (this.#retiring !== undefined) throw new AgentSendRefused("retiring", `The seat is shutting down: agent "${record.name}" cannot be resumed now.`);
		if (this.#link.state === "detached") throw new AgentSendRefused("detached", `The seat is being replaced by its continuation: agent "${record.name}" cannot be resumed until the new session attaches.`);
		if (record.sessionFile === undefined || !existsSync(record.sessionFile)) {
			throw new AgentSendRefused("no-transcript", `Agent "${record.name}" has no transcript on disk to resume from.`);
		}
		const port = this.#port("resuming an agent");
		const model = port.resolveModel(record.model) ?? port.model();
		if (model === undefined) throw new AgentSendRefused("no-model", `No model to resume "${record.name}" on (${record.model}).`);
		const sessionManager = SessionManager.open(record.sessionFile, port.sessionDir);
		const type = port.types.find((candidate) => candidate.name === record.type);
		const role: AgentRole = record.type === "lead" ? "lead" : "worker";
		const seat: EngineChildSeat = {
			name: record.name,
			role,
			depth: record.depth,
			parentSessionId: port.sessionId,
			workflowChild: record.workflowChild,
			prompt: type?.prompt ? { kind: "own" } : { kind: "inherit" },
		};
		const resumed = this.registry.put({
			...record,
			// The task id is the *agent's*, kept across the resume, because the human,
			// `SendMessage`, `ListAgents` and the dock all key on one agent. Minting a
			// fresh one gave the dock two rows under one name, the older still
			// asserting `completed` for an agent that was running.
			//
			// Every delivery still carries its own tool-use id: the `SendMessage` call
			// that caused this run, not the `Agent` call that caused the first one.
			// Reusing it made a genuinely new result indistinguishable from a
			// redelivery of the old one (observed 2026-09-03: three runs of one
			// agent, three task ids, one tool-use id). That is the distinction the
			// fresh task id was wrongly doing.
			toolCallId,
			status: "queued",
			// The stop, if any, was the previous run's; a record carries only its own run's.
			stoppedBy: undefined,
			result: undefined,
			error: undefined,
			readBy: undefined,
			readAt: undefined,
			toolUses: 0,
			costUsd: 0,
			totalTokens: 0,
			outputTokens: 0,
			startedAt: this.#now(),
			completedAt: undefined,
		});
		// Its own channel, not `created`: the dock's backwards guard must keep
		// refusing a late `started` that would resurrect a settled agent, and only a
		// channel that means "this row is alive again" can be exempt from it.
		this.#emit("subagents:resumed", lifecyclePayload(resumed));
		markAgentLive(this.#facts().sessionId, resumed.taskId);
		const sessionRuntime = await this.#createChildRuntime({
			sessionManager,
			cwd: record.cwd,
			model,
			// The level this agent has been running at all along, not one recomputed
			// from its type: a resume continues the agent the human is talking to.
			thinking: record.thinking ?? type?.thinking ?? this.#childThinking(),
			systemPrompt: type?.prompt || undefined,
			seat,
			sessionName: `${record.name}#${resumed.taskId.slice(1, 7)}`,
			modelRuntime: port.modelRuntime,
		});
		await this.#start(record.name, sessionRuntime, undefined, message, undefined);
		return this.registry.byName(record.name) ?? resumed;
	}

	// ---- stop -------------------------------------------------------------------------------

	/**
	 * Stop a run by name or task id, and every agent it owns. Keeps the result so
	 * far. `by` names the caller and is written to the record, so a stopped agent
	 * in a session file says who stopped it (issues/31 (h)).
	 */
	async stop(nameOrTaskId: string, by: StopCause): Promise<AgentRecord> {
		this.#refuseSelfOrAncestor(nameOrTaskId);
		const record = this.registry.byName(nameOrTaskId) ?? this.registry.byTaskId(nameOrTaskId);
		if (record === undefined) throw new AgentStopRefused("unknown-agent", `No agent named "${nameOrTaskId}".`);
		const run = this.#runs.get(record.taskId);
		if (agentIsSettled(record.status)) throw new AgentStopRefused("not-running", `Agent "${record.name}" is not running (${record.status}).`);
		// Settling: its child has ended and its outcome is fixed. Refused at once, not after the
		// worktree settle, which can take ~25 s and would hold a quit behind this tool call.
		if (run?.phase.at === "settling") {
			const { status } = run.phase.outcome;
			throw new AgentStopRefused("not-running", `Agent "${record.name}" is not running (${status}).`, status);
		}
		if (run === undefined) {
			// A record whose run lives outside this runtime — a workflow (ticket
			// 23) — stops through the stopper it registered under its task id.
			const foreign = descendantStoppers().get(record.taskId);
			if (foreign === undefined) throw new AgentStopRefused("not-running", `Agent "${record.name}" is not running (${record.status}).`);
			await foreign();
			return this.registry.byTaskId(record.taskId) ?? record;
		}
		this.#markStopping(run, by);
		run.interruptWith = undefined;
		markSessionStopping(record.sessionId);
		this.#stopDescendants(record.sessionId);
		await run.session.abort();
		await run.done;
		return this.registry.byTaskId(record.taskId) ?? record;
	}

	/** Descendants run under their own runtimes; the seam lets us find their live sessions. */
	#stopDescendants(ownerSessionId: string): void {
		for (const taskId of liveAgentsOf(ownerSessionId)) {
			const stopper = descendantStoppers().get(taskId);
			if (stopper !== undefined) void stopper();
		}
	}

	/** Mark every run stopping now, synchronously, and return the aborts. */
	#stopEach(by: StopCause): Promise<void> {
		const aborts: Promise<void>[] = [];
		for (const [taskId, run] of this.#runs) {
			if (!runIsLive(run)) continue;
			this.#markStopping(run, by);
			// A record that is gone has no session to mark; the empty string used to
			// go in and stay in the stopping set forever (38's finding 6).
			const childSessionId = this.registry.byTaskId(taskId)?.sessionId;
			if (childSessionId !== undefined) {
				markSessionStopping(childSessionId);
				this.#stopDescendants(childSessionId);
			}
			aborts.push(run.session.abort());
		}
		return Promise.all(aborts).then(() => undefined);
	}
}

/** Expected failures of `send`. */
export class AgentSendRefused extends Error {
	readonly _tag = "AgentSendRefused" as const;
	constructor(
		readonly reason: "unknown-agent" | "no-transcript" | "no-model" | "retiring" | "detached" | "cancelled",
		message: string,
	) {
		super(message);
	}
}

/** A name that means the caller itself, or a seat above it. */
export class AgentAddressRefused extends Error {
	readonly _tag = "AgentAddressRefused" as const;
	constructor(
		readonly reason: "self" | "ancestor",
		message: string,
	) {
		super(message);
	}
}

/** Expected failures of `stop`. */
export class AgentStopRefused extends Error {
	readonly _tag = "AgentStopRefused" as const;
	constructor(
		readonly reason: "unknown-agent" | "not-running",
		message: string,
		/** The status a settling run ended with, which its record shows only once the settle writes. */
		readonly status?: AgentStatus,
	) {
		super(message);
	}
}

const STOPPERS_SEAM = "__piKitAgentStoppers";

/**
 * task id -> a function that stops it, across every runtime in the process.
 * A workflow run (ticket 23) registers its own here so `TaskStop` and a
 * parent's cascade reach it.
 */
export function descendantStoppers(): Map<string, () => Promise<void>> {
	return shared(STOPPERS_SEAM, () => new Map<string, () => Promise<void>>());
}
