import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { PromptTarget } from "./prompt-target.ts";
import { processShared } from "../process/process-shared-state.ts";

/** A conversation to draw as main's transcript draws its own: pi's `AgentSession` satisfies it as it stands. */
export interface ConversationSource {
	readonly messages: readonly AgentMessage[];
	readonly isStreaming?: boolean;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	getToolDefinition(name: string): ToolDefinition | undefined;
}

/** pi's theme as extensions receive it. */
export type FocusTheme = ExtensionContext["ui"]["theme"];

/** What a target made of a submit: `sent` starts an answer (`…` until visible output or `settles`), `queued` joins one, `refused` restores the text. */
export type FocusSubmit =
	| { readonly kind: "sent"; readonly settles?: Promise<unknown> }
	| { readonly kind: "queued" }
	| { readonly kind: "refused"; readonly reason: string };

export type ThreadPlacement = "below" | "replace";

/** One thing the prompt can talk to instead of main, as the prompt focus controller drives it. */
export interface FocusTarget {
	readonly target: PromptTarget;
	readonly placement: ThreadPlacement;
	readonly marker: { readonly text: string; readonly color: "success" | "accent" };
	source(): ConversationSource | undefined;
	statusLines(theme: FocusTheme, waiting: boolean): string[];
	submit(text: string, images: ImageContent[] | undefined, how: "enter" | "followUp"): FocusSubmit;
	takesFollowUpKey(): boolean;
	interrupt(): "handled" | "leave";
	leave(why: "exit" | "switch"): void;
}

/** A main session's prompt focus owner, as other extensions reach it. */
export interface PromptFocus {
	focus(target: FocusTarget): boolean;
	exit(): void;
}

const PROMPT_FOCUS_SEAM = "__piKitPromptFocus";

const owners = (): Map<string, PromptFocus> => processShared(PROMPT_FOCUS_SEAM, () => new Map<string, PromptFocus>());

/** Publish a main session's prompt focus owner; `side-chat` calls this at `session_start`. */
export function publishPromptFocus(sessionId: string, focus: PromptFocus): void {
	owners().set(sessionId, focus);
}

/** The prompt focus owner of a session, or undefined on a seat without a screen or before side-chat started. */
export function promptFocusOf(sessionId: string): PromptFocus | undefined {
	return owners().get(sessionId);
}

/** The session is over; drop its owner. `side-chat` calls this at `session_shutdown`. */
export function forgetPromptFocus(sessionId: string): void {
	owners().delete(sessionId);
}
