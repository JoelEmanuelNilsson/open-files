import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";

import type { ConversationSource } from "../session/prompt-focus.ts";
import { rowState } from "./tool-row.ts";

type FeedUi = Pick<TUI, "requestRender">;

const TOOL_OPTIONS = { showImages: false } as const;

function stopReasonText(message: AssistantMessage): string | undefined {
	if (message.stopReason === "aborted") return "Operation aborted";
	if (message.stopReason === "error") return message.errorMessage || "Error";
	return undefined;
}

function userText(message: Message & { role: "user" }): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

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

export class AgentConversationFeed implements Component {
	private readonly container = new Container();
	private readonly source: ConversationSource;
	private readonly ui: FeedUi;
	private readonly cwd: string;
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

	public get size(): number {
		return this.container.children.length;
	}

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
				if (event.message.role !== "assistant") return;
				this.streaming ??= this.addAssistant(undefined);
				this.streaming.updateContent(event.message, true);
				for (const part of event.message.content) {
					if (part.type !== "toolCall") continue;
					const known = this.pendingTools.get(part.id);
					if (known) known.updateArgs(part.arguments);
					else this.pendingTools.set(part.id, this.addTool(part.name, part.id, part.arguments));
				}
				break;
			case "message_end": {
				if (event.message.role !== "assistant") return;
				this.streaming ??= this.addAssistant(undefined);
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
			// SAFETY: the feed is constructed with the TUI as its ui; the field is typed wider for tests
			this.ui as TUI,
			this.cwd,
		);
		this.container.addChild(component);
		return component;
	}
}
