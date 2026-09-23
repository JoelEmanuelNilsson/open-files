/**
 * A subagent's conversation as the components the main transcript is made of.
 *
 * Subagents run in this process, and every one of them carries a live pi
 * session: `messages` plus `subscribe`, the same stream the main screen is
 * drawn from. This mirrors pi's own `renderSessionItems` / `handleEvent`
 * (`interactive-mode.js`) onto that stream — the same `UserMessageComponent`,
 * `AssistantMessageComponent` and `ToolExecutionComponent`, built the same way.
 *
 * `ToolExecutionComponent` is what calls a tool's `renderCall` / `renderResult`,
 * and the subagent's session registers the same kit tools this one does, so its
 * rows come out as receipts (`● Bash(npm test)` / `⎿  41 passed`) for free.
 * Nothing in the kit's transcript grammar is restated here.
 *
 * **Rows drawn here are off the transcript.** The transcript planner keeps one
 * process-wide map of rows in flight and hollows every one of them out when the
 * *main* run settles (`row.ts` `quiesce`). A subagent keeps running after the
 * main run settles, so its rows are handed a tool definition whose renderers
 * mark the row `offTranscript` first, and `watch` leaves those alone. Rollups
 * are the other half of the same planner and are per-process too, so a
 * subagent's rows have no seats and every row draws itself: no `Ran 3 shell
 * commands` line in a box. That is the declared limit of this view.
 *
 * Thinking is hidden. The box exists to read what an agent did, not to watch it
 * think; the main transcript already makes the same choice.
 */

import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";

import { rowState } from "../transcript/row.ts";

/**
 * What the feed needs from a subagent's session, restated so the view is
 * testable with a fake and so it depends on the documented surface only.
 */
export interface ConversationSource {
	/** pi's own message type, so a real `AgentSession` satisfies this as it stands. */
	readonly messages: readonly AgentMessage[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	getToolDefinition(name: string): ToolDefinition | undefined;
}

/** The TUI surface the feed uses: only the redraw request. */
type FeedUi = Pick<TUI, "requestRender">;

/** Options pi's tool component takes; images stay off in a box. */
const TOOL_OPTIONS = { showImages: false } as const;

/** Whether an assistant message ended in an error or an abort. */
function stopReasonText(message: AssistantMessage): string | undefined {
	if (message.stopReason === "aborted") return "Operation aborted";
	if (message.stopReason === "error") return message.errorMessage || "Error";
	return undefined;
}

/** Text of a user message: string content or its text parts joined. */
function userText(message: Message & { role: "user" }): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/**
 * Wrap a tool definition so its rows are marked off the transcript before the
 * kit's renderer sees them. See the header.
 */
export function offTranscript(definition: ToolDefinition | undefined): ToolDefinition | undefined {
	if (definition === undefined) return undefined;
	const { renderCall, renderResult } = definition;
	const marked: ToolDefinition = { ...definition };
	if (renderCall) {
		marked.renderCall = (args, theme, context) => {
			rowState(context).offTranscript = true;
			return renderCall(args, theme, context);
		};
	}
	if (renderResult) {
		marked.renderResult = (result, options, theme, context) => {
			rowState(context).offTranscript = true;
			return renderResult(result, options, theme, context);
		};
	}
	return marked;
}

/**
 * The components for one subagent's conversation, kept live.
 *
 * `render` is the whole of the output: the container's lines, in order. The
 * caller owns the viewport. `dispose` stops following the session.
 */
export class AgentConversationFeed implements Component {
	private readonly container = new Container();
	private readonly source: ConversationSource;
	private readonly ui: FeedUi;
	private readonly cwd: string;
	/** Tool rows that have not received a result, by call id — pi's `pendingTools`. */
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private streaming: AssistantMessageComponent | undefined;
	private unsubscribe: (() => void) | undefined;

	public constructor(source: ConversationSource, ui: FeedUi, cwd: string) {
		this.source = source;
		this.ui = ui;
		this.cwd = cwd;
		this.rebuild();
		this.unsubscribe = source.subscribe((event) => this.handleEvent(event));
	}

	public render(width: number): string[] {
		return this.container.render(width);
	}

	public invalidate(): void {
		this.container.invalidate();
	}

	public dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/** Number of components, for tests that count what an event added. */
	public get size(): number {
		return this.container.children.length;
	}

	// ---- history ----

	/** pi's `renderSessionItems`: history first, then the live stream continues it. */
	private rebuild(): void {
		this.container.clear();
		this.pendingTools.clear();
		this.streaming = undefined;
		const awaitingResult = new Map<string, ToolExecutionComponent>();
		for (const message of this.source.messages) {
			if (message.role === "assistant") {
				this.addAssistant(message);
				const failed = stopReasonText(message);
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const component = this.addTool(part.name, part.id, part.arguments);
					if (failed !== undefined) component.updateResult({ content: [{ type: "text", text: failed }], isError: true });
					else awaitingResult.set(part.id, component);
				}
			} else if (message.role === "toolResult") {
				const component = awaitingResult.get(message.toolCallId);
				if (component === undefined) continue;
				component.updateResult(message);
				awaitingResult.delete(message.toolCallId);
			} else if (message.role === "user") {
				this.addUser(message);
			}
		}
		for (const [id, component] of awaitingResult) this.pendingTools.set(id, component);
	}

	// ---- live ----

	/** pi's `handleEvent`, the cases a conversation box draws. */
	private handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "user") this.addUser(event.message);
				else if (event.message.role === "assistant") {
					this.streaming = this.addAssistant(undefined);
					this.streaming.updateContent(event.message, true);
				}
				break;
			case "message_update":
				if (this.streaming === undefined || event.message.role !== "assistant") return;
				this.streaming.updateContent(event.message, true);
				for (const part of event.message.content) {
					if (part.type !== "toolCall") continue;
					const known = this.pendingTools.get(part.id);
					if (known) known.updateArgs(part.arguments);
					else this.pendingTools.set(part.id, this.addTool(part.name, part.id, part.arguments));
				}
				break;
			case "message_end": {
				if (this.streaming === undefined || event.message.role !== "assistant") return;
				this.streaming.updateContent(event.message, false);
				const failed = stopReasonText(event.message);
				for (const component of this.pendingTools.values()) {
					if (failed !== undefined) component.updateResult({ content: [{ type: "text", text: failed }], isError: true });
					else component.setArgsComplete();
				}
				if (failed !== undefined) this.pendingTools.clear();
				this.streaming = undefined;
				break;
			}
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (component === undefined) {
					component = this.addTool(event.toolName, event.toolCallId, event.args);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				break;
			}
			case "tool_execution_update":
				this.pendingTools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component === undefined) return;
				component.updateResult({ ...event.result, isError: event.isError });
				this.pendingTools.delete(event.toolCallId);
				break;
			}
			case "agent_end":
				// A stream cut off mid-message leaves a half component; pi removes it
				// and so does this.
				if (this.streaming !== undefined) {
					this.container.removeChild(this.streaming);
					this.streaming = undefined;
				}
				this.pendingTools.clear();
				break;
			default:
				return;
		}
		this.ui.requestRender();
	}

	// ---- components ----

	private addUser(message: Message & { role: "user" }): void {
		const text = userText(message);
		if (text === "") return;
		this.container.addChild(new UserMessageComponent(text, getMarkdownTheme(), 0));
	}

	private addAssistant(message: AssistantMessage | undefined): AssistantMessageComponent {
		const component = new AssistantMessageComponent(message, true, getMarkdownTheme(), undefined, 0);
		this.container.addChild(component);
		return component;
	}

	private addTool(name: string, id: string, args: unknown): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			name,
			id,
			args,
			TOOL_OPTIONS,
			offTranscript(this.source.getToolDefinition(name)),
			this.ui as TUI,
			this.cwd,
		);
		this.container.addChild(component);
		return component;
	}
}
