import { execFile } from "node:child_process";
import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** How long an unused command log is kept for the model to read back. */
export const LOG_KEEP_MS = 24 * 60 * 60 * 1000;

const PI_TEMP_LOG = /^pi-bash-[0-9a-f]+\.log$/;

function openAmong(files: readonly string[]): Promise<Set<string> | undefined> {
	return new Promise((resolve) => {
		execFile("lsof", ["-Fn", "--", ...files], { encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout) => {
			const failed = error !== null && (typeof error.code !== "number" || error.code > 1);
			resolve(failed ? undefined : new Set(stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1))));
		});
	});
}

function oldFiles(dir: string, wanted: (name: string) => boolean, cutoffMs: number): string[] {
	try {
		return readdirSync(dir)
			.filter(wanted)
			.map((name) => join(dir, name))
			.filter((file) => (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Number.POSITIVE_INFINITY) < cutoffMs);
	} catch {
		return [];
	}
}

/** Delete the stale logs under `backgroundDir` and the stale pi temp logs under `tmpDir`; returns the paths deleted. Deletes nothing if open files cannot be checked. */
export async function sweepStaleLogs(options: { backgroundDir: string; tmpDir: string; held: ReadonlySet<string>; now?: number }): Promise<string[]> {
	const cutoff = (options.now ?? Date.now()) - LOG_KEEP_MS;
	const candidates = [...oldFiles(options.backgroundDir, (name) => name.endsWith(".log"), cutoff), ...oldFiles(options.tmpDir, (name) => PI_TEMP_LOG.test(name), cutoff)].filter((file) => !options.held.has(file));
	if (candidates.length === 0) return [];
	const removed: string[] = [];
	for (let from = 0; from < candidates.length; from += 200) {
		const batch = candidates.slice(from, from + 200);
		const open = await openAmong(batch);
		if (open === undefined) return removed;
		for (const file of batch) {
			try {
				if (open.has(realpathSync(file))) continue;
				rmSync(file, { force: true });
				removed.push(file);
			} catch {
			}
		}
	}
	return removed;
}
