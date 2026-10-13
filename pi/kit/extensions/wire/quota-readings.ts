import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notice } from "../../lib/process/human-notice.ts";
import { type CodexQuotaReading, codexQuotaReport, type QuotaReading, quotaReport, readCodexQuotaHeaders, readQuotaHeaders } from "./quota-meter.ts";

const CODEX_QUOTA_UNREPORTED = "Codex quota: not reported over WebSocket (pi-ai drops the codex.rate_limits event; only an SSE response carries it to extensions)";

/** One wire instance's quota readings, Anthropic OAuth and Codex. */
export interface QuotaReadings {
	codexRequestSent(): void;
	codexResponded(headers: Record<string, string>): void;
	codexAnswered(stopReason: string | undefined): void;
	anthropicResponded(headers: Record<string, string>): void;
	takePendingReading(): QuotaReading | undefined;
	notifyQuota(ctx: ExtensionContext): void;
}

/** Create the quota readings of one wire instance. */
export function createQuotaReadings(): QuotaReadings {
	let pendingQuota: QuotaReading | undefined;
	let lastQuota: QuotaReading | undefined;
	let codexQuota: { kind: "read"; reading: CodexQuotaReading } | { kind: "unreported" } | undefined;
	let codexAwaitingResponse = false;

	return {
		codexRequestSent() {
			codexAwaitingResponse = true;
		},
		codexResponded(headers) {
			codexAwaitingResponse = false;
			const reading = readCodexQuotaHeaders(headers);
			if (reading !== undefined) codexQuota = { kind: "read", reading };
		},
		codexAnswered(stopReason) {
			if (codexAwaitingResponse && stopReason !== "error" && stopReason !== "aborted") codexQuota = { kind: "unreported" };
			codexAwaitingResponse = false;
		},
		anthropicResponded(headers) {
			const reading = readQuotaHeaders(headers);
			if (reading === undefined) return;
			pendingQuota = reading;
			lastQuota = reading;
		},
		takePendingReading() {
			const quota = pendingQuota;
			pendingQuota = undefined;
			return quota;
		},
		notifyQuota(ctx) {
			const claude = quotaReport(lastQuota);
			const codex = codexQuota === undefined ? undefined : codexQuota.kind === "read" ? `Codex quota ${codexQuotaReport(codexQuota.reading)}` : CODEX_QUOTA_UNREPORTED;
			if (claude === undefined && codex === undefined) {
				notice(ctx, "No quota headers seen yet this runtime (Anthropic OAuth and Codex responses only).", "warning");
				return;
			}
			const lines = [...(claude === undefined ? [] : [`Quota ${claude}`]), ...(codex === undefined ? [] : [codex])];
			notice(ctx, lines.join("\n"), "info");
		},
	};
}
