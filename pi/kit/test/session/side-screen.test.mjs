/**
 * Side mode on pi's real screen layout.
 *
 * `thread-screen.ts` appends its marker and feed to pi's transcript document
 * (side mode, `below`) or takes main's parts out of it and puts them back (the
 * agent view, `replace`), so it depends on how `interactive-mode.js` builds that
 * document and mounts the screen, and on Esc reaching an input listener before
 * the editor. The first half pins those lines in the installed pi; the second
 * renders pi's own `createChatViewport` through `renderLayoutFrame` with each
 * placement on and off.
 *
 *   node test/session/side-screen.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, PI_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { readFileSync } from "node:fs";

const TUI_DIST = `${PI_ROOT}/node_modules/@earendil-works/pi-tui/dist`;
const themeModule = await importPi("dist/modes/interactive/theme/theme.js");
themeModule.initTheme("dark", false);
const { renderLayoutFrame } = await import(`${TUI_DIST}/layout.js`);
const { Container } = await import(`${TUI_DIST}/tui.js`);
const { Text } = await import(`${TUI_DIST}/components/text.js`);
const { createChatViewport } = await importPi("dist/modes/interactive/chat-viewport.js");
const jiti = kitJiti();
const { ThreadScreen } = await jiti.import(`${KIT_ROOT}/extensions/side-chat/thread-screen.ts`);
const { SIDE_MARKER } = await jiti.import(`${KIT_ROOT}/extensions/side-chat/side-session.ts`);

/** The side thread as a focus target, with its source set by the test. */
function sideTarget() {
	let current;
	return {
		target: { kind: "side" },
		placement: "below",
		marker: { text: SIDE_MARKER, color: "success" },
		source: () => current,
		set: (source) => { current = source; },
		statusLines: (theme, waiting) => (waiting ? [` ${theme.fg("dim", "…")}`] : []),
	};
}

const AGENT_MARKER = "<AGENT worker-2 · audit the wire>";

/** An agent as a focus target: it replaces main's transcript. */
function agentTarget(source) {
	return {
		target: { kind: "agent", name: "worker-2" },
		placement: "replace",
		marker: { text: AGENT_MARKER, color: "accent" },
		source: () => source,
		statusLines: () => [" ↳ queued: and the timeout"],
	};
}

console.log("side-screen: the installed pi still builds the screen side mode reads");
{
	const interactive = readFileSync(`${PI_ROOT}/dist/modes/interactive/interactive-mode.js`, "utf8");
	const customEditor = readFileSync(`${PI_ROOT}/dist/modes/interactive/components/custom-editor.js`, "utf8");
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
	check("pi writes chat through its own field, so a chat out of the document still gets it", interactive.includes("this.chatContainer.addChild(this.streamingComponent);"));
	check("a container's clear() swaps its own children, not its parent's", /clear\(\) \{\s*this\.children = \[\];\s*\}/.test(tuiSource));
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
	header.addChild(new Text("HEADER", 0, 0));
	resources.addChild(new Text("RESOURCES", 0, 0));
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
	return { document, header, resources, chat, tui, viewport, frame };
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
	const side = new ThreadScreen(KIT_ROOT);
	const target = sideTarget();
	s.frame();
	s.viewport.transcript.scrollTo(5);
	s.frame();
	check("main is scrolled up before side mode", !s.viewport.transcript.isFollowingEnd);

	target.set(fakeSource(sideTurns()));
	check("entering is accepted on pi's layout", side.enter(s.tui, themeModule.theme, target) === undefined);
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
	const side = new ThreadScreen(KIT_ROOT);
	const target = sideTarget();
	const source = fakeSource([]);
	side.enter(s.tui, themeModule.theme, target);
	target.set(source);
	side.refresh();
	const dots = () => s.frame().some((line) => line.trim() === "…");
	check("no … before a side run", !dots());
	source.emit({ type: "agent_start" });
	check("… from the start of a side run", dots());
	source.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] } });
	check("thinking does not end it (the feed hides thinking)", dots());
	source.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "a" }] } });
	check("the first visible content ends it", !dots());
	target.set(undefined);
	side.refresh();
	check("dropping the thread leaves the marker alone", s.frame().some((line) => line.includes(SIDE_MARKER)) && s.document.children.length === 6);
	side.setWaiting(true);
	check("… from the submit, while the first side session is still being built", dots());
	target.set(fakeSource([]));
	side.refresh();
	check("and the session arriving does not end it", dots());
	side.setWaiting(false);
	check("the settled question ends it", !dots());
}

// 2026-09-25: a child thought for up to 167 s between tool calls; the view showed its last
// finished tool and nothing moving, and Joel stopped it as stuck.
console.log("\nside-screen: the … row on every turn of a run, and in a run the view joined late");
{
	const s = screen();
	const side = new ThreadScreen(KIT_ROOT);
	const target = sideTarget();
	const source = fakeSource([]);
	let renders = 0;
	s.tui.requestRender = () => { renders++; };
	side.enter(s.tui, themeModule.theme, target);
	target.set(source);
	side.refresh();
	const dots = () => s.frame().some((line) => line.trim() === "…");
	const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
	source.emit({ type: "agent_start" });
	source.emit({ type: "turn_start" });
	source.emit({ type: "message_update", message: { role: "assistant", content: [call] } });
	source.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: call.arguments });
	source.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
	check("(the tool call ended the first turn's …)", !dots());
	const before = renders;
	source.emit({ type: "turn_start" });
	check("the next turn shows … again while its thinking is hidden", dots());
	check("and asks for a frame, since the feed draws nothing for a turn start", renders > before);
	source.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] } });
	check("thinking does not end it", dots());
	source.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "done" }] } });
	check("visible content ends it", !dots());

	// A view opened mid-turn: its run started before the view subscribed.
	target.set({ ...fakeSource([]), isStreaming: true });
	side.refresh();
	check("a session bound mid-run shows … until it draws something", dots());
	side.leave();
}

console.log("\nside-screen: an agent replaces main's transcript, and main comes back whole");
{
	const s = screen();
	const parts = [s.header, s.resources, s.chat];
	const agentFeed = () => fakeSource([{ role: "user", content: [{ type: "text", text: "audit the wire" }], timestamp: 1 }, { ...sideTurns()[2], content: [{ type: "text", text: "agent answer" }] }]);
	const screenOf = new ThreadScreen(KIT_ROOT);
	s.frame();
	s.viewport.transcript.scrollTo(5);
	s.frame();

	check("entering an agent is accepted on pi's layout", screenOf.enter(s.tui, themeModule.theme, agentTarget(agentFeed())) === undefined);
	let whole = s.document.render(40).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, ""));
	check("main's header, resources and chat are not drawn", !whole.some((line) => /HEADER|RESOURCES|^main \d/.test(line)), JSON.stringify(whole));
	check("the document is the marker, the feed and the status rows alone", s.document.children.length === 3 && parts.every((part) => !s.document.children.includes(part)));
	let frame = s.frame();
	check("the marker, the agent's turns and its status rows show above the dock", frame.findIndex((line) => line.includes(AGENT_MARKER)) >= 0 && frame.some((line) => line.includes("agent answer")) && frame[frame.indexOf("EDITOR") - 1] === " ↳ queued: and the timeout", JSON.stringify(frame));

	// Main keeps writing to its own chat while hidden, and a compaction clears and refills it.
	for (let i = 40; i < 45; i++) s.chat.addChild(new Text(`main ${i}`, 0, 0));
	check("main output while hidden is not drawn", !s.frame().some((line) => line.startsWith("main 4")));

	screenOf.leave();
	check("leaving puts back the same three objects, in order", s.document.children.length === 3 && s.document.children.every((part, i) => part === parts[i]));
	frame = s.frame();
	check("main output added while hidden is there, right above the dock", frame[frame.indexOf("EDITOR") - 1] === "main 44", JSON.stringify(frame));
	check("with no agent content left", !frame.some((line) => line.includes(AGENT_MARKER) || line.includes("agent answer")));
	check("scrolled to the bottom, though main was scrolled up before", s.viewport.transcript.isFollowingEnd);
	whole = s.document.render(40).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	check("header and resources are back at the top", whole[0] === "HEADER" && whole[1] === "RESOURCES", JSON.stringify(whole.slice(0, 3)));

	screenOf.enter(s.tui, themeModule.theme, agentTarget(agentFeed()));
	s.chat.clear();
	s.chat.addChild(new Text("after compaction", 0, 0));
	screenOf.leave();
	frame = s.frame();
	check("a chat cleared and refilled while hidden comes back refilled", frame.includes("after compaction") && !frame.some((line) => line.startsWith("main ")), JSON.stringify(frame));
}

console.log("\nside-screen: switching agent → side → agent keeps main's parts");
{
	const s = screen();
	const parts = [s.header, s.resources, s.chat];
	const threads = new ThreadScreen(KIT_ROOT);
	const side = sideTarget();
	side.set(fakeSource(sideTurns()));
	const mainShown = () => s.document.render(40).some((line) => line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("main 39"));

	threads.enter(s.tui, themeModule.theme, agentTarget(fakeSource([])));
	check("agent: main hidden", !mainShown());
	check("side after agent is accepted: the drift check sees pi's layout again", threads.enter(s.tui, themeModule.theme, side) === undefined);
	check("side: main shown, the side thread appended after it", mainShown() && s.document.children.length === 6 && s.document.children.slice(0, 3).every((part, i) => part === parts[i]));
	check("agent after side is accepted", threads.enter(s.tui, themeModule.theme, agentTarget(fakeSource([]))) === undefined);
	check("agent again: main hidden, no side rows left", !mainShown() && s.document.children.length === 3 && !s.document.render(40).some((line) => line.includes(SIDE_MARKER)));
	check("agent to agent is accepted", threads.enter(s.tui, themeModule.theme, agentTarget(fakeSource([]))) === undefined && s.document.children.length === 3);
	threads.leave();
	check("leaving: main's three parts, the same objects, and nothing else", s.document.children.length === 3 && s.document.children.every((part, i) => part === parts[i]) && mainShown());
	threads.leave();
	check("a second leave changes nothing", s.document.children.length === 3);
}

console.log("\nside-screen: a layout side mode was not built for is refused");
{
	const extra = screen();
	extra.document.addChild(new Container());
	check("a fourth document child is drift", /header, resources, chat/.test(new ThreadScreen(KIT_ROOT).enter(extra.tui, themeModule.theme, sideTarget()) ?? ""));
	check("and nothing was mounted", extra.document.children.length === 4);

	const short = screen();
	short.tui.children.pop();
	check("a mount list of six is drift", /not pi's 7/.test(new ThreadScreen(KIT_ROOT).enter(short.tui, themeModule.theme, sideTarget()) ?? ""));

	const dialog = screen();
	dialog.tui.focused = { render: () => [] };
	check("an editor that does not hold the keyboard is drift", /focused/.test(new ThreadScreen(KIT_ROOT).enter(dialog.tui, themeModule.theme, sideTarget()) ?? ""));
	check("and the document is untouched", dialog.document.children.length === 3);
}

await finish();
