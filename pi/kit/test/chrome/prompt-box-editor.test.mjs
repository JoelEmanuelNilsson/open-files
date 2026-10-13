/**
 * The prompt box through the real extension: zen-chrome is booted and its
 * editor rendered alone — folding, unfolding, scroll indicators, the cache
 * window — and inside pi's real fullscreen layout.
 */

import { eq, finish } from "../support/check-harness.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();
const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const { CURSOR_MARKER } = await importPi("node_modules/@earendil-works/pi-tui/dist/index.js");

const bare = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const squash = (text) => text.replace(/ ─+ /g, "  ");

// ---------------------------------------------------------------------------
// The real extension: its editor rendered.
// ---------------------------------------------------------------------------

console.log("fold: the editor, through the extension");
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t };
let editorFactory;
const ctx = {
	mode: "tui",
	cwd: KIT_ROOT,
	hasUI: true,
	model: { id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", reasoning: true },
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
const pi = fakeExtensionApi({ getThinkingLevel: () => "high" });
const extension = await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/index.ts`, { default: true });
await extension(pi.api);
await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

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


// ---------------------------------------------------------------------------
// /reload while agents run: refused unless forced.
// ---------------------------------------------------------------------------

console.log("reload: refused while agents run");
{
	const { publishAgentRuntime, forgetAgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const submitted = [];
	const notices = [];
	editor.onSubmit = (text) => submitted.push(text);
	ctx.ui.notify = (message) => notices.push(message);
	publishAgentRuntime("prompt-fold", { registry: { live: () => [{ name: "t46" }, { name: "build" }] } });
	for (const text of ["/reload", "/reload --force", "hello"]) {
		editor.setText(text);
		editor.handleInput("\r");
	}
	eq("only a forced reload and plain text reach pi", submitted, ["/reload", "hello"]);
	eq("the refusal names the running agents and the override", [notices.length, notices[0]?.includes("t46, build"), notices[0]?.includes("/reload --force")], [1, true, true]);
	forgetAgentRuntime("prompt-fold");
	submitted.length = 0;
	editor.setText("/reload");
	editor.handleInput("\r");
	eq("with no agents running a plain reload goes through", submitted, ["/reload"]);
}

// ---------------------------------------------------------------------------
// pi's real fullscreen layout: the folded rows go back to the transcript.
// ---------------------------------------------------------------------------

console.log("fold: pi's chat viewport, laid out by pi-tui");
const { Container, Spacer, Text } = await importPi("node_modules/@earendil-works/pi-tui/dist/index.js");
const { renderLayoutFrame } = await importPi("node_modules/@earendil-works/pi-tui/dist/layout.js");
const { createChatViewport } = await importPi("dist/modes/interactive/chat-viewport.js");

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
	await pi.fire("before_agent_start", { type: "before_agent_start" }, ctx);
	eq(`${box}, streaming: no blank row either`, gapAbove(screenOf(live.root).lines), 0);
	// pi's steering display: a spacer, then the message, in the pending entry above the editor.
	live.pendingMessages.addChild(new Spacer(1));
	live.pendingMessages.addChild(new Text("Steering: hold on", 1, 0));
	screen = screenOf(live.root);
	eq(`${box}, steering: the pending message sits on the box`, [gapAbove(screen.lines), rowAboveBox(screen.lines)], [0, "Steering: hold on"]);
	eq(`${box}, steering: pi's spacer still separates it from the transcript`, screen.lines.includes(""), true);
	live.pendingMessages.clear();
	await pi.fire("agent_settled", { type: "agent_settled" }, ctx);
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

await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);

await finish();
