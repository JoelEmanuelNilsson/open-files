const KEY = "disable-model-invocation";
const MUTED_LINE = `${KEY}: true`;
const KEY_LINE = new RegExp(`^${KEY}\\s*:`);

interface Frontmatter {
	readonly lines: string[];
	readonly open: number;
	readonly close: number;
	readonly newline: string;
}

export function setMuted(source: string, muted: boolean): string | undefined {
	const frontmatter = readFrontmatter(source);
	if (frontmatter === undefined) return undefined;

	const { lines, open, close, newline } = frontmatter;
	const body = lines.slice(open + 1, close);
	const kept = body.filter((line) => !KEY_LINE.test(line));
	const next = muted ? [...kept, MUTED_LINE] : kept;
	if (sameLines(body, next)) return undefined;

	return [...lines.slice(0, open + 1), ...next, ...lines.slice(close)].join(newline);
}

/** Whether this file has a frontmatter block `setMuted` can edit. */
export function isPatchable(source: string): boolean {
	return readFrontmatter(source) !== undefined;
}

function readFrontmatter(source: string): Frontmatter | undefined {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lines = source.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;

	const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (close === -1) return undefined;

	return { lines, open: 0, close, newline };
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}
