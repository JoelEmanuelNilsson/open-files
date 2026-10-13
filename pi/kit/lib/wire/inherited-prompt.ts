import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { buildOwnedSystemPrompt, promptToolNames, type WireToolName } from "./owned-prompt.ts";
import { processShared } from "../process/process-shared-state.ts";

const SEAM = "__piKitOwnedPrompts";

/** Who a session is, for the purpose of inheriting and being inherited from. */
export interface SessionLineage {
	readonly sessionId: string;
	readonly parentSessionId: string | undefined;
}

export function ownedSessionPrompt(options: BuildSystemPromptOptions, lineage: SessionLineage, wireToolName?: WireToolName): string {
	return publish(lineage.sessionId, options, buildOwnedSystemPrompt(options, wireToolName), wireToolName);
}

export function inheritedSessionPrompt(options: BuildSystemPromptOptions, lineage: SessionLineage, wireToolName?: WireToolName): string {
	const parent = lineage.parentSessionId === undefined ? undefined : publishedPrompts().get(lineage.parentSessionId);
	const source = parent?.source ?? { ...options, customPrompt: undefined };
	const verbatim = parent !== undefined && parent.toolNames === toolNamesKey(source, wireToolName);
	return publish(lineage.sessionId, source, verbatim ? parent.text : buildOwnedSystemPrompt(source, wireToolName), wireToolName);
}

/** The prompt bytes a session last put on the wire, or undefined before its first request. */
export function publishedOwnedPrompt(sessionId: string): string | undefined {
	return publishedPrompts().get(sessionId)?.text;
}

export function forgetOwnedPrompt(sessionId: string): void {
	publishedPrompts().delete(sessionId);
}

interface PublishedPrompt {
	readonly text: string;
	readonly source: BuildSystemPromptOptions;
	readonly toolNames: string;
}

function publish(sessionId: string, source: BuildSystemPromptOptions, text: string, wireToolName: WireToolName | undefined): string {
	publishedPrompts().set(sessionId, { text, source, toolNames: toolNamesKey(source, wireToolName) });
	return text;
}

const toolNamesKey = (source: BuildSystemPromptOptions, wireToolName: WireToolName | undefined): string => JSON.stringify(promptToolNames(source, wireToolName));

const publishedPrompts = (): Map<string, PublishedPrompt> => processShared(SEAM, () => new Map<string, PublishedPrompt>());
