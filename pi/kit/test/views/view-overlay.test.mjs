/**
 * The kit's one adapter onto pi's `ctx.ui.custom`: the view it builds takes
 * the editor's slot or the full screen, repaints after a key, repaints when the
 * dock refreshes it, and resolves with the exit the view hands `done`.
 *
 *   node test/views/view-overlay.test.mjs
 */

import { check, eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const { FULLSCREEN_OVERLAY_OPTIONS, showViewOverlay } = await jiti.import(`${KIT_ROOT}/lib/ui/view-overlay.ts`);

console.log("view-overlay: a view in the editor's slot");
{
	const calls = [];
	let renders = 0;
	let component;
	let exitWith;
	const tui = { terminal: { rows: 33 }, requestRender: () => renders++ };
	const ctx = {
		ui: {
			custom: (factory, options) =>
				new Promise((resolve) => {
					calls.push(options);
					component = factory(tui, "the theme", undefined, resolve);
				}),
		},
	};
	let refresh;
	const opened = showViewOverlay(
		ctx,
		(tui, theme, done) => {
			exitWith = done;
			return {
				render: (width) => [`${theme} at ${width} over ${tui.terminal.rows} rows`],
				invalidate: () => calls.push("invalidate"),
				handleInput: (data) => calls.push(`key ${data}`),
			};
		},
		{ overlay: false },
		(repaint) => {
			refresh = repaint;
		},
	);

	eq("the options reach pi unchanged", calls[0], { overlay: false });
	eq("the view is built with pi's theme and the terminal's height", component.render(40), ["the theme at 40 over 33 rows"]);
	component.handleInput("x");
	check("a key goes to the view, then asks pi for a frame", calls.at(-1) === "key x" && renders === 1);
	refresh();
	check("the dock's refresh invalidates the view and asks for a frame", calls.at(-1) === "invalidate" && renders === 2);
	component.invalidate();
	eq("pi's invalidate reaches the view", calls.at(-1), "invalidate");
	exitWith({ kind: "closed" });
	eq("it resolves with the exit the view hands done", await opened, { kind: "closed" });
}

console.log("\nview-overlay: a dialog over the full screen");
{
	let options;
	const ctx = { ui: { custom: (_factory, given) => ((options = given), Promise.resolve()) } };
	await showViewOverlay(ctx, () => ({ render: () => [], invalidate: () => {}, handleInput: () => {} }), FULLSCREEN_OVERLAY_OPTIONS);
	eq("pi is asked for a full-width, full-height overlay", options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
}

await finish();
