import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SkillChange } from "./skill-draft.ts";
import { setMuted } from "./skill-frontmatter-patch.ts";

/** What one apply pass did, in the terms the summary line reports. */
export interface ApplyReport {
	readonly written: number;
	readonly failures: string[];
}

/** Rewrite each changed skill's frontmatter, collecting failures rather than throwing. */
export function applyChanges(changes: readonly SkillChange[]): ApplyReport {
	const failures: string[] = [];
	let written = 0;

	for (const change of changes) {
		try {
			const next = setMuted(readFileSync(change.filePath, "utf8"), change.muted);
			if (next === undefined) continue;
			writeAtomic(change.filePath, next);
			written++;
		} catch (error) {
			failures.push(`${change.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { written, failures };
}

function writeAtomic(requestedPath: string, contents: string): void {
	const path = realpathSync(requestedPath);
	const mode = statSync(path).mode & 0o777;
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		writeFileSync(temp, contents, { encoding: "utf8", mode });
		fsyncFile(temp);
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
		}
		throw new Error(`${describeCause(error)}: ${path}`, { cause: error });
	}
}

function describeCause(error: unknown): string {
	// SAFETY: a thrown fs error is a NodeJS.ErrnoException; code is re-checked as a non-empty string below
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string" && code.length > 0) return code;
	return error instanceof Error ? error.message : String(error);
}

function fsyncFile(path: string): void {
	const handle = openSync(path, "r+");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

/** One line naming what changed, so the notification is not just a count. */
export function describeChanges(changes: readonly SkillChange[], written: number): string {
	const hidden = changes.filter((change) => change.muted).map((change) => change.name);
	const shown = changes.filter((change) => !change.muted).map((change) => change.name);
	const parts: string[] = [];
	if (shown.length > 0) parts.push(`model can now invoke ${shown.join(", ")}`);
	if (hidden.length > 0) parts.push(`hidden from the model: ${hidden.join(", ")}`);
	return `${written} file${written === 1 ? "" : "s"} written — ${parts.join("; ")}`;
}
