import type { TUI } from "@earendil-works/pi-tui";
import { FADE_MS, FRAME_MS, SHIMMER_FRAME_MS } from "../../lib/ui/prism-light.ts";
import type { AnimationClock, ReleaseFrames } from "./animation-clock.ts";

/** One zen-chrome instance's level flash on the model label. */
export interface LevelFlash {
	flashedAt(): number | undefined;
	flashLevel(): void;
	stopFlash(): void;
}

/** A level flash drawing its frames off `clock`; nothing lights while `wave` is off or there is no TUI. */
export function createLevelFlash(clock: AnimationClock, tui: () => TUI | undefined, wave: boolean): LevelFlash {
	let flashedAt: number | undefined;
	let flashFrames: ReleaseFrames | undefined;
	let fadeTimer: ReturnType<typeof setTimeout> | undefined;

	function stopFlash(): void {
		clearTimeout(fadeTimer);
		fadeTimer = undefined;
		flashedAt = undefined;
		flashFrames?.();
		flashFrames = undefined;
	}

	function flashLevel(): void {
		if (!wave || !tui()) return;
		flashedAt = Date.now();
		flashFrames ??= clock.demandFrames(SHIMMER_FRAME_MS);
		clearTimeout(fadeTimer);
		// raw-timer: the chrome's fade and ticker timers, back from main's animation-clock rewrite after the scope sweep, pending their move onto the scope
		fadeTimer = setTimeout(() => {
			if (flashedAt !== undefined && Date.now() - flashedAt >= FADE_MS) stopFlash();
			tui()?.requestRender();
		}, FADE_MS + FRAME_MS).unref();
	}

	return { flashedAt: () => flashedAt, flashLevel, stopFlash };
}
