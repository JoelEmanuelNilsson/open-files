/**
 * How long the provider's prompt cache stays warm, and how that reads in the
 * status bar.
 *
 * `session-mode` owns the window and publishes it; `zen-chrome` renders it. They
 * meet on `globalThis` because the two extensions are separate modules in the
 * same process, and on this file for the rules, because a countdown that
 * disagrees with the provider is worse than no countdown.
 *
 * The rules are Anthropic's, not ours
 * (docs.claude.com/en/docs/build-with-claude/prompt-caching):
 *
 *   - The TTL clock starts when the request that writes or reads the entry
 *     *begins*, not when its response finishes. Streaming time is spent warmth.
 *   - A read refreshes the entry for free, measured from that read's start, so
 *     every request in a run re-anchors the window.
 *   - `{type: "ephemeral"}` is 5m; `ttl: "1h"` is the hour.
 *   - Under a mix, 1h breakpoints must precede 5m ones, so the tail expires first.
 */

import { shared } from "./shared.ts";

export type CacheMode = "short" | "long" | "keepalive";

/**
 * Tokens a response admits to having seen.
 *
 * Every prompt token lands in exactly one of these buckets, so a real response
 * can never total zero. A zero total is therefore not a response at all: press
 * escape mid-stream and pi still emits `message_end`, carrying a usage object
 * zeroed in every field. Nothing was read, nothing was billed, and nothing
 * about the cache can be inferred from it — which is the opposite of what the
 * numbers say if you read them literally (issue 22).
 */
export const accounted = (usage: { input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }): number =>
	(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.cacheWrite1h ?? 0);

/** Anthropic's two ephemeral TTLs. A block with no `ttl` gets the short one. */
export const SHORT_TTL_MS = 5 * 60 * 1000;
export const LONG_TTL_MS = 60 * 60 * 1000;

export interface CacheWindow {
	mode: CacheMode;
	/** Epoch ms when the cache goes cold. 0 before the first write of the session. */
	warmUntil: number;
	/**
	 * The model the last request went out on. The conversation is warm for that
	 * model and no other, which is what lets the status bar tell a switch that
	 * rewrites the whole prefix from one that reads it back.
	 */
	model?: string;
	/**
	 * The reasoning level the last request went out at. Whether the model reads
	 * the conversation back across a change of it is that model's measured fact
	 * (`lib/warm-prefix.ts`); the status bar needs the level to know whether to ask.
	 */
	reasoning?: string;
	/** What actually ends this seat's warmth; `warmUntil` is only the TTL a ping re-anchors. */
	cold: Cold;
}

/**
 * The clock that decides when this seat's prefix goes cold.
 *
 * `ttl` — nothing renews it, so the last write's expiry is the whole truth.
 * `shutoff` — a chain runs and the idle shutoff at `at` is what will stop it.
 * `held` — the seat is busy or waiting on a child, so the shutoff has no date
 * yet: the prefix is good for at least one idle window from any instant, and
 * settling only pushes that out (issues/36, issues/48).
 */
export type Cold = { kind: "ttl" } | { kind: "shutoff"; at: number } | { kind: "held"; windowMs: number };

/** Where published windows live so every session in the process sees its own. */
const SEAM = "__piKitCacheWindows";
/** Where each seat's renewal commitment lives, for whoever files bytes on its behalf. */
const RENEWAL_SEAM = "__piKitCacheRenewals";

/**
 * Keyed by session because subagents run in this process: one unkeyed slot let a
 * child's request move the main seat's countdown, and the only thing stopping it
 * was a boolean every writer had to remember to check. `lib/ping.ts` solved the
 * identical problem this way two files over (issues/45).
 */
const cacheWindows = (): Map<string, CacheWindow> => shared(SEAM, () => new Map<string, CacheWindow>());

type Renewal = () => number | undefined;

const renewals = (): Map<string, Renewal> => shared(RENEWAL_SEAM, () => new Map<string, Renewal>());

/**
 * Publish how long this seat's ping chain commits to keeping its prefix warm,
 * for `extensions/wire.ts` to file next to the bytes it records.
 *
 * A function rather than a number because pi promises no order between two
 * extensions' handlers for one request: reading the commitment at the moment
 * the bytes are filed is what makes that order stop mattering.
 */
export function publishRenewal(sessionId: string, commitment: Renewal): void {
	renewals().set(sessionId, commitment);
}

/** This seat's commitment, or undefined when nothing renews its prefix. */
export function readRenewal(sessionId: string): number | undefined {
	return renewals().get(sessionId)?.();
}

/** This seat's window, or undefined before its first cache write. */
export function readCacheWindow(sessionId: string): CacheWindow | undefined {
	return cacheWindows().get(sessionId);
}

/** Publish this seat's window for the status bar to render. */
export function publishCacheWindow(sessionId: string, window: CacheWindow): void {
	cacheWindows().set(sessionId, window);
}

/**
 * Drop a session's window, from `session_shutdown`, so the seam holds one entry
 * per live session. Not on a reload: the seat and the provider's entry go on.
 */
export function forgetCacheWindow(sessionId: string): void {
	cacheWindows().delete(sessionId);
	renewals().delete(sessionId);
}

function ttlOf(block: unknown): number | undefined {
	const control = (block as { cache_control?: { ttl?: unknown } } | null)?.cache_control;
	if (!control) return undefined;
	return control.ttl === "1h" ? LONG_TTL_MS : SHORT_TTL_MS;
}

function ttlIn(blocks: unknown): number | undefined {
	if (!Array.isArray(blocks)) return undefined;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const ttl = ttlOf(blocks[i]);
		if (ttl !== undefined) return ttl;
	}
	return undefined;
}

/**
 * How long the request about to go out keeps the whole prefix warm, or undefined
 * if it writes no cache at all.
 *
 * Read from the payload rather than from the mode, because the two disagree in
 * three ways that all end as a countdown promising a window the provider never
 * granted: the mode can flip mid-run, a model whose compat lacks long retention
 * silently gets 5m, and an auth adapter may repatch the payload on its way out.
 * The payload is the last word before the wire.
 *
 * The *shortest* TTL wins, because a full hit needs every breakpoint alive and
 * the run is only as warm as its coldest one. Anthropic requires 1h breakpoints
 * to precede 5m ones, so under a mix it is the tail that dies first — reporting
 * the tools' hour would be the optimistic lie this function exists to prevent.
 *
 * Only the tails of each section are scanned. pi marks the last tool, the system
 * prompt, and the last conversation block, so this stays cheap on a payload that
 * can be megabytes.
 */
export function ttlFromPayload(payload: unknown): number | undefined {
	const body = payload as { tools?: unknown; system?: unknown; messages?: unknown } | null;
	if (!body) return undefined;

	const messages = Array.isArray(body.messages) ? body.messages : [];
	const found = [
		ttlIn(body.tools),
		ttlIn(body.system),
		ttlIn((messages[messages.length - 1] as { content?: unknown } | undefined)?.content),
	].filter((ttl): ttl is number => ttl !== undefined);

	return found.length > 0 ? Math.min(...found) : undefined;
}

/**
 * How long until this prefix is actually cold, in ms; 0 once it is.
 *
 * While the ping chain is alive the TTL is not information — it runs to zero and
 * a ping renews it, forever — so the only clock that predicts a cold prefix is
 * the shutoff. The entry outlives the shutoff by up to one TTL, but the last
 * ping lands somewhere inside its own interval, so the shutoff is the part of
 * that we know. A held clock has no shutoff date yet, so what is known is the
 * floor: one idle window from now, which settling only pushes further out. With
 * no chain armed, or a stopped one, the TTL is the whole truth (issues/48).
 */
export function warmFor(window: CacheWindow, now: number): number {
	const cold =
		window.cold.kind === "shutoff" ? window.cold.at : window.cold.kind === "held" ? now + window.cold.windowMs : window.warmUntil;
	return Math.max(0, cold - now);
}

/**
 * The one number: `45s` inside the last minute, then `12m`, then `1h48m`.
 *
 * Minutes floor, so the figure is a floor on the warmth left rather than a
 * promise; it can never read `0m` because anything under a minute is seconds.
 */
function untilCold(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * How long until the label's number changes, or undefined when nothing moves.
 *
 * Above a minute only the minute counter moves, so a per-second render redrew
 * the same string 59 times out of 60: wait for the boundary instead, and drop
 * to 1 Hz only inside the last minute (issues/48).
 */
export function nextRedrawMs(window: CacheWindow | undefined, now: number): number | undefined {
	if (window === undefined) return undefined;
	// A held clock reads the same number at every instant, so the next change is
	// the publish that ends the hold, not a tick.
	if (window.cold.kind === "held") return undefined;
	const remaining = warmFor(window, now);
	if (remaining <= 0) return undefined;
	if (remaining <= 60_000) return 1000;
	return remaining % 60_000 || 60_000;
}

/**
 * The whole cache indicator, as one string: the flake and one number — how
 * long until this prefix is actually cold.
 *
 *   `❄12m`    twelve minutes before it goes cold
 *   `❄1h48m`  the same clock on a longer window
 *   `❄`       already cold, or nothing written yet
 *
 * The flake is the cache itself and is always present, so the indicator holds a
 * fixed place in the bar instead of appearing and vanishing under the model name.
 * The number is the whole reading: which window or chain produced it does not
 * change what it tells you, so no glyph qualifies it.
 */
export function cacheLabel(window: CacheWindow | undefined, now: number): string {
	if (!window) return "";
	const remaining = warmFor(window, now);
	return remaining > 0 ? `❄${untilCold(remaining)}` : "❄";
}
