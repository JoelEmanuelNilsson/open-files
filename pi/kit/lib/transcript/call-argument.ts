import { isAbsolute, relative, resolve } from "node:path";

import { HOME_GLYPH } from "../ui/home-glyph.ts";

const HOME = process.env.HOME || process.env.USERPROFILE;

const LABELS: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	read: "Read",
	write: "Write",
	edit: "Edit",
};

/** The bold name at the head of a row. An unknown tool keeps the name it registered. */
export function toolCallLabel(tool: string): string {
	return LABELS[tool] ?? tool;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function shortDisplayPath(path: string, cwd: string, home: string | undefined): string {
	if (!path) return "";
	if (!isAbsolute(path)) return path;
	const inside = relative(cwd, path);
	if (inside === "") return ".";
	if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
	return underHome(path, home) ?? path;
}

function underHome(path: string, home: string | undefined): string | undefined {
	if (!home) return undefined;
	const root = home.endsWith("/") ? home.slice(0, -1) : home;
	if (path === root) return HOME_GLYPH;
	return path.startsWith(`${root}/`) ? `${HOME_GLYPH}${path.slice(root.length)}` : undefined;
}

export const COMMAND_HEADER_ROWS = 2;
export const COMMAND_HEADER_CHARS = 160;

export interface CallArgument {
	text: string;
	headerRows?: number;
	clip: "head" | "tail";
	file?: string;
	line?: number;
}

function fileArgument(value: unknown, cwd: string, home: string | undefined): CallArgument {
	const raw = str(value);
	const text = shortDisplayPath(raw, cwd, home);
	if (!raw) return { text: ".", clip: "head" };
	return { text, clip: "head", file: isAbsolute(raw) ? raw : resolve(cwd, raw) };
}

function editPaths(args: Record<string, unknown>): string[] {
	const files = Array.isArray(args.files) ? args.files : [];
	// SAFETY: file is a non-null object; path is read as unknown and passed through str
	const paths = files.map((file) => (typeof file === "object" && file !== null ? str((file as { path?: unknown }).path) : ""));
	const single = str(args.path);
	return [single, ...paths].filter(Boolean);
}

export function describeCallArgument(tool: string, args: Record<string, unknown>, cwd: string, home: string | undefined = HOME): CallArgument {
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
		case "write":
			return fileArgument(args.path, cwd, home);
		case "edit": {
			const paths = editPaths(args);
			const first = paths[0];
			if (first === undefined) return { text: "", clip: "head" };
			const shown = paths.map((path) => shortDisplayPath(path, cwd, home)).join(", ");
			const link = paths.length === 1 ? (isAbsolute(first) ? first : resolve(cwd, first)) : undefined;
			return { text: shown, clip: "head", file: link };
		}
		default:
			return { text: "", clip: "tail" };
	}
}
