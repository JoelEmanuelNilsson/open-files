import { processShared } from "../process/process-shared-state.ts";

/** Where a plain submit goes instead of main: the side thread, or the background agent with this name. */
export type PromptTarget = { readonly kind: "side" } | { readonly kind: "agent"; readonly name: string };

const promptTargets = processShared("__piKitPromptTarget", () => new Map<string, PromptTarget>());

/** The prompt target of the main session `sessionId`, or undefined while the prompt talks to main. */
export function promptTargetOf(sessionId: string): PromptTarget | undefined {
	return promptTargets.get(sessionId);
}

/** Point the prompt of main session `sessionId` at a target, replacing any other; undefined gives it back to main. */
export function setPromptTarget(sessionId: string, target: PromptTarget | undefined): void {
	if (target === undefined) promptTargets.delete(sessionId);
	else promptTargets.set(sessionId, target);
}

/** Whether two prompt targets are the same side thread or the same agent name. */
export function samePromptTarget(a: PromptTarget | undefined, b: PromptTarget | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.kind === "side" ? b.kind === "side" : b.kind === "agent" && a.name === b.name;
}

export function promptTargetClaimsInput(sessionId: string, event: { source: string }): boolean {
	return promptTargets.has(sessionId) && event.source === "interactive";
}
