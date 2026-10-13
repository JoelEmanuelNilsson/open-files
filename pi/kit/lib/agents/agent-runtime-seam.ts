import type { AgentRuntime } from "./agent-runtime.ts";
import { processShared } from "../process/process-shared-state.ts";

const RUNTIMES_SEAM = "__piKitAgentRuntimes";

const runtimes = (): Map<string, AgentRuntime> => processShared(RUNTIMES_SEAM, () => new Map<string, AgentRuntime>());

/** Publish the seat's runtime; the engine calls this at `session_start`. */
export function publishAgentRuntime(sessionId: string, runtime: AgentRuntime): void {
	runtimes().set(sessionId, runtime);
}

/** The runtime of a session, or undefined before its engine has started. */
export function agentRuntimeOf(sessionId: string): AgentRuntime | undefined {
	return runtimes().get(sessionId);
}

export function forgetAgentRuntime(sessionId: string): void {
	runtimes().delete(sessionId);
}
