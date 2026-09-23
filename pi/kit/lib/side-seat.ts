/**
 * The side seat: an in-process child session answering `/btw` questions whose
 * requests `wire` sends as main's last request (R_k) with only `messages`
 * replaced, so the side reads main's cached prefix instead of writing its own.
 *
 * Keyed by the child's session id and published before that session exists,
 * like `lib/seat.ts`'s engine children: wire must recognise the side seat from
 * its first request, cold path included.
 */

import { isDeepStrictEqual } from "node:util";
import { shared } from "./shared.ts";

/** What a side seat's requests are built from: main's session and main's last payload. */
export interface SideRequestBasis {
	readonly mainSessionId: string;
	/** A private clone of main's last Anthropic payload; `undefined` sends the side request cold. */
	readonly mainPayload: Record<string, unknown> | undefined;
}

const sideSeats = (): Map<string, SideRequestBasis> => shared("__piKitSideSeats", () => new Map<string, SideRequestBasis>());

/** Declare `sideSessionId` a side seat of `basis.mainSessionId`; the payload is cloned here. */
export function publishSideRequestBasis(sideSessionId: string, basis: SideRequestBasis): void {
	// Cloned on publish because session-mode rewrites cache_control TTLs on main's
	// live payload by reference, and the keep-warm ping reuses that object.
	sideSeats().set(sideSessionId, {
		mainSessionId: basis.mainSessionId,
		mainPayload: basis.mainPayload === undefined ? undefined : structuredClone(basis.mainPayload),
	});
}

/** The basis a side seat's next request is built from, or undefined for any other session. */
export function readSideRequestBasis(sideSessionId: string): SideRequestBasis | undefined {
	return sideSeats().get(sideSessionId);
}

/** Drop a side seat once its session is disposed. */
export function forgetSideRequestBasis(sideSessionId: string): void {
	sideSeats().delete(sideSessionId);
}

type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown };
type BlockAt = { message: number; block: number };

/**
 * Pure: `mainPayload` with `messages` replaced by `sidePayload`'s, and message
 * breakpoints moved to main's old breakpoint (a cache read of main's prefix)
 * and the side's last block (a write of the side turns only).
 */
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
	// R_k's own prefix bytes, so the anchor reads exactly what main wrote.
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

/** Where the last message-level `cache_control` sits, pi-ai's one message breakpoint. */
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

/** The last block of the last non-assistant message with content; a string content becomes one text block. */
function lastWritableBlock(messages: Message[]): BlockAt | undefined {
	for (let m = messages.length - 1; m >= 0; m--) {
		const message = messages[m];
		// A breakpoint on an assistant message could land on a thinking block, which the API refuses.
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

/**
 * The message as the provider caches it: pi-ai turns string content into one
 * text block only on the message that carries the breakpoint, so the same
 * message is a string on one request and an array on another.
 */
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
