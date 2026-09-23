/**
 * Side mode on pi's real screen layout.
 *
 * `side-screen.ts` appends its marker and feed to pi's transcript document, so
 * it depends on how `interactive-mode.js` builds that document and mounts the
 * screen, and on Esc reaching an input listener before the editor. The first
 * half pins those lines in the installed pi; the second renders pi's own
 * `createChatViewport` through `renderLayoutFrame` with side mode on and off.
 *
 *   node test/side-screen.mjs
 */

import "./env.mjs";
import { readFileSync } from "node:fs";

const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const TUI_DIST = `${PI}/node_modules/@earendil-works/pi-tui/dist`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);
const { renderLayoutFrame } = await import(`${TUI_DIST}/layout.js`);
const { Container } = await import(`${TUI_DIST}/tui.js`);
const { Text } = await import(`${TUI_DIST}/components/text.js`);
const { createChatViewport } = await import(`${PI}/dist/modes/interactive/chat-viewport.js`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { SideScreen, SIDE_MARKER } = await jiti.import(`${ROOT}/extensions/side-chat/side-screen.ts`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

console.log("side-screen: the installed pi still builds the screen side mode reads");
{
	const interactive = readFileSync(`${PI}/dist/modes/interactive/interactive-mode.js`, "utf8");
	const customEditor = readFileSync(`${PI}/dist/modes/interactive/components/custom-editor.js`, "utf8");
	const tuiSource = readFileSync(`${TUI_DIST}/tui.js`, "utf8");
	check(
		"the document holds header, resources, chat, in that order",
		/this\.documentContainer\.addChild\(this\.headerContainer\);\s*this\.documentContainer\.addChild\(this\.loadedResourcesContainer\);\s*this\.documentContainer\.addChild\(this\.chatContainer\);/.test(interactive),
	);
	check(
		"the screen mounts document, pending, status, widgets above, editor, widgets below, footer",
		/this\.mountInteractiveTui\(this\.renderer, \[\s*this\.documentContainer,\s*this\.pendingMessagesContainer,\s*this\.statusContainer,\s*this\.widgetContainerAbove,\s*this\.editorContainer,\s*this\.widgetContainerBelow,\s*this\.footerContainer,\s*\]\);/.test(interactive),
	);
	check("the chat viewport scrolls that document", interactive.includes("document: this.documentContainer,"));
	const uses = interactive.split("documentContainer").length - 1;
	check("nothing else adds to the document (7 mentions of documentContainer)", uses === 7, `${uses} mentions`);
	check("the editor's Esc runs onEscape, else app.interrupt", customEditor.includes('const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");'));
	check("a custom editor inherits the default editor's Esc", interactive.includes("if (!customEditor.onEscape) {"));
	const listeners = tuiSource.indexOf("for (const listener of this.inputListeners)");
	const focused = tuiSource.indexOf("this.focusedComponent.handleInput(data);");
	check("input listeners see a key before the focused editor", listeners > 0 && focused > listeners);
}

/** The screen as pi builds it, around pi's own chat viewport. */
function screen() {
	const header = new Container();
	const resources = new Container();
	const chat = new Container();
	const document = new Container();
	document.addChild(header);
	document.addChild(resources);
	document.addChild(chat);
	for (let i = 0; i < 40; i++) chat.addChild(new Text(`main ${i}`, 0, 0));
	const editor = {
		keybindings: { matches: () => false },
		isShowingAutocomplete: () => false,
		getExpandedText: () => "",
		getText: () => "",
		getLines: () => [""],
		getCursor: () => ({ line: 0, col: 0 }),
		setText: () => {},
		addToHistory: () => {},
		render: () => ["EDITOR"],
		invalidate: () => {},
	};
	const editorContainer = new Container();
	editorContainer.children.push(editor);
	const parts = { pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(), widgetsBelow: new Container(), footer: new Container() };
	const viewport = createChatViewport({ document, editor: editorContainer, ...parts });
	const tui = {
		children: [document, parts.pendingMessages, parts.status, parts.widgetsAbove, editorContainer, parts.widgetsBelow, parts.footer],
		focused: editor,
		getFocusedComponent() { return this.focused; },
		requestRender: () => {},
		scrollToBottom: () => viewport.transcript.scrollToEnd(),
	};
	const frame = () => renderLayoutFrame(viewport.root, 40, 12, () => {}).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[│┃]$/, "").trimEnd());
	return { document, chat, tui, viewport, frame };
}

function fakeSource(messages) {
	const listeners = new Set();
	return {
		messages,
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		emit: (event) => { for (const listener of listeners) listener(event); },
		getToolDefinition: () => undefined,
	};
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sideTurns = () => [
	{ role: "system", content: "", timestamp: 0 },
	{ role: "user", content: [{ type: "text", text: "side question" }], timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "side answer" }], provider: "p", model: "m", api: "anthropic-messages", usage, stopReason: "stop", timestamp: 2 },
];

console.log("\nside-screen: side mode on pi's chat viewport");
{
	const s = screen();
	const side = new SideScreen(ROOT);
	s.frame();
	s.viewport.transcript.scrollTo(5);
	s.frame();
	check("main is scrolled up before side mode", !s.viewport.transcript.isFollowingEnd);

	side.attach(fakeSource(sideTurns()));
	check("entering is accepted on pi's layout", side.enter(s.tui, themeModule.theme) === undefined);
	let frame = s.frame();
	const marker = frame.findIndex((line) => line.includes(SIDE_MARKER));
	const answer = frame.findIndex((line) => line.includes("side answer"));
	const dock = frame.indexOf("EDITOR");
	check("the marker and the side turns show, above the dock", marker >= 0 && frame.findIndex((line) => line.includes("side question")) > marker && answer > marker && dock > answer, JSON.stringify(frame));
	check("entering scrolls to the side feed", s.viewport.transcript.isFollowingEnd);

	for (let i = 40; i < 45; i++) s.chat.addChild(new Text(`main ${i}`, 0, 0));
	const whole = s.document.render(40).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, ""));
	check("main output added in side mode lands above the marker", whole.findIndex((line) => line.startsWith("main 44")) < whole.findIndex((line) => line.includes(SIDE_MARKER)));
	frame = s.frame();
	check("and the view stays at the end of the side feed", frame[frame.indexOf("EDITOR") - 1] === "side answer" && frame.indexOf("main 44") < frame.findIndex((line) => line.includes(SIDE_MARKER)), JSON.stringify(frame));

	side.leave();
	frame = s.frame();
	check("leaving shows main with the new rows, right above the dock", frame[frame.indexOf("EDITOR") - 1] === "main 44", JSON.stringify(frame));
	check("with no side content left", !frame.some((line) => line.includes(SIDE_MARKER) || line.includes("side answer")));
	check("and the transcript following the end", s.viewport.transcript.isFollowingEnd);
	check("the document is pi's three containers again", s.document.children.length === 3);
}

console.log("\nside-screen: the … row while the side model has said nothing");
{
	const s = screen();
	const side = new SideScreen(ROOT);
	const source = fakeSource([]);
	side.enter(s.tui, themeModule.theme);
	side.attach(source);
	const dots = () => s.frame().some((line) => line.trim() === "…");
	check("no … before a side run", !dots());
	source.emit({ type: "agent_start" });
	check("… from the start of a side run", dots());
	source.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] } });
	check("thinking does not end it (the feed hides thinking)", dots());
	source.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "a" }] } });
	check("the first visible content ends it", !dots());
	side.attach(undefined);
	check("dropping the thread leaves the marker alone", s.frame().some((line) => line.includes(SIDE_MARKER)) && s.document.children.length === 5);
	side.setWaiting(true);
	check("… from the submit, while the first side session is still being built", dots());
	side.attach(fakeSource([]));
	check("and the session arriving does not end it", dots());
	side.setWaiting(false);
	check("the settled question ends it", !dots());
}

console.log("\nside-screen: a layout side mode was not built for is refused");
{
	const extra = screen();
	extra.document.addChild(new Container());
	check("a fourth document child is drift", /header, resources, chat/.test(new SideScreen(ROOT).enter(extra.tui, themeModule.theme) ?? ""));
	check("and nothing was mounted", extra.document.children.length === 4);

	const short = screen();
	short.tui.children.pop();
	check("a mount list of six is drift", /not pi's 7/.test(new SideScreen(ROOT).enter(short.tui, themeModule.theme) ?? ""));

	const dialog = screen();
	dialog.tui.focused = { render: () => [] };
	check("an editor that does not hold the keyboard is drift", /focused/.test(new SideScreen(ROOT).enter(dialog.tui, themeModule.theme) ?? ""));
	check("and the document is untouched", dialog.document.children.length === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
