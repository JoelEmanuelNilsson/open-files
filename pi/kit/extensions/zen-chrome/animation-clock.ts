/** Stops an animation's frame demand; calling it again, or after `releaseAllFrames`, does nothing. */
export type ReleaseFrames = () => void;

/** Starts a repeating frame timer and returns the function that stops it. */
export type StartFrameTimer = (tick: () => void, frameMs: number) => () => void;

/** One render timer shared by the chrome's animations, running at the fastest frame rate any of them asks for. */
export interface AnimationClock {
	demandFrames(frameMs: number, onFrame?: () => void): ReleaseFrames;
	releaseAllFrames(): void;
}

const startUnrefInterval: StartFrameTimer = (tick, frameMs) => {
	// raw-timer: a TUI component timer: the chrome's shared frame clock. It landed on main after the scope sweep, pending its move onto the scope
	const timer = setInterval(tick, frameMs);
	timer.unref();
	return () => clearInterval(timer);
};

/** Create the shared animation clock: one `requestRender` per tick, no timer while nothing demands frames. */
export function createAnimationClock(requestRender: () => void, startTimer: StartFrameTimer = startUnrefInterval): AnimationClock {
	const demands = new Set<{ frameMs: number; onFrame: (() => void) | undefined }>();
	let running: { frameMs: number; stop: () => void } | undefined;

	function retime(): void {
		let fastest = Number.POSITIVE_INFINITY;
		for (const demand of demands) fastest = Math.min(fastest, demand.frameMs);
		if (running?.frameMs === fastest) return;
		running?.stop();
		running = demands.size === 0 ? undefined : { frameMs: fastest, stop: startTimer(tick, fastest) };
	}

	function tick(): void {
		for (const demand of [...demands]) if (demands.has(demand)) demand.onFrame?.();
		requestRender();
	}

	return {
		demandFrames(frameMs, onFrame) {
			const demand = { frameMs, onFrame };
			demands.add(demand);
			retime();
			return () => {
				if (demands.delete(demand)) retime();
			};
		},
		releaseAllFrames() {
			demands.clear();
			retime();
		},
	};
}
