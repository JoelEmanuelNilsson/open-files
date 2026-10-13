import { liveAgentsOf } from "../agents/agent-live-runs.ts";
import { processShared } from "../process/process-shared-state.ts";
import { childSeatOf } from "../session/seat-identity.ts";
import { backgroundTasksOf } from "../tools/background-tasks.ts";

/** The last real request's start, the latest request of either kind, the TTL of the entry the real one wrote, and the warm the warmer has scheduled. */
export interface CacheTouch {
	readonly startedAt: number;
	readonly touchedAt: number;
	readonly ttlMs: number;
	readonly warmAt: number | undefined;
}

const touches = (): Map<string, CacheTouch> => processShared("__piKitCacheTouches", () => new Map<string, CacheTouch>());

/** A real request went out and wrote an entry living `ttlMs`. */
export function publishCacheWrite(sessionId: string, ttlMs: number, now: number): void {
	touches().set(sessionId, { startedAt: now, touchedAt: now, ttlMs, warmAt: undefined });
}

/** The warmer refreshed the entry. */
export function publishCacheWarm(sessionId: string, now: number): void {
	const last = touches().get(sessionId);
	if (last !== undefined) touches().set(sessionId, { ...last, touchedAt: now, warmAt: undefined });
}

/** The warmer will refresh the entry at `warmAt`, or will not refresh it. */
export function publishWarmSchedule(sessionId: string, warmAt: number | undefined): void {
	const last = touches().get(sessionId);
	if (last !== undefined) touches().set(sessionId, { ...last, warmAt });
}

/** This session's last cache touch, or undefined before its first request. */
export function readCacheTouch(sessionId: string): CacheTouch | undefined {
	return touches().get(sessionId);
}

/** Drop a session's touch when it ends. */
export function forgetCacheTouch(sessionId: string): void {
	touches().delete(sessionId);
}

export function seatWantsWarming(sessionId: string): boolean {
	return childSeatOf(sessionId) === undefined || liveAgentsOf(sessionId).size > 0 || backgroundTasksOf(sessionId).length > 0;
}

/** No warm later than this after the last real request (Joel's ruling after one seat was warmed for 1,880 minutes, issues/10). */
export const IDLE_WARMING_LIMIT_MS = 30 * 60_000;

/** Whether the entry the last request or warm wrote is still inside its TTL at `now`; false when nothing was written. */
export const entryLives = (touch: CacheTouch | undefined, now: number): boolean => touch !== undefined && now < touch.touchedAt + touch.ttlMs;

/** Warm at 90% of the TTL, and at least ten seconds before expiry. */
export const warmDelayMs = (ttlMs: number): number => Math.min(ttlMs * 0.9, ttlMs - 10_000);

export function coldAt(touch: CacheTouch, seatIsWarmed: boolean): number {
	if (touch.warmAt === undefined || !seatIsWarmed) return touch.touchedAt + touch.ttlMs;
	let lastWarm = touch.touchedAt;
	for (let next = touch.warmAt; next <= touch.startedAt + IDLE_WARMING_LIMIT_MS; next = lastWarm + warmDelayMs(touch.ttlMs)) lastWarm = next;
	return lastWarm + touch.ttlMs;
}

/** `❄12m`, `❄45s` in the last minute, a bare `❄` once cold. */
export function cacheLabel(touch: CacheTouch | undefined, now: number, seatIsWarmed: boolean): string {
	if (touch === undefined) return "";
	const remaining = coldAt(touch, seatIsWarmed) - now;
	if (remaining <= 0) return "❄";
	const seconds = Math.ceil(remaining / 1000);
	if (seconds < 60) return `❄${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `❄${minutes}m` : `❄${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Milliseconds until the label changes, or undefined once it is cold. */
export function nextRedrawMs(touch: CacheTouch | undefined, now: number, seatIsWarmed: boolean): number | undefined {
	if (touch === undefined) return undefined;
	const remaining = coldAt(touch, seatIsWarmed) - now;
	if (remaining <= 0) return undefined;
	if (remaining <= 60_000) return remaining % 1000 || 1000;
	return remaining - (60_000 * (Math.ceil((remaining + 1000) / 60_000) - 1) - 1000);
}
