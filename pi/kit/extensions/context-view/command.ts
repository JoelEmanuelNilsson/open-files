/**
 * `/context` command grammar, argument completions, and Initial capture
 * resolution shared by the Usage and Injections views.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { buildNativeSnapshot, type InitialCaptureState } from "./capture.ts";
import type { InitialSnapshot } from "./model.ts";
import { buildOwnedSystemPrompt } from "../../lib/owned-prompt.ts";

const COMMAND_USAGE = "Usage: /context [usage|injections]";
const DEFAULT_VIEW: ContextView = "usage";
const ARGUMENT_OPTIONS = [
	{ value: "usage", label: "usage", description: "Show estimated context usage" },
	{ value: "injections", label: "injections", description: "Explore initial context injections" },
] satisfies AutocompleteItem[];

/** The focused view a `/context` invocation requests. */
export type ContextView = "usage" | "injections";

/** Parsed `/context` argument grammar. */
export type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "invalid"; readonly message: string };

/** Resolved Initial capture, possibly degraded to the pi-native fallback. */
export interface InitialCaptureResult {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
}

/** Parse the complete, intentionally small `/context` argument grammar. */
export function parseContextCommand(argumentsText: string): ContextCommand {
	const words = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return { type: "view", view: DEFAULT_VIEW };
	}
	if (words.length === 1 && words[0] === "usage") {
		return { type: "view", view: "usage" };
	}
	if (words.length === 1 && words[0] === "injections") {
		return { type: "view", view: "injections" };
	}
	return { type: "invalid", message: COMMAND_USAGE };
}

/** Complete full argument values for the supported `/context` grammar. */
export function getContextArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = argumentPrefix.trimStart().toLowerCase();
	const matches = ARGUMENT_OPTIONS.filter((option) => option.value.startsWith(normalizedPrefix));
	return matches.length > 0 ? matches.map((option) => ({ ...option })) : null;
}

/**
 * Obtain Initial from passive capture, or degrade to the pi-native snapshot.
 *
 * Capture is per-runtime, so the degraded path is what every `/context` before
 * the first turn of a session, resume, reload or fork shows. It is honest about
 * what it does not know rather than manufacturing a turn to find out: the one
 * thing it loses is the message-level injection list, which is empty unless an
 * extension adds to `context`, and none in this kit do.
 */
export async function resolveInitialCapture(
	pi: ExtensionAPI,
	capture: InitialCaptureState,
	context: ExtensionCommandContext,
): Promise<InitialCaptureResult> {
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	// A turn already in flight will freeze Initial on its own; wait for it.
	await context.waitForIdle();
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	return createFallback(pi, context);
}

/** Build the degraded pi-native snapshot for a runtime that has seen no turn. */
function createFallback(pi: ExtensionAPI, context: ExtensionCommandContext): InitialCaptureResult {
	return {
		snapshot: buildNativeSnapshot({
			systemPrompt: buildOwnedSystemPrompt(context.getSystemPromptOptions()),
			options: context.getSystemPromptOptions(),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		}),
		degradedReason: "No turn has run since this session was loaded. "
			+ "Extension additions were not observed.",
	};
}
