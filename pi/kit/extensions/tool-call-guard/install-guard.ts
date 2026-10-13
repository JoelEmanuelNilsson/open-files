import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lowerToolName } from "./tool-name.ts";
import { programSegments } from "../../lib/tools/shell-command-segments.ts";

const VALUED_OPTIONS = new Set(["--prefix", "-C", "--workspace", "-w", "--registry", "--userconfig", "--cache", "--filter", "-F", "--dir", "--cwd"]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

function subcommandOf(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		if (VALUED_OPTIONS.has(args[index])) index++;
		else if (!args[index].startsWith("-")) return args[index];
	}
	return undefined;
}

const INSTALL_COMMANDS = new Set(["install", "i", "ci", "add"]);

const REFUSAL =
	"Blocked: a dependency install in a worktree. The worktree's node_modules is linked from the main checkout; an install here replaces the link or nests a node_modules inside the main checkout's and has stuck the lander. " +
	"Change package.json and the lockfile by hand, commit, and land: the lander installs. If you need a package to try something, say so in your report.";

function inLinkedWorktree(dir: string): boolean {
	for (let current = dir; ; current = dirname(current)) {
		try {
			return statSync(join(current, ".git")).isFile();
		} catch {
			if (dirname(current) === current) return false;
		}
	}
}

/** Why this command's install must not run from `cwd`, or `undefined` if it may. */
export function installRefusal(toolName: unknown, input: Record<string, unknown> | undefined, cwd: string): string | undefined {
	const tool = lowerToolName(toolName);
	if (tool !== "bash" && tool !== "powershell") return undefined;
	const command = typeof input?.command === "string" ? input.command : "";
	let dir = cwd;
	for (const segment of programSegments(command)) {
		if (segment.program === "cd" && segment.args[0] !== undefined && /^[^-~$]/.test(segment.args[0])) dir = resolve(dir, segment.args[0]);
		if (!PACKAGE_MANAGERS.has(segment.program)) continue;
		const subcommand = subcommandOf(segment.args);
		const installs = subcommand === undefined ? segment.program === "yarn" && !segment.args.some((arg) => /^(?:-h|--help|-v|--version)$/.test(arg)) : INSTALL_COMMANDS.has(subcommand);
		if (installs && inLinkedWorktree(dir)) return REFUSAL;
	}
	return undefined;
}
