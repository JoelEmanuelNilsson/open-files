import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { processShared } from "../process/process-shared-state.ts";

/** The request as the provider saw it, with the envelope it went out in. */
export interface LastRequest {
	readonly payload: Record<string, unknown>;
	readonly headers: ProviderHeaders;
	readonly model: Model<Api>;
	readonly sessionId: string;
	readonly leafId: string | null;
}

const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "cf-aig-authorization"];

const isCredential = (name: string): boolean => CREDENTIAL_HEADERS.includes(name.toLowerCase());

const modelKey = (model: { readonly provider: string; readonly id: string }): string => `${model.provider}/${model.id}`;

const lastRequests = (): Map<string, Map<string, LastRequest>> => processShared("__piKitLastRequests", () => new Map<string, Map<string, LastRequest>>());

/** Keep this request as its session's last one for its model; keyed by session because subagents share the process. */
export function publishLastRequest(request: LastRequest): void {
	const seat = lastRequests().get(request.sessionId) ?? new Map<string, LastRequest>();
	seat.set(modelKey(request.model), request);
	lastRequests().set(request.sessionId, seat);
}

/** This session's last request for the model asked about, or undefined before its first one. */
export function readLastRequest(sessionId: string, model: { readonly provider: string; readonly id: string }): LastRequest | undefined {
	return lastRequests().get(sessionId)?.get(modelKey(model));
}

/** Drop a session's requests when it ends, so the seam holds one entry per live session. */
export function forgetLastRequests(sessionId: string): void {
	lastRequests().delete(sessionId);
}

export function replayHeaders(captured: ProviderHeaders, resolved: ProviderHeaders | undefined): ProviderHeaders {
	const headers: ProviderHeaders = {};
	for (const [name, value] of Object.entries(captured)) {
		if (!isCredential(name)) headers[name] = value;
	}
	for (const [name, value] of Object.entries(resolved ?? {})) {
		if (isCredential(name)) headers[name] = value;
	}
	return headers;
}
