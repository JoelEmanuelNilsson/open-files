/**
 * One tool call as one line — `Bash(npm test)`, `Read(lib/wire.ts)` — for the
 * workflow view's Activity block.
 *
 * This is deliberately *not* the transcript's receipt grammar. A receipt is two
 * rows and carries the result; an activity line is one row, carries no result,
 * and exists so five of them fit in a box beside four other blocks. Claude
 * Code draws the same thing from `renderToolUseMessage`; pi has no equivalent
 * that works outside a live tool registry, so the argument is picked here by
 * name and everything else about the call is dropped.
 *
 * The line is built once, when the call starts, and rides the progress event —
 * so a settled agent still has its last calls to show, which is the whole
 * reason a photograph of a finished agent has an Activity block at all.
 */

/**
 * Longest activity line kept. Wider than any terminal: the view truncates to
 * its own width, and this only stops a 200KB heredoc living in the registry.
 */
export const ACTIVITY_LINE_MAX_CHARS = 200;

/** How many activity lines one agent keeps. Claude Code's `MAX_RECENT_ACTIVITIES`. */
export const ACTIVITY_TAIL_LIMIT = 5;

/**
 * Argument names that are the whole point of the call, most specific first.
 * A `Bash` is its command, a `Read` is its path; anything on this list renders
 * bare, because naming the key would only repeat the tool.
 */
const PRIMARY_KEYS = ["command", "pattern", "query", "file_path", "filePath", "path", "url", "message", "description", "name", "prompt", "script", "scriptPath", "to"] as const;

/** How many `key: value` pairs a call with no primary argument shows. */
const PAIR_LIMIT = 3;

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function scalarText(value: unknown): string | undefined {
	if (typeof value === "string") return oneLine(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

/** `Bash(npm test)`: the tool's name and the one argument that says what it did. */
export function toolActivityLine(name: string, args: unknown): string {
	return `${name}(${activityArguments(args)})`.slice(0, ACTIVITY_LINE_MAX_CHARS);
}

function activityArguments(args: unknown): string {
	const scalar = scalarText(args);
	if (scalar !== undefined) return scalar;
	if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
	const source = args as Record<string, unknown>;
	for (const key of PRIMARY_KEYS) {
		const text = scalarText(source[key]);
		if (text !== undefined && text !== "") return text;
	}
	const pairs: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		const text = scalarText(value);
		if (text === undefined || text === "") continue;
		pairs.push(`${key}: ${typeof value === "string" ? JSON.stringify(text) : text}`);
		if (pairs.length === PAIR_LIMIT) break;
	}
	return pairs.join(", ");
}
