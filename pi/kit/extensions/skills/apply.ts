/**
 * The write half of `/skills`: turn the dialog's decisions into edited files.
 *
 * Each file is **re-read here**, at apply time, rather than snapshotted when
 * the dialog opened. That is deliberate, and it is the stronger guarantee: a
 * change someone made in another window while the dialog was open survives,
 * because the patch is applied to the newest bytes rather than refused against
 * stale ones. The user's toggle decides one line and the file decides the rest,
 * so there is no conflict to detect and nothing to ask about.
 *
 * Nothing here throws. A skill whose file has been deleted, made read-only or
 * stripped of its frontmatter is one failure in the report, and the other
 * files still get written — a batch that abandons the rest because of one bad
 * member leaves the user with a half-applied dialog and no way to tell which
 * half.
 */

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

import type { SkillChange } from "./model.ts";
import { setMuted } from "./patch.ts";

/** What one apply pass did, in the terms the summary line reports. */
export interface ApplyReport {
	/** Files whose bytes changed. Excludes files that already said the right thing. */
	readonly written: number;
	/** One human-readable line per skill that could not be written. */
	readonly failures: string[];
}

/** Rewrite each changed skill's frontmatter, collecting failures rather than throwing. */
export function applyChanges(changes: readonly SkillChange[]): ApplyReport {
	const failures: string[] = [];
	let written = 0;

	for (const change of changes) {
		try {
			const next = setMuted(readFileSync(change.filePath, "utf8"), change.muted);
			// undefined means the file already says what was asked — including when
			// someone edited it by hand while the dialog was open. Nothing to do.
			if (next === undefined) continue;
			writeAtomic(change.filePath, next);
			written++;
		} catch (error) {
			failures.push(`${change.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { written, failures };
}

/**
 * Replace a file's contents through a same-directory temp file and a rename.
 *
 * Same directory because rename is only atomic within one filesystem. The temp
 * file is removed on every failure path and the original's mode is carried
 * over: a half-written `SKILL.md` beside the real one is a file pi will try to
 * load as a skill.
 *
 * **Resolved through symlinks first, and this is the important part here.**
 * This harness reaches its own skills through `~/.agents/skills`, a symlink
 * into the dotfiles checkout, so pi reports every `filePath` through that
 * link. `rename` replaces the *name* it is given: pointed at a symlinked file
 * it would swap the link for a regular file and quietly sever the checkout,
 * leaving two copies that drift. Resolving to the real path first means the
 * temp file is created next to the real file, on the real file's filesystem,
 * and the link keeps pointing at content that just changed. Any link in any
 * segment of the path is covered by the same call.
 */
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
			// The temp file was never created, or is already gone. Either is fine.
		}
		// Re-thrown against the file the user chose, not the temp name they have
		// never heard of: "permission denied, .SKILL.md.96756.tmp" reads like a
		// bug in this extension rather than a read-only directory.
		throw new Error(`${describeCause(error)}: ${path}`, { cause: error });
	}
}

/** The part of a filesystem error worth repeating: its code, or its message. */
function describeCause(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string" && code.length > 0) return code;
	return error instanceof Error ? error.message : String(error);
}

/** Flush the replacement to disk before the rename publishes it. */
function fsyncFile(path: string): void {
	// Node has no fsyncSync-by-path; the descriptor exists only for this call.
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
