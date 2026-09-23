/**
 * The chrome's shared animation clock: one timer at the fastest rate any
 * running animation asks for, and no timer at all once none is asking.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { createAnimationClock } = await jiti.import(`${ROOT}/extensions/zen-chrome/animation-clock.ts`);
const { FRAME_MS, SHIMMER_FRAME_MS } = await jiti.import(`${ROOT}/extensions/zen-chrome/animate.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/** A clock on a hand-driven timer: `live` holds the running intervals, `tick()` fires them, `renders` counts renders. */
function manualClock() {
	const live = new Set();
	const rig = {
		live,
		renders: 0,
		rates: () => [...live].map((timer) => timer.frameMs),
		tick: () => { for (const timer of [...live]) timer.tick(); },
	};
	rig.clock = createAnimationClock(
		() => { rig.renders++; },
		(tick, frameMs) => {
			const timer = { tick, frameMs };
			live.add(timer);
			return () => live.delete(timer);
		},
	);
	return rig;
}

const refedTimeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

console.log("animation clock: one demand at 40 ms ticks at 40 ms");
{
	const rig = manualClock();
	eq("no demand, no timer", rig.rates(), []);
	rig.clock.demandFrames(SHIMMER_FRAME_MS);
	eq("the idle shimmer alone runs at 40 ms", rig.rates(), [40]);
	rig.tick();
	eq("each tick asks for exactly one render", rig.renders, 1);
}

console.log("\nanimation clock: a 33 ms demand takes the rate over, on one timer");
{
	const rig = manualClock();
	rig.clock.demandFrames(SHIMMER_FRAME_MS);
	const releaseWave = rig.clock.demandFrames(FRAME_MS);
	eq("one interval, at 33 ms", rig.rates(), [33]);
	rig.tick();
	eq("two animations, still one render per tick", rig.renders, 1);
	releaseWave();
	eq("releasing the 33 ms demand returns the rate to 40 ms", rig.rates(), [40]);
}

console.log("\nanimation clock: the timer stops with the last demand");
{
	const rig = manualClock();
	const releaseShimmer = rig.clock.demandFrames(SHIMMER_FRAME_MS);
	const releaseTasks = rig.clock.demandFrames(SHIMMER_FRAME_MS);
	releaseShimmer();
	eq("a demand still standing keeps the timer", rig.rates(), [40]);
	releaseTasks();
	eq("releasing every demand stops the interval", rig.rates(), []);
}

console.log("\nanimation clock: releasing twice, or after shutdown, is harmless");
{
	const rig = manualClock();
	const releaseWave = rig.clock.demandFrames(FRAME_MS);
	const releaseShimmer = rig.clock.demandFrames(SHIMMER_FRAME_MS);
	releaseWave();
	releaseWave();
	eq("a second release does not take another demand with it", rig.rates(), [40]);
	rig.clock.releaseAllFrames();
	eq("shutdown releases every demand", rig.rates(), []);
	releaseShimmer();
	eq("a release after shutdown starts nothing", rig.rates(), []);
	rig.clock.demandFrames(SHIMMER_FRAME_MS);
	eq("and the clock still serves a new demand", rig.rates(), [40]);
}

console.log("\nanimation clock: onFrame runs before the tick's render and may release itself");
{
	const rig = manualClock();
	const seen = [];
	const release = rig.clock.demandFrames(FRAME_MS, () => {
		seen.push(rig.renders);
		release();
	});
	rig.tick();
	eq("onFrame saw the render count before this tick's render", seen, [0]);
	eq("the tick that ended the demand still renders", rig.renders, 1);
	eq("and the timer is gone", rig.rates(), []);
}

console.log("\nanimation clock: the real timer is unreffed and really ticks");
{
	let renders = 0;
	const clock = createAnimationClock(() => { renders++; });
	const before = refedTimeouts();
	clock.demandFrames(FRAME_MS);
	eq("the running timer holds nothing open", refedTimeouts(), before);
	// The unreffed clock cannot keep the loop alive alone, so a ref'd wait carries it.
	await new Promise((resolve) => setTimeout(resolve, FRAME_MS * 4));
	eq("it asked for renders while demanded", renders > 0, true);
	clock.releaseAllFrames();
	const after = renders;
	await new Promise((resolve) => setTimeout(resolve, FRAME_MS * 3));
	eq("and none after release", renders, after);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
