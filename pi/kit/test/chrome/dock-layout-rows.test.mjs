/**
 * The dock rows zen-chrome fits (extensions/zen-chrome/dock-layout-rows.ts).
 */

import { check, finish } from "../support/check-harness.mjs";
import { importPi, KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();

// ---------------------------------------------------------------------------
// The dock: no blank row under the box.
//
// pi gives the footer entry `minSize: 1`, so in fullscreen a footer that
// renders nothing still reserves a row and the box floats one line above the
// bottom of the screen. The dock here is pi's own — same components, same
// entry options as interactive-mode's VStack — laid out through pi-tui's real
// fullscreen path, so this fails the day either of those changes shape.
// ---------------------------------------------------------------------------

console.log("\n--- the dock: a silent footer costs no row");

const { Container, VStack } = await importPi("node_modules/@earendil-works/pi-tui/dist/index.js");
const { renderLayoutFrame } = await importPi("node_modules/@earendil-works/pi-tui/dist/layout.js");
const { fitDockRows, hideBlankRowsAbove, capDockFloor, restoreDockLayout } = await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/dock-layout-rows.ts`);

const lines = (component) => ({ render: () => component });
const wrap = (child) => {
	const container = new Container();
	container.addChild(child);
	return container;
};

/** pi's dock and fullscreen root, with `footer` in the footer's place. */
const dockWith = (footer) => {
	const transcript = wrap(lines(["transcript"]));
	const editor = wrap(lines(["\u256d\u2500 top \u2500\u256e", "\u2502 hi   \u2502", "\u2570\u2500 bot \u2500\u256f"]));
	const dock = new VStack([
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: wrap(footer), shrink: 1, minSize: 1 },
	]);
	const root = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	return { root, tui: { layoutRoot: root } };
};

/** The screen pi would paint, blank rows and all. */
const screen = (root, height = 8) => renderLayoutFrame(root, 20, height, () => {}).lines;
const rowsUnderBox = (painted) => {
	const bottom = painted.findLastIndex((line) => line.includes("bot"));
	return painted.length - 1 - bottom;
};

{
	const stock = { render: () => [] };
	check("pi alone leaves a blank row under the box", rowsUnderBox(screen(dockWith(stock).root)) === 1);
}

{
	// The footer zen-chrome installs: silent unless another extension has set a
	// status, and asking for exactly the rows it is about to use.
	let status = "";
	let fit;
	const footer = {
		render: () => {
			fit ??= fitDockRows(tui, () => footer);
			if (status === "") {
				fit(0);
				return [];
			}
			fit(1);
			return [status];
		},
	};
	const { root, tui } = dockWith(footer);

	check("a silent footer costs no row", rowsUnderBox(screen(root)) === 0);

	status = "indexing\u2026";
	const speaking = screen(root);
	check("a footer with something to say gets its row back", rowsUnderBox(speaking) === 1);
	check("and the status is on it", speaking.at(-1).includes("indexing"), JSON.stringify(speaking.at(-1)));

	status = "";
	check("and gives it up again", rowsUnderBox(screen(root)) === 0);

	// A terminal too short for the box: the footer must still not be the thing
	// that pushes the box off screen, and nothing may throw.
	status = "indexing\u2026";
	check("survives a screen with no room", screen(root, 2).length === 2);
}

{
	// pi's `regular` tuiMode has no layout root, and no reservation to undo.
	const footer = { render: () => [] };
	const fit = fitDockRows({}, () => footer);
	let threw = false;
	try {
		fit(0);
	} catch {
		threw = true;
	}
	check("no layout root is a no-op, not a crash", !threw);
}

{
	// Two copies of the module (a /reload) must not stack wrappers, and shutdown puts pi's layout back.
	const other = await kitJiti().import(`${KIT_ROOT}/extensions/zen-chrome/dock-layout-rows.ts`, { try: false });
	let renders = 0;
	const gap = { render: () => (renders++, ["x"]) };
	const editor = wrap(lines(["\u256d\u2500 top \u2500\u256e", "\u2502 hi   \u2502", "\u2570\u2500 bot \u2500\u256f"]));
	const above = { component: wrap(gap), shrink: 1, minSize: 0 };
	const box = { component: editor, shrink: 1, minSize: 3 };
	const root = new VStack([above, box]);
	const tui = { layoutRoot: root, requestRender() {} };
	const [aboveEntry, boxEntry] = root[Symbol.for("@earendil-works/pi-tui/layout-node")]().entries;
	const originalVisible = aboveEntry.visible;
	hideBlankRowsAbove(tui, () => editor)();
	const wrapped = aboveEntry.visible;
	other.hideBlankRowsAbove(tui, () => editor)();
	check("a second module copy does not wrap the predicate again", aboveEntry.visible === wrapped && wrapped !== originalVisible);
	capDockFloor(tui, () => editor)(1);
	other.capDockFloor(tui, () => editor)(2);
	check("the floor is capped", boxEntry.minSize === 2);
	other.restoreDockLayout(tui);
	check("shutdown restores the floor and the predicate", boxEntry.minSize === 3 && aboveEntry.visible === originalVisible);
}

await finish();
