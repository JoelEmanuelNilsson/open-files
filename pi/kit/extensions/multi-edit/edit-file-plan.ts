import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyEditRanges, resolveEditRanges, type TextEdit } from "./edit-text-matching.ts";

/** The edits aimed at one file, as the call named it. */
export type FileEdits = { path: string; edits: TextEdit[] };

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlf = (content.match(/\r\n/g) ?? []).length;
	const lf = (content.match(/\n/g) ?? []).length;
	return crlf > 0 && crlf >= lf / 2 ? "\r\n" : "\n";
}

const toLF = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const restoreEndings = (text: string, ending: "\r\n" | "\n") =>
	ending === "\n" ? text : text.replace(/\n/g, "\r\n");

/** One file's edit, planned in memory: the text before and after, and how to write it back. */
export type FileChange = {
	path: string;
	absolutePath: string;
	before: string;
	after: string;
	bom: string;
	ending: "\r\n" | "\n";
};

const splitBom = (text: string): { bom: string; text: string } =>
	text.startsWith("\ufeff") ? { bom: "\ufeff", text: text.slice(1) } : { bom: "", text };

const stripAt = (path: string) => (path.startsWith("@") ? path.slice(1) : path);

function absolute(cwd: string, path: string): string {
	const clean = stripAt(path).trim();
	if (!clean) throw new Error("Empty path.");
	return isAbsolute(clean) ? resolve(clean) : resolve(cwd, clean);
}

function display(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	return rel && !rel.startsWith("..") ? rel : absolutePath;
}

async function readIfExists(absolutePath: string): Promise<string | undefined> {
	try {
		return await readFile(absolutePath, "utf8");
	} catch {
		return undefined;
	}
}

export async function planFileEdits(cwd: string, targets: FileEdits[]): Promise<FileChange[]> {
	const changes: FileChange[] = [];

	for (const target of targets) {
		const absolutePath = absolute(cwd, target.path);
		const shown = display(cwd, absolutePath);

		if (target.edits.length === 0) throw new Error(`${shown}: no edits given.`);

		const raw = await readIfExists(absolutePath);
		if (raw === undefined) {
			throw new Error(`${shown}: file not found. Use the write tool to create it.`);
		}
		await access(absolutePath, constants.R_OK | constants.W_OK).catch(() => {
			throw new Error(`${shown}: not writable.`);
		});

		const { bom, text: original } = splitBom(raw);
		const ending = detectLineEnding(original);
		const before = toLF(original);
		const after = applyEditRanges(before, resolveEditRanges(shown, before, target.edits));
		if (after === before) throw new Error(`${shown}: edits produced no change.`);

		changes.push({ path: shown, absolutePath, before, after, bom, ending });
	}

	return changes;
}

export async function commitFileEdits(changes: FileChange[]): Promise<string[]> {
	const written: string[] = [];

	for (const change of changes) {
		await withFileMutationQueue(change.absolutePath, async () => {
			const onDisk = await readIfExists(change.absolutePath);
			if (onDisk !== undefined && toLF(splitBom(onDisk).text) !== change.before) {
				throw new Error(
					`${change.path}: changed on disk between the dry run and the write. Re-read it and retry.` +
						(written.length ? ` Already written: ${written.join(", ")}.` : ""),
				);
			}
			await writeFile(change.absolutePath, change.bom + restoreEndings(change.after, change.ending), "utf8");
		});
		written.push(change.path);
	}

	return written;
}
