/**
 * The agent runtime seam: where a seat's `AgentRuntime` is published so
 * another extension in the same session — the `Workflow` tool — can spawn
 * through it, keep its children in the same registry, and be stopped by the
 * same `TaskStop`. Process-wide on `globalThis`, keyed by session id,
 * because pi loads each extension through its own module cache and
 * module-level state does not cross that line (the engine's own stopper map
 * is kept the same way).
 */

import type { AgentRuntime } from "./agent-runtime.ts";
import { shared } from "./shared.ts";

const RUNTIMES_SEAM = "__piKitAgentRuntimes";

const runtimes = (): Map<string, AgentRuntime> => shared(RUNTIMES_SEAM, () => new Map<string, AgentRuntime>());

/** Publish the seat's runtime; the engine calls this at `session_start`. */
export function publishAgentRuntime(sessionId: string, runtime: AgentRuntime): void {
	runtimes().set(sessionId, runtime);
}

/** The runtime of a session, or undefined before its engine has started. */
export function agentRuntimeOf(sessionId: string): AgentRuntime | undefined {
	return runtimes().get(sessionId);
}

/**
 * The session is over; drop its runtime. The engine calls this at
 * `session_shutdown`, which is the counterpart {@link publishAgentRuntime}
 * had none of: every entry pins a runtime, and a runtime pins its host, its
 * registry and every `AgentSession` it ever held, so a process across many
 * handoffs accumulated all of them (38's finding 7). A runtime that is being
 * handed to a replacement is held by the park seam, not by this one.
 */
export function forgetAgentRuntime(sessionId: string): void {
	runtimes().delete(sessionId);
}
