/**
 * Side mode on screen: marker and side feed appended to pi's transcript document
 * `[header, resources, chat]` (pinned by test/side-screen.mjs), so main's new
 * output, appended to `chat`, lands above the marker.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Container, Text, type TUI } from "@earendil-works/pi-tui";

import { AgentConversationFeed, type ConversationSource } from "../agent-dock/agent-conversation-feed.ts";

type Theme = ExtensionContext["ui"]["theme"];

/** The literal line that opens side mode under main's chat. */
export const SIDE_MARKER = "<SIDE-CHAT-STARTED>";

/** pi's prompt editor (`CustomEditor`) as side mode reads it: structurally, since jiti splits class identity. */
export interface PromptEditor {
	readonly keybindings: { matches(data: string, action: string): boolean };
	isShowingAutocomplete(): boolean;
	getExpandedText(): string;
	getText(): string;
	getLines(): string[];
	getCursor(): { line: number; col: number };
	setText(text: string): void;
	addToHistory(text: string): void;
}

function member(value: unknown, name: string): unknown {
	// SAFETY: a non-null object is indexable; every read here is checked with typeof before use.
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

function isPromptEditor(value: unknown): value is PromptEditor {
	return (
		["isShowingAutocomplete", "getExpandedText", "getText", "getLines", "getCursor", "setText", "addToHistory"].every((name) => typeof member(value, name) === "function") &&
		typeof member(member(value, "keybindings"), "matches") === "function"
	);
}

function childrenOf(value: unknown): Component[] | undefined {
	const children = member(value, "children");
	// SAFETY: pi-tui's Container keeps its components in a plain `children` array; the shape check only reads it.
	return Array.isArray(children) ? (children as Component[]) : undefined;
}

/** The prompt editor, when it holds the keyboard: `tui.children[4]` is pi's editor container. */
export function focusedPromptEditor(tui: TUI): PromptEditor | undefined {
	const editor = childrenOf(childrenOf(tui)?.[4])?.[0];
	// pi-tui's `TUI` interface omits it; the renderer class pi hands out has it.
	const focused = member(tui, "getFocusedComponent");
	return editor !== undefined && typeof focused === "function" && editor === focused.call(tui) && isPromptEditor(editor) ? editor : undefined;
}

/** pi's transcript document, or what about the screen differs from the layout side mode was built against. */
function transcriptDocument(tui: TUI): { document: Container } | { drift: string } {
	const mounted = childrenOf(tui);
	if (mounted === undefined || mounted.length !== 7) return { drift: `the screen mounts ${mounted?.length ?? "no"} components, not pi's 7` };
	const document = mounted[0];
	const parts = childrenOf(document);
	if (parts === undefined || parts.length !== 3 || !parts.every((part) => childrenOf(part) !== undefined)) {
		return { drift: "the transcript document is not [header, resources, chat]" };
	}
	if (focusedPromptEditor(tui) === undefined) return { drift: "the prompt editor is not the focused component in pi's editor container" };
	// SAFETY: `childrenOf` just proved it is a container of components; pi built it as `new Container()`.
	return { document: document as Container };
}

/** The marker, the side feed and the `…` row, mounted into pi's transcript while side mode is on. */
export class SideScreen {
	readonly #cwd: string;
	#tui: TUI | undefined;
	#document: Container | undefined;
	#marker: Component | undefined;
	#feed: AgentConversationFeed | undefined;
	#unsubscribe: (() => void) | undefined;
	#waiting = false;
	#theme: Theme | undefined;
	readonly #placeholder: Component = {
		render: () => (this.#waiting && this.#theme ? [` ${this.#theme.fg("dim", "…")}`] : []),
		invalidate: () => {},
	};
	readonly #ui = { requestRender: (): void => this.#tui?.requestRender() };

	public constructor(cwd: string) {
		this.#cwd = cwd;
	}

	/** Mount side mode under main's chat; returns the drift that refused it, or undefined. */
	public enter(tui: TUI, theme: Theme): string | undefined {
		this.leave();
		const shape = transcriptDocument(tui);
		if ("drift" in shape) return shape.drift;
		this.#tui = tui;
		this.#theme = theme;
		this.#document = shape.document;
		this.#marker = new Text(theme.fg("success", SIDE_MARKER), 1, 1);
		this.#mount();
		return undefined;
	}

	/** Take side mode off the screen; main's transcript is as it was, plus whatever main added. */
	public leave(): void {
		const document = this.#document;
		if (document === undefined) return;
		this.#unmount();
		this.#document = undefined;
		document.invalidate();
		this.#settle();
	}

	/** Follow a side session, or none after the thread is dropped. */
	public attach(source: ConversationSource | undefined): void {
		this.#unmount();
		this.#feed?.dispose();
		this.#unsubscribe?.();
		this.#feed = undefined;
		this.#unsubscribe = undefined;
		if (source === undefined) this.#waiting = false;
		else {
			this.#feed = new AgentConversationFeed(source, this.#ui, this.#cwd);
			this.#unsubscribe = source.subscribe((event) => {
				if (event.type === "agent_start") this.#waiting = true;
				else if (event.type === "agent_end") this.#waiting = false;
				else if (event.type === "message_update" && event.message.role === "assistant") {
					// The feed hides thinking, so only a part it draws ends the wait.
					if (event.message.content.some((part) => part.type !== "thinking")) this.#waiting = false;
				}
			});
		}
		if (this.#document !== undefined) this.#mount();
	}

	/** Show or hide the dim `…`; on from the submit, since the first question waits for its session to be built. */
	public setWaiting(on: boolean): void {
		this.#waiting = on;
		this.#tui?.requestRender();
	}

	#mount(): void {
		const document = this.#document;
		if (document === undefined || this.#marker === undefined) return;
		this.#unmount();
		document.addChild(this.#marker);
		if (this.#feed !== undefined) document.addChild(this.#feed);
		document.addChild(this.#placeholder);
		this.#settle();
	}

	#unmount(): void {
		const document = this.#document;
		if (document === undefined) return;
		for (const component of [this.#marker, this.#feed, this.#placeholder]) if (component !== undefined) document.removeChild(component);
	}

	#settle(): void {
		// Only the fullscreen renderer has it; inline mode redraws the whole screen instead.
		const scrollToBottom = member(this.#tui, "scrollToBottom");
		if (typeof scrollToBottom === "function") scrollToBottom.call(this.#tui);
		this.#tui?.requestRender();
	}
}
