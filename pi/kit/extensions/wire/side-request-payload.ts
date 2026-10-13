import { isDeepStrictEqual } from "node:util";

type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown };
type BlockAt = { message: number; block: number };

export function buildSideRequest(
	mainPayload: Record<string, unknown>,
	sidePayload: Record<string, unknown>,
): { payload: Record<string, unknown>; prefixMatched: boolean } {
	const next = structuredClone(mainPayload);
	const mainMessages: Message[] = Array.isArray(next.messages) ? next.messages : [];
	const sideMessages: Message[] = Array.isArray(sidePayload.messages) ? structuredClone(sidePayload.messages) : [];

	const anchorAt = lastBreakpoint(mainMessages);
	const anchor = anchorAt === undefined ? undefined : blockAt(mainMessages, anchorAt);
	const anchorCc = anchor?.cache_control;
	const sideAt = lastBreakpoint(sideMessages);
	const sideCc = sideAt === undefined ? undefined : blockAt(sideMessages, sideAt)?.cache_control;
	const tailAt = sideAt ?? lastWritableBlock(sideMessages);

	const i = anchorAt?.message ?? -1;
	const prefixMatched =
		anchorCc !== undefined &&
		sideMessages.length > i + 1 &&
		isDeepStrictEqual(mainMessages.slice(0, i + 1).map(normalised), sideMessages.slice(0, i + 1).map(normalised));
	const messages = prefixMatched ? [...mainMessages.slice(0, i + 1), ...sideMessages.slice(i + 1)] : sideMessages;
	for (const message of messages) stripBreakpoints(message);

	if (prefixMatched && anchorAt !== undefined) {
		const block = blockAt(messages, anchorAt);
		if (block !== undefined) block.cache_control = anchorCc;
	}
	const tailCc = anchorCc ?? systemBreakpoint(next.system) ?? sideCc;
	if (tailAt !== undefined && isRecord(tailCc)) {
		const block = blockAt(messages, tailAt);
		if (block !== undefined) block.cache_control = { ...tailCc };
	}
	next.messages = messages;
	return { payload: next, prefixMatched };
}

function lastBreakpoint(messages: readonly Message[]): BlockAt | undefined {
	for (let m = messages.length - 1; m >= 0; m--) {
		const content = messages[m]?.content;
		if (!Array.isArray(content)) continue;
		for (let b = content.length - 1; b >= 0; b--) {
			if (isRecord(content[b]) && content[b].cache_control !== undefined) return { message: m, block: b };
		}
	}
	return undefined;
}

function lastWritableBlock(messages: Message[]): BlockAt | undefined {
	for (let m = messages.length - 1; m >= 0; m--) {
		const message = messages[m];
		if (message === undefined || message.role === "assistant") continue;
		if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
		if (Array.isArray(message.content) && message.content.length > 0) return { message: m, block: message.content.length - 1 };
	}
	return undefined;
}

function blockAt(messages: readonly Message[], at: BlockAt): Block | undefined {
	const content = messages[at.message]?.content;
	const block = Array.isArray(content) ? content[at.block] : undefined;
	return isRecord(block) ? block : undefined;
}

function stripBreakpoints(message: Message): void {
	if (!Array.isArray(message.content)) return;
	for (const block of message.content) if (isRecord(block)) delete block.cache_control;
}

function normalised(message: Message): unknown {
	const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	if (!Array.isArray(content)) return message;
	return {
		...message,
		content: content.map((block) => {
			if (!isRecord(block)) return block;
			const { cache_control: _dropped, ...rest } = block;
			return rest;
		}),
	};
}

function systemBreakpoint(system: unknown): unknown {
	if (!Array.isArray(system)) return undefined;
	return [...system].reverse().find((block) => isRecord(block) && block.cache_control !== undefined)?.cache_control;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
