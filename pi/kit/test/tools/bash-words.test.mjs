/**
 * The bash tool's words and numbers (lib/tools/bash-tool.ts and its siblings):
 * the timeout rule, the schema and description the model reads, the result and
 * notification sentences, the log tail, the stall detector, and the spawn env.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, REPO_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

const lib = await jiti.import(`${KIT_ROOT}/lib/tools/bash-tool.ts`);
const { BASH_DEFAULT_TIMEOUT_SEC, BASH_MAX_TIMEOUT_SEC, BASH_DESCRIPTION, RUN_IN_BACKGROUND, bashParams, resolveTimeoutSec, wantsBackground, backgroundHint } = lib;
const { UNATTENDED_REFUSAL, backgroundedText, exitCodeNotice, killedWithAgentNotice, killedNotice, leftRunningEndedNotice, orphanNotice } = await jiti.import(`${KIT_ROOT}/lib/tools/bash-result-notices.ts`);
const { completionNotice, looksLikePrompt, stallNotice } = await jiti.import(`${KIT_ROOT}/lib/tools/background-task-notification.ts`);
const { backgroundDir, boundedTail } = await jiti.import(`${KIT_ROOT}/lib/tools/background-task-log.ts`);
const { commandEnv } = await jiti.import(`${KIT_ROOT}/extensions/bash/bash-process.ts`);

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
	check("the timeout's move and kill are said once, on the parameter, and not repeated in the description", !BASH_DESCRIPTION.includes("background") && !BASH_DESCRIPTION.includes("timeout") && bashParams.properties.timeout.description.includes("a kill limit"));
	const withCommas = (n) => n.toLocaleString("en-US");
	check("the description's output numbers are the constants the cut reads", [lib.BASH_INLINE_MAX_CHARS, lib.BASH_FAILURE_INLINE_MAX_CHARS, lib.BASH_PREVIEW_CHARS, lib.BASH_FAILURE_EXCERPT_CHARS / 2].every((n) => BASH_DESCRIPTION.includes(withCommas(n))) && lib.BASH_FAILURE_INLINE_MAX_CHARS === 11024);
	check("and no longer tells the model to wait in the foreground for what it needs", !lib.RUN_IN_BACKGROUND_DESCRIPTION.includes("do not need the result immediately"));
	check("only a literal true asks for the background", wantsBackground({ [RUN_IN_BACKGROUND]: true }) && !wantsBackground({ [RUN_IN_BACKGROUND]: "true" }) && !wantsBackground({}));
	check("the sink is under the kit's state dir, not /tmp by default", backgroundDir({}, "/home/x") === "/home/x/.local/state/pi-kit/background" && backgroundDir({ XDG_STATE_HOME: "/s" }, "/home/x") === "/s/pi-kit/background");
}

// ---------------------------------------------------------------------------
console.log("\nbash: the words");
{
	const task = { id: 4, command: "npm test", logPath: "/l/4.log" };
	const byTimeout = backgroundedText(task, "timeout", 120, false);
	check("a timeout says it was still running and moved", byTimeout.includes("Still running after 120s") && byTimeout.includes("task 4"));
	const asAgent = backgroundedText(task, "requested", 120, true);
	check("an agent is told a task still running when it ends is killed, and to wait with TaskOutput", asAgent.includes("is killed") && asAgent.includes("`TaskOutput {task: 4}`") && !asAgent.includes("Do not wait"));
	check("any other seat is told nothing of the kind", !byTimeout.includes("is killed") && !backgroundedText(task, "requested", 120, false).includes("is killed"));
	check("a user move says the user did it", backgroundedText(task, "user", 120, false).includes("by the user"));
	check("a requested start says it started", backgroundedText(task, "requested", 120, false).startsWith("Started in the background as task 4"));
	check("each names the log, the notification, and says not to wait", ["timeout", "user", "requested"].every((t) => { const s = backgroundedText(task, t, 120, false); return s.includes("/l/4.log") && s.includes("notified") && s.includes("Do not wait"); }));
	const left = backgroundedText(task, "orphans", 120, false);
	check("what the shell left running is a background task that ends with the session", left.startsWith("The shell exited but left processes running") && left.includes("background task 4") && left.includes("end with the session") && left.includes("/l/4.log"));
	check("its end says the status is the shell's", leftRunningEndedNotice(2400).includes("exited after 2s") && leftRunningEndedNotice(2400).includes("shell's exit code"));

	const done = completionNotice({ ...task, exitCode: 0, signal: null, durationMs: 4200, tail: "ok" });
	check("the completion notice is the fielded shape", done.startsWith("<background-task-notification>") && done.includes("<status>Done</status>") && done.includes("<output>ok</output>") && done.includes("<log-file>/l/4.log</log-file>") && !done.includes("Full log at"));
	check("a failure carries its exit code", completionNotice({ ...task, exitCode: 3, signal: null, durationMs: 1, tail: "" }).includes("<status>Failed (exit 3)</status>"));
	check("a signal is reported as a kill", completionNotice({ ...task, exitCode: null, signal: "SIGKILL", durationMs: 1, tail: "" }).includes("<status>Killed (SIGKILL)</status>"));
	check("no output is said, not left blank", completionNotice({ ...task, exitCode: 0, signal: null, durationMs: 1, tail: "" }).includes("<output>No output.</output>"));
	check("XML in output is escaped", completionNotice({ ...task, exitCode: 0, signal: null, durationMs: 1, tail: "<b>&" }).includes("&lt;b&gt;&amp;"));

	const stalled = stallNotice(task, "Overwrite? ", 4242);
	check("the stall notice names the prompt and the kill", stalled.includes("<status>Stalled</status>") && stalled.includes("waiting for interactive input") && stalled.includes("kill -- -4242") && stalled.includes("echo y | command"));

	check("the hint knows about tmux", backgroundHint({}) === "ctrl+b to background" && backgroundHint({ TMUX: "/tmp/x" }) === "ctrl+b ctrl+b to background");
	check("the refusal tells an unattended child what to do instead", UNATTENDED_REFUSAL.includes("Re-run this call without") && UNATTENDED_REFUSAL.includes("`timeout`"));
	const killedTask = { ...task, exitCode: null, signal: "SIGKILL", durationMs: 1, tail: "", how: "killed-with-owner" };
	const unreadTask = { id: 5, command: "make", logPath: "/l/5.log", exitCode: 2, signal: null, durationMs: 1, tail: "", how: "exited" };
	check("an ended agent's result names each task its end took, one line each: killed, or finished and unread with its exit", killedWithAgentNotice([killedTask, unreadTask]) === "Background task 4 `npm test` killed when the agent ended (log /l/4.log).\nBackground task 5 `make` ended before the agent read its result: Failed (exit 2) (log /l/5.log).");

	// The whole mitigation for the one thing the verdict rule gives up: the model
	// can no longer read failure off the colour, so the sentence has to carry it.
	const notice = exitCodeNotice(3);
	check("the exit notice leads with the number", notice.startsWith("Exit code: 3."));
	check("and says a failing build looks exactly like this", notice.includes("failing build") && notice.includes("search with no match") && notice.includes("read the output above"));
	// Both local oddities are fixed at the source now (the rm wrapper honours -f,
	// ripgrep is taught the types), so the description must not spend words on them.
	check("no machine-specific workarounds left in the description", !BASH_DESCRIPTION.includes("trash") && !BASH_DESCRIPTION.includes("/bin/rm") && !BASH_DESCRIPTION.includes("tsx"));
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "kit-home-"));
	fs.mkdirSync(path.join(fakeHome, ".config", "ripgrep"), { recursive: true });
	fs.writeFileSync(path.join(fakeHome, ".config", "ripgrep", "rc"), "--type-add=tsx:*.tsx\n");
	check("a spawned command is told where ripgrep's config is", commandEnv({ PATH: "/bin" }, fakeHome).RIPGREP_CONFIG_PATH === path.join(fakeHome, ".config/ripgrep/rc"));
	check("and an env that already names one is left alone", commandEnv({ RIPGREP_CONFIG_PATH: "/elsewhere/rc" }, fakeHome).RIPGREP_CONFIG_PATH === "/elsewhere/rc");
	check("a machine without the config file is not made to warn", commandEnv({ PATH: "/bin" }, path.join(fakeHome, "nope")).RIPGREP_CONFIG_PATH === undefined);
	check("the config file defines the two types rg lacks", ((rc) => rc.includes("--type-add=tsx:*.tsx") && rc.includes("--type-add=mjs:*.mjs"))(fs.readFileSync(path.join(REPO_ROOT, "ripgrep", "rc"), "utf8")));
	fs.rmSync(fakeHome, { recursive: true, force: true });
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

await finish();
