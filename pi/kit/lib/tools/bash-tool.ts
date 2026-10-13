import { Type } from "typebox";

export const BASH_DEFAULT_TIMEOUT_SEC = 120;

export const BASH_MAX_TIMEOUT_SEC = 30 * 60;

export function resolveTimeoutSec(requested: unknown, ceiling: number): number {
	if (requested === undefined) return Math.min(BASH_DEFAULT_TIMEOUT_SEC, ceiling);
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
		throw new Error("Invalid timeout: must be a positive number of seconds");
	}
	return Math.min(requested, ceiling);
}

/** Characters of a command's output the model reads whole; Claude Code's `bashOutputMaxChars` default (2.1.282). */
export const BASH_INLINE_MAX_CHARS = 30_000;

/** Characters of preview beside the saved output's path when a successful command printed more; Claude Code's. */
export const BASH_PREVIEW_CHARS = 2_000;

/** A failing command's output past this is cut to its first and last halves; Claude Code's error cap. */
export const BASH_FAILURE_EXCERPT_CHARS = 10_000;

/** A failing command's output up to this is returned whole; past it, the excerpt. */
export const BASH_FAILURE_INLINE_MAX_CHARS = BASH_FAILURE_EXCERPT_CHARS + 1_024;

const chars = (count: number): string => count.toLocaleString("en-US");

/** The parameter name, on the wire and in `params`. */
export const RUN_IN_BACKGROUND = "run_in_background";

export const BASH_DESCRIPTION =
	"Execute a bash command in the current working directory. Returns stdout and stderr. " +
	`Output is returned whole up to ${chars(BASH_INLINE_MAX_CHARS)} characters, or ${chars(BASH_FAILURE_INLINE_MAX_CHARS)} when the command exits non-zero. ` +
	`Longer output is saved to a file and you get its path and the first ${chars(BASH_PREVIEW_CHARS)} characters, or for a failing command the first and last ${chars(BASH_FAILURE_EXCERPT_CHARS / 2)}. ` +
	"A non-zero exit code is reported in the result text, not as a failed call; the call fails only when the command could not be run.";

/** The one sentence that has to kill the belief that `timeout` is how long a command may take. */
export const TIMEOUT_PARAM_DESCRIPTION =
	`Seconds before the command leaves the foreground (optional; at most ${BASH_DEFAULT_TIMEOUT_SEC}, then it is backgrounded, not killed; ` +
	`a seat nobody waits on (a child no agent runner waits on, or \`pi -p\`/json): a kill limit, default ${BASH_DEFAULT_TIMEOUT_SEC}, max ${BASH_MAX_TIMEOUT_SEC})`;

/** Claude Code's sentences, adjusted: survives the turn, and waiting for it is never sleeping. */
export const RUN_IN_BACKGROUND_DESCRIPTION =
	"Runs the command as a task of this session: it keeps running across turns, is killed when the session quits or reloads, and re-invokes you with the exit code and log tail when it exits. " +
	"No `&` or `nohup` needed. Never sleep or poll to wait for it. In the main session, end your turn: the notification starts the next one. " +
	"In an agent, a task still running when you end is killed and named in your result, so wait for one you need with `TaskOutput {task}`. " +
	"Read the log file to look before then.";

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

export const backgroundHint = (env: NodeJS.ProcessEnv = process.env): string =>
	env.TMUX ? "ctrl+b ctrl+b to background" : "ctrl+b to background";
