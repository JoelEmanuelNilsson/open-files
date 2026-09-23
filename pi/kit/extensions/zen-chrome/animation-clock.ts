// One timer, because intervals at 33 ms and 40 ms beat into ~55 renders a second where 30 do.
// Every light takes its phase from wall-clock time, so the shared rate changes sampling, not the picture.

/** Stops an animation's frame demand; calling it again, or after `releaseAllFrames`, does nothing. */
export type ReleaseFrames = () => void;

/** Starts a repeating frame timer and returns the function that stops it. */
export type StartFrameTimer = (tick: () => void, frameMs: number) => () => void;

/** One render timer shared by the chrome's animations, running at the fastest frame rate any of them asks for. */
export interface AnimationClock {
	/** Ask for a render every `frameMs` until released; `onFrame` runs on each tick, before that tick's render. */
	demandFrames(frameMs: number, onFrame?: () => void): ReleaseFrames;
	/** Release every frame demand and stop the timer, as session shutdown does. */
	releaseAllFrames(): void;
}

// Unreffed because pi's own render timer is not: a timer that keeps the loop
// alive would hold the process open at quit.
const startUnrefInterval: StartFrameTimer = (tick, frameMs) => {
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
