import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { checkoutLayout } from "../../lib/git/checkout-layout.ts";
import { programSegments, redirectTargets } from "../../lib/tools/shell-command-segments.ts";
import { editTargetPaths } from "../../lib/tools/edit-tool-params.ts";
import { lowerToolName } from "./tool-name.ts";

interface Fence {
	readonly worktree: string;
	readonly root: string;
}

// shared-state: a cache of each cwd's checkout layout; a second copy reads the same files and derives the same fence
const fences = new Map<string, Fence | null>();

/** The linked worktree holding `cwd` and the main checkout it belongs to. */
function fenceOf(cwd: string): Fence | undefined {
	const cached = fences.get(cwd);
	if (cached !== undefined) return cached ?? undefined;
	let found: Fence | null = null;
	try {
		const layout = checkoutLayout(realpathSync(cwd));
		if (layout?.worktree !== undefined) found = { worktree: layout.worktree, root: layout.mainRoot };
	} catch {
		found = null;
	}
	fences.set(cwd, found);
	return found ?? undefined;
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

function realish(path: string): string {
	for (let rest = "", current = path; ; rest = join(basename(current), rest), current = dirname(current)) {
		try {
			return join(realpathSync(current), rest);
		} catch {
			if (dirname(current) === current) return path;
		}
	}
}

function refusal(fence: Fence, relative: string): string {
	return (
		`Blocked: this seat runs in worktree ${fence.worktree}, and this reaches the main checkout ${fence.root}. ` +
		`Use the same path inside the worktree: ${join(fence.worktree, relative)}. ` +
		`To read main's version of a file, use \`git show main:<path>\`. Only ${join(fence.root, ".scratch")} is writable there.`
	);
}

const escapes = (target: string, fence: Fence): boolean =>
	within(target, fence.root) && !within(target, fence.worktree) && !within(target, join(fence.root, ".scratch"));

/** Why this call from a seat in `cwd` must not touch the main checkout of its linked worktree, or `undefined` if it may. */
export function worktreeFenceRefusal(toolName: unknown, input: Record<string, unknown> | undefined, cwd: string, home = homedir()): string | undefined {
	const tool = lowerToolName(toolName);
	const fence = fenceOf(cwd);
	if (fence === undefined) return undefined;
	const resolved = (base: string, raw: string): string => {
		const expanded = raw === "~" || raw.startsWith("~/") ? join(home, raw.slice(1)) : raw;
		return realish(resolve(base, expanded));
	};
	if (tool === "edit" || tool === "write") {
		for (const raw of editTargetPaths(input)) {
			const target = resolved(cwd, raw);
			if (escapes(target, fence)) return refusal(fence, target.slice(fence.root.length + 1));
		}
		return undefined;
	}
	if (tool !== "bash" && tool !== "powershell") return undefined;
	const command = typeof input?.command === "string" ? input.command : "";
	const reaches = (dir: string, words: readonly string[]): boolean => words.some((word) => word !== "" && escapes(resolved(dir, word), fence));
	const dirs = [cwd];
	for (const segment of programSegments(command)) {
		const dir = dirs[dirs.length - 1];
		const words = segment.args.map((arg) => (arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg));
		if (reaches(dir, words)) return refusal(fence, "<path>");
		if (segment.program === "cd" && segment.args[0] !== undefined && /^[^-$]/.test(segment.args[0])) dirs.push(resolved(dir, segment.args[0]));
	}
	const targets = redirectTargets(command);
	if (dirs.some((dir) => reaches(dir, targets))) return refusal(fence, "<path>");
	return undefined;
}
