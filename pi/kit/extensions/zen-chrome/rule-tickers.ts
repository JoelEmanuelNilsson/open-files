import type { TUI } from "@earendil-works/pi-tui";
import { elapsedMs, TURN_CLOCK_FLOOR_MS, readTurnClock } from "../../lib/session/turn-clock.ts";

/** One zen-chrome instance's bottom-rule redraw timers. */
export interface RuleTickers {
	startCacheTicker(): void;
	stopCacheTicker(): void;
	startTurnTicker(): void;
	stopTurnTicker(): void;
}

/** Redraw timers for the bottom rule; `cacheRedrawDelay` says when the cache label next changes, or undefined for never. */
export function createRuleTickers(tui: () => TUI | undefined, cacheRedrawDelay: () => number | undefined): RuleTickers {
	let cacheTicker: ReturnType<typeof setTimeout> | undefined;
	let floorTimer: ReturnType<typeof setTimeout> | undefined;
	let secondTicker: ReturnType<typeof setInterval> | undefined;

	function stopCacheTicker(): void {
		if (cacheTicker) {
			clearTimeout(cacheTicker);
			cacheTicker = undefined;
		}
	}
	function startCacheTicker(): void {
		if (cacheTicker || !tui()) return;
		const delay = cacheRedrawDelay();
		if (delay === undefined) return;
		// raw-timer: the chrome's fade and ticker timers, back from main's animation-clock rewrite after the scope sweep, pending their move onto the scope
		cacheTicker = setTimeout(() => {
			cacheTicker = undefined;
			tui()?.requestRender();
			if (readTurnClock().startedAt === null) startCacheTicker();
		}, delay);
		cacheTicker.unref?.();
	}

	function stopTurnTicker(): void {
		if (floorTimer) {
			clearTimeout(floorTimer);
			floorTimer = undefined;
		}
		if (secondTicker) {
			clearInterval(secondTicker);
			secondTicker = undefined;
		}
	}
	function startTurnTicker(): void {
		if (!tui() || floorTimer || secondTicker) return;
		const remaining = TURN_CLOCK_FLOOR_MS - (elapsedMs(readTurnClock(), Date.now()) ?? 0);
		// raw-timer: the chrome's fade and ticker timers, back from main's animation-clock rewrite after the scope sweep, pending their move onto the scope
		floorTimer = setTimeout(() => {
			floorTimer = undefined;
			tui()?.requestRender();
			// raw-timer: the chrome's fade and ticker timers, back from main's animation-clock rewrite after the scope sweep, pending their move onto the scope
			secondTicker = setInterval(() => tui()?.requestRender(), 1000);
			secondTicker.unref?.();
		}, Math.max(0, remaining));
		floorTimer.unref?.();
	}

	return { startCacheTicker, stopCacheTicker, startTurnTicker, stopTurnTicker };
}
