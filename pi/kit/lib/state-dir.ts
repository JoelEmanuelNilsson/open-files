/**
 * The kit's private state root, and the two rules every sink under it keeps.
 *
 * `$XDG_STATE_HOME/pi-kit` (`~/.local/state/pi-kit` by default), `0700` before
 * anything is written to it rather than after someone notices, and nothing kept
 * longer than it is read. Not `/tmp`, which is world-readable and where the
 * previous generation of hand-rolled probes left whole conversations lying at
 * mode 644 (issue 18).
 *
 * Lifted out of `wire-trace.ts` when the notice sink became the second writer
 * under this root. A leaf both of them can depend on beats the lowest-level
 * module in the kit importing one of the highest to reach ten lines of path
 * arithmetic.
 */

import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The kit's private state root. Every sink the package opens hangs off it. */
export function stateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-kit");
}

/** Create a sink directory `0700` regardless of umask, and return it. */
export function ensurePrivateDir(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

/**
 * Drop files under `dir` older than `maxAgeMs`, and return how many went.
 * A forensic log nobody reads is just residue.
 */
export function pruneOlderThan(dir: string, maxAgeMs: number, now = Date.now()): number {
	let removed = 0;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		try {
			if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
			rmSync(path, { force: true });
			removed++;
		} catch {
			// A file that vanished under us needs no pruning.
		}
	}
	return removed;
}
