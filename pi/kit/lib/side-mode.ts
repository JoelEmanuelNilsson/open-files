/**
 * Which main sessions have side mode on, for every extension that must know.
 *
 * `side-chat` owns the flag; `zen-chrome` draws `[SIDE]` from it, and the
 * other `input` listeners (`agent-engine`, `skill-mentions`) step aside for a
 * submit side mode claims. pi runs `input` handlers in extension load order,
 * which is unsorted `readdir` order, so "side-chat handles it first" cannot be
 * relied on; each listener asks {@link sideModeClaimsInput} instead.
 *
 * Keyed by the main session's id because in-process engine children also
 * prompt with source `"interactive"`; a process-wide boolean would claim their
 * input too.
 */

import { shared } from "./shared.ts";

const sideModeSessions = shared("__piKitSideMode", () => new Set<string>());

/** Whether side mode is on for the main session `sessionId`. */
export function isSideModeOn(sessionId: string): boolean {
	return sideModeSessions.has(sessionId);
}

/** Turns side mode on or off for the main session `sessionId`. */
export function setSideMode(sessionId: string, on: boolean): void {
	if (on) sideModeSessions.add(sessionId);
	else sideModeSessions.delete(sessionId);
}

/** True when side mode owns this submit: on, typed by the user, not a slash command. */
export function sideModeClaimsInput(sessionId: string, event: { text: string; source: string }): boolean {
	return isSideModeOn(sessionId) && event.source === "interactive" && !event.text.startsWith("/");
}
