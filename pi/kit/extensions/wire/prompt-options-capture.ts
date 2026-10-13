import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { processShared } from "../../lib/process/process-shared-state.ts";

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

export function forgetPromptOptions(sessionId: string): void {
	captures().delete(sessionId);
}

const captures = (): Map<string, BuildSystemPromptOptions> => processShared(SEAM, () => new Map<string, BuildSystemPromptOptions>());
