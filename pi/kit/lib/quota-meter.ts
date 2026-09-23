/**
 * The subscription quota, as the server reports it — the only source of truth
 * there is for how much of Joel's Claude allowance a request just spent.
 *
 * There is no local token→quota formula. Ticket 01 searched the installed
 * `claude` binary for one and found none: the client reads
 * `anthropic-ratelimit-unified-*` off the response and displays it, and every
 * weight in the formula (cache reads, thinking, per-model ratios) is server
 * side and undocumented. So the meter records the headers and lets the numbers
 * answer later. Five headers, exactly the five ticket 13 ruled — recording the
 * other twenty-seven would be a log nobody regresses against.
 *
 * The two numeric parses are the binary's, not ours (2.1.259):
 *
 *   - **Utilization is a fraction clamped to 0..1.** `Number(value)`, then
 *     `Math.max(0, Math.min(1, …))`. `0.34` means 34% used. Reading it as a
 *     percent would put "34%" in the bar at 34 hundredths of one percent used.
 *   - **Reset is unix seconds.** `Number(value)`, kept only when `value * 1000`
 *     is still in the future. A reset already past is not a deadline.
 *
 * `-representative-claim` names which window is currently binding, out of a
 * closed set (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_overage_included`, `overage`). It is carried whole rather than
 * parsed into an enum: a claim Anthropic adds tomorrow is a fact worth
 * recording, and a parser that drops it would hide exactly the surprise the
 * meter exists to catch. Without the claim, a utilization delta cannot be
 * attributed to the right pool — a Fable-claim response says nothing about the
 * general weekly one (ticket 01).
 *
 * Nothing here is model-facing (C15), and nothing here renders unprompted. The
 * trace records every reading; `/quota` prints the latest one when it is asked
 * for. The bottom rule says nothing about quota — the numbers are for
 * diagnosis, not chrome.
 *
 * The ChatGPT subscription behind `openai-codex` reports its own allowance in
 * `x-codex-*` headers, read with the Codex CLI's parse
 * (`codex-rs/codex-api/src/rate_limits.rs`): two windows, primary and
 * secondary, each a `-used-percent` in 0..100, a `-window-minutes` and a
 * `-reset-at` in unix seconds. The windows are named by their minutes rather
 * than assumed to be 5h and 7d, because the server says which they are. It is
 * a separate reading, never folded into {@link QuotaReading}: that shape is
 * what the trace pairs with Anthropic token counts, and a Codex number filed
 * there would teach the fit a pool it never measured. Over pi-ai's WebSocket
 * transport the same numbers arrive as a `codex.rate_limits` event that no
 * extension hook carries, so only an SSE response is read here.
 */

/** Fractions used, resets, and the binding window — one response's worth of quota. */
export interface QuotaReading {
	/** Fraction of the 5-hour session limit used, 0..1. Undefined when not sent. */
	fiveHourUtilization?: number;
	/** Fraction of the 7-day limit used, 0..1. Undefined when not sent. */
	sevenDayUtilization?: number;
	/** Unix seconds when the 5-hour window resets, when still in the future. */
	fiveHourResetAtSec?: number;
	/** Unix seconds when the 7-day window resets, when still in the future. */
	sevenDayResetAtSec?: number;
	/** Which claim is binding right now, e.g. `five_hour`, `seven_day_overage_included`. */
	representativeClaim?: string;
}

const FIVE_HOUR_UTILIZATION_HEADER = "anthropic-ratelimit-unified-5h-utilization";
const SEVEN_DAY_UTILIZATION_HEADER = "anthropic-ratelimit-unified-7d-utilization";
const FIVE_HOUR_RESET_HEADER = "anthropic-ratelimit-unified-5h-reset";
const SEVEN_DAY_RESET_HEADER = "anthropic-ratelimit-unified-7d-reset";
const REPRESENTATIVE_CLAIM_HEADER = "anthropic-ratelimit-unified-representative-claim";

/**
 * Case-folded lookup. pi hands over `headersToRecord(response.headers)`, which
 * is already lower-cased, but a proxy in front of Anthropic may title-case them
 * and a meter that goes blank behind a proxy is a meter that lies about a quiet
 * account.
 */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const direct = headers[name];
	if (typeof direct === "string") return direct;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

/** A utilization header as the binary reads it: a finite fraction clamped to 0..1. */
function utilizationOf(headers: Record<string, string>, name: string): number | undefined {
	const raw = headerValue(headers, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

/** A reset header as the binary reads it: unix seconds, kept only while future. */
function resetSecOf(headers: Record<string, string>, name: string, nowMs: number): number | undefined {
	const raw = headerValue(headers, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value * 1000 <= nowMs) return undefined;
	return Math.round(value);
}

/**
 * Read one response's quota headers, or undefined when it carried none.
 *
 * Undefined means "this response said nothing about quota" — an API-key
 * request, a non-Anthropic provider, or a proxy that strips them. It never
 * means zero: a meter that renders a missing header as 0% would report a fresh
 * allowance every time the headers went away.
 */
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
	/** Fraction used, 0..1 — the header's percent divided by 100. */
	utilization: number;
	/** Length of the window in minutes, when sent. */
	windowMinutes?: number;
	/** Unix seconds when the window resets, when still in the future. */
	resetAtSec?: number;
}

/** One Codex response's worth of quota: the primary and secondary windows. */
export interface CodexQuotaReading {
	primary?: CodexQuotaWindow;
	secondary?: CodexQuotaWindow;
}

/**
 * A Codex window as the Codex CLI reads it: present only when `-used-percent`
 * parses, and only when it says something — a zero with no length and no reset
 * is the server's way of sending no window.
 */
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

/**
 * Read one Codex response's quota headers, or undefined when it carried none.
 * Undefined never means zero, for the reason {@link readQuotaHeaders} gives.
 */
export function readCodexQuotaHeaders(headers: Record<string, string>, nowMs: number = Date.now()): CodexQuotaReading | undefined {
	const primary = codexWindowOf(headers, "primary", nowMs);
	const secondary = codexWindowOf(headers, "secondary", nowMs);
	if (primary === undefined && secondary === undefined) return undefined;
	return { ...(primary === undefined ? {} : { primary }), ...(secondary === undefined ? {} : { secondary }) };
}

/** `300` → `5h`, `10080` → `7d`, `45` → `45m`: a window named by its length. */
const windowNameOf = (minutes: number): string =>
	minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

/**
 * The Codex reading in the words {@link quotaReport} uses for Anthropic's:
 *
 *     5h 12% · 7d 40% (5h resets 14:30, 7d resets 09:00)
 *
 * A window whose length was not sent is named `primary` or `secondary`.
 */
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

/** `0.34` → `34%`. Whole percent; the tenths are noise at this resolution. */
const percentOf = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/**
 * The two windows on one line: `5h 34% · 7d 61%`.
 *
 * Empty when nothing has been read yet, so no surface holds a place for a
 * number that does not exist. Either window alone still renders — a response
 * can carry one and not the other, and half a meter beats none.
 */
export function quotaStatusLabel(reading: QuotaReading | undefined): string {
	if (reading === undefined) return "";
	const parts: string[] = [];
	if (reading.fiveHourUtilization !== undefined) parts.push(`5h ${percentOf(reading.fiveHourUtilization)}`);
	if (reading.sevenDayUtilization !== undefined) parts.push(`7d ${percentOf(reading.sevenDayUtilization)}`);
	return parts.join(" · ");
}

/** `1730000000` → local wall-clock time, the only part of a reset worth reading. */
const resetTimeOf = (sec: number): string =>
	new Date(sec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The whole reading, for a surface that was asked for it: the two windows, then
 * each reset that is known, then the binding claim.
 *
 *     5h 34% · 7d 61% (5h resets 14:30, 7d resets 09:00, binding five_hour)
 *
 * Returns undefined when there is nothing to say, so callers report "no reading
 * yet" in their own words rather than printing an empty line.
 */
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
