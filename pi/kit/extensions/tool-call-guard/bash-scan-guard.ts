import { isAbsolute } from "node:path";
import { lowerToolName } from "./tool-name.ts";
import { programSegments } from "../../lib/tools/shell-command-segments.ts";

const SCANNERS: Record<string, "leading" | "trailing"> = {
	find: "leading",
	fd: "trailing",
	rg: "trailing",
	ag: "trailing",
	ack: "trailing",
};

const GREP_REFUSAL =
	"Blocked: recursive grep. Use rg — same job, parallel, measured here at 0.96s where grep -r hit the 120s kill. " +
	"rg skips gitignored files by default; add -uu to search ignored and hidden files too.";

const isRecursiveGrepFlag = (arg: string): boolean =>
	/^-[A-Za-z]*[rR]/.test(arg) || arg === "--recursive" || arg === "--dereference-recursive";

export function scanRefusal(toolName: unknown, input: Record<string, unknown> | undefined, { home }: { home: string }): string | undefined {
	const tool = lowerToolName(toolName);
	if (tool !== "bash" && tool !== "powershell") return undefined;
	const command = typeof input?.command === "string" ? input.command : "";
	if (recursiveGrepIn(command)) return GREP_REFUSAL;
	const hit = broadScanIn(command, home);
	if (hit === undefined) return undefined;
	return refusal(`\`${hit.program}\` at ${describeRoot(hit.root, home)}`, "Re-run it rooted at a specific path — `.` for this directory, or a named subtree");
}

const refusal = (what: string, remedy: string): string =>
	`Blocked: ${what}. A scan rooted at the filesystem root or your home directory walks every mounted volume, ` +
	`takes many minutes, and has wedged this harness before. ${remedy}, then try again.`;

const describeRoot = (root: string, home: string): string => (root === "/" ? "/" : root === home ? `${root} (your home directory)` : root);

function recursiveGrepIn(command: string): boolean {
	for (const { program, args } of programSegments(command)) {
		if (program !== "grep") continue;
		if (args.some(isRecursiveGrepFlag)) return true;
	}
	return false;
}

function broadScanIn(command: string, home: string): { program: string; root: string } | undefined {
	for (const { program, args } of programSegments(command)) {
		const placement = SCANNERS[program];
		if (placement === undefined) continue;
		for (const arg of placement === "leading" ? leadingRoots(args) : trailingRoots(args, program)) {
			const root = literalRoot(arg, home);
			if (root !== undefined) return { program, root };
		}
	}
	return undefined;
}

function leadingRoots(args: readonly string[]): string[] {
	const roots: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("-")) {
			if (roots.length > 0) break;
			continue;
		}
		roots.push(arg);
	}
	return roots;
}

function trailingRoots(args: readonly string[], program: string): string[] {
	const words = args.filter((arg) => !arg.startsWith("-"));
	const listsFiles = args.includes(program === "ack" ? "-f" : "--files");
	return listsFiles ? words : words.slice(1);
}

function literalRoot(token: string, home: string): string | undefined {
	if (token === "/") return "/";
	if (token === "~" || token === "~/" || token === "$HOME" || token === "${HOME}" || token === "$HOME/" || token === "${HOME}/") return home;
	if (isAbsolute(token) && trimSlash(token) === trimSlash(home)) return home;
	return undefined;
}

const trimSlash = (value: string): string => value.replace(/\/+$/, "");
