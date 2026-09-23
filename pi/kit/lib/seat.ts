/**
 * Which seat a session is sitting in — main, or a spawned child running an
 * agent definition.
 *
 * pi exposes no subagent flag, so the answer is inferred, and two modules need
 * the same inference for different reasons: `wire` decides whether to claim
 * Claude Code's subagent headers, `background` decides whether a command may be
 * detached at all (a child has nobody to deliver a late result to, ruling 4 of
 * issues/07). Two copies of an inference is two copies that can drift, and this
 * one has a subtle exception in it, so there is one.
 *
 * The signal is `customPrompt`: a child running an agent definition's own
 * prompt has one, and a main session has none. The exception is a process
 * launched with `--system-prompt`, which hands *every* session it runs a
 * `customPrompt` and so erases the signal — there, nothing is a child.
 *
 * Declining to declare is always the safe direction, and it is the same
 * direction for both callers: an undeclared session gets no subagent headers
 * and, at the seam that matters, is refused by the runtime check rather than
 * the advertisement (see `lib/background.ts`).
 *
 * The owned engine's children are the second signal, and a stronger one: the
 * engine *declares* each child seat on a process-wide seam before the child
 * session exists ({@link declareChildSeat}), keyed by the session id it
 * assigned. A worker that inherits its parent's prompt bytes has no
 * `customPrompt` at all — the declaration is the only way to know it is a
 * child, and it also carries what `wire` needs to shape its requests: the
 * parent, the depth, and where its system prompt comes from.
 */

import { shared } from "./shared.ts";
import type { ToolSeat } from "./tool-policy.ts";

/**
 * Whether this process is the chat seat (`PI_CHAT=1`, set by the `chat` command
 * and nothing else). Read once per module load by its callers, like `wire`
 * always has: the answer is fixed for the process.
 */
export function isChatSeat(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_CHAT === "1";
}

/** Just enough of pi's `BuildSystemPromptOptions` to answer the question. */
export interface SeatOptions {
	readonly customPrompt?: string;
}

/** What a declared engine child is to the seams that shape its requests. */
export interface EngineChildSeat {
	/** The agent's name (its address). */
	readonly name: string;
	readonly role: "worker" | "lead";
	/** 1 for a child of the main seat. */
	readonly depth: number;
	/** The spawning session's id — the key its owned prompt is published under. */
	readonly parentSessionId: string;
	/** A child spawned by a workflow script's `agent()`: it holds one item, and may not start a workflow of its own. */
	readonly workflowChild: boolean;
	/** Whether this child carries the `Workflow` tool — its parent's launch answer, inherited at spawn. */
	readonly workflows: boolean;
	/**
	 * How the child's system prompt is produced:
	 *   `inherit` — the parent's owned prompt bytes, published under `parentSessionId`;
	 *   `own`     — the type's body, arriving as `customPrompt`, built like any custom prompt.
	 */
	readonly prompt: { readonly kind: "inherit" } | { readonly kind: "own" };
}

/** Where declared child seats live so every session in the process sees them. */
const SEAM = "__piKitEngineChildSeats";

const declaredSeats = (): Map<string, EngineChildSeat> => shared(SEAM, () => new Map<string, EngineChildSeat>());

/** Declare a session (by the id the engine assigned it) as an engine child. Call before the session is created. */
export function declareChildSeat(sessionId: string, seat: EngineChildSeat): void {
	declaredSeats().set(sessionId, seat);
}

/** The engine child declaration for a session, or undefined for a main seat. */
export function childSeatOf(sessionId: string): EngineChildSeat | undefined {
	return declaredSeats().get(sessionId);
}

/** Drop a declaration once its session is gone. */
export function forgetChildSeat(sessionId: string): void {
	declaredSeats().delete(sessionId);
}

/**
 * Where a main seat's launch answer about the `Workflow` tool lives, so that
 * every session in the process reads the same one. A child seat carries its own
 * answer in its declaration and never looks here.
 */
const WORKFLOWS_SEAM = "__piKitSeatWorkflows";

const workflowSeats = (): Set<string> => shared(WORKFLOWS_SEAM, () => new Set<string>());

/** Record what the launcher (`extensions/session-mode.ts`) was told, before the session's first request. */
export function declareSeatWorkflows(sessionId: string, on: boolean): void {
	if (on) workflowSeats().add(sessionId);
	else workflowSeats().delete(sessionId);
}

/** Whether this session carries the `Workflow` tool. A spawned child inherits this from its parent. */
export function seatCarriesWorkflows(sessionId: string): boolean {
	const child = childSeatOf(sessionId);
	if (child !== undefined) return child.workflows;
	return workflowSeats().has(sessionId);
}

/**
 * The seat a session's requests go out on: its engine-child declaration, or the
 * main seat with the launch answer given for it. The one place the tool cuts
 * and the call-time refusal both ask, so they cannot disagree.
 */
export function toolSeatOf(sessionId: string): ToolSeat {
	return childSeatOf(sessionId) ?? { role: "main", workflows: workflowSeats().has(sessionId) };
}

/**
 * Whether this session is a spawned child — running an agent definition's
 * own prompt, or declared by the owned engine under `sessionId`.
 *
 * False when nothing was captured and nothing was declared: a session whose
 * options are unknown is not claimed as a child, because every consequence
 * of the claim (headers, a refusal) is worse applied wrongly than omitted.
 */
export function isChildSeat(options: SeatOptions | undefined, argv: readonly string[], sessionId?: string): boolean {
	if (sessionId !== undefined && childSeatOf(sessionId) !== undefined) return true;
	return options?.customPrompt !== undefined && !cliSuppliesSystemPrompt(argv);
}

/**
 * Whether this process was launched with `--system-prompt`, which gives every
 * session it runs a `customPrompt` and so makes an agent-definition session
 * indistinguishable from a forked or branched main session. Exported for the
 * tests; the running extensions always pass `process.argv`.
 */
export function cliSuppliesSystemPrompt(argv: readonly string[]): boolean {
	return argv.some((arg) => arg === "--system-prompt" || arg.startsWith("--system-prompt="));
}
