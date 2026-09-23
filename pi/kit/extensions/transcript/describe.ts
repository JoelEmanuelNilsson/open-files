/**
 * What a tool call is about, taken from its arguments.
 *
 * Arguments are the honest source: they exist before the call runs, they are
 * what was asked for, and no output limit can truncate them. This module turns
 * them into the string inside the parentheses of `Read(lib/split-diff.ts)`, and
 * says which end of that string to drop when the pane is too narrow to hold it.
 *
 * The names are Claude Code's, capitalised, because a bold `Read` beside a bold
 * `Bash` reads as one system. `ls` becomes `List` for the same reason the others
 * are verbs.
 */

import { isAbsolute, relative, resolve } from "node:path";

import { HOME_GLYPH } from "../../lib/home-glyph.ts";

const LABELS: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	read: "Read",
	grep: "Grep",
	find: "Find",
	ls: "List",
	write: "Write",
	edit: "Edit",
};

/** The bold name at the head of a row. An unknown tool keeps the name it registered. */
export function labelFor(tool: string): string {
	return LABELS[tool] ?? tool;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * The shortest honest spelling of a path: relative to the session when it is
 * inside it, the home glyph when it is under home, otherwise left alone. Paths that climb
 * out of the session with `../../..` stay absolute, since the climb is longer
 * than the truth.
 */
export function shortPath(path: string, cwd: string, home: string | undefined): string {
	if (!path) return "";
	if (!isAbsolute(path)) return path;
	const inside = relative(cwd, path);
	if (inside === "") return ".";
	if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
	if (home && path.startsWith(home)) return `${HOME_GLYPH}${path.slice(home.length)}`;
	return path;
}

/**
 * Rows a shell command's argument may take in the header, and characters it may
 * spend across them.
 *
 * Claude Code's `MAX_COMMAND_DISPLAY_LINES` and `MAX_COMMAND_DISPLAY_CHARS`
 * (`tools/BashTool/UI.tsx:25-26`), at the same two and the same 160. A command
 * is the one argument whose tail routinely carries the point — the redirect,
 * the flag, the path being written — so one clipped line drops the half you
 * would have read second. Two is where that stops being true and a header
 * starts being a paragraph.
 */
export const COMMAND_HEADER_ROWS = 2;
export const COMMAND_HEADER_CHARS = 160;

export interface Argument {
	/** What goes inside the parentheses. */
	text: string;
	/**
	 * How many rows this argument may occupy before it is cut.
	 *
	 * One for everything, because a header that can grow is a header you have to
	 * read to skip. `COMMAND_HEADER_ROWS` for a shell command, which is the one
	 * argument that earns a second row.
	 */
	headerRows?: number;
	/**
	 * Which end is dropped when the row is too narrow.
	 *
	 * A path is identified by its last segment, so a clipped one keeps its tail.
	 * A command is identified by the program it runs, so a clipped one keeps its
	 * head. Both are the half you would have read first.
	 */
	clip: "head" | "tail";
	/**
	 * The one file this call names, absolute, for the OSC-8 link on the row.
	 *
	 * Only set when the argument *is* a path. A grep pattern that happens to
	 * match a filename is not a file, and linking it would open the wrong thing.
	 */
	file?: string;
	/**
	 * The line in that file the call is about, when its arguments say so.
	 *
	 * `read` is the only tool that knows one before it runs. The link carries it
	 * so the click lands where the model was looking rather than at line 1.
	 */
	line?: number;
}

/** The session root is where a search starts unless told otherwise; saying so is noise. */
function scopeOf(where: string): string {
	return where === "." || where === "./" ? "" : where;
}

function fileArgument(value: unknown, cwd: string, home: string | undefined): Argument {
	const raw = str(value);
	const text = shortPath(raw, cwd, home);
	if (!raw) return { text: ".", clip: "head" };
	return { text, clip: "head", file: isAbsolute(raw) ? raw : resolve(cwd, raw) };
}

/**
 * A directory named rather than pointed at.
 *
 * `List(.)` is honest — `.` is what the argument said — but a dot is not a
 * name, and the row beside it says `Listed 31 entries` of something. The
 * session root is spelled the way every other path on the row is: relative to
 * home when it is under it, absolute when it is not.
 */
function directoryArgument(value: unknown, cwd: string, home: string | undefined): Argument {
	const argument = fileArgument(value, cwd, home);
	if (argument.text !== ".") return argument;
	const named = home && cwd.startsWith(home) ? `${HOME_GLYPH}${cwd.slice(home.length)}` : cwd;
	return { ...argument, text: named, file: argument.file ?? cwd };
}

/** The files an `edit` call touches, in the order they appear in its arguments. */
function editPaths(args: Record<string, unknown>): string[] {
	const files = Array.isArray(args.files) ? args.files : [];
	const paths = files.map((file) => (typeof file === "object" && file !== null ? str((file as { path?: unknown }).path) : ""));
	const single = str(args.path);
	return [single, ...paths].filter(Boolean);
}

/**
 * The argument of one call.
 *
 * A tool this function does not know contributes nothing, and its row is just
 * the bold name. Inventing a summary for an unknown schema is how a header
 * starts lying about what ran.
 */
export function describe(tool: string, args: Record<string, unknown>, cwd: string, home: string | undefined): Argument {
	const scope = (value: unknown) => scopeOf(shortPath(str(value), cwd, home));
	switch (tool) {
		case "bash":
		case "powershell":
			return {
				text: str(args.command).replace(/\s*\n\s*/g, " ").trim(),
				clip: "tail",
				headerRows: COMMAND_HEADER_ROWS,
			};
		case "read": {
			const file = fileArgument(args.path, cwd, home);
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			if (offset === undefined && limit === undefined) return file;
			const from = offset ?? 1;
			const window = limit === undefined ? `from ${from}` : `${from}-${from + limit - 1}`;
			return { ...file, text: `${file.text} ${window}`, line: offset };
		}
		case "grep": {
			// `glob` is the built-in's own name for the include filter; `include`
			// was this file's invention and never matched anything.
			const where = scope(args.path);
			const glob = str(args.glob);
			let target = str(args.pattern);
			if (where) target += ` in ${where}`;
			if (glob) target += ` (${glob})`;
			return { text: target, clip: "tail" };
		}
		case "find": {
			const where = scope(args.path);
			const pattern = str(args.pattern);
			return { text: where ? `${pattern} in ${where}` : pattern, clip: "tail" };
		}
		case "ls":
			return directoryArgument(args.path, cwd, home);
		case "write":
			return fileArgument(args.path, cwd, home);
		case "edit": {
			const paths = editPaths(args);
			const first = paths[0];
			if (first === undefined) return { text: "", clip: "head" };
			const shown = paths.map((path) => shortPath(path, cwd, home)).join(", ");
			const link = paths.length === 1 ? (isAbsolute(first) ? first : resolve(cwd, first)) : undefined;
			return { text: shown, clip: "head", file: link };
		}
		default:
			return { text: "", clip: "tail" };
	}
}
