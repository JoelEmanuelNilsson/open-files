/**
 * The cache countdown (lib/wire/cache-touch.ts): when the prefix goes cold if
 * nothing more is sent, from the last request sent and the one warm scheduled.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });
const { cacheLabel, entryLives, forgetCacheTouch, nextRedrawMs, publishCacheWarm, publishCacheWrite, publishWarmSchedule, readCacheTouch } = await jiti.import(`${KIT_ROOT}/lib/wire/cache-touch.ts`);

const MIN = 60_000;
const T0 = 1_000_000;

const label = (now, warmed = true) => cacheLabel(readCacheTouch("s"), now, warmed);
const next = (now, warmed = true) => nextRedrawMs(readCacheTouch("s"), now, warmed);

console.log("cache-touch: a five-minute entry under the warmer's plan");
publishCacheWrite("s", 5 * MIN, T0);
check("before the warmer schedules, the plain entry remainder", label(T0 + 1000) === "❄4m");
publishWarmSchedule("s", T0 + 4.5 * MIN);
check("after a request: last planned warm at 27m plus 5m", label(T0) === "❄32m");
check("a seat not wanting warming shows the plain remainder", label(T0 + 1000, false) === "❄4m");
publishCacheWarm("s", T0 + 4.5 * MIN);
publishWarmSchedule("s", T0 + 9 * MIN);
check("after a warm it continues down, not back to 9m", label(T0 + 4.5 * MIN) === "❄27m");
check("the label is seconds inside the last minute", label(T0 + 31.5 * MIN) === "❄30s");
check("the label is a bare snowflake once cold", label(T0 + 32 * MIN) === "❄");
publishWarmSchedule("s", undefined);
check("after a stop, the plain remainder of the last warm", label(T0 + 6 * MIN) === "❄3m");
publishWarmSchedule("s", T0 + 9 * MIN);
publishCacheWrite("s", 5 * MIN, T0 + 6 * MIN);
check("a new request drops the old schedule", label(T0 + 6 * MIN) === "❄5m");

console.log("cache-touch: redraw timing");
publishWarmSchedule("s", T0 + 10.5 * MIN);
check("one minute boundary away above a minute", next(T0 + 7.5 * MIN, false) === 31_000);
check("a second inside the last minute", next(T0 + 10.5 * MIN, false) === 1000);
let outOfPhase = 0;
for (let at = T0; at < T0 + 11 * MIN; at += 337) {
	const wait = next(at, false);
	if (wait === undefined) continue;
	if (label(at + wait - 1, false) !== label(at, false) || label(at + wait, false) === label(at, false)) outOfPhase++;
}
check("the timer fires on the tick the label changes, never a second before", outOfPhase === 0, String(outOfPhase));
check("nothing once cold", next(T0 + 11 * MIN, false) === undefined);

console.log("cache-touch: whether the entry still exists");
publishCacheWrite("entry", 5 * MIN, T0);
check("one millisecond before the TTL ends it lives", entryLives(readCacheTouch("entry"), T0 + 5 * MIN - 1) === true);
check("at the TTL it is gone", entryLives(readCacheTouch("entry"), T0 + 5 * MIN) === false);
check("with nothing written there is no entry", entryLives(undefined, T0) === false);

console.log("cache-touch: sessions");
check("an unseen session has no label", cacheLabel(readCacheTouch("other"), T0) === "");
publishCacheWarm("other", T0);
publishWarmSchedule("other", T0);
check("a warm or a schedule without a write records nothing", readCacheTouch("other") === undefined);
forgetCacheTouch("s");
check("forgetting drops the touch", readCacheTouch("s") === undefined);

await finish();
