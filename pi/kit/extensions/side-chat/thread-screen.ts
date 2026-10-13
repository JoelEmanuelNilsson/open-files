import { type Component, type Container, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

import type { ConversationSource, FocusTarget, FocusTheme } from "../../lib/session/prompt-focus.ts";
import { AgentConversationFeed } from "../../lib/transcript/agent-conversation-feed.ts";

/** pi's prompt editor (`CustomEditor`) as the prompt focus reads it: structurally, since jiti splits class identity. */
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
	// SAFETY: value is a non-null object; the read yields unknown and callers narrow it
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
	// SAFETY: pi's Container.children is Component[]; Array.isArray verified the container shape
	return Array.isArray(children) ? (children as Component[]) : undefined;
}

/** The prompt editor, when it holds the keyboard: `tui.children[4]` is pi's editor container. */
export function focusedPromptEditor(tui: TUI): PromptEditor | undefined {
	const editor = childrenOf(childrenOf(tui)?.[4])?.[0];
	const focused = member(tui, "getFocusedComponent");
	return editor !== undefined && typeof focused === "function" && editor === focused.call(tui) && isPromptEditor(editor) ? editor : undefined;
}

function transcriptDocument(tui: TUI): { document: Container } | { drift: string } {
	const mounted = childrenOf(tui);
	if (mounted === undefined || mounted.length !== 7) return { drift: `the screen mounts ${mounted?.length ?? "no"} components, not pi's 7` };
	const document = mounted[0];
	const parts = childrenOf(document);
	if (parts === undefined || parts.length !== 3 || !parts.every((part) => childrenOf(part) !== undefined)) {
		return { drift: "the transcript document is not [header, resources, chat]" };
	}
	if (focusedPromptEditor(tui) === undefined) return { drift: "the prompt editor is not the focused component in pi's editor container" };
	// SAFETY: focusedPromptEditor above verified the tui's focused component sits in this document's editor container
	return { document: document as Container };
}

type ThreadFeedSlot = Component & { readonly source: ConversationSource | undefined };

/** The marker, the focused thread's feed and its status rows, below or in place of main's transcript while a prompt target is focused. */
export class ThreadScreen {
	readonly #cwd: string;
	#tui: TUI | undefined;
	#document: Container | undefined;
	#theme: FocusTheme | undefined;
	#target: FocusTarget | undefined;
	#marker: Component | undefined;
	#hiddenMain: Component[] = [];
	#feed: AgentConversationFeed | undefined;
	#bound: ConversationSource | undefined;
	#unsubscribe: (() => void) | undefined;
	#waiting = false;
	readonly #slot: ThreadFeedSlot;
	readonly #status: Component = {
		render: (width) =>
			this.#target !== undefined && this.#theme !== undefined ? this.#target.statusLines(this.#theme, this.#waiting).map((line) => truncateToWidth(line, width)) : [],
		invalidate: () => {},
	};
	readonly #ui = { requestRender: (): void => this.#tui?.requestRender() };

	public constructor(cwd: string) {
		this.#cwd = cwd;
		const screen = this;
		this.#slot = {
			render: (width) => {
				screen.#sync();
				return screen.#feed?.render(width) ?? [];
			},
			invalidate: () => screen.#feed?.invalidate(),
			get source() {
				return screen.#bound;
			},
		};
	}

	public enter(tui: TUI, theme: FocusTheme, target: FocusTarget): string | undefined {
		this.leave();
		const shape = transcriptDocument(tui);
		if ("drift" in shape) return shape.drift;
		this.#tui = tui;
		this.#theme = theme;
		this.#target = target;
		this.#document = shape.document;
		this.#marker = new Text(theme.fg(target.marker.color, target.marker.text), 1, 1);
		this.#sync();
		this.#mount();
		return undefined;
	}

	public leave(): void {
		const document = this.#document;
		if (document === undefined) return;
		this.#unmount();
		this.#unbind();
		this.#document = undefined;
		this.#target = undefined;
		this.#waiting = false;
		document.invalidate();
		this.#settle();
	}

	public refresh(): void {
		this.#sync();
		this.#tui?.requestRender();
	}

	public setWaiting(on: boolean): void {
		this.#waiting = on;
		this.#tui?.requestRender();
	}

	#sync(): void {
		const target = this.#target;
		if (target === undefined) return;
		const next = target.source();
		if (next === this.#bound) return;
		this.#unbind();
		if (next === undefined) {
			this.#waiting = false;
			return;
		}
		this.#bound = next;
		if (next.isStreaming === true) this.#waiting = true;
		this.#feed = new AgentConversationFeed(next, this.#ui, this.#cwd);
		this.#unsubscribe = next.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "turn_start") {
				this.#waiting = true;
				this.#tui?.requestRender();
			} else if (event.type === "agent_end") this.#waiting = false;
			else if (event.type === "message_update" && event.message.role === "assistant") {
				if (event.message.content.some((part) => part.type !== "thinking")) this.#waiting = false;
			}
		});
	}

	#unbind(): void {
		this.#feed?.dispose();
		this.#unsubscribe?.();
		this.#feed = undefined;
		this.#bound = undefined;
		this.#unsubscribe = undefined;
	}

	#mount(): void {
		const document = this.#document;
		if (document === undefined || this.#marker === undefined) return;
		this.#unmount();
		if (this.#target?.placement === "replace") {
			this.#hiddenMain = [...document.children];
			for (const part of this.#hiddenMain) document.removeChild(part);
		}
		document.addChild(this.#marker);
		document.addChild(this.#slot);
		document.addChild(this.#status);
		this.#settle();
	}

	#unmount(): void {
		const document = this.#document;
		if (document === undefined) return;
		for (const component of [this.#marker, this.#slot, this.#status]) if (component !== undefined) document.removeChild(component);
		document.children.unshift(...this.#hiddenMain);
		this.#hiddenMain = [];
	}

	#settle(): void {
		const scrollToBottom = member(this.#tui, "scrollToBottom");
		if (typeof scrollToBottom === "function") scrollToBottom.call(this.#tui);
		this.#tui?.requestRender();
	}
}
