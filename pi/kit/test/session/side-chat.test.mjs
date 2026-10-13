/**
 * Side mode (`extensions/side-chat/`): what a side question sends, where input
 * goes, and which keys side mode takes.
 *
 * The end-to-end half drives the real extension entry with a real child
 * session against a local stand-in for the Anthropic API, so the requests
 * checked are the bytes pi would send: main's cut transcript first, then the
 * side turns with every side user message wrapped identically, tools executed
 * only when allowlisted, and at most SIDE_TOOL_ROUND_CAP rounds.
 *
 *   node test/session/side-chat.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { sleep, until } from "../support/async-waits.mjs";
import { KIT_ROOT, PI_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The child reads auth and settings from the agent dir: a throwaway one, with a
// fake key, so no real credential ever reaches the stand-in server.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "side-chat-agent-"));
process.env.ANTHROPIC_API_KEY = "sk-side-chat-test";

const themeModule = await importPi("dist/modes/interactive/theme/theme.js");
themeModule.initTheme("dark", false);
const { Container } = await importPi("node_modules/@earendil-works/pi-tui/dist/tui.js");
const jiti = kitJiti();

const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const side = await jiti.import(`${KIT_ROOT}/extensions/side-chat/side-session.ts`);
const sideChat = (await jiti.import(`${KIT_ROOT}/extensions/side-chat/index.ts`)).default;
const { promptTargetOf } = await jiti.import(`${KIT_ROOT}/lib/session/prompt-target.ts`);
const isSideModeOn = (sessionId) => promptTargetOf(sessionId)?.kind === "side";
const { promptFocusOf } = await jiti.import(`${KIT_ROOT}/lib/session/prompt-focus.ts`);
const { publishLastRequest: publishPingTarget, forgetLastRequests: forgetPingTargets } = await jiti.import(`${KIT_ROOT}/lib/wire/last-request.ts`);

async function waitFor(what, predicate, ms = 5000) {
	if (await until(predicate, ms, 5)) return true;
	check(`(timed out waiting for ${what})`, false);
	return false;
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const system = (text) => ({ role: "system", content: text, timestamp: 0 });
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, provider: "anthropic", model: "claude-side-test", api: "anthropic-messages", usage, stopReason, timestamp: 2 });
const call = (id, name = "read") => ({ type: "toolCall", id, name, arguments: { path: "x" } });
const result = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 });

console.log("side-chat: main's transcript cut to its last complete point");
{
	const cut = side.cutAtCompletePoint;
	const done = [system("sys"), user("q"), assistant([call("a")]), result("a"), assistant([{ type: "text", text: "done" }])];
	check("a finished transcript is kept whole", cut(done).length === done.length);
	check("a tool call still waiting for its result is cut, with its assistant message", cut([...done, user("next"), assistant([call("b")])]).length === done.length + 1);
	check("parallel calls with one result in are cut at the assistant that made them", cut([user("q"), assistant([call("a"), call("b")]), result("a")]).length === 1);
	check("completed rounds before the open one are kept", cut([user("q"), assistant([call("a")]), result("a"), assistant([call("b")])]).length === 3);
	check("system messages, leading and mid-conversation, are kept", cut([system("sys"), user("q"), system("tools changed"), assistant([call("a")]), result("a")]).filter((m) => m.role === "system").length === 2);
	check("an aborted assistant's calls do not hold the cut (pi-ai drops that message)", cut([user("q"), assistant([call("a")], "aborted"), user("again")]).length === 3);
	check("a later user message closes calls left open (pi-ai answers them for us)", cut([user("q"), assistant([call("a")]), user("moving on")]).length === 3);
}

console.log("\nside-chat: the child's own extension");
{
	const handlers = new Map();
	const basis = { mainCut: [system("main system"), user("main q")] };
	side.sideChildExtension(basis)({ on: (event, handler) => handlers.set(event, handler) });
	check("the child stops pi's cache warmer for itself", handlers.get("cache_warming_decision")({ type: "cache_warming_decision" })?.action === "stop");

	const childMessages = [system("child system"), user("side q")];
	const first = handlers.get("context_with_system")({ type: "context_with_system", messages: childMessages }).messages;
	const second = handlers.get("context_with_system")({ type: "context_with_system", messages: [...childMessages, assistant([{ type: "text", text: "a" }]), user("side 2")] }).messages;
	check("the request is main's cut, then the side turns", first.length === 3 && first[0].content === "main system" && first[1].content[0].text === "main q");
	check("the child's own system message is dropped when main has one", !first.some((m) => m.content === "child system"));
	check("every side user message is wrapped", first[2].content[0].text === `${side.SIDE_THREAD_PREAMBLE}\n\nside q` && second[4].content[0].text.startsWith(side.SIDE_THREAD_PREAMBLE));
	check("an earlier side message carries the same bytes on the next request", JSON.stringify(first[2]) === JSON.stringify(second[2]));
	check("the child's stored messages are not rewritten", childMessages[1].content[0].text === "side q");

	const guard = (toolName) => handlers.get("tool_call")({ type: "tool_call", toolCallId: "t", toolName, input: {} });
	for (const name of ["bash", "edit", "write", "Agent", "Workflow"]) check(`${name} is blocked with a reason`, guard(name)?.block === true && guard(name).reason.includes("only read and web_search"));
	for (const name of ["read", "web_search"]) check(`${name} runs`, guard(name) === undefined);

	const round = () => handlers.get("turn_end")({ type: "turn_end", toolResults: [result("a")] });
	for (let i = 0; i < side.SIDE_TOOL_ROUND_CAP - 1; i++) round();
	check(`round ${side.SIDE_TOOL_ROUND_CAP} is refused and told to answer, without ending the run`, guard("read")?.block === true && guard("read").terminate === undefined && /answer now/.test(guard("read").reason));
	round();
	check("a call after that ends the run", guard("read")?.terminate === true);
	handlers.get("turn_end")({ type: "turn_end", toolResults: [] });
	check("a turn without tool calls is not a round", guard("read")?.terminate === true);
	handlers.get("message_start")({ type: "message_start", message: user("follow-up") });
	check("a new side user message starts the count again", guard("read") === undefined);
}

// ---------------------------------------------------------------------------
// The stand-in API: each request takes the next scripted reply, else a text one.
const requests = [];
const script = [];
const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const opening = { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-side-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };
const replyText = (text) => sse([opening, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }]);
const replyTool = (id, name, input) => sse([opening, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }]);
let hanging;
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		requests.push(JSON.parse(body));
		const next = script.shift() ?? (() => replyText(`pong ${requests.length}`));
		res.writeHead(200, { "content-type": "text/event-stream" });
		const reply = next(res);
		if (reply === undefined) {
			hanging = { res, closed: false };
			res.on("close", () => { if (hanging) hanging.closed = true; });
			return;
		}
		res.end(reply);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const model = { id: "claude-side-test", name: "side test", provider: "anthropic", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${server.address().port}`, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

/** pi's mounted screen as side mode reads it: seven containers, the editor in the fifth. */
function fakeScreen() {
	const document = new Container();
	for (let i = 0; i < 3; i++) document.addChild(new Container());
	const editor = {
		text: "",
		history: [],
		autocomplete: false,
		keybindings: { matches: (data, action) => (action === "app.interrupt" && data === "\x1b") || (action === "app.message.followUp" && data === "\x11") || (action === "tui.input.submit" && data === "\r") },
		isShowingAutocomplete() { return this.autocomplete; },
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

/** The real extension entry on a stub seat with a real main session manager. */
function seat(sessionId = "main-side-test") {
	const handlers = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const notices = [];
	const inputListeners = [];
	const screen = fakeScreen();
	const main = SessionManager.inMemory(KIT_ROOT);
	main.appendMessage(user("main question"));
	main.appendMessage(assistant([{ type: "text", text: "main answer" }]));
	let mainAborts = 0;
	let idle = true;
	sideChat({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: (key, options) => shortcuts.set(key, options),
		getThinkingLevel: () => "off",
	});
	const ctx = {
		cwd: KIT_ROOT,
		mode: "tui",
		hasUI: true,
		model,
		modelRegistry: {},
		sessionManager: { getSessionId: () => sessionId, getEntries: () => main.getEntries(), getLeafId: () => main.getLeafId() },
		abort: () => { mainAborts++; },
		isIdle: () => idle,
		ui: {
			theme: themeModule.theme,
			notify: (message, level) => notices.push({ message, level }),
			onTerminalInput: (listener) => { inputListeners.push(listener); return () => {}; },
			setWidget: (_key, factory) => { factory(screen.tui, themeModule.theme); },
		},
	};
	const input = (text, extra = {}) => handlers.get("input")({ type: "input", text, source: "interactive", ...extra }, ctx);
	const key = (data) => inputListeners.at(-1)?.(data);
	const lines = () => screen.document.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd()).filter((line) => line !== "");
	const feed = () => screen.document.children[4];
	const emit = (event) => handlers.get(event)({ type: event }, ctx);
	return { handlers, commands, shortcuts, notices, ctx, main, screen, input, key, lines, feed, emit, setIdle: (on) => { idle = on; }, mainAborts: () => mainAborts };
}

/** Wait until the side run that produced `count` requests has settled. */
async function settled(s, count) {
	await waitFor(`${count} side requests`, () => requests.length >= count);
	await waitFor("the side run to settle", () => s.feed()?.source?.isStreaming === false);
	await sleep(30);
}

const userTexts = (request) => request.messages.filter((m) => m.role === "user").flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.filter((p) => p.type === "text").map((p) => p.text)));

console.log("\nside-chat: /btw, input routing and the requests a side question sends");
{
	const s = seat();
	await s.handlers.get("session_start")({ type: "session_start" }, s.ctx);
	check("plain input is main's while side mode is off", s.input("hello") === undefined);
	check("the toggle key is alt+s", s.shortcuts.has("alt+s"));

	await s.commands.get("btw").handler("", s.ctx);
	check("/btw turns side mode on", isSideModeOn("main-side-test"));
	check("the marker is under main's chat", s.lines().includes(" <SIDE-CHAT-STARTED>"), JSON.stringify(s.lines()));
	check("input that is not typed passes through", s.input("from an extension", { source: "extension" }) === undefined);

	const base = requests.length;
	check("plain typed input is handled by the side", s.input("what is main doing?")?.action === "handled");
	await settled(s, base + 1);
	const first = requests[base];
	const firstUsers = userTexts(first);
	check("the request opens with main's transcript", firstUsers[0] === "main question" && first.messages[1].role === "assistant");
	check("the side question comes last, wrapped", firstUsers.at(-1) === `${side.SIDE_THREAD_PREAMBLE}\n\nwhat is main doing?`);
	check("only read and web_search are declared to the cold child", first.tools.every((tool) => ["read", "web_search"].includes(tool.name)));
	check("the answer is drawn under the marker", s.lines().some((line) => line.includes(`pong ${base + 1}`)), JSON.stringify(s.lines()));
	check("the feed shows the question as typed, not wrapped", s.lines().some((line) => line.includes("what is main doing?")) && !s.lines().some((line) => line.includes("<side-thread>")));
	const child = s.feed().source;
	check("the child's stored messages are only side turns, unwrapped", child.messages.filter((m) => m.role !== "system").map((m) => m.role).join(",") === "user,assistant" && !JSON.stringify(child.messages).includes("<side-thread>"));

	// Main moves on between two side questions; the next one sees it.
	s.main.appendMessage(user("main second"));
	s.main.appendMessage(assistant([{ type: "text", text: "main second answer" }]));
	s.input("and now?");
	await settled(s, base + 2);
	const second = requests[base + 1];
	check("the next side question sees main as it is now", userTexts(second).includes("main second"));
	const earlier = second.messages.find((m) => m.role === "user" && JSON.stringify(m).includes("what is main doing?"));
	const strip = (m) => JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v));
	check("the earlier side question is byte-identical on the next request", strip(earlier) === strip(first.messages.at(-1)));

	// A tool round in flight: main moving meanwhile does not change the running request's prefix.
	const mainLengthAtAsk = s.main.getEntries().length;
	script.push(() => {
		s.main.appendMessage(user("main third, during the side run"));
		return replyTool("toolu_1", "read", { path: "package.json" });
	});
	s.input("read package.json");
	await settled(s, base + 4);
	check("main's snapshot is fixed for the whole side run", !userTexts(requests[base + 3]).includes("main third, during the side run") && s.main.getEntries().length === mainLengthAtAsk + 1);
	const readResult = requests[base + 3].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((p) => p.type === "tool_result" && p.tool_use_id === "toolu_1");
	check("read runs in the side thread", JSON.stringify(readResult?.content ?? "").includes("test/suite-runner.mjs"), JSON.stringify(readResult).slice(0, 200));

	script.push(() => replyTool("toolu_2", "bash", { command: "touch /tmp/side-chat-should-not-exist" }));
	s.input("run a command");
	await settled(s, base + 6);
	const bashResult = requests[base + 5].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((p) => p.type === "tool_result" && p.tool_use_id === "toolu_2");
	check("bash does not run: the child has no such tool", bashResult?.is_error === true && /not found/i.test(JSON.stringify(bashResult.content)), JSON.stringify(bashResult));

	const cap = side.SIDE_TOOL_ROUND_CAP;
	const before = requests.length;
	for (let i = 0; i < cap + 3; i++) script.push(() => replyTool(`toolu_cap_${i}`, "read", { path: "package.json" }));
	s.input("keep reading");
	await settled(s, before + cap + 1);
	await sleep(100);
	check(`a side question gets ${cap + 1} requests at most: ${cap - 1} rounds run, one is refused, the next ends it`, requests.length === before + cap + 1, `${requests.length - before} requests`);
	const refused = requests.at(-1).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool_result").at(-1);
	check("the refused round tells the model to answer", /answer now/.test(JSON.stringify(refused?.content)), JSON.stringify(refused));
	script.length = 0;

	await s.handlers.get("session_shutdown")({ type: "session_shutdown" }, s.ctx);
}

console.log("\nside-chat: while a side answer runs");
{
	const s = seat("main-busy");
	await s.handlers.get("session_start")({ type: "session_start" }, s.ctx);
	await s.commands.get("btw").handler("", s.ctx);
	const base = requests.length;
	script.push(() => undefined);
	s.input("slow question");
	await waitFor("the hanging request", () => requests.length === base + 1);
	check("Enter steers, even when pi calls it a follow-up for main", s.input("steer this", { streamingBehavior: "followUp" })?.action === "handled");
	s.screen.editor.text = "queue this";
	check("the follow-up key is taken while the side runs", s.key("\x11")?.consume === true);
	check("and it clears the editor into history", s.screen.editor.text === "" && s.screen.editor.history.at(-1) === "queue this");
	hanging.res.end(replyText("slow answer"));
	await settled(s, base + 3);
	check("the steer reaches the running side answer", userTexts(requests[base + 1]).some((t) => t.endsWith("steer this")));
	check("the follow-up is sent after it", userTexts(requests[base + 2]).some((t) => t.endsWith("queue this")));

	script.push(() => undefined);
	s.input("another slow one");
	await waitFor("the second hanging request", () => requests.length === base + 4);
	s.screen.editor.autocomplete = true;
	check("Esc with autocomplete open is the editor's", s.key("\x1b") === undefined);
	s.screen.editor.autocomplete = false;
	s.screen.tui.focused = { render: () => [] };
	check("Esc with something else focused is not side mode's", s.key("\x1b") === undefined);
	s.screen.tui.focused = s.screen.editor;
	check("Esc stops the running side answer", s.key("\x1b")?.consume === true);
	await waitFor("the side request to be dropped", () => hanging.closed);
	await sleep(50);
	check("side mode stays on after the stop", isSideModeOn("main-busy"));
	check("main was never aborted", s.mainAborts() === 0);
	check("Esc with nothing running leaves side mode", s.key("\x1b")?.consume === true && !isSideModeOn("main-busy"));
	check("and takes the marker off the screen", !s.lines().some((line) => line.includes("SIDE-CHAT-STARTED")));
	check("Esc with side mode off is not side mode's", s.key("\x1b") === undefined);
	check("key releases are never taken", s.key("\x1b[27;1:3u") === undefined);

	await s.commands.get("btw").handler("", s.ctx);
	check("re-entering shows the earlier side turns again", s.lines().some((line) => line.includes("slow question")));
	await s.commands.get("btw").handler("clear", s.ctx);
	check("/btw clear empties the side view", !s.lines().some((line) => line.includes("slow question")) && s.lines().some((line) => line.includes("SIDE-CHAT-STARTED")));
	const cleared = requests.length;
	await s.commands.get("btw").handler("fresh start", s.ctx);
	await settled(s, cleared + 1);
	check("/btw <text> asks, and after clear the thread starts fresh", !userTexts(requests[cleared]).some((t) => t.includes("slow question")) && userTexts(requests[cleared]).at(-1).endsWith("fresh start"));

	await s.handlers.get("session_shutdown")({ type: "session_shutdown" }, s.ctx);
	check("a session switch turns side mode off", !isSideModeOn("main-busy"));
	check("and drops the side thread's request basis", await waitFor("the basis to be forgotten", () => (globalThis.__piKitSideSeats?.size ?? 0) === 0));
}

console.log("\nside-chat: switching between side mode and an agent keeps the work");
{
	const s = seat("main-switch");
	await s.handlers.get("session_start")({ type: "session_start" }, s.ctx);
	const agentSent = [];
	const agentLeft = [];
	const agent = {
		target: { kind: "agent", name: "worker-2" },
		marker: { text: "<AGENT worker-2>", color: "accent" },
		source: () => undefined,
		statusLines: () => [],
		submit: (text) => { agentSent.push(text); return { kind: "sent" }; },
		takesFollowUpKey: () => false,
		interrupt: () => "leave",
		leave: (why) => agentLeft.push(why),
	};
	await s.commands.get("btw").handler("", s.ctx);
	const base = requests.length;
	script.push(() => undefined);
	s.input("long side question");
	await waitFor("the hanging request", () => requests.length === base + 1);
	check("focusing an agent from side mode is accepted", promptFocusOf("main-switch").focus(agent) === true);
	check("the agent is the prompt target now, and side mode is off", promptTargetOf("main-switch")?.kind === "agent" && !isSideModeOn("main-switch"));
	check("the side marker is replaced by the agent's", !s.lines().some((line) => line.includes("SIDE-CHAT-STARTED")) && s.lines().some((line) => line.includes("<AGENT worker-2>")));
	check("a plain submit goes to the agent", s.input("to the agent")?.action === "handled" && agentSent.join() === "to the agent");
	await sleep(50);
	check("switching away did not abort the running side answer", !hanging.closed);
	hanging.res.end(replyText("side answer after the switch"));
	await sleep(100);
	await s.commands.get("btw").handler("", s.ctx);
	check("/btw while an agent is focused switches to side mode, not off", isSideModeOn("main-switch"));
	check("the agent heard a switch, not an exit", agentLeft.join() === "switch");
	await waitFor("the side answer on screen", () => s.lines().some((line) => line.includes("side answer after the switch")));
	check("coming back shows the side turns, the answer finished while away included", s.lines().some((line) => line.includes("long side question")));
	check("the agent's marker is gone", !s.lines().some((line) => line.includes("<AGENT worker-2>")));

	promptFocusOf("main-switch").focus(agent);
	s.shortcuts.get("alt+s").handler(s.ctx);
	check("alt+s while an agent is focused switches to side mode too", isSideModeOn("main-switch"));
	s.shortcuts.get("alt+s").handler(s.ctx);
	check("alt+s in side mode toggles it off", promptTargetOf("main-switch") === undefined);
	await s.handlers.get("session_shutdown")({ type: "session_shutdown" }, s.ctx);
}

console.log("\nside-chat: pi queues a submit made during compaction without an input event");
{
	const source = readFileSync(`${PI_ROOT}/dist/modes/interactive/interactive-mode.js`, "utf8");
	const body = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
	const submit = body("setupEditorSubmitHandler() {", "subscribeToAgent() {");
	const at = (text, part = submit) => part.indexOf(text);
	check("Enter: `!cmd` runs bash before the compaction check", at("if (text.startsWith(\"!\")) {") !== -1 && at("if (text.startsWith(\"!\")) {") < at("if (this.session.isCompacting) {"));
	check("Enter: during compaction plain text is queued before any path that fires input", at("this.queueCompactionMessage(text, \"steer\");") > at("if (this.session.isCompacting) {") && at("this.queueCompactionMessage(text, \"steer\");") < at("await this.session.prompt(text, { streamingBehavior: \"steer\" });") && at("this.queueCompactionMessage(text, \"steer\");") < at("this.onInputCallback(text);"));
	const followUp = body("async handleFollowUp() {", "handleDequeue() {");
	check("follow-up key: during compaction it is queued before any path that fires input", at("this.queueCompactionMessage(text, \"followUp\");", followUp) !== -1 && at("this.queueCompactionMessage(text, \"followUp\");", followUp) < at("this.session.prompt(text, { streamingBehavior: \"followUp\" })", followUp) && at("if (this.session.isCompacting) {", followUp) < at("this.queueCompactionMessage", followUp));
	check("the compaction queue only stores the text", !/session\.|emitInput/.test(body("queueCompactionMessage(text, mode) {", "isExtensionCommand(text) {")));
	const session = readFileSync(`${PI_ROOT}/dist/core/agent-session.js`, "utf8");
	check("isCompacting is manual, auto or branch-summary compaction", /get isCompacting\(\) \{\s*return \(this\._autoCompactionAbortController !== undefined \|\|\s*this\._compactionAbortController !== undefined \|\|\s*this\._branchSummaryAbortController !== undefined\);/.test(session));
	check("isIdle is false while compacting", /get isIdle\(\) \{\s*return !this\._isAgentRunActive && !this\.isCompacting;/.test(session));
	for (const event of ["session_before_compact", "session_compact", "session_compact_failed", "session_before_tree", "session_tree"]) check(`pi emits ${event} to extensions`, session.includes(`type: "${event}"`));
	const editor = readFileSync(`${PI_ROOT}/node_modules/@earendil-works/pi-tui/dist/components/editor.js`, "utf8");
	check("Enter after `\\` is a newline, not a submit", /if \(kb\.matches\(data, "tui\.input\.submit"\)\) \{[\s\S]{0,400}currentLine\[this\.state\.cursorCol - 1\] === "\\\\"\) \{\s*this\.handleBackspace\(\);\s*this\.addNewLine\(\);/.test(editor));
}

console.log("\nside-chat: while main compacts, side submits are held in the editor");
{
	const s = seat("main-compacting");
	await s.handlers.get("session_start")({ type: "session_start" }, s.ctx);
	const editor = s.screen.editor;
	editor.text = "side question";
	s.emit("session_before_compact");
	s.setIdle(false);
	check("with side mode off, Enter is main's", s.key("\r") === undefined && s.key("\x11") === undefined);
	await s.commands.get("btw").handler("", s.ctx);
	const base = requests.length;
	check("Enter is held", s.key("\r")?.consume === true);
	check("with the notice", s.notices.at(-1)?.message === "Main is compacting — send again when it's done." && s.notices.at(-1)?.level === "warning");
	check("the follow-up key is held", s.key("\x11")?.consume === true);
	check("the text stays in the editor", editor.text === "side question" && editor.history.length === 0);
	await sleep(30);
	check("nothing is sent to the side", requests.length === base);
	for (const text of ["/compact now", "/model", "/tmp/build.log has errors"]) {
		editor.text = text;
		check(`a submit of \`${text}\` is held on both keys: pi would run or queue it without an input event`, s.key("\r")?.consume === true && s.key("\x11")?.consume === true && editor.text === text && editor.history.length === 0);
	}
	editor.text = "!ls";
	check("Enter on `!cmd` runs bash on main", s.key("\r") === undefined);
	check("the follow-up key on `!cmd` is held: pi queues it as text", s.key("\x11")?.consume === true);
	editor.text = "!!";
	check("Enter on a bare `!!` is held: pi queues it as text", s.key("\r")?.consume === true);
	editor.text = "line one\\";
	check("Enter after `\\` is the editor's newline", s.key("\r") === undefined);
	editor.text = "  ";
	check("an empty submit is left to pi", s.key("\r") === undefined);
	editor.text = "side question";
	editor.autocomplete = true;
	check("Enter with autocomplete open is the editor's", s.key("\r") === undefined);
	editor.autocomplete = false;

	s.emit("session_compact");
	check("once compaction ends, Enter goes to the side as usual", s.key("\r") === undefined && s.key("\x11") === undefined);
	s.emit("session_before_compact");
	s.emit("session_compact_failed");
	check("a failed or cancelled compaction ends the hold", s.key("\r") === undefined);
	s.emit("session_before_tree");
	check("a branch summary holds too", s.key("\r")?.consume === true);
	s.emit("session_tree");
	check("and ends with the tree navigation", s.key("\r") === undefined);
	s.emit("session_before_tree");
	s.emit("agent_start");
	check("an aborted tree navigation (no end event) ends at main's next run", s.key("\r") === undefined);
	s.emit("session_before_tree");
	s.setIdle(true);
	check("and never holds while main is idle", s.key("\r") === undefined);
	await s.handlers.get("session_shutdown")({ type: "session_shutdown" }, s.ctx);
}

console.log("\nside-chat: pi's own Enter dispatch against the input event");
{
	const { InteractiveMode } = await importPi("dist/modes/interactive/interactive-mode.js");
	/** pi's installed submit and follow-up handlers on a stub host: their effects are recorded, their routing is pi's. */
	function piSubmits(s, extensionCommands = []) {
		const editor = s.screen.editor;
		const record = { dispatched: [], inputs: [], prompted: [], bash: [] };
		const host = Object.assign(Object.create(InteractiveMode.prototype), {
			editor,
			defaultEditor: editor,
			runtimeHost: { session: { isCompacting: false, isStreaming: false, isBashRunning: false, extensionRunner: { getCommand: (name) => extensionCommands.includes(name) }, prompt: async (text) => record.prompted.push(text) } },
			compactionQueuedMessages: [],
			pendingBashComponents: [],
			pendingUserInputs: [],
			isBashMode: false,
			onInputCallback: (text) => {
				record.inputs.push(text);
				s.input(text);
			},
			handleModelCommand: async (term) => record.dispatched.push(`model:${term}`),
			handleCompactCommand: async (instructions) => record.dispatched.push(`compact:${instructions}`),
			handleBashCommand: async (command) => record.bash.push(command),
			updatePendingMessagesDisplay() {},
			updateEditorBorderColor() {},
			showStatus() {},
		});
		host.setupEditorSubmitHandler();
		/** A key as the terminal delivers it: the extension's listener first, then pi's own handler unless the key was consumed. */
		const press = async (data, text) => {
			editor.text = text;
			if (s.key(data)?.consume === true) return "consumed";
			if (data === "\r") await editor.onSubmit(text);
			else await host.handleFollowUp();
			return "pi";
		};
		return { host, record, press };
	}

	const s = seat("main-dispatch");
	await s.handlers.get("session_start")({ type: "session_start" }, s.ctx);
	await s.commands.get("btw").handler("", s.ctx);
	const { host, record, press } = piSubmits(s);
	let base = requests.length;
	await press("\r", "/model");
	check("Enter on `/model` dispatches pi's model command: no input event, nothing for the side", JSON.stringify(record.dispatched) === '["model:undefined"]' && record.inputs.length === 0 && requests.length === base);
	await press("\r", "/tmp/build.log has errors");
	await settled(s, base + 1);
	check("Enter on a pasted path fires the input event, and the side answers it", record.inputs.join() === "/tmp/build.log has errors" && userTexts(requests[base]).at(-1) === `${side.SIDE_THREAD_PREAMBLE}\n\n/tmp/build.log has errors`);

	host.session.isCompacting = true;
	s.emit("session_before_compact");
	s.setIdle(false);
	const held = { dispatched: [...record.dispatched], inputs: [...record.inputs] };
	base = requests.length;
	for (const text of ["/model", "/model gpt", "/compact now", "/tmp/build.log has errors"]) {
		for (const [label, data] of [["Enter", "\r"], ["the follow-up key", "\x11"]]) {
			const outcome = await press(data, text);
			check(`during compaction ${label} on \`${text}\` is held: editor unchanged, no dispatch, no input event, no side send, no main queue`,
				outcome === "consumed" && s.screen.editor.text === text && JSON.stringify(record.dispatched) === JSON.stringify(held.dispatched) && record.inputs.length === held.inputs.length && requests.length === base && host.compactionQueuedMessages.length === 0);
		}
	}
	s.emit("session_compact");
	host.session.isCompacting = false;
	s.setIdle(true);
	await s.handlers.get("session_shutdown")({ type: "session_shutdown" }, s.ctx);

	const off = seat("main-dispatch-off");
	await off.handlers.get("session_start")({ type: "session_start" }, off.ctx);
	const plain = piSubmits(off, ["deploy"]);
	plain.host.session.isCompacting = true;
	off.emit("session_before_compact");
	off.setIdle(false);
	base = requests.length;
	await plain.press("\r", "/model");
	await plain.press("\r", "/compact now");
	check("without a target, Enter on a built-in during compaction still dispatches it", JSON.stringify(plain.record.dispatched) === '["model:undefined","compact:now"]' && plain.host.compactionQueuedMessages.length === 0);
	await plain.press("\r", "/deploy now");
	check("an extension command executes at once, through session.prompt", plain.record.prompted.join() === "/deploy now" && plain.host.compactionQueuedMessages.length === 0);
	await plain.press("\r", "/tmp/build.log has errors");
	await plain.press("\x11", "/model");
	check("a pasted path on Enter and a built-in on the follow-up key queue for main instead", JSON.stringify(plain.host.compactionQueuedMessages) === '[{"text":"/tmp/build.log has errors","mode":"steer"},{"text":"/model","mode":"followUp"}]' && plain.record.dispatched.length === 2 && plain.record.inputs.length === 0 && requests.length === base);
	await off.handlers.get("session_shutdown")({ type: "session_shutdown" }, off.ctx);
}

console.log("\nside-chat: a side request is main's last request with other messages");
{
	const s = seat("main-warm");
	await s.handlers.get("session_start")({ type: "session_start" }, s.ctx);
	const tools = [{ name: "read", description: "main's read", input_schema: { type: "object" } }, { name: "bash", description: "main's bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }];
	const mainSystem = [{ type: "text", text: "main's system", cache_control: { type: "ephemeral", ttl: "1h" } }];
	const rk = {
		model: model.id,
		max_tokens: 8192,
		stream: true,
		system: mainSystem,
		tools,
		messages: [
			{ role: "user", content: [{ type: "text", text: "main question" }] },
			{ role: "assistant", content: [{ type: "text", text: "main answer" }] },
			{ role: "user", content: [{ type: "text", text: "main second", cache_control: { type: "ephemeral", ttl: "1h" } }] },
		],
	};
	s.main.appendMessage(user("main second"));
	publishPingTarget({ payload: rk, at: Date.now(), headers: {}, model, sessionId: "main-warm", registry: {}, record: () => {} });
	await s.commands.get("btw").handler("warm question", s.ctx);
	const base = requests.length;
	await settled(s, base + 1);
	const sent = requests[base];
	check("the side request carries main's system and full tool JSON", JSON.stringify(sent.system) === JSON.stringify(mainSystem) && JSON.stringify(sent.tools) === JSON.stringify(tools));
	check("main's prefix is read at main's breakpoint", JSON.stringify(sent.messages[2].content[0].cache_control) === JSON.stringify({ type: "ephemeral", ttl: "1h" }));
	check("and the side question is the last message", userTexts(sent).at(-1).endsWith("warm question"));
	check("main's published request is untouched", rk.messages.length === 3 && rk.messages[2].content[0].cache_control.ttl === "1h");
	// Main switched models since it published: the old model's bytes are not the basis
	// of a request that goes out on the new one.
	forgetPingTargets("main-warm");
	publishPingTarget({ payload: rk, at: Date.now(), headers: {}, model: { ...model, id: "claude-main-before-the-switch" }, sessionId: "main-warm", registry: {}, record: () => {} });
	await s.commands.get("btw").handler("cold question", s.ctx);
	const coldBase = requests.length;
	await settled(s, coldBase + 1);
	check("after main switched models the side request is cold, not built on the old model's bytes",
		JSON.stringify(requests[coldBase].system) !== JSON.stringify(mainSystem) && JSON.stringify(requests[coldBase].tools) !== JSON.stringify(tools));
	forgetPingTargets("main-warm");
	await s.handlers.get("session_shutdown")({ type: "session_shutdown" }, s.ctx);
}

server.close();
await finish();
