/**
 * The bash tool (extensions/bash/): real processes through pi's own bash
 * definition — the verdict, the move to the background, notices, orphans,
 * abort, shutdown, and the child seat.
 */

import { check, finish } from "../support/check-harness.mjs";
import { loadPerCore, sleep, until } from "../support/async-waits.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { KIT_ROOT, REPO_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const themeModule = await importPi("dist/modes/interactive/theme/theme.js");
themeModule.initTheme("dark", false);

const jiti = kitJiti({ moduleCache: false });

const SINK = fs.mkdtempSync(path.join(os.tmpdir(), "kit-bash-"));
process.env.PI_KIT_BACKGROUND_DIR = path.join(SINK, "background");

// A command that must still be running at some point blocks on a gate the test
// opens, not on a `sleep` a loaded machine can outlast.
let gates = 0;
/** A shell wait (`gate.shell`) that ends once the test calls `gate.open()`. */
function gate() {
	const file = path.join(SINK, `gate-${++gates}`);
	return { shell: `until [ -e ${file} ]; do sleep 0.02; done`, open: () => fs.writeFileSync(file, "") };
}

const { BASH_DESCRIPTION, RUN_IN_BACKGROUND, bashParams } = await jiti.import(`${KIT_ROOT}/lib/tools/bash-tool.ts`);
const { ENDED_WITH_SESSION_NOTICE, UNATTENDED_REFUSAL, exitCodeNotice, killedNotice } = await jiti.import(`${KIT_ROOT}/lib/tools/bash-result-notices.ts`);
const { BACKGROUND_NOTIFICATION } = await jiti.import(`${KIT_ROOT}/lib/tools/background-task-notification.ts`);
const { declareChildSeat } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
const { backgroundTasksOf, endBackgroundTasksOf, heldLogPaths, readBackgroundTask, stopBackgroundTask } = await jiti.import(`${KIT_ROOT}/lib/tools/background-tasks.ts`);

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
console.log("bash: the tool");

const mod = await jiti.import(`${KIT_ROOT}/extensions/bash/index.ts`);

/**
 * One extension instance, driven through the seams pi drives it through. Each
 * gets its own session id: task ids restart at 1 per instance, and the log path
 * is `<session>-<id>`, so a shared id would have two seats writing one file.
 */
let seats = 0;
function seat({ customPrompt, mode = "tui", agent = false, primed = true, sessionId = `session-${++seats}` } = {}) {
	// An array, not the fake's by-name map: a second registration of `bash` must show.
	const tools = [];
	const sent = [];
	let refusing = 0;
	let refusals = 0;
	const pi = fakeExtensionApi({
		registerTool: (tool) => tools.push(tool),
		sendMessage: (message, options) => {
			if (refusing > 0) {
				refusing--;
				refusals++;
				throw new Error("the session is gone");
			}
			sent.push({ message, options });
		},
	});
	if (agent) declareChildSeat(sessionId, { name: sessionId, role: "worker", depth: 1, parentSessionId: "parent", workflowChild: false, workflows: false, prompt: { kind: "inherit" }, ...(agent === true ? { receivesTaskNotices: true } : {}) });
	mod.default(pi.api);
	const ctx = { mode, cwd: REPO_ROOT, isIdle: () => true, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined } };
	// The seat is decided at turn start from the options *and* the engine's seat
	// seam, which is keyed by session id — so the handler needs the context.
	// Synchronous, unlike the fake's `fire`: a call made right after `seat()` must see the seat.
	const fire = (e, event) => { for (const h of pi.handlers.get(e) ?? []) h(event, ctx); };
	if (primed) fire("before_agent_start", { systemPromptOptions: { cwd: REPO_ROOT, ...(customPrompt ? { customPrompt } : {}) } });
	const tool = () => tools[tools.length - 1];
	let calls = 0;
	return {
		sent, sessionId, tools, shortcuts: pi.shortcuts, handlers: pi.handlers, renderers: pi.messageRenderers,
		tool,
		run: (params, { signal, onUpdate } = {}) => tool().execute(`call-${++calls}`, params, signal, onUpdate, ctx),
		background: () => pi.shortcuts.get("ctrl+b").handler({ ui: { notify: (m) => sent.push({ toast: m }) } }),
		shutdown: (reason) => fire("session_shutdown", { reason }),
		start: (reason) => fire("session_start", { reason }),
		agentStart: () => fire("agent_start", {}),
		refuseNextSend: () => {
			refusing++;
		},
		refusals: () => refusals,
		deliver: (message) => fire("message_end", { message: { role: "custom", ...message } }),
	};
}
const logsOf = (s) => fs.readdirSync(process.env.PI_KIT_BACKGROUND_DIR).filter((name) => name.startsWith(`${s.sessionId}-`));

{
	const s = seat();
	check("it registers bash, under the built-in's name", s.tools.length === 1 && s.tools[0].name === "bash");
	check("with the one schema and description", same(s.tools[0].parameters, bashParams) && s.tools[0].description === BASH_DESCRIPTION);
	check("and no prompt snippet, since the owned prompt never renders one", s.tools[0].promptSnippet === undefined && s.tools[0].promptGuidelines?.[0]?.includes("PI_*"));
	check("ctrl+b is bound", s.shortcuts.has("ctrl+b"));
	check("it binds its session scope's seams and the notice's delivery", [...s.handlers.keys()].sort().join(",") === "agent_settled,agent_start,before_agent_start,input,message_end,session_before_fork,session_before_switch,session_compact,session_compact_failed,session_shutdown,session_start", [...s.handlers.keys()].sort().join(","));

	const hi = await s.run({ command: "echo hi; echo err >&2" });
	check("an ordinary command returns its output", text(hi).includes("hi") && text(hi).includes("err"), text(hi));
	check("and leaves no log behind", logsOf(s).length === 0, logsOf(s).join(","));
	check("and sends no notification", s.sent.length === 0);
	check("a clean command carries no exit line", !text(hi).includes("Exit code"));
	check("a nonsense timeout is refused before anything runs", (await thrown(s.run({ command: "echo x", timeout: 0 })))?.includes("Invalid timeout") && logsOf(s).length === 0);
	const niceness = text(await s.run({ command: "ps -o nice= -p $$" })).trim();
	check("a command runs at nice +10, not background QoS", Number(niceness) === Math.min(20, os.getPriority() + 10), niceness);
	check("cwd is the session's", text(await s.run({ command: "pwd" })).trim() === fs.realpathSync(REPO_ROOT));

	const updates = [];
	const between = gate();
	const streaming = s.run({ command: `echo one; ${between.shell}; echo two` }, { onUpdate: (u) => updates.push(text(u)) });
	await until(() => updates.some((u) => u.includes("one")));
	between.open();
	const streamed = await streaming;
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

	// The code is taken from the settled run rather than scraped back out of pi's
	// thrown message, so a long failing result still ends on it.
	const big = await ok({ command: "seq 1 5000; exit 2" });
	check("a long non-zero result is cut and still ends on its code", text(big).includes("characters truncated") && text(big).endsWith(exitCodeNotice(2)), text(big).slice(-400));

	// pi reads a signal death as `undefined` and returns it as a clean success,
	// so an out-of-memory kill used to arrive as an empty green result.
	const killed = await ok({ command: "echo half; kill -9 $$" });
	check("a kill says it was killed instead of passing silently", killed.threw === undefined && text(killed).includes("half") && text(killed).endsWith(killedNotice("SIGKILL")), text(killed) ?? killed.threw);
	check("and the notice says nothing above is a verdict", killedNotice("SIGKILL").includes("did not finish"));

	// Headless runs shut the runtime down when the prompt ends, so nothing backgrounded survives to be notified.
	for (const mode of ["print", "json"]) {
		const h = seat({ mode });
		const slow = await thrown(h.run({ command: "sleep 5", timeout: 0.2 }));
		check(`a ${mode} run kills a long command at its timeout, and says so`, slow?.includes("Command timed out"), slow);
		check(`a ${mode} run refuses run_in_background`, (await thrown(h.run({ command: "sleep 5", [RUN_IN_BACKGROUND]: true }))) === UNATTENDED_REFUSAL);
		const left = await h.run({ command: "sleep 30 & echo $!" });
		const leftPid = Number(text(left).split("\n")[0]);
		check(`a ${mode} run kills what the shell left and names it`, /Left \d+ process(es)? running after the shell exited; killed/.test(text(left)) && await until(() => !alive(leftPid), 5_000, 20), text(left));
	}

	// Still red: the tool did not do its job.
	const c = seat({ customPrompt: "You are a worker." });
	check("a subagent's timeout is still an error", (await thrown(c.run({ command: "sleep 5", timeout: 0.2 })))?.includes("Command timed out"));
	const a = seat();
	const controller = new AbortController();
	const pending = a.run({ command: "echo x; sleep 5" }, { signal: controller.signal });
	// The log is opened just before the spawn, so its existence means the process is running.
	await until(() => logsOf(a).length > 0);
	controller.abort();
	check("an aborted command is still an error", (await thrown(pending))?.includes("Command aborted"));
}

// ---------------------------------------------------------------------------
// Claude Code 2.1.282: 30,000 characters inline; past that a successful command
// is saved to a file with a 2,000-character preview, and a failing one keeps its
// first and last 5,000 characters.
console.log("\nbash: output is cut as Claude Code cuts it");
{
	const s = seat();
	const seq = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join("\n") + "\n";

	const manyLines = await s.run({ command: "seq 1 3000" });
	check("3,000 lines under 30,000 characters come back whole, where pi cut them to 2,000", text(manyLines) === seq(1, 3000), text(manyLines).slice(-200));
	check("and leave no file behind", logsOf(s).length === 0 && manyLines.details === undefined, logsOf(s).join(","));

	const long = await s.run({ command: "seq 1 7000" });
	const saved = /Full output saved to: (\S+)/.exec(text(long))?.[1];
	check("a successful command past 30,000 characters is Claude Code's persisted-output block", /^<persisted-output>\nOutput too large \(33\.1KB\)\. Full output saved to: \S+\nPreview \(first 2\.0KB\):\n1\n2\n[\s\S]*\n\.\.\.\n<\/persisted-output>$/.test(text(long)), text(long).slice(0, 200));
	check("the file it names holds every line, under the kit's log directory", saved !== undefined && saved.startsWith(process.env.PI_KIT_BACKGROUND_DIR) && fs.readFileSync(saved, "utf8") === seq(1, 7000));
	const preview = text(long).split("\n").slice(3, -2);
	check("the preview is at most 2,000 characters and ends on a whole line", preview.join("\n").length <= 2_000 && preview.at(-1) === String(Number(preview.at(-2)) + 1), preview.slice(-2).join(","));
	check("the result's details name the saved file, not pi's temp file", long.details?.fullOutputPath === saved && long.details.truncation === undefined, JSON.stringify(long.details));

	const failedLong = await s.run({ command: "seq 1 7000; exit 1" });
	const excerpt = text(failedLong);
	const failedSaved = /Full output saved to: (\S+)/.exec(excerpt)?.[1];
	check("a failing command keeps its first and last 5,000 characters and the count between", excerpt.startsWith(seq(1, 1400).slice(0, 5_000)) && excerpt.includes(`\n\n... [23893 characters truncated] ...\n\n${seq(1, 7000).slice(-5_000)}`), excerpt.slice(4_990, 5_060));
	check("then the saved file's path, then its exit code", failedSaved !== undefined && fs.readFileSync(failedSaved, "utf8") === seq(1, 7000) && excerpt.endsWith(`Full output saved to: ${failedSaved}\n\n${exitCodeNotice(1)}`), excerpt.slice(-300));
	const failedShort = await s.run({ command: "seq 1 2000; exit 1" });
	check("a failing command within 11,024 characters comes back whole", text(failedShort) === `${seq(1, 2000).trimEnd()}\n\n${exitCodeNotice(1)}`, text(failedShort).slice(-200));

	const huge = await s.run({ command: "yes abcdefghi | head -c 3000000" });
	const hugeSaved = /Full output saved to: (\S+)/.exec(text(huge))?.[1];
	check("a 3 MB output is measured and previewed without being held whole", text(huge).includes("Output too large (2.9MB)") && hugeSaved !== undefined && fs.statSync(hugeSaved).size === 3_000_000, text(huge).slice(0, 160));
	check("only the saved outputs stay on disk", logsOf(s).length === 3, logsOf(s).join(","));
}

// A command that floods stdout leaves at most the bound on disk, in the kit's log and in pi's temp file, while it still runs.
console.log("\nbash: a flood of output is bounded on disk");
{
	const { LOG_MAX_BYTES } = await jiti.import(`${KIT_ROOT}/lib/tools/bounded-log.ts`);
	const s = seat();
	const started = Date.now();
	const piTempFiles = () => fs.readdirSync(os.tmpdir()).filter((name) => /^pi-bash-.*\.log$/.test(name)).map((name) => path.join(os.tmpdir(), name)).filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs >= started);
	const held = gate();
	const running = s.run({ command: `head -c 150000000 /dev/zero | tr '\\0' 'x' | fold -w 99; echo flooded; ${held.shell}`, timeout: 1 });
	await sleep(3_000 * loadPerCore());
	const kitLog = logsOf(s).map((name) => path.join(process.env.PI_KIT_BACKGROUND_DIR, name));
	const kitBytes = kitLog.reduce((sum, file) => sum + fs.statSync(file).size, 0);
	const piBytes = piTempFiles().reduce((sum, file) => sum + fs.statSync(file).size, 0);
	check(`while it runs, the kit's log holds at most ${LOG_MAX_BYTES} bytes (${kitBytes})`, kitLog.length === 1 && kitBytes <= LOG_MAX_BYTES, String(kitBytes));
	check(`and the two files together stay under 32 MiB (${kitBytes + piBytes})`, kitBytes + piBytes <= 32 * 1024 * 1024, `kit ${kitBytes} pi ${piBytes}`);
	held.open();
	await running;
	s.shutdown();
}

// ---------------------------------------------------------------------------
console.log("\nbash: the timeout is a move, not a kill");
{
	const s = seat();
	const held = gate();
	const command = `echo start; ${held.shell}; echo later`;
	const t0 = Date.now();
	const result = await Promise.race([s.run({ command, timeout: 0.3 }), sleep(10_000 * loadPerCore()).then(() => undefined)]);
	const took = Date.now() - t0;
	check("the call returns at the timeout", result !== undefined, `${result === undefined ? "no return" : "returned"} after ${took}ms`);
	check("with the output so far", text(result).includes("start") && !text(result).includes("later"), text(result));
	check("and the move sentence", text(result).includes("Still running after 0.3s") && text(result).includes("task 1"), text(result));
	check("and no exit line, because it has not exited", !text(result).includes("Exit code:"), text(result));
	const logPath = /(\S+\.log)/.exec(text(result))?.[1];
	check("naming a log that exists", logPath !== undefined && fs.existsSync(logPath), text(result));
	check("the log is 0600 — command output is as sensitive as the command", (fs.statSync(logPath).mode & 0o777) === 0o600);
	check("the process is still running", s.sent.length === 0);
	held.open();

	const settled = await until(() => s.sent.length > 0, 5_000, 20);
	check("the completion notification arrives when it exits", settled, JSON.stringify(s.sent));
	const { message, options } = s.sent[0] ?? { message: {}, options: {} };
	check("it is steered, triggering a turn: a busy seat reads it at its next step", options?.deliverAs === "steer" && options?.triggerTurn === true, JSON.stringify(options));
	check("it is its own custom type, with its own renderer", message.customType === BACKGROUND_NOTIFICATION);
	check("it is displayed", message.display === true);
	check("it carries the exit code", message.content?.includes("<status>Done</status>") && message.details?.exitCode === 0, message.content);
	check("the tail has the output after the move", message.content.includes("later"), message.content);
	check("and the log has all of it", fs.readFileSync(logPath, "utf8") === "start\nlater\n", JSON.stringify(fs.readFileSync(logPath, "utf8")));
	check("the details carry the command and the id", message.details?.command === command && message.details?.id === 1);
}

// Before the seat's first user turn the session scope refuses a turn: the
// notice is appended, and the model reads it when that turn comes.
console.log("\nbash: a notice before the first turn is appended, not a turn");
{
	const s = seat({ primed: false });
	await s.run({ command: "echo early", run_in_background: true });
	const settled = await until(() => s.sent.length > 0, 5_000, 20);
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
	await until(() => s.sent.length > 0, 5_000, 20);
	check("and settles with its output", s.sent[0]?.message.content.includes("<output>done</output>"), JSON.stringify(s.sent));

	check("a failing background command reports its exit code", await (async () => {
		const f = seat();
		await f.run({ command: "exit 3", [RUN_IN_BACKGROUND]: true });
		await until(() => f.sent.length > 0, 5_000, 20);
		return f.sent[0]?.message.content.includes("<status>Failed (exit 3)</status>");
	})());

	const u = seat();
	check("ctrl+b with nothing running says so", (u.background(), u.sent.pop()?.toast?.includes("nothing is running")));
	const moving = gate();
	const early = [];
	const pending = u.run({ command: `echo before; ${moving.shell}; echo after`, timeout: 10 }, { onUpdate: (update) => early.push(text(update)) });
	await until(() => early.some((update) => update.includes("before")));
	u.background();
	check("ctrl+b reports the move", u.sent.pop()?.toast?.includes("1 command moved"));
	const moved = await pending;
	check("the foreground call resolves with the output so far", text(moved).includes("before") && !text(moved).includes("after"), text(moved));
	check("and says the user moved it", text(moved).includes("Moved to the background by the user"), text(moved));
	moving.open();
	await until(() => u.sent.some((x) => x.message), 5_000, 20);
	check("its exit is still delivered", u.sent.find((x) => x.message)?.message.content.includes("after"), JSON.stringify(u.sent));
}

// ---------------------------------------------------------------------------
// Work the model detaches itself (`&`, `nohup`, a subshell) is what it believes
// it is: still running, a background task it is told about, notified when the
// last process ends, and killed with the session. Unit 51: 48 cases in Oct 5-8
// where the kit killed it at the shell's exit and the agent read on as if it ran.
console.log("\nbash: what the shell leaves behind");
{
	// The production window is a second of polling; a test that waited it out
	// would pay it per case.
	process.env.PI_KIT_ORPHAN_CONFIRM_MS = "150";
	const s = seat();
	const t0 = Date.now();
	const detached = await s.run({ command: "nohup sleep 30 >/dev/null 2>&1 & echo $!" });
	check("a detached command still returns promptly", Date.now() - t0 < 2_000 * loadPerCore(), `${Date.now() - t0}ms`);
	const orphan = Number(text(detached).split("\n")[0]);
	check("the process it left is still running", Number.isFinite(orphan) && (await sleep(300), alive(orphan)), text(detached));
	check("and the result says so, as a background task", text(detached).includes("left processes running") && text(detached).includes("background task 1") && !text(detached).includes("killed"), text(detached));
	check("with no notification while it runs", s.sent.length === 0);
	try { process.kill(orphan, "SIGTERM"); } catch {}
	check("its end is notified once the last process is gone", await until(() => s.sent.length > 0, 5_000, 20) && s.sent[0].message.content.includes("<task-id>1</task-id>") && s.sent[0].message.content.includes("left running"), JSON.stringify(s.sent));

	const clean = await s.run({ command: "echo tidy" });
	check("a command that leaves nothing behind says nothing", text(clean).trim() === "tidy", JSON.stringify(text(clean)));

	// A dev server started with `&`, and a later call that uses it.
	const port = 20_000 + (process.pid % 20_000);
	const served = await s.run({ command: `node -e "require('http').createServer((q, r) => r.end('up')).listen(${port})" & echo $!; sleep 0.5; echo started` });
	const server = Number(text(served).split("\n")[0]);
	check("a server started with & is a background task", text(served).includes("started") && text(served).includes("background task"), text(served));
	const used = await s.run({ command: `curl -s localhost:${port}` });
	check("and a later call can use it", text(used).trim() === "up", text(used));
	s.shutdown("reload");
	check("session shutdown kills it", await until(() => !alive(server), 5_000, 20), String(server));
	const after = seat({ sessionId: s.sessionId, primed: false });
	after.start("reload");
	check("as a task the session's end killed", after.sent.some((x) => x.message?.content.includes(ENDED_WITH_SESSION_NOTICE)), JSON.stringify(after.sent));

	// A process left behind that keeps writing to the pipe must not hold the call open.
	const chatty = seat();
	const t1 = Date.now();
	const loud = await chatty.run({ command: "(while :; do echo x; sleep 0.02; done) & echo $!", timeout: 30 });
	check("a chatty process left behind does not hold the call", Date.now() - t1 < 3_000 * loadPerCore() && text(loud).includes("background task"), `${Date.now() - t1}ms ${text(loud).slice(-300)}`);
	chatty.shutdown();

	const b = seat();
	const before = Date.now();
	await b.run({ command: "sleep 0.6 & echo shell done", [RUN_IN_BACKGROUND]: true });
	await until(() => b.sent.length > 0, 5_000, 20);
	check("a background call is not done until what its shell left is done", Date.now() - before >= 550 && b.sent[0]?.message.content.includes("<status>Done</status>") && b.sent[0]?.message.content.includes("left running"), JSON.stringify(b.sent[0]?.message.content));

	const stopped = seat();
	const leftover = await stopped.run({ command: "sleep 30 & echo $!" });
	const leftPid = Number(text(leftover).split("\n")[0]);
	check("TaskStop on a leftover process group is notified as Killed", leftover && stopBackgroundTask(stopped.sessionId, 1) !== undefined && await until(() => stopped.sent.length > 0, 5_000, 20) && stopped.sent[0].message.content.includes("<status>Killed (SIGKILL)</status>") && stopped.sent[0].message.details.signal === "SIGKILL" && !alive(leftPid), JSON.stringify(stopped.sent));

	const u = seat({ customPrompt: "You are a worker." });
	const unattended = await u.run({ command: "nohup sleep 30 >/dev/null 2>&1 & echo $!" });
	const lost = Number(text(unattended).split("\n")[0]);
	check("an unattended child, which nobody waits on, still kills what its shell left", /Left \d+ process(es)? running after the shell exited; killed/.test(text(unattended)) && await until(() => !alive(lost), 5_000, 20), text(unattended));
	check("and does not offer it a background it may not use", !text(unattended).includes("run_in_background"), text(unattended));
	delete process.env.PI_KIT_ORPHAN_CONFIRM_MS;
}

// ---------------------------------------------------------------------------
console.log("\nbash: abort, shutdown, and what may not be backgrounded");
{
	const s = seat();
	const controller = new AbortController();
	const pending = s.run({ command: "sleep 5" }, { signal: controller.signal });
	await until(() => logsOf(s).length > 0);
	controller.abort();
	check("Esc still kills a foreground command", (await thrown(pending))?.includes("Command aborted"));
	check("and no notification follows", (await sleep(250), s.sent.length === 0));

	const k = seat();
	const bg = await k.run({ command: "echo $$; sleep 30", [RUN_IN_BACKGROUND]: true });
	const logPath = /(\S+\.log)/.exec(text(bg))?.[1];
	await until(() => fs.readFileSync(logPath, "utf8").trim() !== "", 5_000, 20);
	const pid = Number(fs.readFileSync(logPath, "utf8").trim());
	check("a background process is alive until shutdown", alive(pid));
	k.shutdown();
	check("and dead after it", await until(() => !alive(pid), 5_000, 20));
	check("with no notification for a kill the session asked for", (await sleep(250), k.sent.length === 0));

	const r = seat();
	await r.run({ command: "sleep 30", [RUN_IN_BACKGROUND]: true });
	r.shutdown("reload");
	const reloaded = seat({ sessionId: r.sessionId, primed: false });
	check("a reload says nothing until the session's next runtime starts", reloaded.sent.length === 0 && r.sent.length === 0);
	reloaded.start("reload");
	const ended = reloaded.sent[0]?.message;
	check("which reports the task the reload killed", reloaded.sent.length === 1 && ended.customType === BACKGROUND_NOTIFICATION && ended.content.includes("<status>Exit status unknown</status>") && ended.content.includes("<task-id>1</task-id>") && ended.content.includes(ENDED_WITH_SESSION_NOTICE), JSON.stringify(reloaded.sent));
	reloaded.start("reload");
	check("once", reloaded.sent.length === 1);
	const quit = seat();
	await quit.run({ command: "sleep 30", [RUN_IN_BACKGROUND]: true });
	quit.shutdown("quit");
	const next = seat({ sessionId: quit.sessionId, primed: false });
	next.start("startup");
	check("a quit leaves nothing to report", next.sent.length === 0);

	const c = seat({ customPrompt: "You are a worker." });
	check("a child seat registers the identical tool — one array on every seat", c.tools.length === 1 && JSON.stringify(c.tool()?.parameters) === JSON.stringify(bashParams) && c.tool().description === BASH_DESCRIPTION);
	check("an unattended child's timeout is a kill, in pi's words", (await thrown(c.run({ command: "sleep 5", timeout: 0.2 })))?.includes("Command timed out after 0.2 seconds"));
	check("an unattended child asking for the background is refused", (await thrown(c.run({ command: "sleep 5", [RUN_IN_BACKGROUND]: true }))) === UNATTENDED_REFUSAL);
	check("and nothing was spawned or notified for it", c.sent.length === 0 && logsOf(c).length === 0);
	check("an unattended child's ordinary bash works", text(await c.run({ command: "echo hi" })).includes("hi"));
	const old = seat({ agent: "older engine" });
	check("a child declared by an older engine, whose runner does not wait on tasks, is refused too", (await thrown(old.run({ command: "sleep 5", [RUN_IN_BACKGROUND]: true }))) === UNATTENDED_REFUSAL);
	check("a main seat is registered once — the seat does not flap", seat().tools.length === 1);
}

console.log("\nbash: an engine agent backgrounds, and its tasks end with it");
{
	const a = seat({ agent: true, customPrompt: "You are a worker." });
	const held = gate();
	const moved = await a.run({ command: `echo start; ${held.shell}`, timeout: 0.3 });
	check("an agent's timeout moves the command to the background", text(moved).includes("Still running after 0.3s") && text(moved).includes("task 1"), text(moved));
	check("and the agent's session owns the task", backgroundTasksOf(a.sessionId).length === 1);
	held.open();
	check("its exit starts the agent's next turn", await until(() => a.sent.length > 0, 5_000, 20) && a.sent[0].options?.triggerTurn === true, JSON.stringify(a.sent));
	check("the task stays registered until its notice is in the conversation", backgroundTasksOf(a.sessionId).length === 1);
	a.deliver(a.sent[0].message);
	check("and leaves the registry once it is", backgroundTasksOf(a.sessionId).length === 0);

	const requested = await a.run({ command: "echo $$; sleep 30", [RUN_IN_BACKGROUND]: true });
	check("an agent may ask for the background", text(requested).includes("Started in the background as task 2"), text(requested));
	const logPath = /(\S+\.log)/.exec(text(requested))?.[1];
	await until(() => fs.readFileSync(logPath, "utf8").trim() !== "", 5_000, 20);
	const pid = Number(fs.readFileSync(logPath, "utf8").trim());
	const killed = endBackgroundTasksOf(a.sessionId);
	check("stopping the agent kills its task and names it", killed.length === 1 && killed[0].id === 2 && killed[0].how === "killed-with-owner" && killed[0].logPath === logPath && await until(() => !alive(pid), 5_000, 20), JSON.stringify(killed));
	check("with no notification into the stopped agent", (await sleep(250), a.sent.length === 1) && backgroundTasksOf(a.sessionId).length === 0);

	process.env.PI_KIT_ORPHAN_CONFIRM_MS = "150";
	const w = seat({ agent: true, customPrompt: "You are a worker." });
	const job = gate();
	const left = await w.run({ command: `(${job.shell}; echo job done) & echo started` });
	check("work an agent starts with & is its background task", text(left).includes("background task 1"), text(left));
	check("and is registered while it runs", backgroundTasksOf(w.sessionId).length === 1);
	job.open();
	check("its end wakes the agent, with the output the job wrote", await until(() => w.sent.length > 0, 5_000, 20) && w.sent[0].options?.triggerTurn === true && w.sent[0].message.content.includes("job done"), JSON.stringify(w.sent));
	w.deliver(w.sent[0].message);
	check("and leaves the registry once delivered", backgroundTasksOf(w.sessionId).length === 0);
	delete process.env.PI_KIT_ORPHAN_CONFIRM_MS;

	const m = seat();
	await m.run({ command: "sleep 30", [RUN_IN_BACKGROUND]: true });
	m.shutdown();
	check("a main session's shutdown leaves none of its tasks registered", backgroundTasksOf(m.sessionId).length === 0);
}

console.log("\nbash: each task's result reaches exactly one place");
{
	/** A background task whose shell node has reaped and whose process group is empty; the run finishes only after the exit grace. */
	async function inExitWindow(s) {
		const started = await s.run({ command: "echo $$; echo ok", [RUN_IN_BACKGROUND]: true });
		const logPath = /(\S+\.log)/.exec(text(started))?.[1];
		await until(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("ok"), 5_000, 1);
		const pgid = Number(fs.readFileSync(logPath, "utf8").split("\n")[0]);
		await until(() => !alive(-pgid) && !alive(pgid), 5_000, 1);
		return logPath;
	}

	process.env.PI_KIT_EXIT_STDIO_GRACE_MS = "600000";
	const stopped = seat();
	await inExitWindow(stopped);
	const stop = stopBackgroundTask(stopped.sessionId, 1);
	check("TaskStop on a task whose group already exited returns its clean exit, and the task is gone", stop?.at === "ended" && stop.result.how === "exited" && stop.result.exitCode === 0 && stop.result.signal === null && backgroundTasksOf(stopped.sessionId).length === 0 && stopped.sent.length === 0, JSON.stringify({ stop, sent: stopped.sent }));

	const ending = seat({ agent: true, customPrompt: "You are a worker." });
	await inExitWindow(ending);
	const endedClean = endBackgroundTasksOf(ending.sessionId);
	check("an owner's end in that window returns the task as exited 0, with no notice", endedClean.length === 1 && endedClean[0].how === "exited" && endedClean[0].exitCode === 0 && endedClean[0].signal === null && ending.sent.length === 0, JSON.stringify({ endedClean, sent: ending.sent }));
	delete process.env.PI_KIT_EXIT_STDIO_GRACE_MS;

	const waited = seat({ agent: true, customPrompt: "You are a worker." });
	await waited.run({ command: "sleep 30", [RUN_IN_BACKGROUND]: true });
	const reading = readBackgroundTask(waited.sessionId, 1, 3_000);
	await sleep(50);
	const endAt = performance.now();
	endBackgroundTasksOf(waited.sessionId);
	const read = await reading;
	const took = performance.now() - endAt;
	check("a TaskOutput wait resolves at the owner's end, told the owner ended", took < 200 && read.state === "owner-ended" && read.task.id === 1, `${Math.round(took)}ms ${JSON.stringify(read)}`);

	const unread = seat({ agent: true, customPrompt: "You are a worker." });
	const unreadStart = await unread.run({ command: "echo bye; exit 3", [RUN_IN_BACKGROUND]: true });
	const unreadLog = /(\S+\.log)/.exec(text(unreadStart))?.[1];
	await until(() => unread.sent.length > 0, 5_000, 20);
	const unreadEnded = endBackgroundTasksOf(unread.sessionId);
	check("a finished task whose notice started a turn counts as delivered at its owner's end, and is not listed again", unread.sent[0]?.options?.triggerTurn === true && unread.sent[0].message.content.includes("<status>Failed (exit 3)</status>") && unreadEnded.length === 0, JSON.stringify(unreadEnded));
	check("and nothing of it is left", backgroundTasksOf(unread.sessionId).length === 0 && !heldLogPaths().has(unreadLog));

	const refused = seat();
	refused.refuseNextSend();
	await refused.run({ command: "exit 5", [RUN_IN_BACKGROUND]: true });
	await until(() => refused.refusals() === 1, 5_000, 20);
	check("a notice that cannot be sent is held, not counted as delivered", refused.sent.length === 0 && backgroundTasksOf(refused.sessionId).length === 1, JSON.stringify(refused.sent));
	refused.agentStart();
	check("and is offered again when the next turn starts", refused.sent.length === 1 && refused.sent[0].message.content.includes("<status>Failed (exit 5)</status>"), JSON.stringify(refused.sent));
	refused.deliver(refused.sent[0].message);
	check("and leaves the registry once it lands", backgroundTasksOf(refused.sessionId).length === 0);

	const inFlight = seat();
	await inFlight.run({ command: "exit 4", [RUN_IN_BACKGROUND]: true });
	await until(() => inFlight.sent.length > 0, 5_000, 20);
	inFlight.refuseNextSend();
	await inFlight.run({ command: "exit 6", [RUN_IN_BACKGROUND]: true });
	await until(() => inFlight.refusals() === 1, 5_000, 20);
	inFlight.shutdown("reload");
	const reloaded = seat({ sessionId: inFlight.sessionId, primed: false });
	reloaded.start("reload");
	const reported = reloaded.sent.map((sent) => sent.message.content).join("\n");
	check("a reload reports the held task to the next runtime, as it ended, and not the one whose notice was already sent", reloaded.sent.length === 1 && reported.includes("<task-id>2</task-id>") && reported.includes("<status>Failed (exit 6)</status>") && !reported.includes(ENDED_WITH_SESSION_NOTICE), JSON.stringify(reloaded.sent));
	const after = await reloaded.run({ command: "true", [RUN_IN_BACKGROUND]: true });
	check("the next runtime of the session numbers its tasks after the last one's", text(after).includes("task 3"), text(after));

	const unsent = seat();
	await unsent.run({ command: "sleep 30", [RUN_IN_BACKGROUND]: true });
	unsent.shutdown("reload");
	const restarted = seat({ sessionId: unsent.sessionId, primed: false });
	restarted.refuseNextSend();
	restarted.start("reload");
	check("a task ended with the session whose report cannot be sent at the next start is kept", restarted.refusals() === 1 && restarted.sent.length === 0, JSON.stringify(restarted.sent));
	restarted.agentStart();
	check("and offered again when the next turn starts", restarted.sent.length === 1 && restarted.sent[0].message.content.includes("<task-id>1</task-id>") && restarted.sent[0].message.content.includes(ENDED_WITH_SESSION_NOTICE), JSON.stringify(restarted.sent));
	restarted.agentStart();
	check("once", restarted.sent.length === 1);
}

await finish();
