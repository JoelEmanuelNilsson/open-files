import type { AgentRole } from "../agents/agent-role-tails.ts";
import { processShared } from "../process/process-shared-state.ts";

export function isChatSeat(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_CHAT === "1";
}

/** Just enough of pi's `BuildSystemPromptOptions` to answer the question. */
export interface SeatOptions {
	readonly customPrompt?: string;
}

/** What a declared engine child is to the seams that shape its requests. */
export interface EngineChildSeat {
	readonly name: string;
	readonly role: AgentRole;
	readonly depth: number;
	readonly parentSessionId: string;
	readonly workflowChild: boolean;
	readonly agentTypes: readonly string[] | undefined;
	readonly workflows: boolean;
	readonly prompt: { readonly kind: "inherit" } | { readonly kind: "own" };
	readonly receivesTaskNotices?: true;
}

const SEAM = "__piKitEngineChildSeats";

const declaredSeats = (): Map<string, EngineChildSeat> => processShared(SEAM, () => new Map<string, EngineChildSeat>());

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

/** Whether this session may load the `Workflow` tool: every main seat, and a child its declaration says. */
export function seatCarriesWorkflows(sessionId: string): boolean {
	const child = childSeatOf(sessionId);
	if (child !== undefined) return child.workflows;
	return true;
}

export function isChildSeat(options: SeatOptions | undefined, argv: readonly string[], sessionId?: string): boolean {
	if (sessionId !== undefined && childSeatOf(sessionId) !== undefined) return true;
	return options?.customPrompt !== undefined && !cliSuppliesSystemPrompt(argv);
}

export function cliSuppliesSystemPrompt(argv: readonly string[]): boolean {
	return argv.some((arg) => arg === "--system-prompt" || arg.startsWith("--system-prompt="));
}
