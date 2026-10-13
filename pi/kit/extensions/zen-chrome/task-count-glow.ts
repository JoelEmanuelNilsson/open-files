import type { TUI } from "@earendil-works/pi-tui";
import { SHIMMER_FRAME_MS } from "../../lib/ui/prism-light.ts";
import type { AnimationClock, ReleaseFrames } from "./animation-clock.ts";

/** One zen-chrome instance's task-count glow. */
export interface TaskCountGlow {
	taskGlow(present: boolean): number | null;
	stopTaskFrames(): void;
}

/** A task-count glow drawing its frames off `clock`; the label stays still while `wave` is off. */
export function createTaskCountGlow(clock: AnimationClock, tui: () => TUI | undefined, wave: boolean): TaskCountGlow {
	let tasksSince: number | undefined;
	let tasksFrames: ReleaseFrames | undefined;

	function stopTaskFrames(): void {
		tasksSince = undefined;
		tasksFrames?.();
		tasksFrames = undefined;
	}

	function taskGlow(present: boolean): number | null {
		if (!present) {
			stopTaskFrames();
			return null;
		}
		if (!wave) return null;
		tasksSince ??= Date.now();
		if (!tasksFrames && tui()) tasksFrames = clock.demandFrames(SHIMMER_FRAME_MS);
		return tasksSince;
	}

	return { taskGlow, stopTaskFrames };
}
