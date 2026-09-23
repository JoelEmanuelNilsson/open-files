/**
 * The chrome's repainted rows put the same cells on screen in fewer bytes.
 *
 * Every lit row is split into cells and rebuilt by `animate.ts`, at up to 30
 * frames a second. A rebuild that re-sent every escape the row was painted
 * with made each row ~90% escapes, and a frame that large reaches the
 * multiplexer in pieces it may show half-drawn. Screens here are compared by
 * replaying the bytes through a headless xterm, cell by cell.
 */

import "./env.mjs";
import { createRequire } from "node:module";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const { fg, fromCells, toCells } = await jiti.import(`${ROOT}/extensions/zen-chrome/animate.ts`);
const { CALL_LIGHT, isNotFrame, LABEL_LIGHT, shadeBox, shadeLine } = await jiti.import(`${ROOT}/extensions/zen-chrome/prism.ts`);
const { greyOut } = await jiti.import(`${ROOT}/extensions/zen-chrome/wake.ts`);
const { slotColors } = await jiti.import(`${ROOT}/lib/slot-colors.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const COLS = 400;
// Left over by whatever was drawn before the row; a row that styles itself from
// a reset must not show any of it, and must leave none of its own behind.
const DIRTY = "\x1b[1;2;3;4;5;7;9;53;38;5;1;48;2;9;8;7;58;5;3m";
const PROBE = "#";

/** Every cell of the first screen row after `bytes`, as the terminal holds it. */
async function screenCells(bytes) {
	const term = new Terminal({ cols: COLS, rows: 2, allowProposedApi: true });
	await new Promise((resolve) => term.write(bytes, resolve));
	const line = term.buffer.active.getLine(0);
	const cells = [];
	for (let x = 0; x < COLS; x++) {
		const c = line.getCell(x);
		cells.push([
			c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(),
			c.isBold(), c.isDim(), c.isItalic(), c.isUnderline(), c.isBlink(), c.isInverse(), c.isInvisible(), c.isStrikethrough(), c.isOverline(),
		].join("|"));
	}
	term.dispose();
	return cells;
}

/** The first column where two byte streams put different cells on screen, or null. */
async function firstScreenDifference(a, b) {
	const [left, right] = await Promise.all([screenCells(a), screenCells(b)]);
	const x = left.findIndex((cell, i) => cell !== right[i]);
	return x < 0 ? null : { x, a: left[x], b: right[x] };
}

// The reference encoding: a reset and the cell's own escapes before every cell.
const resetPerCell = (cells) => `${cells.map((cell) => `\x1b[0m${cell.sgr}${cell.ch}`).join("")}\x1b[0m`;

// A seeded generator, so a failure names an input that reproduces.
let seed = 0x5eed;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
const pick = (list) => list[Math.floor(random() * list.length)];

const ESCAPES = [
	"\x1b[0m", "\x1b[m", "\x1b[;1m", "\x1b[1m", "\x1b[2m", "\x1b[22m", "\x1b[3m", "\x1b[23m", "\x1b[4m", "\x1b[21m", "\x1b[24m",
	"\x1b[5m", "\x1b[25m", "\x1b[7m", "\x1b[27m", "\x1b[8m", "\x1b[28m", "\x1b[9m", "\x1b[29m", "\x1b[53m", "\x1b[55m",
	"\x1b[31m", "\x1b[91m", "\x1b[39m", "\x1b[42m", "\x1b[103m", "\x1b[49m", "\x1b[38;5;8m", "\x1b[38;5;208m", "\x1b[48;5;17m",
	"\x1b[38;2;1;2;3m", "\x1b[38;2;250;128;0m", "\x1b[48;2;9;9;9m", "\x1b[1;38;2;4;5;6;48;5;3m", "\x1b[0;3;38;5;4m",
	"\x1b[58;5;1m", "\x1b[59m", "\x1b[4;58;2;1;2;3m", "\x1b[10m", "\x1b[51m", "\x1b[038;05;001m", "\x1b[22;1m",
];
const GLYPHS = ["a", "Z", " ", "\u2500", "\u25b1", "\u2193", "\u4e2d", "\udbc0\udc00"];

// Real rows from a session: the box's top rule, and the folded bottom bar as
// the rebuild used to write it.
const BOX_TOP = "\u001b[38;5;7m╭\u001b[39m\u001b[38;5;7m─\u001b[39m \u001b[38;5;4m\udbc0\udc00/dotfiles\u001b[39m \u001b[38;5;7m─────────\u001b[39m \u001b[38;5;7m↑ 1 more\u001b[39m \u001b[38;5;7m──\u001b[39m \u001b[38;5;7m\udbc0\udc00\u001b[39m \u001b[38;5;7m─────\u001b[39m \u001b[38;5;4mopus\u001b[39m\u001b[0m \u001b[0m\u001b[38;2;92;130;242m▱\u001b[0m\u001b[38;2;50;20;53m▱\u001b[0m\u001b[38;2;53;22;20m▱\u001b[0m\u001b[38;2;47;53;20m▱\u001b[0m\u001b[38;2;20;53;31m▱\u001b[0m \u001b[38;5;7m─\u001b[39m\u001b[38;5;7m╮\u001b[39m\u001b[0m";
const BAR = "\u001b[0m\u001b[38;5;7m╶─\u001b[0m\u001b[38;5;7m\u001b[39m \u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\udbc0\udc00/dotfiles\u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;4m-main\u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m ─ \u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;5;7mopus\u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;5;7m\u001b[39m \u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;2;92;130;242m▱\u001b[0m\u001b[38;2;50;20;53m▱\u001b[0m\u001b[38;2;53;22;20m▱\u001b[0m\u001b[38;2;47;53;20m▱\u001b[0m\u001b[38;2;20;53;31m▱\u001b[0m\u001b[38;5;7m ─ \u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m47s\u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m ─ \u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;5;8m1 task ↓\u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;5;8m\u001b[39m\u001b[38;5;4m 42s\u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;5;8m\u001b[39m\u001b[38;5;4m\u001b[39m \u001b[0m\u001b[38;5;7m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m\u001b[39m\u001b[38;5;8m\u001b[39m\u001b[38;5;4m\u001b[39m\u001b[38;5;7m───╴\u001b[0m\u001b[0m";
const BOX_MID = "\x1b[38;5;7m│\x1b[39m \x1b[1mhello\x1b[22m \x1b[38;5;4mworld\x1b[39m\x1b[38;5;7m│\x1b[39m";
const BOX_BOTTOM = "\x1b[38;5;7m╰──────────────╯\x1b[39m";

// The lights read indexed colours through the terminal's palette; a session
// learns it from OSC 4 replies, and so does this file.
const PALETTE = ["1d1f21", "cc6666", "b5bd68", "f0c674", "81a2be", "b294bb", "8abeb7", "c5c8c6", "666666", "d54e53", "b9ca4a", "e7c547", "7aa6da", "c397d8", "70c0b1", "eaeaea"];
const slots = slotColors();
let listener = null;
slots.attach({ write: () => {}, addInputListener: (fn) => { listener = fn; return () => { listener = null; }; } });
listener(PALETTE.map((hex, i) => `\x1b]4;${i};rgb:${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4, 6)}\x07`).join(""));

const PHASES = [0, 0.37, 1.5, 4.2, 9.9];
const litRows = [
	...PHASES.flatMap((t) => [0, 0.5].map((fade) => [`wave on the folded bar, t=${t} fade=${fade}`, shadeLine(BAR, t, "self", { fade })])),
	...PHASES.map((t) => [`call light on the bar, t=${t}`, shadeLine(BAR, t, "self", { light: CALL_LIGHT })]),
	...PHASES.flatMap((t) => shadeBox([BOX_TOP, BOX_MID, BOX_BOTTOM], t).map((row, y) => [`wave on the box, t=${t} row ${y}`, row])),
	...PHASES.map((t) => [`shimmer on the model label, t=${t}`, shadeLine("\x1b[38;5;4mopus\x1b[39m", t, "self", { light: LABEL_LIGHT, offset: 2, total: 9 })]),
	...[0.1, 0.5, 0.9].map((fade) => [`level flash fading, fade=${fade}`, shadeLine("\x1b[38;5;4mhigh\x1b[39m", 1.2, "self", { light: LABEL_LIGHT, fade })]),
	...PHASES.map((t) => [`tasks label, t=${t}`, shadeLine("\x1b[38;5;8m2 tasks \u2193\x1b[39m", t, "self", { light: LABEL_LIGHT })]),
	...[1, 0.5].flatMap((grey) => greyOut(shadeBox([BOX_TOP, BOX_MID, BOX_BOTTOM], 2, { tint: isNotFrame, fade: 0.3 }), grey).map((row, y) => [`wake at grey ${grey}, row ${y}`, row])),
];

console.log("cells: a painted line resolves to the style in force");
{
	const cells = toCells("\x1b[38;2;1;2;3ma\x1b[1mb\x1b[0mc\x1b[1;2m\x1b[22md");
	eq("each cell carries one escape per attribute, not the escapes that built it", cells.map((cell) => cell.sgr), ["\x1b[38;2;1;2;3m", "\x1b[1m\x1b[38;2;1;2;3m", "", ""]);
	eq("a pile of overridden colours collapses to the last", toCells("\x1b[38;5;7m\x1b[39m\x1b[38;5;4m\x1b[39m\x1b[38;5;8mx")[0].sgr, "\x1b[38;5;8m");
	eq("an extended colour keeps its spelling", toCells("\x1b[38;5;1;48;2;1;2;3mx")[0].sgr, "\x1b[38;5;1m\x1b[48;2;1;2;3m");
	eq("an empty line rebuilds to a bare reset", fromCells([]), "\x1b[0m");
	eq("an unstyled line opens and ends reset", fromCells(toCells("plain")), "\x1b[0mplain\x1b[0m");
	eq("one colour change is one escape", fromCells(toCells("\x1b[31mab\x1b[32mc")), "\x1b[0m\x1b[31mab\x1b[32mc\x1b[0m");
	eq("an attribute dropped is switched off, not reset", fromCells(toCells("\x1b[1;31ma\x1b[22mb")), "\x1b[0m\x1b[1m\x1b[31ma\x1b[22mb\x1b[0m");
	eq("a reset is used when it is shorter", fromCells(toCells("\x1b[1;3;4;9;31ma\x1b[0mb")), "\x1b[0m\x1b[1m\x1b[3m\x1b[4m\x1b[9m\x1b[31ma\x1b[0mb\x1b[0m");
	eq("bold dropped with dim kept takes the shorter reset", fromCells(toCells("\x1b[1;2ma\x1b[22;2mb")), "\x1b[0m\x1b[1;2ma\x1b[0m\x1b[2mb\x1b[0m");
	eq("and a longer style is switched off in place", fromCells(toCells("\x1b[1;2;38;5;208ma\x1b[22;2mb")), "\x1b[0m\x1b[1;2m\x1b[38;5;208ma\x1b[22m\x1b[2mb\x1b[0m");
	eq("a code with no off switch needs a reset to leave", fromCells(toCells("\x1b[51;31ma\x1b[0;31mb")), "\x1b[0m\x1b[31m\x1b[51ma\x1b[0m\x1b[31mb\x1b[0m");
}

console.log("\nscreen: a rebuilt line shows the same cells as the line it came from");
{
	const crafted = [
		["wide glyphs and a nerd-font surrogate pair", "\x1b[38;5;4m\u4e2d\u6587\x1b[39m \udbc0\udc00 \x1b[1m\u4e2dx\x1b[0m"],
		["nested resets", "\x1b[1m\x1b[3ma\x1b[0m\x1b[4mb\x1b[m\x1b[;9mc\x1b[0;1md"],
		["256-colour and truecolour mixed on both planes", "\x1b[38;5;208;48;2;1;2;3ma\x1b[38;2;4;5;6mb\x1b[48;5;17mc\x1b[91;103md\x1b[39;49me"],
		["every per-attribute off code", "\x1b[1;2;3;4;5;7;8;9;53ma\x1b[22mb\x1b[23mc\x1b[24md\x1b[25me\x1b[27mf\x1b[28mg\x1b[29mh\x1b[55mi"],
		["an OSC 8 link passes through", "\x1b[38;5;4m\x1b]8;;https://x.test\x07link\x1b]8;;\x07\x1b[39m after"],
	];
	for (const [label, line] of crafted) {
		eq(label, await firstScreenDifference(line, fromCells(toCells(line))), null);
	}
	for (const [label, line] of [["the box's top rule", BOX_TOP], ["the folded bar", BAR], ...litRows]) {
		eq(`${label}: rebuilt`, await firstScreenDifference(line, fromCells(toCells(line))), null);
	}

	let first = null;
	for (let n = 0; n < 300 && first === null; n++) {
		const line = Array.from({ length: 24 }, () => (random() < 0.4 ? pick(ESCAPES) : pick(GLYPHS))).join("");
		const diff = await firstScreenDifference(line, fromCells(toCells(line)));
		if (diff !== null) first = { line, diff };
	}
	eq("300 generated lines rebuild to the same screen", first, null);
}

console.log("\nrestyled: cells a light has repainted show as each cell's own escapes would");
{
	// What the lights do to a cell: append a colour (a tint, a grey), or replace
	// the style outright (the box's outline).
	const restyles = [
		(cell) => ({ ch: cell.ch, sgr: cell.sgr + fg({ r: Math.floor(random() * 256), g: 90, b: 200 }) }),
		(cell) => ({ ch: cell.ch, sgr: fg({ r: 10, g: Math.floor(random() * 256), b: 30 }) }),
		(cell) => cell,
		(cell) => ({ ch: cell.ch, sgr: cell.sgr + pick(ESCAPES) + pick(ESCAPES) }),
	];
	let first = null;
	const sources = [BOX_TOP, BAR, BOX_MID];
	for (let n = 0; n < 200 && first === null; n++) {
		const cells = toCells(pick(sources)).map((cell) => pick(restyles)(cell));
		const diff = await firstScreenDifference(DIRTY + resetPerCell(cells) + PROBE, DIRTY + fromCells(cells) + PROBE);
		if (diff !== null) first = { cells, diff };
	}
	eq("200 restyled rows match a reset before every cell, with a dirty terminal before and a glyph after", first, null);
	const cells = toCells(BAR).map((cell, i) => (i % 3 === 0 ? { ch: cell.ch, sgr: cell.sgr + fg({ r: i, g: 2 * i, b: 3 * i }) } : cell));
	eq("a row leaves nothing styled behind it", (await screenCells(`${DIRTY}${fromCells(cells)}${PROBE}`))[toCells(BAR).length], (await screenCells(PROBE))[0]);
}

console.log("\nbytes: a lit row is mostly glyphs again");
{
	const bytes = (s) => Buffer.byteLength(s);
	// Measured 2026-09-23 on this bar: 929 bytes as written, 273 rebuilt (29%).
	// Lit at t=4.2 it went from 3684 bytes to 1129 (31%).
	const rebuilt = fromCells(toCells(BAR));
	eq(`the bar as the old rebuild wrote it (${bytes(BAR)} B) rebuilds in at most a third (${bytes(rebuilt)} B)`, bytes(rebuilt) * 3 <= bytes(BAR), true);
	// Lit, every glyph carries its own truecolour: 19 bytes of escape at most per
	// cell, besides the glyph's own and the row's two resets. The old rebuild paid ~2x that.
	const worst = (row) => bytes(row.replace(/\x1b\[[0-9;]*m/g, "")) + 19 * toCells(row).length + 8;
	const lit = litRows.filter(([label]) => label.startsWith("wave on the folded bar"));
	eq("each lit bar costs no more than one truecolour escape per cell", lit.filter(([, row]) => bytes(row) > worst(row)).map(([label]) => label), []);
}

slots.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
