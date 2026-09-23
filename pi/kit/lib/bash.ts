/**
 * The owned `bash` tool's pure half: its numbers, its schema, its words, its
 * log, and the one detector it runs. `extensions/bash.ts` is the process side.
 *
 * The shape is Claude Code's, deliberately: no new tool, one boolean on bash,
 * and a command that outruns its budget is *moved to the background*, never
 * killed. Three triggers — `run_in_background: true`, the timeout, and the
 * user's `ctrl+b` — land on one mechanism, and the model learns one thing: a
 * result that says "still running, log at <path>, you will be notified".
 *
 * Why the kit owns the tool rather than patching pi's from outside (which it
 * did, at three seams — a schema rewrite on the wire, a `tool_call` intercept,
 * a `tool_result` rewrite): pi's bash holds the child and kills its process
 * tree from a private timer, so the one behaviour that matters — keep the
 * process, hand back the output so far — was unreachable. Registering a tool
 * under the built-in's name replaces it (`docs/extensions.md`, "override
 * built-in tools"), and `createBashToolDefinition(cwd, { operations })` takes
 * the process as a parameter, so the accumulator, truncation, temp files and
 * renderer all stay pi's. This module and the extension own only what pi
 * exposed for owning.
 *
 * Everything the model can read from this feature is generated here. That
 * matters because the tool's text is the only channel: a backgrounded call
 * returns once, and the notification that follows is the only other thing the
 * model ever sees about it.
 */

import { chmodSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { stateDir } from "./state-dir.ts";

// --- the numbers -----------------------------------------------------------

/**
 * Seconds a call gets when the model asks for nothing, and the main seat's
 * foreground ceiling: there a longer `timeout` buys nothing, because past it
 * the command is moved to the background rather than killed.
 */
export const BASH_DEFAULT_TIMEOUT_SEC = 120;

/**
 * A subagent's ceiling. Nothing there can be backgrounded — the session ends
 * with the task — so its `timeout` is a real kill budget, and this is the
 * promise that the wait ends. Claude Code's `utils/Shell.ts` number.
 */
export const BASH_MAX_TIMEOUT_SEC = 30 * 60;

/**
 * The seconds a call actually waits in the foreground: the default when
 * absent, `ceiling` when above it, the request otherwise. A nonsense value
 * (0, negative, NaN) is an error the model can act on, not a silent
 * substitution that would hide the mistake behind a working call.
 */
export function resolveTimeoutSec(requested: unknown, ceiling: number): number {
	if (requested === undefined) return Math.min(BASH_DEFAULT_TIMEOUT_SEC, ceiling);
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
		throw new Error("Invalid timeout: must be a positive number of seconds");
	}
	return Math.min(requested, ceiling);
}

// --- the schema ------------------------------------------------------------

/** The parameter name, on the wire and in `params`. */
export const RUN_IN_BACKGROUND = "run_in_background";

/** pi's own opening, kept so the tool reads as the tool the model already knows. */
const PI_DESCRIPTION_HEAD =
	"Execute a bash command in the current working directory. Returns stdout and stderr. " +
	"Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.";

/**
 * {@link exitCodeNotice}'s rule, said once where the model reads it before the
 * first call. The notice explains the number it prints; only the description
 * can say what a *red* bash call now means, and it means one thing.
 */
const EXIT_CODE_RULE =
	"A non-zero exit code is reported in the result text, not as a failed call: the call fails only when the command " +
	"could not be run — aborted, timed out, or the shell would not start.";

/**
 * The budget, in the one description every seat carries.
 *
 * There used to be two — a main-seat one that promised a move to the
 * background and a subagent one that promised a kill — and two descriptions
 * are two tools arrays, which costs a child the parent's whole tools+system
 * cache entry (map C4). The behaviour still differs, because a subagent's
 * session ends with its task and a late notification would have nowhere to
 * land; the description says so instead of being rewritten per seat.
 */
export const BASH_DESCRIPTION =
	`${PI_DESCRIPTION_HEAD} ` +
	`A call does not bound the command: after \`timeout\` seconds (default ${BASH_DEFAULT_TIMEOUT_SEC}) a command still running is moved to the ` +
	"background on the main session — you get the output so far and a notification with the exit code — and killed on a subagent seat, " +
	"whose session ends with its task. " +
	EXIT_CODE_RULE;

/** The one sentence that has to kill the belief that `timeout` is how long a command may take. */
export const TIMEOUT_PARAM_DESCRIPTION =
	`Seconds before the command leaves the foreground (optional; main session: at most ${BASH_DEFAULT_TIMEOUT_SEC}, then it is backgrounded, not killed; ` +
	`subagent: a kill budget, default ${BASH_DEFAULT_TIMEOUT_SEC}, max ${BASH_MAX_TIMEOUT_SEC})`;

/** Claude Code's sentences: detached, survives the turn, and waiting for it is never sleeping. */
export const RUN_IN_BACKGROUND_DESCRIPTION =
	"Runs the command detached: it keeps running across turns and re-invokes you with the exit code and log tail when it exits. " +
	"No `&` or `nohup` needed. Never sleep or poll to wait for it — end your turn, the notification starts the next one; " +
	"`read` the log path to look before then. Main session only — a subagent has nobody to deliver a late result to and the call is refused.";

const commandParam = Type.String({ description: "Shell command to execute" });
const timeoutParam = Type.Optional(Type.Number({ description: TIMEOUT_PARAM_DESCRIPTION }));

/** The parameters, one set for every seat (map C4): pi's two, plus the flag. */
export const bashParams = Type.Object({
	command: commandParam,
	timeout: timeoutParam,
	[RUN_IN_BACKGROUND]: Type.Optional(Type.Boolean({ description: RUN_IN_BACKGROUND_DESCRIPTION })),
});

export interface BashParams {
	readonly command: string;
	readonly timeout?: number;
	readonly [RUN_IN_BACKGROUND]?: boolean;
}

/** Whether a call asked to be backgrounded from the start. Only a literal `true` counts. */
export const wantsBackground = (params: BashParams): boolean => params[RUN_IN_BACKGROUND] === true;

// --- the verdict -----------------------------------------------------------

/**
 * The verdict rule, in one place: **`isError` says whether the command ran, not
 * what it concluded.**
 *
 * `rg` with no match, `diff` on files that differ, `test`, and a failing build
 * all exit non-zero, and nothing in the result tells them apart — nor is the
 * last link of `a; b; c` the chain's verdict, though it is the only status one
 * process has to give. So the harness stops guessing: a command that ran to
 * completion is a successful call whose text carries its exit code, and a call
 * is an error only where the tool itself did not do its job — aborted, timed
 * out, or the shell would not start.
 *
 * A false pass is the risk traded for, and this sentence is the whole
 * mitigation, so it says out loud that a failing build looks like this.
 */
export const exitCodeNotice = (code: number): string =>
	`Exit code: ${code}. The command ran; this is its own verdict, not a harness failure — a failing build ` +
	"and a search with no match both look like this, so read the output above to tell them apart.";

/**
 * The same rule for a command that never reached an exit code. pi reads a
 * signal death as `undefined` and returns it as a clean success, so an
 * out-of-memory kill used to arrive as an empty green result saying nothing.
 */
export const killedNotice = (signal: string): string =>
	`Killed by ${signal}. The command did not finish, so nothing above is its verdict — the output stops where the kill landed.`;

/**
 * How long a process group that outlived its shell is watched before it counts
 * as orphaned: a descendant winding down is not work the model detached.
 */
export const ORPHAN_CONFIRM_MS = 1_000;

/** Appended when a command left its own processes running; they were killed. */
export const orphanNotice = (count: number | undefined): string =>
	`Left ${count === undefined ? "process(es)" : `${count} process${count === 1 ? "" : "es"}`} running after the shell exited; killed. ` +
	"Nothing survives the call, so detaching work yourself (`&`, `nohup`) only loses it — pass `run_in_background: true` instead.";

// --- the environment -------------------------------------------------------

/**
 * The environment a spawned command gets: pi's, plus a ripgrep config path.
 *
 * ripgrep reads `--type-add` lines only from the file this variable names, and
 * `~/.config/ripgrep/rc` (installed by `install.sh`) is where `tsx` and `mjs`
 * get defined. Without it `rg -t tsx` is an error instead of a search.
 */
export function commandEnv(
	env: NodeJS.ProcessEnv | undefined,
	home: string = homedir(),
): NodeJS.ProcessEnv | undefined {
	const base = env ?? process.env;
	if (base.RIPGREP_CONFIG_PATH) return env;
	const rc = join(home, ".config", "ripgrep", "rc");
	// Naming a file that is not there makes rg warn on every single search, so a
	// machine that has not run install.sh is left alone.
	if (!existsSync(rc)) return env;
	return { ...base, RIPGREP_CONFIG_PATH: rc };
}

// --- the log ---------------------------------------------------------------

/**
 * Where logs live: `$XDG_STATE_HOME/pi-kit/background`, directory `0700`, file
 * `0600`, following `lib/wire-trace.ts` — not `/tmp`, where an earlier
 * generation of probes left whole conversations at mode 644 (issues/18).
 */
export function backgroundDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	if (env.PI_KIT_BACKGROUND_DIR) return env.PI_KIT_BACKGROUND_DIR;
	return join(stateDir(env, home), "background");
}

/** A run's log path. Session-scoped, so two sessions cannot collide on an id. */
export const logPathFor = (dir: string, sessionId: string, id: number): string => join(dir, `${sessionId}-${id}.log`);

/**
 * Open a log for append at `0600` whatever the umask is, and hand back the
 * descriptor. `openSync`'s mode only applies on creation, so an existing file
 * from an earlier umask is chmod'd too: this file holds command output, which
 * is as sensitive as whatever the command touched.
 */
export function openLog(path: string): number {
	const fd = openSync(path, "a", 0o600);
	chmodSync(path, 0o600);
	return fd;
}

/** Tail of the log carried in a notification. Beyond this, the model reads the file. */
const TAIL_MAX_CHARS = 4_000;
const TAIL_MAX_LINES = 60;

/** The tail of a log, bounded, with a note when there is more above it. */
export function readLogTail(path: string, maxChars = TAIL_MAX_CHARS, maxLines = TAIL_MAX_LINES): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		if (size === 0) return "";
		// Read only the window that can survive the bound: a build's log can be
		// hundreds of megabytes and the notification carries at most 4k of it.
		const from = Math.max(0, size - maxChars * 4);
		const buffer = Buffer.alloc(size - from);
		fd = openSync(path, "r");
		const read = readSync(fd, buffer, 0, buffer.length, from);
		return boundedTail(buffer.subarray(0, read).toString("utf8"), from > 0, maxChars, maxLines);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The last {@link TAIL_MAX_LINES} lines of `text`, then the last {@link TAIL_MAX_CHARS} chars. */
export function boundedTail(text: string, alreadyClipped = false, maxChars = TAIL_MAX_CHARS, maxLines = TAIL_MAX_LINES): string {
	const trimmed = text.replace(/\n+$/, "");
	const lines = trimmed.split("\n");
	let clipped = alreadyClipped;
	let tail = trimmed;
	if (lines.length > maxLines) {
		clipped = true;
		tail = lines.slice(-maxLines).join("\n");
	}
	if (tail.length > maxChars) {
		clipped = true;
		tail = tail.slice(tail.length - maxChars);
	}
	return clipped ? `[earlier output omitted — read the log file for all of it]\n${tail}` : tail;
}

// --- the stall detector ----------------------------------------------------

/**
 * Claude Code's numbers (`LocalShellTask.tsx`): a background task whose log has
 * not grown for 45 seconds is looked at every 5, and its last kilobyte is
 * matched against the shapes of a question waiting for a keyboard.
 */
export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1_024;

/** What an interactive prompt looks like at the end of a log. Claude Code's list. */
const PROMPT_PATTERNS: readonly RegExp[] = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
	/Press (?:any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
];

/** Whether a log tail ends in something that is waiting for a person to type. */
export const looksLikePrompt = (tail: string): boolean => {
	const end = tail.trimEnd();
	return PROMPT_PATTERNS.some((pattern) => pattern.test(end));
};

// --- the words -------------------------------------------------------------

/** The custom message type completion and stall notices are delivered as. */
export const BACKGROUND_NOTIFICATION = "background-task-notification";

/** Why a run left the foreground. Each gets its own sentence because each asks the model for something different. */
export type BackgroundTrigger = "requested" | "timeout" | "user";

/** A run the model may read about: its id, its command, its log. */
export interface BackgroundTask {
	readonly id: number;
	readonly command: string;
	readonly logPath: string;
}

/**
 * The sentence appended to a result whose command is still running. It is
 * appended to pi's own output text, so it opens on its own line and says the
 * three things a decision needs: it is running, where the output goes, and
 * that the model should not wait.
 */
export function backgroundedText(task: BackgroundTask, trigger: BackgroundTrigger, timeoutSec: number): string {
	const how =
		trigger === "timeout"
			? `Still running after ${timeoutSec}s, so it was moved to the background as task ${task.id}.`
			: trigger === "user"
				? `Moved to the background by the user as task ${task.id}; it is still running.`
				: `Started in the background as task ${task.id}; it is running now.`;
	return (
		`${how} Output continues at ${task.logPath} — \`read\` it any time. ` +
		"You will be notified with the exit code and the tail of the output when it finishes. Do not wait for it: if your next " +
		"step needs the result, end your turn — the notification starts the next one. Never sleep or poll."
	);
}

/**
 * Why a subagent may not background anything: a child's session ends when its
 * task does, so a notification that arrives afterwards has nowhere to land.
 * The remedy is spelled out because the alternative is a child that retries.
 */
export const CHILD_REFUSAL =
	"`run_in_background` is a main-session capability. A subagent's session ends with its task, so there is nobody " +
	"left to deliver a late result to — commands here run synchronously. Re-run this call without " +
	"`run_in_background`, raising `timeout` if the work is genuinely slow, or report the long-running step back to " +
	"the session that spawned you and let it background the work.";

/** How a run ended, as the notification reports it. */
export interface SettledTask extends BackgroundTask {
	/** Null when the process was ended by a signal rather than exiting. */
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly durationMs: number;
	readonly tail: string;
}

/** How a run ended, in one word. The notice and the row it draws say it once. */
export const backgroundStatus = (task: { exitCode: number | null; signal: string | null }): string => {
	if (task.signal !== null) return `Killed (${task.signal})`;
	if (task.exitCode === 0) return "Done";
	return `Failed (exit ${task.exitCode ?? "unknown"})`;
};

/**
 * The completion message, in the engine's `<task-notification>` shape — the
 * same fielded XML, so a session that already reads one reads this one. The
 * tag and custom type are its own: `<task-notification>` is an *agent*
 * finishing, and its renderer is keyed to its own `details` shape.
 */
export function completionNotice(task: SettledTask): string {
	return [
		"<background-task-notification>",
		`<task-id>${task.id}</task-id>`,
		`<status>${escapeXml(backgroundStatus(task))}</status>`,
		`<summary>Background command \`${escapeXml(task.command)}\` ${backgroundStatus(task).toLowerCase()} after ${Math.round(task.durationMs / 1000)}s</summary>`,
		`<log-file>${escapeXml(task.logPath)}</log-file>`,
		`<output>${escapeXml(task.tail === "" ? "No output." : task.tail)}</output>`,
		"</background-task-notification>",
		`Full log at: ${task.logPath}`,
	].join("\n");
}

/**
 * The stall message, same shape, sent once per run. It does not kill anything:
 * a guess about a prompt is a guess, and the model holds the log and the
 * remedy. The wording is Claude Code's.
 */
export function stallNotice(task: BackgroundTask, tail: string, pid: number | undefined): string {
	const kill = pid === undefined ? "Kill it" : `Kill it (\`kill -- -${pid}\` ends its whole process group)`;
	return [
		"<background-task-notification>",
		`<task-id>${task.id}</task-id>`,
		"<status>Stalled</status>",
		`<summary>Background command \`${escapeXml(task.command)}\` appears to be waiting for interactive input</summary>`,
		`<log-file>${escapeXml(task.logPath)}</log-file>`,
		`<output>${escapeXml(tail.trimEnd())}</output>`,
		"</background-task-notification>",
		`The command is likely blocked on an interactive prompt. ${kill} ` +
			"and re-run with piped input (e.g. `echo y | command`) or a non-interactive flag if one exists.",
	].join("\n");
}

/** One line for the human in the transcript. */
export const describeTask = (task: SettledTask): string => `task ${task.id}: ${backgroundStatus(task).toLowerCase()} — ${task.command}`;

/**
 * The hint beside a running command. Short, because the transcript drops a
 * suffix that would take more than half the row. Under tmux the prefix eats
 * the first press, so the key is named twice, as Claude Code does.
 */
export const backgroundHint = (env: NodeJS.ProcessEnv = process.env): string =>
	env.TMUX ? "ctrl+b ctrl+b to background" : "ctrl+b to background";

const escapeXml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
