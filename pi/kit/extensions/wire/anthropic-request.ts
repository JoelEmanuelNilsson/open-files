import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { noticeOnce } from "../../lib/process/human-notice.ts";
import { readSideRequestBasis } from "../../lib/session/side-seat.ts";
import { claudeCodeSystem, claudeCodeToolName, firstUserTextOf, isFirstParty, type SystemTextBlock, type TurnPosition } from "../../lib/wire/claude-code.ts";
import { cwdBlockText } from "../../lib/wire/owned-prompt.ts";
import { captureWire, type WireCapture } from "../../lib/wire/wire-capture.ts";
import { buildSideRequest } from "./side-request-payload.ts";
import { type AnthropicTarget, seatClaudeCodeHeaders, seatOwnedPrompt, seatWireTools, subagentIdentityOf } from "./wire-seat.ts";

/** The attribution facts a request carries from its session: this turn's prompt id and position, and the previous response's request id. */
export interface AttributionIds {
	promptId: string;
	previousRequestId: string | undefined;
	turnPosition: TurnPosition | undefined;
}

/** One Anthropic request as it leaves, and what `/prompt` and the instruments read off it. */
export interface AnthropicWireRequest {
	payload: Record<string, unknown>;
	model: string;
	system: SystemTextBlock[];
	tools: unknown;
	degraded: boolean;
	sideSeat: boolean;
}

/** Build the request this seat sends in place of pi's payload, or undefined for a payload that is not a messages request; `payload.model` is only read. */
export function buildAnthropicWireRequest(
	ctx: ExtensionContext,
	target: AnthropicTarget,
	payload: unknown,
	chatSeat: boolean,
	attribution: AttributionIds,
): AnthropicWireRequest | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
	const { model, oauth } = target;
	const existing = Array.isArray(payload.system) ? payload.system.filter(isTextBlock) : [];
	const cacheControl = [...existing].reverse().find((block) => block.cache_control)?.cache_control;

	const { text, degraded } = seatOwnedPrompt(ctx, chatSeat, oauth ? claudeCodeToolName : undefined);
	const prompt: SystemTextBlock = { type: "text", text, ...(cacheControl ? { cache_control: cacheControl } : {}) };
	const cwdBlock: SystemTextBlock = { type: "text", text: cwdBlockText(ctx.cwd) };
	const subagent = subagentIdentityOf(ctx);
	const system: [SystemTextBlock, SystemTextBlock, SystemTextBlock, SystemTextBlock] | [SystemTextBlock, SystemTextBlock] = oauth
		? claudeCodeSystem(
				{
					firstUserText: firstUserTextOf(payload.messages),
					firstParty: isFirstParty(model.baseUrl),
					subagent,
					previousRequestId: attribution.previousRequestId,
					promptId: attribution.promptId,
					turnOrigin: subagent === undefined ? "human" : undefined,
					turnPosition: subagent === undefined ? attribution.turnPosition : undefined,
				},
				prompt,
				cwdBlock,
			)
		: [prompt, cwdBlock];

	const tools = seatWireTools(payload.tools);

	const sideBasis = readSideRequestBasis(ctx.sessionManager.getSessionId());
	const sideMain = sideBasis?.mainPayload !== undefined && sideBasis.mainPayload.model === payload.model ? sideBasis.mainPayload : undefined;
	const side = sideMain === undefined ? undefined : buildSideRequest(sideMain, payload);
	if (side !== undefined && !side.prefixMatched) {
		noticeOnce(ctx, "wire:side-prefix", "side request: main prefix differs from last main request; side reads cold", "info");
	}
	const own = { ...payload, system, ...(tools ? { tools } : {}) };
	const next = side?.payload ?? own;
	const sentSystem = side !== undefined && Array.isArray(next.system) ? next.system.filter(isTextBlock) : system;
	return {
		payload: next,
		model: typeof payload.model === "string" ? payload.model : model.id,
		system: sentSystem,
		tools: side === undefined ? (tools ?? payload.tools) : next.tools,
		degraded,
		sideSeat: sideBasis !== undefined,
	};
}

export function captureAnthropicWire(ctx: ExtensionContext, oauth: boolean, sent: AnthropicWireRequest): WireCapture {
	return captureWire({
		api: "anthropic-messages",
		at: new Date(),
		model: sent.model,
		oauth,
		degraded: sent.degraded,
		system: sent.system,
		headers: oauth ? seatClaudeCodeHeaders(ctx) : {},
		tools: sent.tools,
		messages: sent.payload.messages,
		payload: sent.payload,
	});
}

function isTextBlock(value: unknown): value is SystemTextBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
