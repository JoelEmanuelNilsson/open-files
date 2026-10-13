/** Fractions used, resets, and the binding window — one response's worth of quota. */
export interface QuotaReading {
	fiveHourUtilization?: number;
	sevenDayUtilization?: number;
	fiveHourResetAtSec?: number;
	sevenDayResetAtSec?: number;
	representativeClaim?: string;
}

const FIVE_HOUR_UTILIZATION_HEADER = "anthropic-ratelimit-unified-5h-utilization";
const SEVEN_DAY_UTILIZATION_HEADER = "anthropic-ratelimit-unified-7d-utilization";
const FIVE_HOUR_RESET_HEADER = "anthropic-ratelimit-unified-5h-reset";
const SEVEN_DAY_RESET_HEADER = "anthropic-ratelimit-unified-7d-reset";
const REPRESENTATIVE_CLAIM_HEADER = "anthropic-ratelimit-unified-representative-claim";

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const direct = headers[name];
	if (typeof direct === "string") return direct;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

function utilizationOf(headers: Record<string, string>, name: string): number | undefined {
	const raw = headerValue(headers, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

function resetSecOf(headers: Record<string, string>, name: string, nowMs: number): number | undefined {
	const raw = headerValue(headers, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value * 1000 <= nowMs) return undefined;
	return Math.round(value);
}

export function readQuotaHeaders(headers: Record<string, string>, nowMs: number = Date.now()): QuotaReading | undefined {
	const reading: QuotaReading = {};
	const fiveHourUtilization = utilizationOf(headers, FIVE_HOUR_UTILIZATION_HEADER);
	if (fiveHourUtilization !== undefined) reading.fiveHourUtilization = fiveHourUtilization;
	const sevenDayUtilization = utilizationOf(headers, SEVEN_DAY_UTILIZATION_HEADER);
	if (sevenDayUtilization !== undefined) reading.sevenDayUtilization = sevenDayUtilization;
	const fiveHourResetAtSec = resetSecOf(headers, FIVE_HOUR_RESET_HEADER, nowMs);
	if (fiveHourResetAtSec !== undefined) reading.fiveHourResetAtSec = fiveHourResetAtSec;
	const sevenDayResetAtSec = resetSecOf(headers, SEVEN_DAY_RESET_HEADER, nowMs);
	if (sevenDayResetAtSec !== undefined) reading.sevenDayResetAtSec = sevenDayResetAtSec;
	const claim = headerValue(headers, REPRESENTATIVE_CLAIM_HEADER);
	if (claim !== undefined && claim.length > 0) reading.representativeClaim = claim;
	return Object.keys(reading).length === 0 ? undefined : reading;
}

/** One Codex window: how much of it is used, how long it is, when it resets. */
export interface CodexQuotaWindow {
	utilization: number;
	windowMinutes?: number;
	resetAtSec?: number;
}

/** One Codex response's worth of quota: the primary and secondary windows. */
export interface CodexQuotaReading {
	primary?: CodexQuotaWindow;
	secondary?: CodexQuotaWindow;
}

function codexWindowOf(headers: Record<string, string>, window: "primary" | "secondary", nowMs: number): CodexQuotaWindow | undefined {
	const raw = headerValue(headers, `x-codex-${window}-used-percent`);
	if (raw === undefined) return undefined;
	const percent = Number(raw);
	if (!Number.isFinite(percent)) return undefined;
	const minutes = Number(headerValue(headers, `x-codex-${window}-window-minutes`));
	const windowMinutes = Number.isInteger(minutes) && minutes > 0 ? minutes : undefined;
	const resetAtSec = resetSecOf(headers, `x-codex-${window}-reset-at`, nowMs);
	if (percent === 0 && windowMinutes === undefined && resetAtSec === undefined) return undefined;
	return {
		utilization: Math.max(0, Math.min(1, percent / 100)),
		...(windowMinutes === undefined ? {} : { windowMinutes }),
		...(resetAtSec === undefined ? {} : { resetAtSec }),
	};
}

export function readCodexQuotaHeaders(headers: Record<string, string>, nowMs: number = Date.now()): CodexQuotaReading | undefined {
	const primary = codexWindowOf(headers, "primary", nowMs);
	const secondary = codexWindowOf(headers, "secondary", nowMs);
	if (primary === undefined && secondary === undefined) return undefined;
	return { ...(primary === undefined ? {} : { primary }), ...(secondary === undefined ? {} : { secondary }) };
}

const windowNameOf = (minutes: number): string =>
	minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

export function codexQuotaReport(reading: CodexQuotaReading | undefined): string | undefined {
	if (reading === undefined) return undefined;
	const windows: [string, CodexQuotaWindow][] = [];
	if (reading.primary !== undefined) windows.push([reading.primary.windowMinutes === undefined ? "primary" : windowNameOf(reading.primary.windowMinutes), reading.primary]);
	if (reading.secondary !== undefined) windows.push([reading.secondary.windowMinutes === undefined ? "secondary" : windowNameOf(reading.secondary.windowMinutes), reading.secondary]);
	if (windows.length === 0) return undefined;
	const head = windows.map(([name, window]) => `${name} ${percentOf(window.utilization)}`).join(" · ");
	const resets = windows.flatMap(([name, window]) => (window.resetAtSec === undefined ? [] : [`${name} resets ${resetTimeOf(window.resetAtSec)}`]));
	return resets.length === 0 ? head : `${head} (${resets.join(", ")})`;
}

const percentOf = (fraction: number): string => `${Math.round(fraction * 100)}%`;

export function quotaStatusLabel(reading: QuotaReading | undefined): string {
	if (reading === undefined) return "";
	const parts: string[] = [];
	if (reading.fiveHourUtilization !== undefined) parts.push(`5h ${percentOf(reading.fiveHourUtilization)}`);
	if (reading.sevenDayUtilization !== undefined) parts.push(`7d ${percentOf(reading.sevenDayUtilization)}`);
	return parts.join(" · ");
}

const resetTimeOf = (sec: number): string =>
	new Date(sec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function quotaReport(reading: QuotaReading | undefined): string | undefined {
	if (reading === undefined) return undefined;
	const head = quotaStatusLabel(reading);
	const detail: string[] = [];
	if (reading.fiveHourResetAtSec !== undefined) detail.push(`5h resets ${resetTimeOf(reading.fiveHourResetAtSec)}`);
	if (reading.sevenDayResetAtSec !== undefined) detail.push(`7d resets ${resetTimeOf(reading.sevenDayResetAtSec)}`);
	if (reading.representativeClaim !== undefined) detail.push(`binding ${reading.representativeClaim}`);
	if (head.length === 0 && detail.length === 0) return undefined;
	if (detail.length === 0) return head;
	const tail = `(${detail.join(", ")})`;
	return head.length === 0 ? tail : `${head} ${tail}`;
}
