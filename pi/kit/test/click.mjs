/**
 * Can a click find the row it landed on?
 *
 * Builds the layout pi builds in fullscreen — a ScrollView over the document
 * container, a dock under it — with pi's own layout engine and pi's own
 * `ToolExecutionComponent`, then feeds SGR mouse sequences at chosen cells and
 * asks which row was hit. No terminal, no mouse, no alt screen: the click is
 * the escape sequence, and that is all a click ever is.
 *
 *   node test/click.mjs
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { renderLayoutFrame } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/layout.js`);
const { Container } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/tui.js`);
const { ScrollView } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js`);
const { VStack } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/components/v-stack.js`);
const { Text } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/components/text.js`);
const { ToolExecutionComponent } = await import(`${PI}/dist/modes/interactive/components/index.js`);
const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);

const click = await jiti.import(`${ROOT}/extensions/transcript/click.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (actual === expected) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}\n  expected ${expected}\n  actual   ${actual}`);
};

// ---------------------------------------------------------------------------
// The document pi would have: a message, two tool rows, a message.
// ---------------------------------------------------------------------------

const WIDTH = 80;
const HEIGHT = 24;

const ui = { requestRender: () => {}, theme: themeModule.theme, getTheme: () => themeModule.theme };
const toolRow = (name, args, text) => {
	const row = new ToolExecutionComponent(name, `call-${name}`, args, { showImages: false }, undefined, ui, ROOT);
	row.markExecutionStarted();
	row.setArgsComplete();
	row.updateResult({ content: [{ type: "text", text }], isError: false }, false);
	return row;
};

// Nested the way pi nests it: the rows are in a chat container, which is in the
// document container, which is what the scroll view holds.
const document = new Container();
const chat = new Container();
const preamble = new Text("a message above the rows\nsecond line of it", 0, 0);
const first = toolRow("read", { path: "package.json" }, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
const second = toolRow("bash", { command: "npm test" }, "41 passed");
document.addChild(chat);
chat.addChild(preamble);
chat.addChild(first);
chat.addChild(second);

const transcript = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" });
const dock = new VStack([{ component: new Text("the editor lives here", 0, 0), basis: "auto" }]);
const root = new VStack([
	{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
]);

const frame = () => renderLayoutFrame(root, WIDTH, HEIGHT, () => {});

// Where each row actually starts in the document, measured the way the click is.
const heights = [preamble, first, second].map((component) => component.render(WIDTH).length);
const tops = heights.reduce((acc, height) => [...acc, acc[acc.length - 1] + height], [0]);
const documentHeight = tops[tops.length - 1];

// ---------------------------------------------------------------------------
// Hit testing: a screen cell resolves to the row that drew it.
// ---------------------------------------------------------------------------

// The view follows the end, so the last `viewport` lines of the document are on
// screen and the first document line on screen is this one.
const viewport = HEIGHT - dock.render(WIDTH).length;
const scrolled = Math.max(0, documentHeight - viewport);
const screenOf = (documentLine) => documentLine - scrolled;

const at = (x, y) => click.rowAt(frame(), x, y);
// The first row is taller than the viewport, so its top line is scrolled off:
// the probe is its first line that is actually on screen.
eq("a cell in the first row finds it", at(3, screenOf(Math.max(tops[1], scrolled))), first);
eq("its last line too", at(3, screenOf(tops[2] - 1)), first);
eq("the row below is a different row", at(3, screenOf(tops[2])), second);
eq("the message above the rows is not a row", at(3, screenOf(tops[0])), undefined);
eq("the dock is not the transcript", at(3, HEIGHT - 1), undefined);
eq("nor is a cell past the end of the world", at(3, HEIGHT + 5), undefined);

// Scrolling moves the rows under the pointer, which is the whole reason the
// document line is read off the laid-out box instead of counted from the top.
transcript.scrollTo(0, { disableFollow: true });
const top = frame();
eq("scrolled to the top, the first cell is the message", click.rowAt(top, 3, 0), undefined);
eq("and the row is where the document says it is", click.rowAt(top, 3, tops[1]), first);

// ---------------------------------------------------------------------------
// Press and release: a click opens a row, a drag does not.
// ---------------------------------------------------------------------------

const press = (x, y) => `\x1b[<0;${x + 1};${y + 1}M`;
const release = (x, y) => `\x1b[<0;${x + 1};${y + 1}m`;
const drag = (x, y) => `\x1b[<32;${x + 1};${y + 1}M`;
const wheel = (x, y) => `\x1b[<64;${x + 1};${y + 1}M`;

const screen = () => ({
	currentLayout: frame(),
	pressedUrl: undefined,
	selectionDragged: false,
	renders: 0,
	requestRender() {
		this.renders++;
	},
});
const expandedOf = (row) => row.expanded === true;
// The clock is passed in, because whether two clicks are a double-click is a
// question about time and a test should not have to wait to answer it.
let clock = 1_000_000;
const send = (view, ...data) => {
	for (const one of data) click.handleMouse(view, one, clock);
};
const later = () => {
	clock += 1000;
};

const row = tops[1];
let view = screen();
send(view, press(3, row), release(3, row));
eq("a click expands the row it landed on", expandedOf(first), true);
eq("and asks for a frame", view.renders, 1);
later();
send(view, press(3, row), release(3, row));
eq("clicking again closes it", expandedOf(first), false);
later();

// A press on one row and a release on another is not a click on either.
view = screen();
send(view, press(3, row), release(3, tops[2]));
eq("a press and release on different rows does nothing", expandedOf(first), false);

// A drag is a selection. The row underneath it stays as it was.
view = screen();
send(view, press(3, row));
view.selectionDragged = true;
send(view, drag(20, row), release(20, row));
eq("a drag selects and does not expand", expandedOf(first), false);
later();

// A press that pi resolved to a hyperlink belongs to the link. pi's own handler
// runs first and sets `pressedUrl`, so it is already there when this reads it.
view = screen();
view.pressedUrl = "pi-open:///tmp/x.ts";
send(view, press(3, row), release(3, row));
eq("a click on a link opens the link, not the row", expandedOf(first), false);
later();

// The second press of a double-click is pi selecting a word, and a row that
// expanded and collapsed under that would only flicker.
view = screen();
send(view, press(3, row), release(3, row));
eq("the first click of a double still opens", expandedOf(first), true);
send(view, press(3, row), release(3, row));
eq("the second does not close it again", expandedOf(first), true);
later();
first.setExpanded(false);

// Everything that is not a plain left click stays pi's.
view = screen();
send(view, wheel(3, row), release(3, row));
eq("the wheel is not a click", expandedOf(first), false);
send(view, "hello", "\x1b[A");
eq("neither is a keystroke", expandedOf(first), false);

// ---------------------------------------------------------------------------
// The patch goes on and comes off.
// ---------------------------------------------------------------------------

const { TuiAltScreen } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`);
const before = TuiAltScreen.prototype.handleViewportInput;
const stale = click.enableRowClicks();
eq("the handler is wrapped", TuiAltScreen.prototype.handleViewportInput === before, false);
const wrapped = TuiAltScreen.prototype.handleViewportInput;
const current = click.enableRowClicks();
eq("twice does not nest", TuiAltScreen.prototype.handleViewportInput === wrapped, false);
stale();
eq("a handle to a replaced wrapper takes nothing down", TuiAltScreen.prototype.handleViewportInput === before, false);
current();
eq("and it comes back off", TuiAltScreen.prototype.handleViewportInput === before, true);

// ---------------------------------------------------------------------------
// The whole path, through a real alt screen: the escape sequence arrives as
// input, pi's own handler runs, and the row under the pointer opens. Only the
// terminal is a stub, and all it has to do is have a size and swallow writes.
// ---------------------------------------------------------------------------

const stubTerminal = (columns, rows) => ({
	columns,
	rows,
	kittyProtocolActive: false,
	onInput: undefined,
	written: [],
	start(onInput) {
		this.onInput = onInput;
	},
	stop() {},
	async drainInput() {},
	write(data) {
		this.written.push(data);
	},
	moveBy() {},
	hideCursor() {},
	showCursor() {},
	clearLine() {},
	clearFromCursor() {},
	clearScreen() {},
	setTitle() {},
	setProgress() {},
});

const terminal = stubTerminal(WIDTH, HEIGHT);
const live = new TuiAltScreen(terminal, false, "/tmp");
const liveDocument = new Container();
const liveChat = new Container();
const liveRow = toolRow("read", { path: "README.md" }, Array.from({ length: 30 }, (_, i) => `output ${i + 1}`).join("\n"));
liveDocument.addChild(liveChat);
liveChat.addChild(new Text("a message above the rows", 0, 0));
liveChat.addChild(liveRow);
const liveScroll = new ScrollView(liveDocument, { follow: "end", primary: true, overscroll: "chain" });
live.setLayoutRoot(new VStack([
	{ component: liveScroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	{ component: new Text("the editor lives here", 0, 0), basis: "auto" },
]));
live.start();
live.renderNow();
liveScroll.scrollTo(0, { disableFollow: true });
live.renderNow();

const unclick = click.enableRowClicks();
// Row 1 of the document is the first line of the tool row: the message above it
// is one line tall.
terminal.onInput(press(2, 1));
terminal.onInput(release(2, 1));
eq("a mouse sequence off the wire opens the row it points at", liveRow.expanded === true, true);
terminal.onInput("\x1b[A");
eq("and an arrow key is still an arrow key", liveRow.expanded === true, true);
unclick();
terminal.onInput(press(2, 1));
terminal.onInput(release(2, 1));
eq("with the patch off, a click does nothing again", liveRow.expanded === true, true);
live.stop();

// ---------------------------------------------------------------------------
// A settled group is one line, and that line is the only thing left to click.
// Clicking it has to open every row it stands for, not just the one that drew
// it — the other rows are zero lines tall and no pointer can ever reach them.
// ---------------------------------------------------------------------------

const tools = new Map();
const loaderApi = {
	registerTool: (tool) => tools.set(tool.name, tool),
	registerCommand: () => {},
	registerShortcut: () => {},
	registerMessageRenderer: () => {},
	on: () => {},
};
await (await jiti.import(`${ROOT}/extensions/transcript/index.ts`, { default: true }))(loaderApi);
// bash is registered by its own extension, wearing the transcript's receipt.
await (await jiti.import(`${ROOT}/extensions/bash.ts`, { default: true }))(loaderApi);
const group = await jiti.import(`${ROOT}/extensions/transcript/group.ts`);

const ourRow = (name, id, args, text) => {
	const built = new ToolExecutionComponent(name, id, args, { showImages: false }, tools.get(name), ui, ROOT);
	built.markExecutionStarted();
	built.setArgsComplete();
	built.updateResult({ content: [{ type: "text", text }], isError: false }, false);
	return built;
};

const lead = ourRow("read", "c1", { path: "package.json" }, "a\nb\nc");
const member = ourRow("bash", "c2", { command: "whoami" }, "joel");
const groupDocument = new Container();
groupDocument.addChild(lead);
groupDocument.addChild(member);
const groupScroll = new ScrollView(groupDocument, { follow: "end", primary: true, overscroll: "chain" });
const groupRoot = new VStack([{ component: groupScroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]);

const answer = (id) => ({ type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], isError: false } });
group.regroup([
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "c1", name: "read", arguments: {} },
				{ type: "toolCall", id: "c2", name: "bash", arguments: {} },
			],
		},
	},
	answer("c1"),
	answer("c2"),
]);

const collapsed = groupDocument.render(WIDTH).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
eq("the group is one blank and one line", collapsed.length, 2);
eq("and the line is the rollup", collapsed[1], "  Read 1 file, ran 1 shell command");

const groupView = {
	currentLayout: renderLayoutFrame(groupRoot, WIDTH, HEIGHT, () => {}),
	pressedUrl: undefined,
	selectionDragged: false,
	requestRender() {},
};
clock += 1000;
send(groupView, press(4, 1), release(4, 1));
await new Promise((resolve) => setTimeout(resolve, 0));
const opened = groupDocument.render(WIDTH).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
eq("clicking the line opens the lead", opened.some((l) => l.startsWith("● Read(")), true);
eq("and the row that had no line to click", opened.some((l) => l.startsWith("● Bash(")), true);

clock += 1000;
groupView.currentLayout = renderLayoutFrame(groupRoot, WIDTH, HEIGHT, () => {});
send(groupView, press(4, 1), release(4, 1));
await new Promise((resolve) => setTimeout(resolve, 0));
eq("clicking the header again closes the group", groupDocument.render(WIDTH).length, 2);

// Mid-batch the live line is the only thing on screen, so it is the only thing
// there is to click, and what it opens is everything it stands in for —
// including the calls that have not come back.
group.regroup(
	[
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "read", arguments: {} },
					{ type: "toolCall", id: "c2", name: "bash", arguments: {} },
				],
			},
		},
	],
	true,
);
const inFlight = groupDocument.render(WIDTH).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
eq("a batch in flight speaks in the present tense", inFlight[1], "● Reading 1 file, running 1 shell command…");

clock += 1000;
groupView.currentLayout = renderLayoutFrame(groupRoot, WIDTH, HEIGHT, () => {});
send(groupView, press(4, 1), release(4, 1));
await new Promise((resolve) => setTimeout(resolve, 0));
const unfolded = groupDocument.render(WIDTH).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
eq("clicking the live line opens the call it stands on", unfolded.some((l) => l.startsWith("● Read(")), true);
eq("and the one behind it that has not come back", unfolded.some((l) => l.startsWith("● Bash(")), true);

group.ungroup();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
