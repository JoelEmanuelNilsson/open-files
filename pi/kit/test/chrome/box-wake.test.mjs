/**
 * The bar a session opens with (extensions/zen-chrome/box-wake.ts) is grey and
 * ends at rest, and the timeline between the two has to end — a wake that never
 * reports itself finished is a frame timer that never stops.
 */

import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();

console.log("wake: the bar opens grey, lights, and ends at rest");
{
	const { DARK_MS, greyOut, LIT_MS, WAKE_MS, wakeAt } = await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/box-wake.ts`);
	eq("the bar is fully grey the moment it opens", wakeAt(0, 0), { grey: 1, light: 1 });
	eq("and still grey just before the light", wakeAt(0, DARK_MS - 1), { grey: 1, light: 1 });
	const lighting = wakeAt(0, DARK_MS + LIT_MS * 0.2);
	eq("the grey lifts while the light is still at full", [lighting.grey < 1, lighting.grey > 0, lighting.light], [true, true, 1]);
	const settling = wakeAt(0, DARK_MS + LIT_MS * 0.8);
	eq("then the colour is out and the light is leaving", [settling.grey, settling.light < 1, settling.light > 0], [0, true, true]);
	eq("the wake ends, so the frames can stop", wakeAt(0, WAKE_MS), null);
	eq("a clock that ran backwards asks for nothing", wakeAt(1000, 0), null);

	// Grey is desaturation, not dimming: the bar stays as readable as it ends up.
	const { luminance } = await jiti.import(`${KIT_ROOT}/lib/ui/rgb-color.ts`);
	const line = "\x1b[38;2;40;80;200mcwd\x1b[0m";
	eq("no grey leaves the line alone", greyOut([line], 0), [line]);
	const grey = greyOut([line], 1)[0];
	const [, r, g, b] = /\x1b\[38;2;(\d+);(\d+);(\d+)m(?![\s\S]*\x1b\[38;2;)/.exec(grey).map(Number);
	eq("full grey has no colour left", [r === g, g === b], [true, true]);
	eq("and keeps the glyph's brightness", Math.abs(r - luminance({ r: 40, g: 80, b: 200 })) < 1, true);
	eq("the text itself is untouched", grey.replace(/\x1b\[[0-9;]*m/g, ""), "cwd");
	eq("a glyph the theme never painted has no colour to take out", greyOut(["plain"], 1), ["\x1b[0mplain\x1b[0m"]);
}

await finish();
