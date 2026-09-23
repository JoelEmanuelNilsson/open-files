/**
 * The seat's system-prompt options, held where the request can reach them.
 *
 * `wire` needs pi's structured `BuildSystemPromptOptions` at request time, but
 * pi only hands them out at turn time, on `before_agent_start` — and that
 * event fires on one path: a user message. Every ordinary turn is a user
 * message, so the dependency is invisible until something starts a turn
 * without one. `pi.sendMessage(..., { triggerTurn: true })` on an idle session
 * goes straight to `_runAgentPrompt` (pi's `agent-session.js`, no
 * `emitBeforeAgentStart`), and if that is the first turn of the process there
 * is no capture at all. On 2026-09-02 and 2026-09-06 that put pi's own prompt
 * on an Anthropic OAuth request behind the Claude Code identity block, and the
 * provider refused it as a third-party app.
 *
 * So the capture lives here rather than in a closure inside `wire`, for two
 * reasons the closure could not serve:
 *
 *   - Any holder of pi's options can fill it. Command handlers get
 *     `ctx.getSystemPromptOptions()` — pi's own accessor, exact and live — so
 *     a command that triggers a turn primes the seat before it does
 *     (`continue-session.ts`'s `/handoff`). One writer per path, one reader.
 *   - It survives an extension reload, which replaces every module instance
 *     while the seat and its conversation go on. A closure variable would take
 *     the capture with it and leave the next non-user turn with nothing.
 *
 * Keyed by session id because a process runs many seats (children, forks,
 * continuations) whose prompts are not each other's. On `globalThis` via
 * `shared`, because in-process sessions each get their own module registry.
 *
 * Nothing here decides what a missing capture means. That is `wire`'s to
 * answer, and its answer is never pi's prose.
 */

import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { shared } from "./shared.ts";

const SEAM = "__piKitPromptOptions";

/** File the options pi built this seat's prompt from. Last write wins: the newest is the truest. */
export function capturePromptOptions(sessionId: string, options: BuildSystemPromptOptions | undefined): void {
	if (options === undefined) return;
	captures().set(sessionId, options);
}

/** What this seat's prompt is built from, or `undefined` before anything captured. */
export function capturedPromptOptions(sessionId: string): BuildSystemPromptOptions | undefined {
	return captures().get(sessionId);
}

/**
 * Drop a seat's capture. Called when a session ends for good — never on a
 * reload, which is the case this store exists to survive.
 */
export function forgetPromptOptions(sessionId: string): void {
	captures().delete(sessionId);
}

const captures = (): Map<string, BuildSystemPromptOptions> => shared(SEAM, () => new Map<string, BuildSystemPromptOptions>());
