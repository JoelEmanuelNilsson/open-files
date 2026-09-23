/**
 * The folded prompt box: an idle, empty prompt collapses to one packed row —
 * two when one cannot hold every reading — and the moment there is any text — or an autocomplete list, or a scroll
 * indicator — it is the full box again.
 *
 * The decision and the row layout are pure (`fold.ts`) and are pinned here
 * across widths; then the real extension is booted and its editor rendered
 * alone and inside pi's real fullscreen layout.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { visibleWidth } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/utils.js`);
const { CURSOR_MARKER } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const { FOLD_ENDS, foldRows, isPromptFolded } = await jiti.import(`${ROOT}/extensions/zen-chrome/fold.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
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

// ---------------------------------------------------------------------------
// The real extension: its editor rendered.
// ---------------------------------------------------------------------------

console.log("fold: the editor, through the extension");
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t };
const handlers = new Map();
let editorFactory;
const ctx = {
	mode: "tui",
	cwd: ROOT,
	hasUI: true,
	model: { id: "claude-opus-5", reasoning: true },
	thinkingLevel: "high",
	sessionManager: {
		getCwd: () => "/Users/joel/dotfiles",
		getSessionName: () => undefined,
		getSessionId: () => "prompt-fold",
		getBranch: () => [],
		getEntries: () => [],
	},
	getContextUsage: () => ({ percent: 12, tokens: 31_400 }),
	ui: {
		theme,
		notify: () => {},
		setWorkingVisible: () => {},
		setFooter: () => {},
		setEditorComponent: (factory) => {
			editorFactory = factory;
		},
	},
};
const api = {
	registerTool: () => {},
	registerCommand: () => {},
	registerEntryRenderer: () => {},
	registerShortcut: () => {},
	appendEntry: () => {},
	on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	getAllTools: () => [],
	getActiveTools: () => [],
	getThinkingLevel: () => "high",
	events: { on: () => {}, emit: () => {} },
	flags: new Map(),
};
const extension = await jiti.import(`${ROOT}/extensions/zen-chrome/index.ts`, { default: true });
await extension(api);
for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);

const tui = {
	terminal: { rows: 40, columns: 80, write: () => {} },
	requestRender: () => {},
	addInputListener: () => () => {},
};
const identity = (t) => t;
const editorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};
// No app keybinding matches, so keys fall through to pi-tui's own editor bindings.
const editor = editorFactory(tui, editorTheme, { matches: () => false });
editor.focused = true;

let out = editor.render(80);
eq("the empty prompt folds to one row", out.length, 1);
eq("the row is exactly the width", visibleWidth(out[0]), 80);
eq("it reads path, branch-less, model", squash(bare(out[0])).includes("/dotfiles  opus"), true);
eq("no cursor marker in the folded row", out.some((line) => line.includes(CURSOR_MARKER)), false);

editor.setText("hi");
out = editor.render(80);
eq("text unfolds it to the full box", out.length, 3);
eq("with the cursor back in it", out.some((line) => line.includes(CURSOR_MARKER)), true);
editor.setText("");
eq("and clearing the text folds it again", editor.render(80).length, 1);

// A buffer taller than the box scrolls: 40 terminal rows give it 12 visible rows,
// so 30 lines with the cursor on the last leave 18 above the box.
const tall = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
editor.setText(tall);
out = editor.render(80).map(bare);
const readings = (line) => ["/dotfiles", "opus", "31.4k", "↑ 18 more", "↓ 18 more"].filter((text) => line.includes(text));
eq("scrolled to the end, the top rule keeps its readings and says what is above", readings(out[0]), ["/dotfiles", "opus", "↑ 18 more"]);
eq("and the bottom rule keeps its own", readings(out.at(-1)), ["31.4k"]);
for (let i = 0; i < 29; i++) editor.handleInput("\x1b[A");
out = editor.render(80).map(bare);
eq("scrolled to the top, the top rule has nothing above to report", readings(out[0]), ["/dotfiles", "opus"]);
eq("and the bottom rule says what is below, beside its readings", readings(out.at(-1)), ["31.4k", "↓ 18 more"]);
eq("both rules are exactly the width", [visibleWidth(out[0]), visibleWidth(out.at(-1))], [80, 80]);
editor.setText("");

const { publishCacheWindow, forgetCacheWindow } = await jiti.import(`${ROOT}/lib/cache-window.ts`);
publishCacheWindow("prompt-fold", { mode: "short", warmUntil: Date.now() + 240_000, cold: { kind: "ttl" } });
eq("an idle seat shows how long until its cache goes cold", bare(editor.render(120).join("\n")).includes("❄4m"), true);
publishCacheWindow("prompt-fold", { mode: "keepalive", warmUntil: Date.now() + 240_000, cold: { kind: "held", windowMs: 45 * 60_000 } });
eq("a seat waiting on background agents hides it: the chain keeps the cache warm", bare(editor.render(120).join("\n")).includes("❄"), false);
forgetCacheWindow("prompt-fold");

// ---------------------------------------------------------------------------
// pi's real fullscreen layout: the folded rows go back to the transcript.
// ---------------------------------------------------------------------------

console.log("fold: pi's chat viewport, laid out by pi-tui");
const { Container, Spacer, Text } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const { renderLayoutFrame } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/layout.js`);
const { createChatViewport } = await import(`${PI}/dist/modes/interactive/chat-viewport.js`);

const HEIGHT = 24;
const transcriptLines = Array.from({ length: 100 }, (_, i) => `transcript ${i + 1}`);
/** pi's viewport, with `editor` wrapped in a container the way interactive-mode wraps its editor. */
const viewportWith = (component) => {
	const document = new Container();
	document.addChild({ render: () => transcriptLines, invalidate() {} });
	const editorContainer = new Container();
	editorContainer.addChild(component);
	// What pi's `renderWidgetContainer` leaves above the editor while no widget is set.
	const widgetsAbove = new Container();
	widgetsAbove.addChild(new Spacer(1));
	const pendingMessages = new Container();
	const viewport = createChatViewport({
		document,
		pendingMessages,
		status: new Container(),
		widgetsAbove,
		editor: editorContainer,
		widgetsBelow: new Container(),
		footer: new Container(),
	});
	const dock = viewport.root.entries[1].component;
	return {
		root: viewport.root,
		widgetsAbove,
		pendingMessages,
		floor: () => dock.entries.find((entry) => entry.component === editorContainer)?.minSize,
	};
};
const screenOf = (root) => {
	const frame = renderLayoutFrame(root, 80, HEIGHT, () => {});
	return { lines: frame.lines.map(bare), transcriptRows: frame.root.children[0].rect.height };
};

{
	const stock = viewportWith({ render: () => ["╭──╮", "╰──╯"], invalidate() {} });
	eq("pi's own editor floor pads a two-row box with a blank row under it", screenOf(stock.root).lines.at(-1), "");
	eq("and pi's widget spacer leaves a blank row above it", screenOf(stock.root).lines.at(-4), "");
}

/** Blank rows between the last row with text above the box and the box's top row. */
const rowAboveBox = (lines) => lines[lines.findIndex((line) => /^[╭╶]/.test(line)) - 1]?.trim();
const gapAbove = (lines) => {
	const top = lines.findIndex((line) => /^[╭╶]/.test(line));
	let gap = 0;
	for (let i = top - 1; i >= 0 && lines[i]?.trim() === ""; i--) gap++;
	return gap;
};

const live = viewportWith(editor);
tui.layoutRoot = live.root;
editor.setText("");
// The frame the editor first renders in installs the gap's predicate and asks for the next one, as pi's loop would.
screenOf(live.root);

let screen = screenOf(live.root);
eq("the row is the terminal's last row", [screen.lines.at(-1)?.at(0), screen.lines.at(-1)?.at(-1)], ["╶", "╴"]);
eq("the transcript gets every other row", screen.transcriptRows, HEIGHT - 1);
eq("and shows its last line right above the row", screen.lines.at(-2), "transcript 100");

editor.setText("hi");
screen = screenOf(live.root);
eq("typing unfolds it: the bottom rule is still the last row", screen.lines.at(-1)?.at(0), "╰");
eq("with the full three-row box", [screen.lines.at(-3)?.at(0), screen.lines.at(-2)?.includes("hi")], ["╭", true]);
eq("and the transcript gives the rows back", screen.transcriptRows, HEIGHT - 3);
eq("pi's three-row floor is back for the full box", live.floor(), 3);

editor.setText("");
eq("clearing the text folds it again", screenOf(live.root).transcriptRows, HEIGHT - 1);

for (const text of ["", "hi"]) {
	const box = text === "" ? "folded" : "typing";
	editor.setText(text);
	eq(`${box}, idle: no blank row between the transcript and the box`, gapAbove(screenOf(live.root).lines), 0);
	for (const handler of handlers.get("before_agent_start") ?? []) handler({ type: "before_agent_start" }, ctx);
	eq(`${box}, streaming: no blank row either`, gapAbove(screenOf(live.root).lines), 0);
	// pi's steering display: a spacer, then the message, in the pending entry above the editor.
	live.pendingMessages.addChild(new Spacer(1));
	live.pendingMessages.addChild(new Text("Steering: hold on", 1, 0));
	screen = screenOf(live.root);
	eq(`${box}, steering: the pending message sits on the box`, [gapAbove(screen.lines), rowAboveBox(screen.lines)], [0, "Steering: hold on"]);
	eq(`${box}, steering: pi's spacer still separates it from the transcript`, screen.lines.includes(""), true);
	live.pendingMessages.clear();
	for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled" }, ctx);
}
editor.setText("");
eq("the last transcript row is directly above the box", rowAboveBox(screenOf(live.root).lines), "transcript 100");
live.widgetsAbove.clear();
live.widgetsAbove.addChild(new Spacer(1));
live.widgetsAbove.addChild(new Text("a widget", 0, 0));
screen = screenOf(live.root);
eq("a widget above the editor is kept, and sits on the box", [gapAbove(screen.lines), rowAboveBox(screen.lines)], [0, "a widget"]);
live.widgetsAbove.clear();
live.widgetsAbove.addChild(new Spacer(1));

for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
