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

export function pruneOlderThan(dir: string, maxAgeMs: number, now = Date.now()): number {
	let removed = 0;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		try {
			if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
			rmSync(path, { force: true });
			removed++;
		} catch {
		}
	}
	return removed;
}
