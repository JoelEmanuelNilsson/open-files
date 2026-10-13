/**
 * The chrome's light (lib/ui/prism-light.ts): a glyph painted in an ANSI slot
 * is lit through the terminal's palette, the frame predicates, and the lights'
 * tunings on labels, rows and the box.
 */

import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();
const { toCells } = await jiti.import(`${KIT_ROOT}/lib/ui/sgr-cells.ts`);

console.log("prism: a glyph the theme painted in an ANSI slot is lit through the palette");
{
	// The theme paints in indexed colours; a light that read only truecolour left
	// the model label sitting still in accent, however warm the ledger said it was.
	const { slotColors } = await jiti.import(`${KIT_ROOT}/lib/ui/terminal-slot-colors.ts`);
	const { inkOf, restOf, shadeLine, LABEL_LIGHT } = await jiti.import(`${KIT_ROOT}/lib/ui/prism-light.ts`);
	const slots = slotColors();
	let listener = null;
	slots.attach({ write: () => {}, addInputListener: (fn) => { listener = fn; return () => { listener = null; }; } });
	listener("\x1b]4;8;rgb:8080/8080/8080\x07");
	eq("an indexed foreground resolves to the palette's colour", restOf("\x1b[38;5;8m"), { r: 128, g: 128, b: 128 });
	eq("a truecolour one is read as written", restOf("\x1b[38;2;1;2;3m"), { r: 1, g: 2, b: 3 });
	eq("an unpainted glyph has no rest", restOf(""), null);
	// A label let into a rule is drawn inside the border's colour and then its
	// own: reading the first escape tinted every label against the border and
	// left it landing on the wrong colour as the light went.
	eq("the last foreground set is the one on screen", restOf("\x1b[38;2;90;100;120m\x1b[38;2;1;2;3m"), { r: 1, g: 2, b: 3 });
	eq("a named colour is a palette slot spelled differently", restOf("\x1b[90m"), { r: 128, g: 128, b: 128 });
	eq("a glyph handed back to the terminal's own foreground has no rest", restOf("\x1b[38;2;1;2;3m\x1b[39m"), null);
	eq("a background colour is not a foreground", restOf("\x1b[48;2;1;2;3m"), null);
	eq("a sample of the theme is read at the colour it paints", inkOf("\x1b[38;2;1;2;3mopus\x1b[39m"), { r: 1, g: 2, b: 3 });
	// The effort slider opens with an unpainted space. Reading only the first
	// glyph said the label resolved to nothing, and a label that resolves to
	// nothing is painted flat accent whenever it is lit.
	eq("a leading unpainted glyph is not the answer", inkOf(" \x1b[38;2;1;2;3m▱\x1b[39m"), { r: 1, g: 2, b: 3 });
	eq("a string that paints nothing still resolves to nothing", inkOf("  "), null);
	const indexed = "\x1b[38;5;8mfable\x1b[39m";
	const lit = shadeLine(indexed, 1.5, "self", { light: LABEL_LIGHT });
	eq("so a label painted in a slot is repainted by the light", lit !== indexed, true);
	eq("in truecolour", /\x1b\[38;2;\d+;\d+;\d+m/.test(lit), true);
	slots.dispose();
}

console.log("\nprism: the light carries the frame, ghost and all");
{
	const { isFrame, isNotFrame } = await jiti.import(`${KIT_ROOT}/lib/ui/prism-light.ts`);
	const { HOME_GLYPH } = await jiti.import(`${KIT_ROOT}/lib/ui/home-glyph.ts`);
	eq("the outline is the light's own surface", ["\u2500", "\u256d", "\u2502"].map(isFrame), [true, true, true]);
	// A mark, not a letter: nobody reads it, so it is lit rather than tinted, and
	// left out it sat dead in the corner the eye starts at.
	eq("so is the ghost", isFrame(HOME_GLYPH), true);
	eq("a label's letters are not", ["o", "2", " "].map(isFrame), [false, false, false]);
	eq("and the two predicates cannot disagree", ["\u2500", HOME_GLYPH, "o"].map((g) => isFrame(g) === !isNotFrame(g)), [true, true, true]);
}

console.log("\nglow: the text lights keep the full arc");
{
	const { LABEL_LIGHT, ROW_LIGHT, CALL_LIGHT } = await jiti.import(`${KIT_ROOT}/lib/ui/prism-light.ts`);
	eq("the text lights keep the full arc", [LABEL_LIGHT.spread, ROW_LIGHT.spread, CALL_LIGHT.spread], [1, 1, 1]);
}

console.log("\nlabels: a label-length strip takes the label light, not a row's");
{
	const { LABEL_LIGHT, ROW_LIGHT, shadeLine } = await jiti.import(`${KIT_ROOT}/lib/ui/prism-light.ts`);
	// The bottom rule's `2 tasks \u2193`, painted dim and lit where it stands.
	const REST = { r: 120, g: 120, b: 140 };
	const label = `\x1b[38;2;${REST.r};${REST.g};${REST.b}m2 tasks \u2193\x1b[0m`;
	// How far each glyph has been carried from its resting colour. A lamp passing
	// along the strip leaves some glyphs near rest and some at its core; a light
	// whose lamps all cover the whole strip leaves every glyph at the same
	// distance, which is the block pulse the label tuning exists to avoid.
	const travel = (line, light) =>
		toCells(shadeLine(line, 0.4, "self", { light })).map((cell) => {
			const last = [...cell.sgr.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].pop();
			return last === undefined ? 0 : Math.hypot(last[1] - REST.r, last[2] - REST.g, last[3] - REST.b);
		});
	const range = (light) => {
		const moved = travel(label, light);
		return Math.max(...moved) / Math.max(1, Math.min(...moved));
	};
	eq("the label light puts lamps and gaps on nine cells", range(LABEL_LIGHT) > 2, true);
	eq("a row's light would light all nine at once", range(ROW_LIGHT) < 1.3, true);
	eq("and the label still reads as itself", shadeLine(label, 0.4, "self", { light: LABEL_LIGHT }).replace(/\x1b\[[0-9;]*m/g, ""), "2 tasks \u2193");
}

console.log("\npastel: bright text under the light never shows white between lamps");
{
	const { CALL_LIGHT, FOLDED_BAR_LIGHT, ROW_LIGHT, shadeLine } = await jiti.import(`${KIT_ROOT}/lib/ui/prism-light.ts`);
	// A tool row's cream, and the folded bar's rule and model in the terminal's
	// white slot, are the brightest text on screen: left at their own colour
	// between pools they read as white bands travelling along the row.
	const CREAM = { r: 246, g: 221, b: 209 };
	const WHITE_SLOT = { r: 197, g: 200, b: 198 };
	const paint = (c, text) => `\x1b[38;2;${c.r};${c.g};${c.b}m${text}\x1b[0m`;
	const toolRow = paint(CREAM, "Running 1 shell command ".repeat(3));
	const barRow = `${paint(WHITE_SLOT, "\u2576\u2500 ")}${paint({ r: 129, g: 162, b: 190 }, "~/dotfiles")}${paint(WHITE_SLOT, " \u2500 opus \u2500 47s \u2500".padEnd(40, "\u2500"))}`;
	const colours = (row, light, t) =>
		toCells(shadeLine(row, t, "self", { light })).flatMap((cell) => {
			const last = [...cell.sgr.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].pop();
			return cell.ch.trim() === "" || last === undefined ? [] : [{ r: Number(last[1]), g: Number(last[2]), b: Number(last[3]) }];
		});
	const over = (row, light) => Array.from({ length: 130 }, (_, i) => i / 5).flatMap((t) => colours(row, light, t));
	const chroma = (c) => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / Math.max(c.r, c.g, c.b);
	// Chroma 0.15 is the cream itself; the pastel rests near 0.4.
	eq("a lit tool row never goes pale", Math.min(...over(toolRow, CALL_LIGHT).map(chroma)) > 0.3, true);
	eq("nor does the folded bar, rule and model included", Math.min(...over(barRow, FOLDED_BAR_LIGHT).map(chroma)) > 0.3, true);
	eq("where a task row, resting at its own colour, would", Math.min(...over(barRow, ROW_LIGHT).map(chroma)) < 0.1, true);
	// OKLab lightness. At one HSV value the gold and green end of the arc is 0.15 to
	// 0.2 above the violet end, so a tint sweeping into yellow flared.
	const lin = (u) => ((u /= 255) <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
	const lightness = (c) => {
		const [r, g, b] = [c.r, c.g, c.b].map(lin);
		const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
		const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
		const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
		return 0.2104542553 * l + 0.793617785 * m - 0.0040720718 * s;
	};
	const levels = over(toolRow, CALL_LIGHT).map(lightness);
	eq("and holds one lightness as it passes through yellow", Math.max(...levels) - Math.min(...levels) < 0.08, true);
	eq("and the row still reads as itself", shadeLine(toolRow, 1, "self", { light: CALL_LIGHT }).replace(/\x1b\[[0-9;]*m/g, ""), "Running 1 shell command ".repeat(3));
}

await finish();
