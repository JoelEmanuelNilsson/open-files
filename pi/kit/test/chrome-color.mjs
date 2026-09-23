/**
 * What the chrome's light reads out of the terminal.
 *
 *   - A theme that paints in ANSI indices names no channels, so the only way to
 *     mix against its colours is to ask the terminal what each slot shows. The
 *     replies arrive on the same stream as keystrokes and must never reach the
 *     editor, whole or half-arrived.
 *   - A rendered line is repainted glyph by glyph, so it has to survive a split
 *     into cells and a rebuild without losing a style or a code point.
 *   - The bar a session opens with is grey and ends at rest, and the timeline
 *     between the two has to end — a wake that never reports itself finished is
 *     a frame timer that never stops.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { BACKGROUND, parseSlotReplies, splitPending, SlotColors } = await jiti.import(`${ROOT}/lib/slot-colors.ts`);
const { fromCells, toCells } = await jiti.import(`${ROOT}/extensions/zen-chrome/animate.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

console.log("cells: a painted line splits into glyphs and rebuilds unchanged");
{
	const line = "\x1b[38;2;1;2;3ma\x1b[1mb\x1b[0mc";
	const cells = toCells(line);
	eq("every code point is one cell, in order", cells.map((cell) => cell.ch).join(""), "abc");
	eq("styles hold until a reset clears them", cells.map((cell) => cell.sgr), ["\x1b[38;2;1;2;3m", "\x1b[1m\x1b[38;2;1;2;3m", ""]);
	eq("the rebuild carries the same glyphs", toCells(fromCells(cells)).map((cell) => cell.ch).join(""), "abc");
	eq("and the same styles", toCells(fromCells(cells)).map((cell) => cell.sgr), cells.map((cell) => cell.sgr));
	eq("the line ends reset", fromCells(cells).endsWith("\x1b[0m"), true);
}

console.log("\nslots: OSC 4 and OSC 11 replies are read off the input and kept out of the editor");
{
	const reply = "\x1b]4;8;rgb:7878/8282/9696\x07\x1b]4;12;rgb:8c/aa/ff\x1b\\";
	const parsed = parseSlotReplies(`${reply}abc`);
	eq("16-bit and 8-bit channels both land as bytes", parsed.colors, [[8, { r: 120, g: 130, b: 150 }], [12, { r: 140, g: 170, b: 255 }]]);
	eq("keystrokes in the same chunk survive", parsed.rest, "abc");
	eq("the background answers under its own key", parseSlotReplies("\x1b]11;rgb:0808/0b0b/2020\x07").colors, [[BACKGROUND, { r: 8, g: 11, b: 32 }]]);

	let written = "";
	let listener = null;
	const terminal = {
		write: (data) => { written += data; },
		addInputListener: (fn) => { listener = fn; return () => { listener = null; }; },
	};
	let changes = 0;
	const slots = new SlotColors();
	slots.attach(terminal, () => { changes++; });
	eq("one query per slot, then the background", written, `${Array.from({ length: 16 }, (_, i) => `\x1b]4;${i};?\x07`).join("")}\x1b]11;?\x07`);
	eq("nothing is known before the terminal answers", slots.known, false);
	eq("a chunk that is only replies is consumed", listener(reply), { consume: true });
	eq("and the colours are readable afterwards", slots.get(12), { r: 140, g: 170, b: 255 });
	eq("an answer that changed something is announced once", changes, 1);
	eq("and stamps a new version", slots.version, 1);
	eq("the same answers again change nothing", (listener(reply), [changes, slots.version]), [1, 1]);
	eq("unrelated input passes through untouched", listener("x"), {});
	eq("a reply mixed with a keystroke hands the keystroke on", listener(`${reply}y`), { data: "y" });
	slots.dispose();
	eq("dispose stops listening", listener, null);
}

console.log("\nslots: a reply split across two reads is held, not typed into the editor");
{
	eq("a half-arrived reply is held back", splitPending("ab\x1b]4;3;rgb:11"), { pending: "\x1b]4;3;rgb:11", passed: "ab" });
	eq("so is the bare start of one", splitPending("\x1b]"), { pending: "\x1b]", passed: "" });
	eq("an OSC that is not a colour reply is not ours to hold", splitPending("\x1b]0;title\x07"), { pending: "", passed: "\x1b]0;title\x07" });
	eq("plain input is never held", splitPending("hello"), { pending: "", passed: "hello" });

	let listener = null;
	const slots = new SlotColors();
	slots.attach({ write: () => {}, addInputListener: (fn) => { listener = fn; return () => { listener = null; }; } });
	eq("the front half is swallowed", listener("\x1b]4;3;rgb:aaaa/"), { consume: true });
	eq("the back half completes the answer", listener("bbbb/cccc\x07z"), { data: "z" });
	eq("and the colour arrived whole", slots.get(3), { r: 170, g: 187, b: 204 });
	slots.dispose();
}

console.log("\nprism: a glyph the theme painted in an ANSI slot is lit through the palette");
{
	// The theme paints in indexed colours; a light that read only truecolour left
	// the model label sitting still in accent, however warm the ledger said it was.
	const { slotColors } = await jiti.import(`${ROOT}/lib/slot-colors.ts`);
	const { inkOf, restOf, shadeLine, LABEL_LIGHT } = await jiti.import(`${ROOT}/extensions/zen-chrome/prism.ts`);
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
	const { isFrame, isNotFrame } = await jiti.import(`${ROOT}/extensions/zen-chrome/prism.ts`);
	const { HOME_GLYPH } = await jiti.import(`${ROOT}/lib/home-glyph.ts`);
	eq("the outline is the light's own surface", ["\u2500", "\u256d", "\u2502"].map(isFrame), [true, true, true]);
	// A mark, not a letter: nobody reads it, so it is lit rather than tinted, and
	// left out it sat dead in the corner the eye starts at.
	eq("so is the ghost", isFrame(HOME_GLYPH), true);
	eq("a label's letters are not", ["o", "2", " "].map(isFrame), [false, false, false]);
	eq("and the two predicates cannot disagree", ["\u2500", HOME_GLYPH, "o"].map((g) => isFrame(g) === !isNotFrame(g)), [true, true, true]);
}

console.log("\nwake: the bar opens grey, lights, and ends at rest");
{
	const { DARK_MS, greyOut, LIT_MS, WAKE_MS, wakeAt } = await jiti.import(`${ROOT}/extensions/zen-chrome/wake.ts`);
	eq("the bar is fully grey the moment it opens", wakeAt(0, 0), { grey: 1, light: 1 });
	eq("and still grey just before the light", wakeAt(0, DARK_MS - 1), { grey: 1, light: 1 });
	const lighting = wakeAt(0, DARK_MS + LIT_MS * 0.2);
	eq("the grey lifts while the light is still at full", [lighting.grey < 1, lighting.grey > 0, lighting.light], [true, true, 1]);
	const settling = wakeAt(0, DARK_MS + LIT_MS * 0.8);
	eq("then the colour is out and the light is leaving", [settling.grey, settling.light < 1, settling.light > 0], [0, true, true]);
	eq("the wake ends, so the frames can stop", wakeAt(0, WAKE_MS), null);
	eq("a clock that ran backwards asks for nothing", wakeAt(1000, 0), null);

	// Grey is desaturation, not dimming: the bar stays as readable as it ends up.
	const { luminance } = await jiti.import(`${ROOT}/lib/rgb.ts`);
	const line = "\x1b[38;2;40;80;200mcwd\x1b[0m";
	eq("no grey leaves the line alone", greyOut([line], 0), [line]);
	const grey = greyOut([line], 1)[0];
	const [, r, g, b] = /\x1b\[38;2;(\d+);(\d+);(\d+)m(?![\s\S]*\x1b\[38;2;)/.exec(grey).map(Number);
	eq("full grey has no colour left", [r === g, g === b], [true, true]);
	eq("and keeps the glyph's brightness", Math.abs(r - luminance({ r: 40, g: 80, b: 200 })) < 1, true);
	eq("the text itself is untouched", grey.replace(/\x1b\[[0-9;]*m/g, ""), "cwd");
	eq("a glyph the theme never painted has no colour to take out", greyOut(["plain"], 1), ["\x1b[0mplain\x1b[0m"]);
}

console.log("\nglow: the outline's light is a preference, kept outside git");
{
	const { mkdtempSync, readFileSync, statSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	// One state root for the whole block: the choice is read once per process and
	// cached, so a second root would prove nothing a second import could see.
	process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "glow-"));
	const { GLOW_NOTES, GLOWS, glowFile, glowName, parseGlow, setGlowName } = await jiti.import(`${ROOT}/extensions/zen-chrome/choice.ts`);
	eq("a machine that has never chosen gets the default", glowName(), "one");
	eq("a stored name is read back through the newline it was written with", parseGlow("two\n"), "two");
	eq("a name this version does not know is no name at all", parseGlow("prism\n"), null);
	eq("nor is an empty file", parseGlow(""), null);
	setGlowName("two");
	eq("choosing lands in the session that chose", glowName(), "two");
	// The next session reads the file rather than this process, so what lands on
	// disk has to parse back to the same name.
	eq("and in the file the next one reads", parseGlow(readFileSync(glowFile(), "utf8")), "two");
	eq("a preference is nobody else's business", statSync(glowFile()).mode & 0o077, 0);
	eq("every name says what it is", GLOWS.every((name) => typeof GLOW_NOTES[name] === "string"), true);
	delete process.env.XDG_STATE_HOME;
}

console.log("\nglow: the two lights differ where they say they differ");
{
	const { ONE_HUE, TWO_HUES, LABEL_LIGHT, ROW_LIGHT, CALL_LIGHT } = await jiti.import(`${ROOT}/extensions/zen-chrome/prism.ts`);
	// One hue on the whole frame at once against two meeting on it: the spread is
	// the whole difference in kind, and everything else is tuning.
	eq("one puts every lamp on the same hue", ONE_HUE.spread, 0);
	eq("two spreads them over part of a fold", TWO_HUES.spread > 0 && TWO_HUES.spread < 1, true);
	eq("both take their reach from their spacing", [ONE_HUE.reach2, TWO_HUES.reach2], [null, null]);
	// The text lights were tuned on the rainbow and are not part of this choice:
	// a label is read, so its colour stays where the reader last saw it.
	eq("the text lights keep the full arc", [LABEL_LIGHT.spread, ROW_LIGHT.spread, CALL_LIGHT.spread], [1, 1, 1]);
}

console.log("\nlabels: a label-length strip takes the label light, not a row's");
{
	const { LABEL_LIGHT, ROW_LIGHT, shadeLine } = await jiti.import(`${ROOT}/extensions/zen-chrome/prism.ts`);
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
	const { CALL_LIGHT, FOLDED_BAR_LIGHT, ROW_LIGHT, shadeLine } = await jiti.import(`${ROOT}/extensions/zen-chrome/prism.ts`);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
