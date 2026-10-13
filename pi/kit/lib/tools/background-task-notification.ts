import type { BackgroundTask } from "./bash-result-notices.ts";

export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1_024;

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

/** The custom message type completion and stall notices are delivered as. */
export const BACKGROUND_NOTIFICATION = "background-task-notification";

/** How a run ended, as the notification reports it. */
export interface SettledTask extends BackgroundTask {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly durationMs: number;
	readonly tail: string;
}

/** How a run ended, in one word. The notice and the row it draws say it once. */
export const backgroundStatus = (task: { exitCode: number | null; signal: string | null }): string => {
	if (task.signal !== null) return `Killed (${task.signal})`;
	if (task.exitCode === 0) return "Done";
	if (task.exitCode === null) return "Exit status unknown";
	return `Failed (exit ${task.exitCode})`;
};

export function completionNotice(task: SettledTask): string {
	return [
		"<background-task-notification>",
		`<task-id>${task.id}</task-id>`,
		`<status>${escapeXml(backgroundStatus(task))}</status>`,
		`<summary>Background command \`${escapeXml(task.command)}\` ${backgroundStatus(task).toLowerCase()} after ${Math.round(task.durationMs / 1000)}s</summary>`,
		`<log-file>${escapeXml(task.logPath)}</log-file>`,
		`<output>${escapeXml(task.tail === "" ? "No output." : task.tail)}</output>`,
		"</background-task-notification>",
	].join("\n");
}

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

const escapeXml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
