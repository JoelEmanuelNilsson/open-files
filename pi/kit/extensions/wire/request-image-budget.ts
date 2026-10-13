import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ContextEditableContent, ContextEditEntryDraft, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

const IMAGE_CUT_TRIGGER_SHARE = 0.75;
const IMAGE_CUT_TARGET_SHARE = 0.5;

/** One cut: how many images left the conversation and how many bytes it freed. */
export interface ImageCut {
	images: number;
	bytes: number;
}

/** One seat's request image budget; the held cut lives in the instance. */
export interface RequestImageBudget {
	fitContext(messages: AgentMessage[], model: Model<Api> | undefined): { messages: AgentMessage[]; cut: ImageCut | undefined };
	recordImageCut(entries: readonly ProjectedSessionEntry[]): ContextEditEntryDraft[];
	forgetImageCut(): void;
}

type ContentBlock = { readonly type: string };

interface Budget {
	triggerBytes: number;
	targetBytes: number;
	triggerCount: number;
	targetCount: number;
}

/** Create one seat's budget. */
export function createRequestImageBudget(): RequestImageBudget {
	let held = new Map<string, string>();

	return {
		fitContext(messages, model) {
			const budget = budgetOf(model);
			const current = stubImages(messages, held);
			if (budget === undefined) return { messages: current, cut: undefined };
			const images = imageOccurrences(current);
			if (images.length === 0) return { messages: current, cut: undefined };
			let bytes = Buffer.byteLength(JSON.stringify(current));
			let count = images.length;
			if (bytes <= budget.triggerBytes && count <= budget.triggerCount) return { messages: current, cut: undefined };
			const before = bytes;
			const chosen = new Map<string, string>();
			for (const image of images) {
				if (bytes <= budget.targetBytes && count <= budget.targetCount) break;
				const stub = chosen.get(image.block.data) ?? imageStubText(image.source);
				chosen.set(image.block.data, stub);
				bytes -= Buffer.byteLength(JSON.stringify(image.block)) - Buffer.byteLength(JSON.stringify(stubBlock(stub)));
				count--;
			}
			held = new Map([...held, ...chosen]);
			return { messages: stubImages(messages, held), cut: { images: chosen.size, bytes: before - bytes } };
		},

		recordImageCut(entries) {
			if (held.size === 0) return [];
			const drafts: ContextEditEntryDraft[] = [];
			for (const { sourceEntry, messages } of entries) {
				const editable = sourceEntry.type === "custom_message" || (sourceEntry.type === "message" && ["user", "assistant", "toolResult"].includes(sourceEntry.message.role));
				if (!editable || messages.length !== 1) continue;
				const [message] = messages;
				const [edited] = stubImages([message], held);
				if (edited === message || !("content" in edited) || !Array.isArray(edited.content)) continue;
				// SAFETY: edited.content is array content of a user, assistant or toolResult message, the editable shapes checked above
				drafts.push({ type: "context_edit", targetId: sourceEntry.id, replacement: { content: edited.content as ContextEditableContent } });
			}
			held = new Map();
			return drafts;
		},

		forgetImageCut() {
			held = new Map();
		},
	};
}

function budgetOf(model: Model<Api> | undefined): Budget | undefined {
	const maxBytes = model?.inputLimits?.maxRequestBytes;
	if (maxBytes === undefined) return undefined;
	const maxCount = model?.inputLimits?.images?.maxPerRequest ?? Number.POSITIVE_INFINITY;
	return {
		triggerBytes: maxBytes * IMAGE_CUT_TRIGGER_SHARE,
		targetBytes: maxBytes * IMAGE_CUT_TARGET_SHARE,
		triggerCount: maxCount,
		targetCount: Math.floor(maxCount * IMAGE_CUT_TARGET_SHARE),
	};
}

interface ImageOccurrence {
	block: ImageContent;
	source: string;
}

function imageOccurrences(messages: readonly AgentMessage[]): ImageOccurrence[] {
	const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	const found: ImageOccurrence[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") toolCalls.set(block.id, block);
			continue;
		}
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		const source = sourceOf(message, toolCalls);
		// SAFETY: image blocks live only in array content, and the type guard isImageBlock checks each block
		for (const block of message.content as readonly ContentBlock[]) if (isImageBlock(block)) found.push({ block, source });
	}
	return found;
}

function sourceOf(message: AgentMessage, toolCalls: ReadonlyMap<string, { name: string; arguments: Record<string, unknown> }>): string {
	if (message.role === "toolResult") {
		const call = toolCalls.get(message.toolCallId);
		const path = call?.arguments.path ?? call?.arguments.file_path;
		return typeof path === "string" ? `${message.toolName} of ${path}` : `a ${message.toolName} result`;
	}
	if (message.role === "user") return "attached to a user message";
	if (message.role === "custom") return `in a ${message.customType} message`;
	return `in a ${message.role} message`;
}

function imageStubText(source: string): string {
	return `[Image removed from context to keep the request under the provider's size limit: ${source}. Read it again if you still need it.]`;
}

function isImageBlock(block: ContentBlock): block is ImageContent {
	return block.type === "image";
}

function stubBlock(text: string): TextContent {
	return { type: "text", text };
}

function stubImages(messages: AgentMessage[], held: ReadonlyMap<string, string>): AgentMessage[] {
	if (held.size === 0) return messages;
	let changed = false;
	const next = messages.map((message) => {
		if (!("content" in message) || !Array.isArray(message.content)) return message;
		// SAFETY: Array.isArray above confirmed content is an array; blocks are checked by isImageBlock
		const content = message.content as readonly ContentBlock[];
		if (!content.some((block) => isImageBlock(block) && held.has(block.data))) return message;
		changed = true;
		const stubbed = content.map((block) => {
			if (!isImageBlock(block)) return block;
			const stub = held.get(block.data);
			return stub === undefined ? block : stubBlock(stub);
		});
		// SAFETY: stubbing replaces only image blocks inside content, so the message keeps its role-specific shape
		return { ...message, content: stubbed } as AgentMessage;
	});
	return changed ? next : messages;
}
