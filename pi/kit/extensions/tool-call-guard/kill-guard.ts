import { lowerToolName } from "./tool-name.ts";
import { commandSegments, programSegments } from "../../lib/tools/shell-command-segments.ts";

const GENERIC_WAY_OUT = "Kill a pid you started: a literal pid from this session's own shells, or `$!`.";
const STOP_MINE_WAY_OUT =
	"`npm run stop-mine` lists this worktree's processes and `-- --yes` stops them; " +
	"otherwise kill a pid you started: a literal pid from this session's own shells, or `$!`.";

function killTargets(args: readonly string[]): readonly string[] {
	if (args[0] === "-l" || args[0] === "-L") return [];
	let index = args[0] === "-s" || args[0] === "-n" ? 2 : args[0] !== undefined && args[0] !== "--" && args[0].startsWith("-") ? 1 : 0;
	if (args[index] === "--") index++;
	return args.slice(index);
}

/** Why this command's kill must not run, or `undefined` if it may. */
export function killRefusal(toolName: unknown, input: Record<string, unknown> | undefined, { ownTree, stopMine }: { ownTree: () => ReadonlySet<number>; stopMine: boolean }): string | undefined {
	const tool = lowerToolName(toolName);
	if (tool !== "bash" && tool !== "powershell") return undefined;
	const refusal = (what: string): string => `Blocked: ${what}. ${stopMine ? STOP_MINE_WAY_OUT : GENERIC_WAY_OUT}`;
	const command = typeof input?.command === "string" ? input.command : "";
	const startedHere = new Set<string>();
	for (const tokens of commandSegments(command)) {
		for (const token of tokens) {
			const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=\$!$/.exec(token);
			if (assigned !== null) startedHere.add(assigned[1]);
		}
	}

	for (const { program, args, wrappers } of programSegments(command)) {
		if (program === "pkill" || program === "killall") return refusal(`\`${program}\` signals every process whose name matches, other seats' included`);
		if (program !== "kill") continue;
		if (wrappers.includes("xargs")) return refusal("`xargs kill` signals pids read from input, which the guard cannot check");
		for (const target of killTargets(args)) {
			if (target.startsWith("%") || target === "$!") continue;
			const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(target);
			if (variable !== null && startedHere.has(variable[1])) continue;
			if (target === "0" || target.startsWith("-")) return refusal(`\`kill ${target}\` signals a whole process group`);
			if (!/^\d+$/.test(target)) return refusal(`\`kill ${target}\`: a target the guard cannot read, so it may be anyone's process`);
			if (!ownTree().has(Number(target))) return refusal(`\`kill ${target}\`: pid ${target} is not a process this session started`);
		}
	}
	return undefined;
}
