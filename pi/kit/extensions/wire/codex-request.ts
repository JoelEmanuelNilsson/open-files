import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexInstructions } from "../../lib/wire/owned-prompt.ts";
import { captureWire, type WireCapture } from "../../lib/wire/wire-capture.ts";
import { seatOwnedPrompt, seatWireTools } from "./wire-seat.ts";

/** The ChatGPT-subscription API: GPT seats on `openai-codex`. */
export const CODEX_API = "openai-codex-responses";

/** One Codex request as it leaves: pi's body with the owned instructions and the seat's tools. */
export interface CodexWireRequest {
	payload: Record<string, unknown>;
	original: Record<string, unknown>;
	input: unknown[];
	instructions: string;
	tools: unknown[] | undefined;
	degraded: boolean;
}

/** Build the request this seat sends in place of pi's payload, or undefined for a payload that is not a Responses request. */
export function buildCodexWireRequest(ctx: ExtensionContext, payload: unknown, chatSeat: boolean): CodexWireRequest | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
	const { text, degraded } = seatOwnedPrompt(ctx, chatSeat, undefined);
	const instructions = codexInstructions(text, ctx.cwd);
	const tools = seatWireTools(payload.tools);
	return { payload: { ...payload, instructions, ...(tools ? { tools } : {}) }, original: payload, input: payload.input, instructions, tools, degraded };
}

/** What `/prompt` shows for a Codex request: its one instructions block, pi's input, and the headers pi handed over. */
export function captureCodexWire(ctx: ExtensionContext, model: Model<Api>, sent: CodexWireRequest, headers: ProviderHeaders): WireCapture {
	const { original } = sent;
	return captureWire({
		api: CODEX_API,
		at: new Date(),
		model: typeof original.model === "string" ? original.model : model.id,
		oauth: ctx.modelRegistry.isUsingOAuth(model),
		degraded: sent.degraded,
		system: [{ type: "text", text: sent.instructions }],
		headers: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
		tools: sent.tools ?? original.tools,
		messages: sent.input,
		payload: original,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
