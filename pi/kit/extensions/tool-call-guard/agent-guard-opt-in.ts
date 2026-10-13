import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The repo opt-in file, relative to the repo root. */
export const AGENT_GUARDS_FILE = join(".pi", "kit-guards.json");

/** What an opted-in repo adds to the agent guards: its own host-shell wrappers (`<wrapper> ssh`) and its own text for how to wait. */
export interface RepoGuards {
	readonly hostWrappers: readonly string[];
	readonly waitWith: string | undefined;
}

export const NO_REPO_GUARDS: RepoGuards = { hostWrappers: [], waitWith: undefined };

/** The nearest opt-in file's guards when it says yes, or `undefined` when none does. */
export function agentGuards(cwd: string): RepoGuards | undefined {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const file = join(dir, AGENT_GUARDS_FILE);
		if (existsSync(file)) {
			try {
				const config = JSON.parse(readFileSync(file, "utf8"));
				if (config?.agentGuards !== true) return undefined;
				const wrappers = Array.isArray(config.hostWrappers) ? config.hostWrappers.filter((name: unknown) => typeof name === "string") : [];
				return { hostWrappers: wrappers, waitWith: typeof config.waitWith === "string" ? config.waitWith : undefined };
			} catch {
				return undefined;
			}
		}
		if (dirname(dir) === dir) return undefined;
	}
}
