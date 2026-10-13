import { formatSize } from "@earendil-works/pi-coding-agent";
import type { LogEnds } from "./background-task-log.ts";
import { backgroundStatus } from "./background-task-notification.ts";
import type { EndedTask } from "./background-tasks.ts";
import { BASH_FAILURE_EXCERPT_CHARS, BASH_FAILURE_INLINE_MAX_CHARS, BASH_INLINE_MAX_CHARS, BASH_PREVIEW_CHARS } from "./bash-tool.ts";

export const exitCodeNotice = (code: number): string =>
	`Exit code: ${code}. The command ran; this is its own verdict, not a harness failure — a failing build ` +
	"and a search with no match both look like this, so read the output above to tell them apart.";

export const killedNotice = (signal: string): string =>
	`Killed by ${signal}. The command did not finish, so nothing above is its verdict — the output stops where the kill landed.`;

function droppedNote(output: LogEnds): string {
	return output.droppedBytes === 0 ? "" : ` (the ${output.droppedBytes} bytes in the middle were dropped to keep the file bounded; it holds the start and the end)`;
}

export function cutBashOutput(output: LogEnds, failed: boolean, logPath: string): string | undefined {
	if (failed) {
		if (output.chars <= BASH_FAILURE_INLINE_MAX_CHARS) return undefined;
		const half = BASH_FAILURE_EXCERPT_CHARS / 2;
		const cut = output.chars - 2 * half;
		return `${output.head.slice(0, half)}\n\n... [${cut} characters truncated] ...\n\n${output.tail.slice(-half)}\n\nFull output saved to: ${logPath}${droppedNote(output)}`;
	}
	if (output.chars <= BASH_INLINE_MAX_CHARS) return undefined;
	const window = output.head.slice(0, BASH_PREVIEW_CHARS);
	const lineEnd = window.lastIndexOf("\n");
	const preview = lineEnd > BASH_PREVIEW_CHARS * 0.5 ? window.slice(0, lineEnd) : window;
	return (
		`<persisted-output>\nOutput too large (${formatSize(output.chars + output.droppedBytes)}). Full output saved to: ${logPath}${droppedNote(output)}\n` +
		`Preview (first ${formatSize(BASH_PREVIEW_CHARS)}):\n${preview}\n...\n</persisted-output>`
	);
}

/** Appended on a seat that may not background when a command left its own processes running; they were killed. */
export const orphanNotice = (count: number | undefined): string =>
	`Left ${count === undefined ? "process(es)" : `${count} process${count === 1 ? "" : "es"}`} running after the shell exited; killed. ` +
	"This session ends with its task, so nothing a command starts may outlive the call.";

/** Appended to the completion notice of a task whose shell left processes running: the task ended with the last of them. */
export const leftRunningEndedNotice = (shellMs: number): string =>
	`Its shell exited after ${Math.round(shellMs / 1000)}s; the processes it left running have now all exited. ` +
	"The status is the shell's exit code; theirs cannot be observed.";

/** Why a run left the foreground. Each gets its own sentence because each asks the model for something different. */
export type BackgroundTrigger = "requested" | "timeout" | "user" | "orphans";

/** A run the model may read about: its id, its command, its log. */
export interface BackgroundTask {
	readonly id: number;
	readonly command: string;
	readonly logPath: string;
}

export function backgroundedText(task: BackgroundTask, trigger: BackgroundTrigger, timeoutSec: number, agent: boolean): string {
	const how =
		trigger === "timeout"
			? `Still running after ${timeoutSec}s, so it was moved to the background as task ${task.id}.`
			: trigger === "user"
				? `Moved to the background by the user as task ${task.id}; it is still running.`
				: trigger === "orphans"
					? `The shell exited but left processes running in its process group (\`&\`, \`nohup\` or a subshell), so they are background task ${task.id}; they are running now and end with the session.`
					: `Started in the background as task ${task.id}; it is running now.`;
	return (
		`${how} Output continues at ${task.logPath} — \`read\` it any time. ` +
		(agent
			? "You will be notified with the exit code and the tail of the output when it finishes. You are an agent: a task still running when you end your turn is killed, and your result names it. If you need its result, wait with `TaskOutput {task: " + task.id + "}` before you end. Never sleep or poll."
			: "You will be notified with the exit code and the tail of the output when it finishes. Do not wait for it: if your next step needs the result, end your turn — the notification starts the next one. Never sleep or poll. ") +
		"The notification comes when the command exits, not at a time you expect: a `timeout N` inside it sends SIGTERM, which a program can ignore, so a command that must end by then needs `timeout -k 5 N`."
	);
}

/** Appended to the completion notice of a background command that the end of its session killed. */
export const ENDED_WITH_SESSION_NOTICE =
	"The session was reloaded or replaced, which kills its background commands. This one did not finish and nothing will notify you again; run it again if you still need its result.";

export const UNATTENDED_REFUSAL =
	"`run_in_background` needs a session that waits for its tasks: the main session or an agent. This child or headless session " +
	"ends with its task, so there is nobody left to deliver a late result to — commands here run synchronously. Re-run " +
	"this call without `run_in_background`, raising `timeout` if the work is genuinely slow, or, in a child session, report the long-running " +
	"step back to the session that spawned you and let it background the work.";

/** Appended to an ended agent's result: each background task its end took, one line each — killed, or finished with a result the agent never read. */
export const killedWithAgentNotice = (tasks: readonly EndedTask[]): string =>
	tasks
		.map((task) =>
			task.how === "killed-with-owner"
				? `Background task ${task.id} \`${task.command}\` killed when the agent ended (log ${task.logPath}).`
				: `Background task ${task.id} \`${task.command}\` ended before the agent read its result: ${backgroundStatus(task)} (log ${task.logPath}).`,
		)
		.join("\n");
