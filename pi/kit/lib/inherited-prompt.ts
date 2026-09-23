/**
 * Prompt inheritance between the sessions of one process.
 *
 * Every seat's system prompt is built here and **published** under its session
 * id, so a child can be handed its parent's exact bytes rather than a
 * reconstruction of them. That is what map C10 asks for and what map C4 needs:
 * a worker whose system block is byte-identical to its parent's reads the
 * parent's tools+system cache entry instead of writing its own.
 *
 * What is published is the *resolved* text a session put on the wire, not the
 * options it was built from — so one lookup serves a grandchild too, and the
 * bytes are exactly the ones the parent's cache prefix was written with.
 *
 * The seam is `globalThis` (`side-flag.ts`'s pattern: child sessions run
 * in-process but get their own module registry, so a module-level variable
 * would not be shared).
 *
 * A child with a prompt body of its own (an agent type's markdown) is not an
 * inheriting child at all: its body arrives as `customPrompt` and takes pi's
 * ordinary custom-prompt branch through {@link ownedSessionPrompt}. Nothing
 * here ever splits or strips a prompt — every branch constructs.
 */

import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { buildOwnedSystemPrompt, promptToolNames, type WireToolName } from "./owned-prompt.ts";
import { shared } from "./shared.ts";

/** Where published prompts live so every session in the process sees them. */
const SEAM = "__piKitOwnedPrompts";

/** Who a session is, for the purpose of inheriting and being inherited from. */
export interface SessionLineage {
	/** This session's id — the key its children look it up by. */
	readonly sessionId: string;
	/** The spawning session's id, when pi recorded one. */
	readonly parentSessionId: string | undefined;
}

/**
 * The owned system prompt for one request, published so this session's own
 * children can inherit it in turn.
 *
 * Producing and publishing are one act on purpose: what a child reads is by
 * construction the exact text its parent last sent, so a byte-identical cache
 * prefix cannot silently drift from what the wire actually carried.
 */
export function ownedSessionPrompt(options: BuildSystemPromptOptions, lineage: SessionLineage, wireToolName?: WireToolName): string {
	return publish(lineage.sessionId, options, buildOwnedSystemPrompt(options, wireToolName), wireToolName);
}

/**
 * The owned engine's inheritance (map C10): a worker or lead with no prompt
 * body of its own runs on its parent's owned prompt bytes, verbatim, so its
 * first request reads the parent's tools+system cache entry. Published under
 * the child's own id too, so a grandchild inherits the same bytes.
 *
 * Verbatim only while the child's wire spells the tools the way the parent's
 * did. A child on another provider (a Codex child of an Anthropic OAuth parent)
 * gets the parent's prompt rebuilt from the parent's own options in its own
 * spelling: the parent's bytes would name tools its wire does not carry, and
 * there is no shared cache entry across providers to keep.
 *
 * A parent that never published (a child spawned before the parent's first
 * request, or across a process restart) gets the owned skeleton built from
 * the child's own options — 100% owned text, less parental flavour.
 */
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

/**
 * Drop a session's published prompt. Called from `session_shutdown`, so the
 * seam holds one entry per live session rather than one per spawn ever made.
 */
export function forgetOwnedPrompt(sessionId: string): void {
	publishedPrompts().delete(sessionId);
}

/**
 * What a session published: the text it sent, the options that text was built
 * from, and the tool names it was written in, so a child can tell whether the
 * text is right for its own wire and rebuild it when it is not.
 */
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

const publishedPrompts = (): Map<string, PublishedPrompt> => shared(SEAM, () => new Map<string, PublishedPrompt>());
