/**
 * What a finished tool call is allowed to say about itself in one line.
 *
 * The rule this file exists to enforce: a summary is only ever computed from a
 * tool's documented contract, never guessed from the shape of the text. `find`
 * emits one path per line. `ls` emits one entry per line. `grep` emits
 * ripgrep's `file:line:text`, where context lines use `-` instead of `:` and so
 * cannot be miscounted as matches. `read` returns the file verbatim. `write` is
 * counted from the content it was handed rather than the `Successfully wrote N
 * bytes` line it prints back, because the input is the thing that was asked for.
 *
 * `bash` is not countable: its output is whatever the command decided to print,
 * and there is no honest number to put beside it. Its result line shows the last
 * line of that output instead, which is the same thing the live tail shows while
 * it runs. A tool this file does not know returns null and gets no result line.
 *
 * The grammar is Claude Code's: a verb, a bold number, a plain unit. `Read 412
 * lines`, `Found 7 matches`, `Listed 31 entries`. A call that found nothing says
 * so in words rather than with a zero, because `Found 0 matches` reads as an
 * amount and a failed search is not an amount.
 */

/**
 * The bracketed advisory pi appends after a blank line when it truncates or
 * hits a limit: `[500 results limit reached. Use limit=1000 for more]`. It is
 * pi's own text, not the tool's payload, so it never counts.
 */
const NOTICE = /\n\n\[[^\]]*\]\s*$/;

/** Sentinels pi returns instead of an empty list, so zero is unambiguous. */
const EMPTY = [/^No matches found$/, /^No files found matching pattern$/, /^\(empty directory\)$/];

/**
 * A count, or a phrase that stands in for one.
 *
 * `count` carries the number separately from its words so the renderer can bold
 * it, which is the whole reason a row scans at a glance.
 */
export type Summary =
	| {
			kind: "count";
			/** The verb, already in the past tense. */
			lead: string;
			count: number;
			unit: string;
			units: string;
			/** pi truncated the payload, so the count is a floor rather than a total. */
			partial: boolean;
	  }
	| {
			kind: "note";
			text: string;
			/** `warning` is for a search that matched nothing, which is usually a mistake. */
			tone: "muted" | "warning";
	  };

export function stripNotice(text: string): string {
	return text.replace(NOTICE, "");
}

function isEmpty(text: string): boolean {
	const body = text.trim();
	return EMPTY.some((pattern) => pattern.test(body));
}

function lines(text: string): string[] {
	const body = stripNotice(text).trim();
	return body ? body.split("\n") : [];
}

/**
 * pi prints a match as `path:12: text` and a context line as `path-12- text`.
 * Context is tested first: a context line whose *text* contains something shaped
 * like `foo:12:` would otherwise be counted as a match.
 */
const MATCH = /^.+?:\d+: /;
const CONTEXT = /^.+?-\d+- /;

function counted(lead: string, count: number, unit: string, units: string, partial: boolean): Summary {
	return { kind: "count", lead, count, unit, units, partial };
}

/**
 * The one line a settled call gets, or null when the tool has nothing countable
 * to say and its output has to speak for itself.
 */
export function summarize(
	tool: string,
	text: string,
	args: Record<string, unknown>,
	truncated: boolean,
): Summary | null {
	switch (tool) {
		case "read":
			return counted("Read", lines(text).length, "line", "lines", truncated);
		case "write": {
			const content = typeof args.content === "string" ? args.content : undefined;
			if (content === undefined) return null;
			const written = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
			return counted("Wrote", written, "line", "lines", false);
		}
		case "grep": {
			if (isEmpty(text)) return { kind: "note", text: "No matches", tone: "warning" };
			const matches = lines(text).filter((line) => !CONTEXT.test(line) && MATCH.test(line)).length;
			if (matches === 0) return { kind: "note", text: "No matches", tone: "warning" };
			return counted("Found", matches, "match", "matches", truncated);
		}
		case "find": {
			if (isEmpty(text)) return { kind: "note", text: "No files found", tone: "warning" };
			return counted("Found", lines(text).length, "file", "files", truncated);
		}
		case "ls": {
			if (isEmpty(text)) return { kind: "note", text: "Empty directory", tone: "warning" };
			return counted("Listed", lines(text).length, "entry", "entries", truncated);
		}
		default:
			return null;
	}
}

/** `Read 412 lines`, `Found 1 match`, `No matches`. The plain spelling, for tests. */
export function summaryText(summary: Summary): string {
	if (summary.kind === "note") return summary.text;
	const unit = summary.count === 1 ? summary.unit : summary.units;
	return `${summary.lead} ${summary.count}${summary.partial ? "+" : ""} ${unit}`;
}

/** `2.4 MB`. Used for an image, whose only honest measure is how big it was. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `2.4s`, or nothing at all under the floor.
 *
 * A grep that took four milliseconds reporting `0.0s` is the noise this whole
 * extension exists to remove. Claude Code shows no per-call duration; a suffix
 * that only appears once you would have felt the wait keeps the column quiet and
 * still answers which of ten calls ate four seconds.
 */
export const DURATION_FLOOR_MS = 500;

export function formatDuration(ms: number): string | null {
	if (!Number.isFinite(ms) || ms < DURATION_FLOOR_MS) return null;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	// Round to whole seconds first, then split: rounding the remainder alone
	// turns 9m 59.6s into "9m 60s".
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
