import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CheckoutLayout {
	/** The linked worktree holding the directory; absent in a main checkout. */
	readonly worktree?: string;
	readonly mainRoot: string;
}

/** The checkout holding `cwd` and its main checkout, read from `.git` and git's `commondir` file, with no subprocess; `undefined` outside a repository. */
export function checkoutLayout(cwd: string): CheckoutLayout | undefined {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const entry = join(dir, ".git");
		const stat = statSync(entry, { throwIfNoEntry: false });
		if (stat?.isDirectory()) return { mainRoot: dir };
		if (stat?.isFile()) return layoutFromGitFile(dir, entry);
		if (dirname(dir) === dir) return undefined;
	}
}

function layoutFromGitFile(dir: string, entry: string): CheckoutLayout {
	const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(entry, "utf8"))?.[1];
	if (gitdir === undefined) return { mainRoot: dir };
	const common = commonDirOf(resolve(dir, gitdir.trim()));
	return common === undefined ? { mainRoot: dir } : { worktree: dir, mainRoot: dirname(common) };
}

function commonDirOf(gitdir: string): string | undefined {
	try {
		return resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
	} catch {
		return undefined;
	}
}
