import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const HOME = os.homedir();
const REPO = path.join(HOME, "dotfiles");
const SINK = fs.mkdtempSync(path.join(os.tmpdir(), "kit-bash-"));
process.env.PI_KIT_BACKGROUND_DIR = path.join(SINK, "background");

const lib = await jiti.import(`${ROOT}/lib/bash.ts`);
const {
	BASH_DEFAULT_TIMEOUT_SEC, BASH_MAX_TIMEOUT_SEC,
	BASH_DESCRIPTION, RUN_IN_BACKGROUND, BACKGROUND_NOTIFICATION, CHILD_REFUSAL,
	bashParams, resolveTimeoutSec, wantsBackground, backgroundDir, boundedTail,
	looksLikePrompt, backgroundedText, completionNotice, stallNotice, backgroundHint,
	exitCodeNotice, killedNotice, commandEnv,
} = lib;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Poll until `ready()` or the deadline; settling is a real process exit. */
const until = async (ready, ms = 5_000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await sleep(20);
	}
	return ready();
};
const alive = (pid) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};
const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "");
const thrown = async (promise) => {
	try { await promise; return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); }
};

// ---------------------------------------------------------------------------
console.log("bash: the numbers and the schema");
{
	check("the numbers are Claude Code's, deliberately", BASH_DEFAULT_TIMEOUT_SEC === 120 && BASH_MAX_TIMEOUT_SEC === 1800);
	check("the advertised-maximum constant is gone with the sentence that published it", lib.BASH_REQUESTABLE_TIMEOUT_SEC === undefined);
	check("an unbounded call gets the default", resolveTimeoutSec(undefined, 120) === 120 && resolveTimeoutSec(undefined, 1800) === 120);
	// A main seat backgrounds instead of killing, so `timeout` there is only a
	// hang detector: honoured downward, never upward.
	check("the main seat's ceiling is the default, so a long request buys nothing", resolveTimeoutSec(600, 120) === 120 && resolveTimeoutSec(30, 120) === 30);
	check("a subagent, which cannot background, keeps the long budget", resolveTimeoutSec(600, 1800) === 600);
	check("and nothing gets past its 30-minute ceiling", resolveTimeoutSec(3000, 1800) === 1800 && resolveTimeoutSec(86_400, 1800) === 1800);
	check("a nonsense timeout is an error the model can act on", [0, -5, Number.NaN, "60"].every((v) => { try { resolveTimeoutSec(v, 120); return false; } catch (e) { return /Invalid timeout/.test(e.message); } }));

	// One schema for every seat (map C4): the tools array is the front of the
	// cached prefix, so a seat-shaped variant of any tool costs a child the
	// parent's whole tools+system entry. What differs by seat is behaviour, and
	// the description says so rather than being rewritten per seat.
	check("there is one bash schema, and it carries run_in_background", bashParams.properties[RUN_IN_BACKGROUND]?.type === "boolean" && Object.keys(bashParams.properties).join(",") === `command,timeout,${RUN_IN_BACKGROUND}`);
	check("no per-seat schema variant survives", lib.bashParamsChild === undefined && lib.bashParamsMain === undefined && lib.BASH_DESCRIPTION_CHILD === undefined);
	check("the description tells both truths: a move on the main seat, a kill on a subagent's", BASH_DESCRIPTION.includes("moved to the background") && BASH_DESCRIPTION.includes("killed on a subagent seat") && BASH_DESCRIPTION.includes("default 120"));
	// The two false beliefs this text exists to kill: that a call bounds the
	// command, and that waiting for one means sleeping in the foreground.
	check("the description says a call does not bound the command", BASH_DESCRIPTION.includes("A call does not bound the command"));
	check("and no longer advertises a longer wait to ask for", !BASH_DESCRIPTION.includes("600") && !BASH_DESCRIPTION.includes("ask for longer") && !BASH_DESCRIPTION.includes("hard ceiling"));
	check("the background flag forbids `&` and forbids sleeping", lib.RUN_IN_BACKGROUND_DESCRIPTION.includes("No `&` or `nohup` needed") && lib.RUN_IN_BACKGROUND_DESCRIPTION.includes("Never sleep or poll") && lib.RUN_IN_BACKGROUND_DESCRIPTION.includes("keeps running across turns"));
	check("and no longer tells the model to wait in the foreground for what it needs", !lib.RUN_IN_BACKGROUND_DESCRIPTION.includes("do not need the result immediately"));
	check("and keeps pi's own opening", BASH_DESCRIPTION.startsWith("Execute a bash command in the current working directory.") && BASH_DESCRIPTION.includes("saved to a temp file"));
	check("the background flag says where it works", lib.RUN_IN_BACKGROUND_DESCRIPTION.includes("Main session only"));
	check("the timeout parameter says what it really is, per seat", bashParams.properties.timeout.description.startsWith("Seconds before the command leaves the foreground") && bashParams.properties.timeout.description.includes("at most 120, then it is backgrounded, not killed") && bashParams.properties.timeout.description.includes("max 1800"));
	check("only a literal true asks for the background", wantsBackground({ [RUN_IN_BACKGROUND]: true }) && !wantsBackground({ [RUN_IN_BACKGROUND]: "true" }) && !wantsBackground({}));
	check("the sink is under the kit's state dir, not /tmp by default", backgroundDir({}, "/home/x") === "/home/x/.local/state/pi-kit/background" && backgroundDir({ XDG_STATE_HOME: "/s" }, "/home/x") === "/s/pi-kit/background");
}

// ---------------------------------------------------------------------------
console.log("\nbash: the words");
{
	const task = { id: 4, command: "npm test", logPath: "/l/4.log" };
	const byTimeout = backgroundedText(task, "timeout", 120);
	check("a timeout says it was still running and moved", byTimeout.includes("Still running after 120s") && byTimeout.includes("task 4"));
	check("a user move says the user did it", backgroundedText(task, "user", 120).includes("by the user"));
	check("a requested start says it started", backgroundedText(task, "requested", 120).startsWith("Started in the background as task 4"));
	check("each names the log, the notification, and says not to wait", ["timeout", "user", "requested"].every((t) => { const s = backgroundedText(task, t, 120); return s.includes("/l/4.log") && s.includes("notified") && s.includes("Do not wait"); }));
	check("and says what to do instead of sleeping on it", ["timeout", "user", "requested"].every((t) => { const s = backgroundedText(task, t, 120); return s.includes("end your turn \u2014 the notification starts the next one") && s.includes("Never sleep or poll"); }));
	check("the orphan notice names the flag to use instead of detaching", lib.orphanNotice(2).includes("Left 2 processes running after the shell exited; killed") && lib.orphanNotice(2).includes("`run_in_background: true`") && lib.orphanNotice(1).includes("1 process running") && lib.orphanNotice(undefined).includes("process(es)"));

	const done = completionNotice({ ...task, exitCode: 0, signal: null, durationMs: 4200, tail: "ok" });
	check("the completion notice is the fielded shape", done.startsWith("<background-task-notification>") && done.includes("<status>Done</status>") && done.includes("<output>ok</output>") && done.includes("Full log at: /l/4.log"));
	check("a failure carries its exit code", completionNotice({ ...task, exitCode: 3, signal: null, durationMs: 1, tail: "" }).includes("<status>Failed (exit 3)</status>"));
	check("a signal is reported as a kill", completionNotice({ ...task, exitCode: null, signal: "SIGKILL", durationMs: 1, tail: "" }).includes("<status>Killed (SIGKILL)</status>"));
	check("no output is said, not left blank", completionNotice({ ...task, exitCode: 0, signal: null, durationMs: 1, tail: "" }).includes("<output>No output.</output>"));
	check("XML in output is escaped", completionNotice({ ...task, exitCode: 0, signal: null, durationMs: 1, tail: "<b>&" }).includes("&lt;b&gt;&amp;"));

	const stalled = stallNotice(task, "Overwrite? ", 4242);
	check("the stall notice names the prompt and the kill", stalled.includes("<status>Stalled</status>") && stalled.includes("waiting for interactive input") && stalled.includes("kill -- -4242") && stalled.includes("echo y | command"));

	check("the hint knows about tmux", backgroundHint({}) === "ctrl+b to background" && backgroundHint({ TMUX: "/tmp/x" }) === "ctrl+b ctrl+b to background");
	check("the refusal tells a subagent what to do instead", CHILD_REFUSAL.includes("Re-run this call without") && CHILD_REFUSAL.includes("`timeout`"));

	// The whole mitigation for the one thing the verdict rule gives up: the model
	// can no longer read failure off the colour, so the sentence has to carry it.
	const notice = exitCodeNotice(3);
	check("the exit notice leads with the number", notice.startsWith("Exit code: 3."));
	check("and says a failing build looks exactly like this", notice.includes("failing build") && notice.includes("search with no match") && notice.includes("read the output above"));
	check("the description states the rule before the first call", BASH_DESCRIPTION.includes("A non-zero exit code is reported in the result text, not as a failed call") && BASH_DESCRIPTION.includes("aborted, timed out, or the shell would not start"));
	// Both local oddities are fixed at the source now (the rm wrapper honours -f,
	// ripgrep is taught the types), so the description must not spend words on them.
	check("no machine-specific workarounds left in the description", !BASH_DESCRIPTION.includes("trash") && !BASH_DESCRIPTION.includes("/bin/rm") && !BASH_DESCRIPTION.includes("tsx"));
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "kit-home-"));
	fs.mkdirSync(path.join(fakeHome, ".config", "ripgrep"), { recursive: true });
	fs.writeFileSync(path.join(fakeHome, ".config", "ripgrep", "rc"), "--type-add=tsx:*.tsx\n");
	check("a spawned command is told where ripgrep's config is", commandEnv({ PATH: "/bin" }, fakeHome).RIPGREP_CONFIG_PATH === path.join(fakeHome, ".config/ripgrep/rc"));
	check("and an env that already names one is left alone", commandEnv({ RIPGREP_CONFIG_PATH: "/elsewhere/rc" }, fakeHome).RIPGREP_CONFIG_PATH === "/elsewhere/rc");
	check("a machine without the config file is not made to warn", commandEnv({ PATH: "/bin" }, path.join(fakeHome, "nope")).RIPGREP_CONFIG_PATH === undefined);
	check("the config file defines the two types rg lacks", ((rc) => rc.includes("--type-add=tsx:*.tsx") && rc.includes("--type-add=mjs:*.mjs"))(fs.readFileSync(path.join(ROOT, "..", "..", "ripgrep", "rc"), "utf8")));
}

// ---------------------------------------------------------------------------
console.log("\nbash: the log tail and the stall detector");
{
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	check("a long tail is bounded by lines", boundedTail(lines, false, 4000, 60).startsWith("[earlier output omitted") && boundedTail(lines, false, 4000, 60).endsWith("line 99"));
	check("a short tail is untouched", boundedTail("a\nb\n", false, 4000, 60) === "a\nb");
	check("a y/n prompt is a prompt", ["Continue? (y/n) ", "Proceed [Y/n]", "Are you sure you want to delete it? ", "Press Enter to continue", "Overwrite?"].every(looksLikePrompt));
	check("a progress line is not", ["Compiling 42/100", "Done in 3.2s\n", "Would you like fries with that. No."].every((t) => !looksLikePrompt(t)));
}

// ---------------------------------------------------------------------------
console.log("\nbash: the tool");

const mod = await jiti.import(`${ROOT}/extensions/bash.ts`);

/**
 * One extension instance, driven through the seams pi drives it through. Each
 * gets its own session id: task ids restart at 1 per instance, and the log path
 * is `<session>-<id>`, so a shared id would have two seats writing one file.
 */
let seats = 0;
function seat({ customPrompt, primed = true } = {}) {
	const handlers = new Map();
	const tools = [];
	const shortcuts = new Map();
	const renderers = new Map();
	const sent = [];
	const sessionId = `session-${++seats}`;
	const listeners = new Map();
	mod.default({
		on: (e, h) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		events: { on: (channel, h) => { listeners.set(channel, [...(listeners.get(channel) ?? []), h]); return () => {}; }, emit: (channel, data) => { for (const h of listeners.get(channel) ?? []) h(data); } },
		registerTool: (tool) => tools.push(tool),
		registerShortcut: (key, options) => shortcuts.set(key, options),
		registerMessageRenderer: (type, render) => renderers.set(type, render),
		sendMessage: (message, options) => sent.push({ message, options }),
	});
	const ctx = { cwd: REPO, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined } };
	// The seat is decided at turn start from the options *and* the engine's seat
	// seam, which is keyed by session id — so the handler needs the context.
	const fire = (e, event) => { for (const h of handlers.get(e) ?? []) h(event, ctx); };
	if (primed) fire("before_agent_start", { systemPromptOptions: { cwd: REPO, ...(customPrompt ? { customPrompt } : {}) } });
	const tool = () => tools[tools.length - 1];
	let calls = 0;
	return {
		sent, sessionId, tools, shortcuts, handlers, renderers,
		tool,
		run: (params, { signal, onUpdate } = {}) => tool().execute(`call-${++calls}`, params, signal, onUpdate, ctx),
		background: () => shortcuts.get("ctrl+b").handler({ ui: { notify: (m) => sent.push({ toast: m }) } }),
		shutdown: () => fire("session_shutdown", {}),
	};
}
const logsOf = (s) => fs.readdirSync(process.env.PI_KIT_BACKGROUND_DIR).filter((name) => name.startsWith(`${s.sessionId}-`));

{
	const s = seat();
	check("it registers bash, under the built-in's name", s.tools.length === 1 && s.tools[0].name === "bash");
	check("with the one schema and description", same(s.tools[0].parameters, bashParams) && s.tools[0].description === BASH_DESCRIPTION);
	check("and pi's prompt metadata, so the system prompt does not move", s.tools[0].promptSnippet === "Execute bash commands (ls, grep, find, etc.)" && s.tools[0].promptGuidelines?.[0]?.includes("PI_*"));
	check("ctrl+b is bound", s.shortcuts.has("ctrl+b"));
	check("it binds only its session scope's seams", [...s.handlers.keys()].sort().join(",") === "agent_settled,agent_start,before_agent_start,input,session_before_fork,session_before_switch,session_compact,session_compact_failed,session_shutdown", [...s.handlers.keys()].sort().join(","));

	const hi = await s.run({ command: "echo hi; echo err >&2" });
	check("an ordinary command returns its output", text(hi).includes("hi") && text(hi).includes("err"), text(hi));
	check("and leaves no log behind", logsOf(s).length === 0, logsOf(s).join(","));
	check("and sends no notification", s.sent.length === 0);
	check("a clean command carries no exit line", !text(hi).includes("Exit code"));
	check("a nonsense timeout is refused before anything runs", (await thrown(s.run({ command: "echo x", timeout: 0 })))?.includes("Invalid timeout") && logsOf(s).length === 0);
	check("cwd is the session's", text(await s.run({ command: "pwd" })).trim() === fs.realpathSync(REPO));

	const updates = [];
	const streamed = await s.run({ command: "echo one; sleep 0.25; echo two" }, { onUpdate: (u) => updates.push(text(u)) });
	check("output streams to pi's partial render while running", updates.some((u) => u.includes("one") && !u.includes("two")), JSON.stringify(updates));
	check("and the final result has all of it", text(streamed).includes("one") && text(streamed).includes("two"));
}

// ---------------------------------------------------------------------------
// issues/49. A non-zero exit is what the command concluded; `isError` is
// whether it ran. The four survey cases, then the three that must stay red.
console.log("\nbash: a non-zero exit is an answer, not a failed call");
{
	const s = seat();
	const ok = async (params) => {
		try { return await s.run(params); } catch (error) { return { threw: error instanceof Error ? error.message : String(error) }; }
	};

	const exited = await ok({ command: "echo out; exit 3" });
	check("a plain non-zero exit is a result, not a throw", exited.threw === undefined && !exited.isError, exited.threw);
	check("with the output and the code, in that order", text(exited).startsWith("out") && text(exited).endsWith(exitCodeNotice(3)), text(exited));

	// Class 9, the 21: a chain whose last segment is a probe answering "no".
	const chained = await ok({ command: "echo found it; ls /definitely/not/here 2>/dev/null" });
	check("a chain's answer survives its last link exiting non-zero", chained.threw === undefined && text(chained).includes("found it") && text(chained).includes("Exit code:"), text(chained) ?? chained.threw);

	// Class 2a, the 13: a search with no match. Exit 1 and nothing to show.
	const empty = await ok({ command: "grep zzzznomatch /dev/null" });
	check("an empty search is an answer with no output", empty.threw === undefined && text(empty) === `(no output)\n\n${exitCodeNotice(1)}`, text(empty) ?? empty.threw);

	// The genuine failures. Not red any more — so they have to be unmistakable.
	const missing = await ok({ command: "definitely-not-a-command" });
	check("command not found says so, and carries 127", missing.threw === undefined && /not found/.test(text(missing)) && text(missing).includes("Exit code: 127"), text(missing) ?? missing.threw);
	const denied = await ok({ command: "cat /etc/master.passwd" });
	check("permission denied says so, and carries its code", denied.threw === undefined && /denied/i.test(text(denied)) && text(denied).includes("Exit code:"), text(denied) ?? denied.threw);

	// A build that fails is the false pass this rule buys. It must still read as
	// a failure from the text alone, because nothing else says so any more.
	const build = await ok({ command: "echo 'FAIL 3 tests'; exit 1" });
	check("a failed build reads as failed from the text alone", text(build).includes("FAIL 3 tests") && text(build).includes("Exit code: 1") && text(build).includes("not a harness failure"), text(build));

	// Truncation details survive the non-zero path: the code is taken from the
	// settled run rather than scraped back out of pi's thrown message.
	const big = await ok({ command: "seq 1 5000; exit 2" });
	check("a truncated non-zero result keeps pi's details and its temp file", big.details?.fullOutputPath !== undefined && text(big).includes("Full output:") && text(big).endsWith(exitCodeNotice(2)), JSON.stringify(big.details));

	// pi reads a signal death as `undefined` and returns it as a clean success,
	// so an out-of-memory kill used to arrive as an empty green result.
	const killed = await ok({ command: "echo half; kill -9 $$" });
	check("a kill says it was killed instead of passing silently", killed.threw === undefined && text(killed).includes("half") && text(killed).endsWith(killedNotice("SIGKILL")), text(killed) ?? killed.threw);
	check("and the notice says nothing above is a verdict", killedNotice("SIGKILL").includes("did not finish"));

	// Still red: the tool did not do its job.
	const c = seat({ customPrompt: "You are a worker." });
	check("a subagent's timeout is still an error", (await thrown(c.run({ command: "sleep 5", timeout: 0.2 })))?.includes("Command timed out"));
	const a = seat();
	const controller = new AbortController();
	const pending = a.run({ command: "echo x; sleep 5" }, { signal: controller.signal });
	await sleep(100);
	controller.abort();
	check("an aborted command is still an error", (await thrown(pending))?.includes("Command aborted"));
}

// ---------------------------------------------------------------------------
console.log("\nbash: the timeout is a move, not a kill");
{
	const s = seat();
	const t0 = Date.now();
	const result = await s.run({ command: "echo start; sleep 0.8; echo later", timeout: 0.3 });
	const took = Date.now() - t0;
	check("the call returns at the timeout", took < 700, `${took}ms`);
	check("with the output so far", text(result).includes("start") && !text(result).includes("later"), text(result));
	check("and the move sentence", text(result).includes("Still running after 0.3s") && text(result).includes("task 1"), text(result));
	check("and no exit line, because it has not exited", !text(result).includes("Exit code:"), text(result));
	const logPath = /(\S+\.log)/.exec(text(result))?.[1];
	check("naming a log that exists", logPath !== undefined && fs.existsSync(logPath), text(result));
	check("the log is 0600 — command output is as sensitive as the command", (fs.statSync(logPath).mode & 0o777) === 0o600);
	check("the process is still running", s.sent.length === 0);

	const settled = await until(() => s.sent.length > 0);
	check("the completion notification arrives when it exits", settled, JSON.stringify(s.sent));
	const { message, options } = s.sent[0] ?? { message: {}, options: {} };
	check("it is delivered as a follow-up that triggers a turn", options?.deliverAs === "followUp" && options?.triggerTurn === true, JSON.stringify(options));
	check("it is its own custom type, with its own renderer", message.customType === BACKGROUND_NOTIFICATION);
	check("it is displayed", message.display === true);
	check("it carries the exit code", message.content?.includes("<status>Done</status>") && message.details?.exitCode === 0, message.content);
	check("the tail has the output after the move", message.content.includes("later"), message.content);
	check("and the log has all of it", fs.readFileSync(logPath, "utf8") === "start\nlater\n", JSON.stringify(fs.readFileSync(logPath, "utf8")));
	check("the details carry the command and the id", message.details?.command === "echo start; sleep 0.8; echo later" && message.details?.id === 1);
}

// Before the seat's first user turn the session scope refuses a turn: the
// notice is appended, and the model reads it when that turn comes.
console.log("\nbash: a notice before the first turn is appended, not a turn");
{
	const s = seat({ primed: false });
	await s.run({ command: "echo early", run_in_background: true });
	const settled = await until(() => s.sent.length > 0);
	const { message, options } = s.sent[0] ?? { message: {}, options: {} };
	check("it arrives, without a turn", settled && message.customType === BACKGROUND_NOTIFICATION && options?.triggerTurn === false && options?.deliverAs === undefined, JSON.stringify(options));
}

// ---------------------------------------------------------------------------
// One component for both notices, as Claude Code does it: the notice used to
// draw its own `<background-task-notification>` XML in pi's box (issues/31 (b)).
console.log("\nbash: one row for both notices");
{
	const s = seat();
	const render = s.renderers.get(BACKGROUND_NOTIFICATION);
	const draw = (details, expanded = false) => {
		const component = render({ details }, { expanded }, themeModule.theme);
		return component === undefined ? [] : component.render(80).map(plain).filter((line) => line !== "");
	};
	check("the notice type has a renderer", typeof render === "function");
	const finished = { id: 4, command: "npm test", exitCode: 0, signal: null, logPath: "/l/4.log", durationMs: 12_300 };
	const done = draw(finished);
	check("a finished command is a header and one line", done.length === 2 && done[0] === "● Bash(npm test)" && done[1] === "  ⎿  Done · task 4 · 12.3s", JSON.stringify(done));
	const failed = draw({ ...finished, id: 5, exitCode: 3 });
	check("a failure carries its exit code", failed.some((line) => line.includes("Failed (exit 3) · task 5")), JSON.stringify(failed));
	const killed = draw({ ...finished, id: 6, exitCode: null, signal: "SIGKILL" });
	check("a signal is reported as a kill", killed.some((line) => line.includes("Killed (SIGKILL)")), JSON.stringify(killed));
	const stalled = draw({ id: 7, command: "rm -i x", logPath: "/l/7.log", stalled: true });
	check("a stall is the same two lines, and not painted as a failure", stalled.length === 2 && stalled[0] === "● Bash(rm -i x)" && stalled[1] === "  ⎿  Waiting for input · task 7", JSON.stringify(stalled));
	check("no XML reaches the screen", ![...done, ...failed, ...stalled].some((line) => line.includes("<background-task-notification>")));
	check("ctrl+o says where the output went", draw(finished, true).some((line) => line.includes("/l/4.log")), JSON.stringify(draw(finished, true)));
	check("a notice with no details falls back to pi", render({}, { expanded: false }, themeModule.theme) === undefined);
}

// ---------------------------------------------------------------------------
console.log("\nbash: run_in_background, and ctrl+b");
{
	const s = seat();
	const started = await s.run({ command: "sleep 0.2; echo done", [RUN_IN_BACKGROUND]: true });
	check("a requested background call returns at once", text(started).includes("Started in the background as task 1"), text(started));
	check("as a normal result, not an error", !started.isError);
	check("and with no exit line — it has not exited", !text(started).includes("Exit code:"), text(started));
	await until(() => s.sent.length > 0);
	check("and settles with its output", s.sent[0]?.message.content.includes("<output>done</output>"), JSON.stringify(s.sent));

	check("a failing background command reports its exit code", await (async () => {
		const f = seat();
		await f.run({ command: "exit 3", [RUN_IN_BACKGROUND]: true });
		await until(() => f.sent.length > 0);
		return f.sent[0]?.message.content.includes("<status>Failed (exit 3)</status>");
	})());

	const u = seat();
	check("ctrl+b with nothing running says so", (u.background(), u.sent.pop()?.toast?.includes("nothing is running")));
	const pending = u.run({ command: "echo before; sleep 0.6; echo after", timeout: 10 });
	await sleep(150);
	u.background();
	check("ctrl+b reports the move", u.sent.pop()?.toast?.includes("1 command moved"));
	const moved = await pending;
	check("the foreground call resolves with the output so far", text(moved).includes("before") && !text(moved).includes("after"), text(moved));
	check("and says the user moved it", text(moved).includes("Moved to the background by the user"), text(moved));
	await until(() => u.sent.some((x) => x.message));
	check("its exit is still delivered", u.sent.find((x) => x.message)?.message.content.includes("after"), JSON.stringify(u.sent));
}

// ---------------------------------------------------------------------------
// Work the model detaches itself runs outside the mechanism that would notify
// it, and used to survive the session entirely.
console.log("\nbash: what the shell leaves behind");
{
	// The production window is a second of polling; a test that waited it out
	// would pay it per case.
	process.env.PI_KIT_ORPHAN_CONFIRM_MS = "150";
	const s = seat();
	const t0 = Date.now();
	const detached = await s.run({ command: "nohup sleep 30 >/dev/null 2>&1 & echo $!" });
	check("a detached command still returns promptly", Date.now() - t0 < 2_000, `${Date.now() - t0}ms`);
	check("the result says what was left behind and killed", /Left \d+ process(es)? running after the shell exited; killed\./.test(text(detached)), text(detached));
	check("and names the flag to use instead", text(detached).includes("`run_in_background: true`"), text(detached));
	const orphan = Number(text(detached).split("\n")[0]);
	check("the process it left is dead", Number.isFinite(orphan) && (await until(() => !alive(orphan))), String(orphan));

	const clean = await s.run({ command: "echo tidy" });
	check("a command that leaves nothing behind says nothing", text(clean).trim() === "tidy", JSON.stringify(text(clean)));

	const b = seat();
	await b.run({ command: "nohup sleep 30 >/dev/null 2>&1 &", [RUN_IN_BACKGROUND]: true });
	await until(() => b.sent.length > 0);
	check("a backgrounded call's notification carries the same line", /Left \d+ process(es)? running/.test(b.sent[0]?.message.content ?? ""), JSON.stringify(b.sent[0]?.message.content));
	delete process.env.PI_KIT_ORPHAN_CONFIRM_MS;
}

// ---------------------------------------------------------------------------
console.log("\nbash: abort, shutdown, and what may not be backgrounded");
{
	const s = seat();
	const controller = new AbortController();
	const pending = s.run({ command: "sleep 5" }, { signal: controller.signal });
	await sleep(100);
	controller.abort();
	check("Esc still kills a foreground command", (await thrown(pending))?.includes("Command aborted"));
	check("and no notification follows", (await sleep(250), s.sent.length === 0));

	const k = seat();
	const bg = await k.run({ command: "echo $$; sleep 30", [RUN_IN_BACKGROUND]: true });
	const logPath = /(\S+\.log)/.exec(text(bg))?.[1];
	await until(() => fs.readFileSync(logPath, "utf8").trim() !== "");
	const pid = Number(fs.readFileSync(logPath, "utf8").trim());
	check("a background process is alive until shutdown", alive(pid));
	k.shutdown();
	check("and dead after it", await until(() => !alive(pid)));
	check("with no notification for a kill the session asked for", (await sleep(250), k.sent.length === 0));

	const c = seat({ customPrompt: "You are a worker." });
	check("a child seat registers the identical tool — one array on every seat", c.tools.length === 1 && JSON.stringify(c.tool()?.parameters) === JSON.stringify(bashParams) && c.tool().description === BASH_DESCRIPTION);
	check("a subagent's timeout is a kill, in pi's words", (await thrown(c.run({ command: "sleep 5", timeout: 0.2 })))?.includes("Command timed out after 0.2 seconds"));
	check("a subagent asking for the background is refused", (await thrown(c.run({ command: "sleep 5", [RUN_IN_BACKGROUND]: true }))) === CHILD_REFUSAL);
	check("and nothing was spawned or notified for it", c.sent.length === 0 && logsOf(c).length === 0);
	check("a subagent's ordinary bash works", text(await c.run({ command: "echo hi" })).includes("hi"));
	check("a main seat is registered once — the seat does not flap", seat().tools.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
