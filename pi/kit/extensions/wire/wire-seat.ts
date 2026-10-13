import type { Api, Model } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notice } from "../../lib/process/human-notice.ts";
import { childSeatOf, isChildSeat } from "../../lib/session/seat-identity.ts";
import { readSideRequestBasis } from "../../lib/session/side-seat.ts";
import { canonicalToolOrder } from "../../lib/wire/tools-array-order.ts";
import { claudeCodeHeaders, sessionIdFromPath, type SubagentIdentity, subagentIdentity } from "../../lib/wire/claude-code.ts";
import { inheritedSessionPrompt, ownedSessionPrompt, type SessionLineage } from "../../lib/wire/inherited-prompt.ts";
import { buildChatSystemPrompt, PROMPT_UNAVAILABLE, type WireToolName } from "../../lib/wire/owned-prompt.ts";
import { capturedPromptOptions } from "./prompt-options-capture.ts";

/** What this seat's prompt is built from, as of right now. */
export const seatPromptOptions = (ctx: ExtensionContext): BuildSystemPromptOptions | undefined => capturedPromptOptions(ctx.sessionManager.getSessionId());

export const sessionLineageOf = (ctx: ExtensionContext): SessionLineage => ({
	sessionId: ctx.sessionManager.getSessionId(),
	parentSessionId: sessionIdFromPath(ctx.sessionManager.getHeader()?.parentSession),
});

export const subagentIdentityOf = (ctx: ExtensionContext): SubagentIdentity | undefined => {
	if (readSideRequestBasis(ctx.sessionManager.getSessionId()) !== undefined) return undefined;
	if (!isChildSeat(seatPromptOptions(ctx), process.argv, ctx.sessionManager.getSessionId())) return undefined;
	const { sessionId, parentSessionId } = sessionLineageOf(ctx);
	return subagentIdentity(sessionId, parentSessionId);
};

export interface AnthropicTarget {
	model: Model<Api>;
	oauth: boolean;
	registry: ExtensionContext["modelRegistry"];
}

/** The seat's Anthropic target, or undefined when its model speaks another API. */
export const anthropicTargetOf = (ctx: ExtensionContext): AnthropicTarget | undefined => {
	const model = ctx.model;
	if (model === undefined || model.api !== "anthropic-messages") return undefined;
	const registry = ctx.modelRegistry;
	return { model, oauth: registry.isUsingOAuth(model), registry };
};

/** The Claude Code headers this seat sends: a side seat speaks under main's session id. */
export const seatClaudeCodeHeaders = (ctx: ExtensionContext): Record<string, string> => {
	const side = readSideRequestBasis(ctx.sessionManager.getSessionId());
	if (side !== undefined) return claudeCodeHeaders({ sessionId: side.mainSessionId });
	return claudeCodeHeaders({ sessionId: ctx.sessionManager.getSessionId(), subagent: subagentIdentityOf(ctx) });
};

export const seatOwnedPrompt = (ctx: ExtensionContext, chatSeat: boolean, wireToolName: WireToolName | undefined): { text: string; degraded: boolean } => {
	const captured = seatPromptOptions(ctx);
	const degraded = captured === undefined;
	const childSeat = childSeatOf(ctx.sessionManager.getSessionId());
	const text = chatSeat
		? buildChatSystemPrompt(captured?.appendSystemPrompt)
		: captured === undefined
			? PROMPT_UNAVAILABLE
			: childSeat?.prompt.kind === "inherit"
				? inheritedSessionPrompt(captured, sessionLineageOf(ctx), wireToolName)
				: ownedSessionPrompt(captured, sessionLineageOf(ctx), wireToolName);
	if (degraded && !chatSeat) {
		notice(ctx, "wire: no prompt options were captured for this seat — the request went out declaring it has no system prompt. Send a message to restore it.", "error");
	}
	return { text, degraded };
};

export const seatWireTools = (tools: unknown): unknown[] | undefined => {
	if (!Array.isArray(tools)) return undefined;
	return canonicalToolOrder(tools);
};
