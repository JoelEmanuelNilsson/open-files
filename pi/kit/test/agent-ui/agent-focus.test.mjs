/**
 * The agent view (`extensions/agent-dock/agent-focus-target.ts`) driven by
 * side-chat's prompt focus controller, through the real side-chat entry on a
 * stub seat: which submits reach the agent and how, what Esc and the follow-up
 * key do, the compaction hold, following the agent by task id across a resume,
 * keeping the feed when a run settles, the drift refusal, shutdown, the
 * transcript read from disk for an agent with no live session, and the agent
 * view replacing main's transcript across switches to side mode and back.
 *
 *   node test/agent-ui/agent-focus.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { sleep } from "../support/async-waits.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const themeModule = await importPi("dist/modes/interactive/theme/theme.js");
themeModule.initTheme("dark", false);
const { Container } = await importPi("node_modules/@earendil-works/pi-tui/dist/tui.js");
const jiti = kitJiti();

const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const sideChat = (await jiti.import(`${KIT_ROOT}/extensions/side-chat/index.ts`)).default;
const { promptTargetOf } = await jiti.import(`${KIT_ROOT}/lib/session/prompt-target.ts`);
const { promptFocusOf } = await jiti.import(`${KIT_ROOT}/lib/session/prompt-focus.ts`);
const { agentFocusTarget, settledAgentSource } = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/agent-focus-target.ts`);

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: "anthropic", model: "m", api: "anthropic-messages", usage, stopReason: "stop", timestamp: 2 });

/** pi's mounted screen as the prompt focus reads it: seven containers, the editor in the fifth. */
function fakeScreen() {
	const document = new Container();
	for (let i = 0; i < 3; i++) document.addChild(new Container());
	const editor = {
		text: "",
		history: [],
		keybindings: { matches: (data, action) => (action === "app.interrupt" && data === "\x1b") || (action === "app.message.followUp" && data === "\x11") || (action === "tui.input.submit" && data === "\r") },
		isShowingAutocomplete: () => false,
		getExpandedText() { return this.text; },
		getText() { return this.text; },
		getLines() { return this.text.split("\n"); },
		getCursor() { const lines = this.getLines(); return { line: lines.length - 1, col: lines.at(-1).length }; },
		setText(text) { this.text = text; },
		addToHistory(text) { this.history.push(text); },
		render: () => ["EDITOR"],
		invalidate: () => {},
	};
	const editorContainer = new Container();
	editorContainer.children.push(editor);
	const tui = {
		children: [document, new Container(), new Container(), new Container(), editorContainer, new Container(), new Container()],
		focused: editor,
		getFocusedComponent() { return this.focused; },
		requestRender: () => {},
	};
	return { tui, document, editor };
}

/** The real side-chat entry, the prompt focus host, on a stub seat. */
async function seat(sessionId) {
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const inputListeners = [];
	const screen = fakeScreen();
	let idle = true;
	sideChat({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: () => {},
		getThinkingLevel: () => "off",
	});
	const ctx = {
		cwd: KIT_ROOT,
		mode: "tui",
		hasUI: true,
		model: undefined,
		modelRegistry: {},
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getLeafId: () => null },
		isIdle: () => idle,
		ui: {
			theme: themeModule.theme,
			notify: (message, level) => notices.push({ message, level }),
			onTerminalInput: (listener) => { inputListeners.push(listener); return () => {}; },
			setWidget: (_key, factory) => { factory(screen.tui, themeModule.theme); },
		},
	};
	await handlers.get("session_start")({ type: "session_start" }, ctx);
	return {
		handlers,
		commands,
		notices,
		ctx,
		screen,
		input: (text, extra = {}) => handlers.get("input")({ type: "input", text, source: "interactive", ...extra }, ctx),
		key: (data) => inputListeners.at(-1)?.(data),
		lines: () => screen.document.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd()).filter((line) => line !== ""),
		feed: () => screen.document.children.find((child) => "source" in child),
		emit: (event) => handlers.get(event)({ type: event }, ctx),
		setIdle: (on) => { idle = on; },
		shutdown: () => handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx),
	};
}

/** A child session as the feed reads it. */
function fakeSession(messages) {
	const listeners = new Set();
	return {
		messages,
		isStreaming: false,
		aborts: 0,
		abort() { this.aborts++; },
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		emit: (event) => { for (const listener of listeners) listener(event); },
		getToolDefinition: () => undefined,
	};
}

/** The runtime surface the agent view uses, recording every call. */
function fakeRuntime(live) {
	const calls = [];
	const state = { record: { name: "worker-2", taskId: "t1", description: "audit the wire", sessionFile: undefined, result: undefined, error: undefined }, live };
	return {
		calls,
		state,
		registry: { byName: (name) => (name === state.record.name ? state.record : undefined), byTaskId: (taskId) => (taskId === state.record.taskId ? state.record : undefined) },
		liveRun: (taskId) => (taskId === state.record.taskId ? state.live : undefined),
		send: async (name, text, interrupt, from) => { calls.push(["send", name, text, interrupt, from]); return { kind: "queued", record: state.record }; },
		followUp: async (name, text) => { calls.push(["followUp", name, text]); return { kind: "queued", record: state.record }; },
		childToolDefinition: (name) => (name === "read" ? { name: "read", marker: "from a child" } : undefined),
		stop: async () => { calls.push(["stop"]); },
	};
}

const taskOf = (fields = {}) => ({ id: "t1", name: "worker-2", type: "worker", description: "audit the wire", model: "", workflowChild: false, runId: undefined, status: "running", startedAt: 0, settledAt: undefined, durationMs: undefined, toolUses: 0, lastActivityAt: undefined, totalTokens: undefined, costUsd: undefined, activity: [], result: undefined, error: undefined, outcome: undefined, stopRequested: false, ...fields });

// A nested agent's task id is not in main's runtime, and its name can be one of
// main's: the target must find nothing rather than main's namesake.
console.log("agent-focus: a target resolves its agent by task id, never by a name main shares");
{
	const s = await seat("agent-namesake");
	const runtime = fakeRuntime(fakeSession([user("audit the wire"), assistant("Main's own worker-2 said this.")]));
	promptFocusOf("agent-namesake").focus(agentFocusTarget({ runtime, taskId: "n1", name: "worker-2", task: () => taskOf({ id: "n1" }), notify: (message, level) => s.notices.push({ message, level }) }));
	check("main's same-named agent is not drawn", !s.lines().some((line) => line.includes("Main's own worker-2")), JSON.stringify(s.lines()));
	s.input("are you there");
	check("and nothing is sent to it", runtime.calls.length === 0, JSON.stringify(runtime.calls));
	s.shutdown();
}

console.log("agent-focus: an agent target claims the prompt and routes it to send");
{
	const s = await seat("agent-main");
	const live = fakeSession([user("audit the wire"), assistant("Looking at the header block.")]);
	const runtime = fakeRuntime(live);
	let task = taskOf();
	const target = () => agentFocusTarget({ runtime, taskId: "t1", name: "worker-2", task: () => task, notify: (message, level) => s.notices.push({ message, level }) });
	check("focusing the agent is accepted", promptFocusOf("agent-main").focus(target()) === true);
	check("the prompt target is the agent, by name", JSON.stringify(promptTargetOf("agent-main")) === JSON.stringify({ kind: "agent", name: "worker-2" }));
	check("the marker names the agent and its task", s.lines().includes(" <AGENT worker-2 · audit the wire>"), JSON.stringify(s.lines()));
	check("its conversation is drawn under the marker", s.lines().some((line) => line.includes("Looking at the header block.")));
	check("focusing the same agent again changes nothing", promptFocusOf("agent-main").focus(target()) === true && s.lines().filter((line) => line.includes("<AGENT")).length === 1);

	check("a plain submit is handled", s.input("check the retry path")?.action === "handled");
	check("and goes to runtime.send by task id, as Joel, without interrupting", JSON.stringify(runtime.calls.at(-1)) === JSON.stringify(["send", "t1", "check the retry path", false, "Joel"]));
	// pi runs every slash command before `input`; a `/` text that reaches it is a pasted path, as in Joel's misrouted flag feedback.
	check("a submit that starts with a pasted path is handled", s.input("/var/folders/shot.png one ribbon per mast")?.action === "handled");
	check("and goes to the agent, not main", JSON.stringify(runtime.calls.at(-1)) === JSON.stringify(["send", "t1", "/var/folders/shot.png one ribbon per mast", false, "Joel"]));
	check("input that is not typed is main's", s.input("from an extension", { source: "extension" }) === undefined);

	live.isStreaming = true;
	s.input("and the timeout");
	check("a message into a running answer shows as queued", s.lines().includes(" ↳ queued: and the timeout"), JSON.stringify(s.lines()));
	live.messages.push(user("and the timeout"));
	live.emit({ type: "message_start", message: user("and the timeout") });
	check("until the agent's matching user message arrives in the feed", !s.lines().some((line) => line.includes("↳ queued")) && s.lines().some((line) => line.includes("and the timeout")));

	s.screen.editor.text = "after that, the docs";
	const before = runtime.calls.length;
	check("the follow-up key is taken while the agent streams", s.key("\x11")?.consume === true);
	check("and goes to runtime.followUp", JSON.stringify(runtime.calls.at(-1)) === JSON.stringify(["followUp", "t1", "after that, the docs"]) && runtime.calls.length === before + 1);
	check("clearing the editor into history", s.screen.editor.text === "" && s.screen.editor.history.at(-1) === "after that, the docs");
	live.isStreaming = false;
	s.screen.editor.text = "later";
	check("with the agent idle, the follow-up key is left to pi, which submits it as Enter", s.key("\x11") === undefined);
	s.screen.editor.text = "";

	const sends = runtime.calls.length;
	check("a submit with images is handled", s.input("look at this", { images: [{ type: "image", data: "", mimeType: "image/png" }] })?.action === "handled");
	check("and refused: nothing is sent", runtime.calls.length === sends);
	check("with a notice that says so", /text only/.test(s.notices.at(-1)?.message ?? "") && /images were not sent/.test(s.notices.at(-1)?.message ?? ""), JSON.stringify(s.notices.at(-1)));
	check("and the text back in the editor", s.screen.editor.text === "look at this");
	s.screen.editor.text = "";

	s.screen.editor.text = "during compaction";
	s.emit("session_before_compact");
	s.setIdle(false);
	check("while main compacts, Enter to the agent is held", s.key("\r")?.consume === true);
	check("with the notice", s.notices.at(-1)?.message === "Main is compacting — send again when it's done.");
	check("the follow-up key too", s.key("\x11")?.consume === true);
	check("and the text stays in the editor", s.screen.editor.text === "during compaction" && runtime.calls.length === sends);
	s.screen.editor.text = "/var/folders/shot.png during compaction";
	check("a submit that starts with a path is held too: pi would queue it for main", s.key("\r")?.consume === true);
	s.emit("session_compact");
	s.setIdle(true);
	check("once compaction ends, Enter goes through", s.key("\r") === undefined);
	s.screen.editor.text = "";

	task = taskOf({ status: "completed", durationMs: 125_000, outcome: "completed" });
	runtime.state.live = undefined;
	check("when the run settles the feed already built is kept", s.lines().some((line) => line.includes("Looking at the header block.")) && s.lines().some((line) => line.includes("and the timeout")));
	check("still bound to the session it followed", s.feed().source === live);
	check("with the settle line under it", s.lines().some((line) => line.startsWith(" ✓ done · 2m")), JSON.stringify(s.lines()));
	task = taskOf({ status: "failed", outcome: "error", error: "boom\nstack" });
	check("a failure shows its first line", s.lines().includes(" ✗ boom"));
	task = taskOf({ status: "failed", outcome: "stopped", durationMs: 3_000 });
	check("a stop shows as stopped", s.lines().some((line) => line.startsWith(" ■ stopped")));

	s.input("resume please");
	const resumed = fakeSession([user("audit the wire"), assistant("Looking at the header block."), user("resume please"), assistant("Resumed and done.")]);
	runtime.state.live = resumed;
	task = taskOf({ status: "running" });
	check("typing to a settled agent goes through send, which resumes it", JSON.stringify(runtime.calls.at(-1)) === JSON.stringify(["send", "t1", "resume please", false, "Joel"]));
	check("the view rebinds to the resumed run's session under the same name", s.lines().some((line) => line.includes("Resumed and done.")) && s.feed().source === resumed);

	check("Esc is taken", s.key("\x1b")?.consume === true);
	check("and leaves the agent view: the prompt talks to main again", promptTargetOf("agent-main") === undefined && !s.lines().some((line) => line.includes("<AGENT")));
	check("without stopping or aborting the agent", !runtime.calls.some(([kind]) => kind === "stop") && live.aborts === 0 && resumed.aborts === 0);
	check("Esc with nothing focused is not the view's", s.key("\x1b") === undefined);

	promptFocusOf("agent-main").focus(target());
	await s.shutdown();
	check("session_shutdown clears the target", promptTargetOf("agent-main") === undefined);
	check("and forgets the prompt focus", promptFocusOf("agent-main") === undefined);
}

console.log("\nagent-focus: the agent view replaces main's transcript; side mode appends to it");
{
	const s = await seat("agent-swap");
	const focus = promptFocusOf("agent-swap");
	const main = [...s.screen.document.children];
	const [, , chat] = main;
	const { Text } = await importPi("node_modules/@earendil-works/pi-tui/dist/components/text.js");
	chat.addChild(new Text("MAIN SAID THIS", 0, 0));
	const mainShown = () => s.lines().includes("MAIN SAID THIS");
	const sameMain = () => s.screen.document.children.slice(0, 3).every((part, i) => part === main[i]);
	const runtime = fakeRuntime(fakeSession([user("audit the wire"), assistant("Looking at the header block.")]));
	const target = () => agentFocusTarget({ runtime, taskId: "t1", name: "worker-2", task: () => taskOf(), notify: () => {} });

	focus.focus(target());
	check("focused on an agent, main's transcript is not drawn", !mainShown() && s.lines().includes(" <AGENT worker-2 · audit the wire>"), JSON.stringify(s.lines()));
	check("and main's parts are out of the document", main.every((part) => !s.screen.document.children.includes(part)));
	chat.addChild(new Text("MAIN WROTE WHILE HIDDEN", 0, 0));
	s.key("\x1b");
	check("Esc brings main back: the same three objects, in order", s.screen.document.children.length === 3 && sameMain());
	check("with what main wrote while hidden", mainShown() && s.lines().at(-1) === "MAIN WROTE WHILE HIDDEN", JSON.stringify(s.lines()));

	focus.focus(target());
	await s.commands.get("btw").handler("", s.ctx);
	check("/btw from the agent view switches to side mode", promptTargetOf("agent-swap")?.kind === "side");
	check("side mode draws main again, with the side marker appended after it", mainShown() && sameMain() && s.screen.document.children.length === 6 && s.lines().some((line) => line.includes("SIDE-CHAT-STARTED")));
	focus.focus(target());
	check("back to the agent: main hidden again, no side rows", !mainShown() && s.screen.document.children.length === 3 && !s.lines().some((line) => line.includes("SIDE-CHAT-STARTED")));
	focus.exit();
	check("exit restores main whole", mainShown() && sameMain() && s.screen.document.children.length === 3);

	focus.focus(target());
	await s.shutdown();
	check("shutdown in the agent view gives main its transcript back", sameMain() && s.screen.document.children.length === 3);
}

console.log("\nagent-focus: a layout the thread screen was not built for is refused");
{
	const s = await seat("agent-drift");
	s.screen.tui.focused = { render: () => [] };
	const runtime = fakeRuntime(fakeSession([]));
	check("focusing is refused", promptFocusOf("agent-drift").focus(agentFocusTarget({ runtime, taskId: "t1", name: "worker-2", task: () => taskOf(), notify: () => {} })) === false);
	check("saying why", /^agent view refused: .*focused/.test(s.notices.at(-1)?.message ?? ""), JSON.stringify(s.notices.at(-1)));
	check("with no target set and nothing mounted", promptTargetOf("agent-drift") === undefined && s.screen.document.children.length === 3);
	await s.shutdown();
}

console.log("\nagent-focus: an agent with no live session is read from disk");
{
	const dir = mkdtempSync(join(tmpdir(), "agent-focus-"));
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage(user("audit the wire"));
	manager.appendMessage({ ...assistant("Found it."), content: [{ type: "text", text: "Found it." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }] });
	manager.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 });
	manager.appendMessage(assistant("The wire is fine."));
	const sessionFile = manager.getSessionFile();
	check("(the fixture transcript is on disk)", existsSync(sessionFile));

	const runtime = fakeRuntime(undefined);
	const source = settledAgentSource({ sessionFile, result: "not this", error: undefined }, (name) => runtime.childToolDefinition(name));
	check("the transcript is the session file's messages", source.messages.map((message) => message.role).join() === "user,assistant,toolResult,assistant");
	check("subscribe never fires and unsubscribes cleanly", typeof source.subscribe(() => {}) === "function");
	check("tool definitions come from a child the runtime built", source.getToolDefinition("read")?.marker === "from a child" && source.getToolDefinition("bash") === undefined);
	const fallback = settledAgentSource({ sessionFile: join(dir, "missing.jsonl"), result: "the answer", error: undefined }, () => undefined);
	check("with no transcript on disk the result stands in as one answer", fallback.messages.length === 1 && fallback.messages[0].content[0].text === "the answer");
	check("an error stands in before a result", settledAgentSource({ sessionFile: undefined, result: "half", error: "boom" }, () => undefined).messages[0].content[0].text === "boom");
	check("and with neither there is nothing to draw", settledAgentSource({ sessionFile: undefined, result: undefined, error: undefined }, () => undefined).messages.length === 0);

	const s = await seat("agent-disk");
	runtime.state.record = { ...runtime.state.record, sessionFile };
	promptFocusOf("agent-disk").focus(agentFocusTarget({ runtime, taskId: "t1", name: "worker-2", task: () => taskOf({ status: "completed", outcome: "completed" }), notify: () => {} }));
	check("focusing a settled agent draws its transcript from disk", s.lines().some((line) => line.includes("The wire is fine.")) && s.lines().some((line) => line.includes("✓ done")), JSON.stringify(s.lines()));
	const disk = s.feed().source;
	s.lines();
	check("read once: the next render keeps the same source", s.feed().source === disk);
	await s.shutdown();
}

await sleep(10);
await finish();
