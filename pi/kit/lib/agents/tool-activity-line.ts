export const ACTIVITY_LINE_MAX_CHARS = 200;

/** How many activity lines one agent keeps. Claude Code's `MAX_RECENT_ACTIVITIES`. */
export const ACTIVITY_TAIL_LIMIT = 5;

const PRIMARY_KEYS = ["command", "pattern", "query", "file_path", "filePath", "path", "url", "message", "description", "name", "prompt", "script", "scriptPath", "to"] as const;

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
	// SAFETY: args was checked to be a non-null, non-array object on the previous line
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
