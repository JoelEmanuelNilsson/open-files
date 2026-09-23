/**
 * The one frontmatter edit this extension makes: add or remove the top-level
 * `disable-model-invocation` key in a SKILL.md.
 *
 * Deliberately not a YAML round-trip. A parse-and-reserialize would rewrite
 * quoting, key order and comments in files that are otherwise hand-written
 * prose, so a one-key toggle would show up in git as a whole-file diff. Only
 * two operations happen here and both are line-level:
 *
 *   - **remove** — drop every line whose *first* character starts the key.
 *     Column zero is what makes this safe: a key at column zero is top-level
 *     by definition, so nothing nested and nothing inside a block scalar can
 *     match. Every occurrence goes, not just the first, so a file that already
 *     had the key twice comes back with zero rather than one.
 *   - **add** — insert `disable-model-invocation: true` as the last line
 *     before the closing `---`. Column zero again: a column-zero key
 *     terminates a preceding block scalar rather than joining it.
 *
 * Reading is not done here at all. pi already parsed every SKILL.md and hands
 * extensions the result (`BuildSystemPromptOptions.skills`), so a second
 * parser in this repo could only disagree with the one that counts.
 */

const KEY = "disable-model-invocation";
const MUTED_LINE = `${KEY}: true`;
const KEY_LINE = new RegExp(`^${KEY}\\s*:`);

/** A file whose frontmatter block was located: its lines and the fence rows. */
interface Frontmatter {
	readonly lines: string[];
	/** Index of the opening `---`. Always 0; named for the closing one's sake. */
	readonly open: number;
	/** Index of the closing `---`. */
	readonly close: number;
	readonly newline: string;
}

/**
 * Rewrite `source` so the skill is muted (hidden from the model) or not.
 *
 * Returns `undefined` when nothing needs to change — the file already says
 * what was asked, or it has no frontmatter block to edit. Callers treat that
 * as "skip this file", which is what keeps an apply pass from touching mtimes
 * it has no reason to touch.
 */
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

/**
 * Locate the leading frontmatter block, or `undefined` when there is none.
 *
 * A skill without frontmatter has no name or description either, so pi never
 * loaded it; the only way one reaches this code is a file edited between the
 * dialog opening and the write. It is reported, not repaired.
 */
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
