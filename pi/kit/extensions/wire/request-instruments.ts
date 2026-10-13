import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CacheUsage } from "../../lib/cache/cache-usage.ts";
import { ttlFromPayload } from "../../lib/cache/anthropic-cache-policy.ts";
import { notice, noticeSinkDir } from "../../lib/process/human-notice.ts";
import { ensurePrivateDir } from "../../lib/process/kit-state-dir.ts";
import { readSideRequestBasis } from "../../lib/session/side-seat.ts";
import { forgetCacheTouch, publishCacheWrite } from "../../lib/wire/cache-touch.ts";
import { forgetLastRequests, publishLastRequest } from "../../lib/wire/last-request.ts";
import { renderWireCapture, type WireCapture } from "../../lib/wire/wire-capture.ts";
import { type AnthropicWireRequest, captureAnthropicWire } from "./anthropic-request.ts";
import { type BreakReport, breakIsFault, describeBreak, type KnownCause } from "./cache-break.ts";
import { captureCodexWire, type CodexWireRequest } from "./codex-request.ts";
import type { QuotaReading } from "./quota-meter.ts";
import { createWireTrace, type WireTrace } from "./wire-trace.ts";
import { rebilledTokens, traceDir } from "./wire-trace-ledger.ts";
import type { AnthropicTarget } from "./wire-seat.ts";

/** One wire instance's request instruments; every piece of their state lives in the instance. */
export interface RequestInstruments {
	headersStaged(headers: ProviderHeaders): void;
	codexRequestSent(ctx: ExtensionContext, model: Model<Api>, sent: CodexWireRequest): void;
	anthropicRequestSent(ctx: ExtensionContext, target: AnthropicTarget, sent: AnthropicWireRequest): void;
	transcriptChanged(cause: KnownCause, sessionId: string): void;
	warmSent(sessionId: string, model: string): void;
	responseArrived(status: number, requestId: string | undefined): void;
	usageSettled(ctx: ExtensionContext, usage: CacheUsage, quota: QuotaReading | undefined): void;
	sessionEnded(reason: string): void;
	notifyPromptDump(ctx: ExtensionContext): void;
	notifyTraceSummary(ctx: ExtensionContext): void;
}

/** Create the request instruments of one wire instance. */
export function createRequestInstruments(): RequestInstruments {
	let lastWire: WireCapture | undefined;
	let trace: WireTrace | undefined;
	let lastBreak: BreakReport | undefined;
	let pendingHeaders: ProviderHeaders = {};
	let knownCause: KnownCause | undefined;
	let publishedFor: string | undefined;

	return {
		headersStaged(headers) {
			pendingHeaders = { ...headers };
		},
		codexRequestSent(ctx, model, sent) {
			lastWire = captureCodexWire(ctx, model, sent, pendingHeaders);
		},
		anthropicRequestSent(ctx, target, sent) {
			const { model } = target;
			const next = sent.payload;
			const sessionId = ctx.sessionManager.getSessionId();
			trace ??= createWireTrace(sessionId);
			lastWire = captureAnthropicWire(ctx, target.oauth, sent);
			const ttlMs = ttlFromPayload(next);
			const cause = knownCause;
			if (!sent.sideSeat) knownCause = undefined;
			trace.request(next, {
				cause,
				model: model.id,
				degraded: sent.degraded,
				ttlMin: (ttlMs ?? 0) / 60_000 || undefined,
			});
			if (ttlMs !== undefined && !sent.sideSeat) publishCacheWrite(sessionId, ttlMs, Date.now());
			const rewrite = trace.takeRewrite();
			if (rewrite !== undefined) notice(ctx, `wire: ${rewrite.text}`, rewrite.severity);
			if (sent.sideSeat) return;
			publishedFor = sessionId;
			publishLastRequest({ payload: next, headers: pendingHeaders, model, sessionId, leafId: ctx.sessionManager.getLeafId() });
		},
		transcriptChanged(cause, sessionId) {
			knownCause = cause;
			forgetLastRequests(sessionId);
			forgetCacheTouch(sessionId);
		},
		warmSent(sessionId, model) {
			trace ??= createWireTrace(sessionId);
			trace.warm(model);
		},
		responseArrived(status, requestId) {
			trace?.response(status, requestId);
		},
		usageSettled(ctx, usage, quota) {
			const report = trace?.usage(usage, quota);
			if (report === undefined) return;
			lastBreak = report;
			if (readSideRequestBasis(ctx.sessionManager.getSessionId()) !== undefined) return;
			notice(ctx, `wire: ${describeBreak(report)}`, breakIsFault(report.verdict) ? "warning" : "info");
		},
		sessionEnded(reason) {
			if (publishedFor !== undefined && reason !== "reload") {
				forgetLastRequests(publishedFor);
				forgetCacheTouch(publishedFor);
			}
		},
		notifyPromptDump(ctx) {
			if (lastWire === undefined) {
				notice(ctx, "No provider request captured yet this runtime.", "warning");
				return;
			}
			const path = join(ensurePrivateDir(traceDir()), `prompt-${ctx.sessionManager.getSessionId()}.md`);
			writeFileSync(path, renderWireCapture(lastWire), { encoding: "utf8", mode: 0o600 });
			chmodSync(path, 0o600);
			notice(ctx, `Wire prompt (${lastWire.model}, ${lastWire.at.toISOString()}) dumped to ${path}`, "info");
		},
		notifyTraceSummary(ctx) {
			if (trace === undefined) {
				notice(ctx, "No provider request traced yet this runtime.", "warning");
				return;
			}
			const last = lastBreak ? describeBreak(lastBreak) : "no cache break yet";
			const rebilled = rebilledTokens(trace.path);
			const cost = rebilled > 0 ? `, ${rebilled.toLocaleString()} tokens re-billed across every break` : "";
			notice(ctx, `Wire trace: ${trace.path} — ${last}${cost} — headless notices: ${noticeSinkDir()}`, "info");
		},
	};
}
