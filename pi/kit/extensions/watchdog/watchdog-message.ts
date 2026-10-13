import type { WatchdogAction } from "./silence-watchdog.ts";

/** Duration for a line a person or a model has to read. */
export function humanMs(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds >= 90 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
}

export function abortReason(action: WatchdogAction, deadlineMs: number): string {
	const where = action.toolName ? `tool \`${action.toolName}\`` : "the model stream";
	return (
		`watchdog: aborted after ${humanMs(action.silentMs)} with no activity — ` +
		`${where} produced nothing and the ${humanMs(deadlineMs)} deadline expired. ` +
		"Any answer above this line is partial. Re-run with narrower work " +
		"(target repo paths, not `$HOME` or `/`)."
	);
}

export function warnMessage(action: WatchdogAction, deadlineMs: number, mode: "warn" | "abort" = "abort"): string {
	const where = action.toolName ? `\`${action.toolName}\`` : "model stream";
	const tail = mode === "abort" ? `(aborts at ${humanMs(deadlineMs)})` : "— Esc to stop it";
	return `watchdog: ${where} silent for ${humanMs(action.silentMs)} ${tail}`;
}

type FailedAssistant = { role: "assistant"; stopReason?: string; errorMessage?: string };

export function isFailedAssistant(message: unknown): message is FailedAssistant {
	// SAFETY: candidate is only read through optional, type-checked field access
	const candidate = message as FailedAssistant | null;
	if (!candidate || candidate.role !== "assistant") return false;
	return candidate.stopReason === "error" || candidate.stopReason === "aborted";
}
