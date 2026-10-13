/**
 * The folded prompt box: an idle, empty prompt collapses to one packed row —
 * two when one cannot hold every reading — and the moment there is any text — or an autocomplete list, or a scroll
 * indicator — it is the full box again.
 *
 * The decision and the row layout are pure (`fold.ts`) and are pinned here
 * across widths; prompt-box-editor.test.mjs boots the real extension.
 */

import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();
const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const { FOLD_ENDS, foldRows, isPromptFolded } = await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/fold.ts`);

const bare = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

console.log("fold: when the box folds");
const idle = { text: "", contentRows: 1, autocompleteRows: 0, scrolled: false };
eq("an empty one-row prompt folds", isPromptFolded(idle), true);
eq("any text unfolds it", isPromptFolded({ ...idle, text: "h" }), false);
eq("whitespace is text", isPromptFolded({ ...idle, text: " " }), false);
eq("an autocomplete list unfolds it", isPromptFolded({ ...idle, autocompleteRows: 3 }), false);
eq("a scroll indicator unfolds it", isPromptFolded({ ...idle, scrolled: true }), false);
eq("more than one content row unfolds it", isPromptFolded({ ...idle, contentRows: 2 }), false);

console.log("fold: one row, or two, filled in priority order");
const dash = (text) => `\x1b[90m${text}\x1b[0m`;
const labels = {
	side: [],
	path: [{ text: "~/dotfiles", paint: (t) => `\x1b[34m${t}\x1b[0m` }],
	session: [],
	branch: [{ text: "main", paint: (t) => `\x1b[34m${t}\x1b[0m` }],
	model: [{ text: "opus" }, { text: " ▱▱▱", atomic: true }],
	timer: [{ text: "1m 12s ", atomic: true }],
	tasks: [{ text: "2 tasks ↓", atomic: true }, { text: " 4m 10s", atomic: true }],
	cache: [{ text: "❄4m ", atomic: true }],
	context: [{ text: "31.4k", atomic: true }],
};
const rows = (width, given = labels) => foldRows(width, given, dash);
// Every gap read as its narrowest form, so a reading test does not depend on how wide the gaps grew.
const squash = (text) => text.replace(/ ─+ /g, "  ");
const shownRows = (width) => rows(width).map((row) => squash(bare(row)));
const shown = (width) => shownRows(width).join("\n");
// The widths of the gaps between readings on a row, in order.
const gapWidths = (row) => [...bare(row).slice(3, -3).matchAll(/ ─* /g)].map((m) => m[0].length);

// Priority order, which is also left-to-right order, and the text that shows each reading.
const READINGS = [
	["path", "~/dot"],
	["branch", "main"],
	["model", "opus ▱▱▱"],
	["timer", "1m 12s"],
	["tasks", "2 tasks ↓ 4m 10s"],
	["cache", "❄4m"],
	["context", "31.4k"],
];
const readingsAt = (width) => READINGS.filter(([, marker]) => shown(width).includes(marker)).map(([name]) => name);
const ALL = READINGS.map(([name]) => name);

eq(
	"one row, every reading in priority order, when they all fit",
	[rows(120).length, /^╶─ ~\/dotfiles-main  opus ▱▱▱  1m 12s  2 tasks ↓ 4m 10s  ❄4m  31\.4k ─+╴$/.test(shown(120))],
	[1, true],
);
eq("on one row the branch joins the path with a bare dash", shown(120).includes("~/dotfiles-main"), true);
eq(
	"the session name follows the joined path and branch",
	squash(bare(rows(120, { ...labels, session: [{ text: " • fold" }] })[0] ?? "")).startsWith("╶─ ~/dotfiles-main • fold  opus"),
	true,
);
eq("too narrow for the branch, it drops with its dash and ends the fold", shownRows(18), ["╶─ ~/dotfiles ───╴"]);
eq("on two rows the branch stays joined to the path", shownRows(60)[0]?.includes("~/dotfiles-main"), true);
eq("capped by the half-dash ends", [shown(120).at(0), shown(120).at(-1)], [FOLD_ENDS.left, FOLD_ENDS.right]);
eq("the cache is the flake and the minutes, nothing between", shown(120).includes("  ❄4m  "), true);
eq("two rows once one cannot hold them all", rows(60).length, 2);
eq("the first row fills in order until the next reading does not fit", shownRows(60)[0], "╶─ ~/dotfiles-main  opus ▱▱▱  1m 12s  2 tasks ↓ 4m 10s ─╴");
eq("the second row takes the rest, in order", squash(shownRows(60)[1] ?? "").startsWith("╶─ ❄4m  31.4k"), true);
eq("at 40, everything still shows across the two rows", readingsAt(40), ALL);

let everyWidth = true;
let atMostTwo = true;
for (let width = 0; width <= 220; width++) {
	const out = rows(width);
	if (out.length < 1 || out.length > 2) atMostTwo = false;
	if (out.some((row) => visibleWidth(row) !== width || row.includes("\n"))) everyWidth = false;
}
eq("every row, at every width from 0 to 220, is exactly the width", everyWidth, true);
eq("never more than two rows", atMostTwo, true);

// The hierarchy holds at every width: what shows is always a prefix of the
// priority order, so a reading never shows while one above it is hidden, and
// widening the bar never takes a reading away.
let prefix = true;
let monotonic = true;
let ordered = true;
let previous = 0;
for (let width = 14; width <= 220; width++) {
	const names = readingsAt(width);
	if (JSON.stringify(names) !== JSON.stringify(ALL.slice(0, names.length))) {
		prefix = false;
		console.log(`       at ${width}: ${names.join(", ")}`);
	}
	if (names.length < previous) monotonic = false;
	previous = names.length;
	const text = shown(width);
	const at = READINGS.map(([, marker]) => text.indexOf(marker)).filter((index) => index >= 0);
	if (at.some((index, i) => i > 0 && index < (at[i - 1] ?? 0))) ordered = false;
}
eq("what shows is always the top of the priority order", prefix, true);
eq("widening the bar never hides a reading", monotonic, true);
eq("the readings shown are always in the fixed left-to-right order", ordered, true);
eq("the lowest priority drops first once two rows are full", readingsAt(24), ["path", "branch", "model", "timer"]);

eq("the path alone, whole, on a narrow first row", shownRows(16)[0]?.startsWith("╶─ ~/dotfiles ─"), true);
eq("the path is shortened only when it alone does not fit", shown(14).includes("~/dot"), true);
eq("the path shortens with an ellipsis", shown(14).includes("…"), true);
eq("the tasks go whole, never half", shownRows(30).every((row) => row.includes("2 tasks") === row.includes("4m 10s")), true);
eq("a label's trailing space is not doubled by the separator", shown(120).includes("❄4m  31.4k"), true);
eq("an empty path leaves no leading separator", squash(bare(rows(80, { ...labels, path: [] })[0] ?? "")).startsWith("╶─ main  "), true);
eq("gaps are painted in the border colour", /\x1b\[90m ─+ \x1b\[0m/.test(rows(120)[0] ?? ""), true);
for (const width of [80, 100, 120, 160, 200]) {
	eq(`at ${width}, every gap is the same width`, new Set(gapWidths(rows(width)[0] ?? "")).size, 1);
}
eq(
	"gaps narrow as the bar narrows",
	gapWidths(rows(200)[0])[0] > gapWidths(rows(120)[0])[0] && gapWidths(rows(120)[0])[0] > gapWidths(rows(80)[0])[0],
	true,
);
eq("with room to spare the readings reach across the bar", /31\.4k ─{1,6}╴$/.test(bare(rows(200)[0] ?? "")), true);

await finish();
