import { lowerToolName } from "./tool-name.ts";
import { commandSegments, programSegments } from "../../lib/tools/shell-command-segments.ts";
import { NO_REPO_GUARDS, type RepoGuards } from "./agent-guard-opt-in.ts";

const HOST_PROGRAMS = new Set(["ssh", "scp", "rsync", "mosh"]);


const RUNNERS = new Set(["timeout", "nohup", "nice", "setsid", "exec"]);

const SHELLS = new Set(["bash", "sh", "zsh"]);

const MAX_SLEEP_SEC = 5;

const SECONDS_PER_UNIT: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

const WAIT_WITH =
	"Run the command that waits, with run_in_background, and end your turn — its completion starts your next one: " +
	"the repo's own blocking command for a remote job, `aws ec2 wait …` for an instance.";

const waitWith = (guards: RepoGuards): string => (guards.waitWith === undefined ? WAIT_WITH : `${WAIT_WITH} ${guards.waitWith}`);

function sleepSeconds(args: readonly string[]): number | undefined {
	let total = 0;
	for (const arg of args) {
		const parts = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
		if (parts === null) return undefined;
		total += Number(parts[1]) * SECONDS_PER_UNIT[parts[2]];
	}
	return total;
}

const isLoopKeyword = (word: string | undefined): boolean => word === "while" || word === "until";

function innerProgram(program: string, args: readonly string[], boundSec?: number): { program: string; args: readonly string[]; boundSec: number | undefined } {
	if (!RUNNERS.has(program)) return { program, args, boundSec };
	let index = 0;
	let bound = boundSec;
	if (program === "timeout") {
		while (args[index]?.startsWith("-")) index += args[index] === "-k" || args[index] === "-s" ? 2 : 1;
		const limit = args[index] === undefined ? undefined : sleepSeconds([args[index]]);
		if (limit !== undefined) bound = bound === undefined ? limit : Math.min(bound, limit);
		index++;
	} else {
		while (args[index]?.startsWith("-")) index += (program === "nice" && args[index] === "-n") || (program === "exec" && args[index] === "-a") ? 2 : 1;
	}
	return args[index] === undefined ? { program, args, boundSec } : innerProgram(args[index], args.slice(index + 1), bound);
}

/** Why this command must not run in an agent seat, or `undefined` if it may. */
export function hostSleepRefusal(toolName: unknown, input: Record<string, unknown> | undefined, guards: RepoGuards = NO_REPO_GUARDS): string | undefined {
	const tool = lowerToolName(toolName);
	if (tool !== "bash" && tool !== "powershell") return undefined;
	return commandRefusal(typeof input?.command === "string" ? input.command : "", guards);
}

function commandRefusal(command: string, guards: RepoGuards): string | undefined {
	let inLoop = false;
	for (const tokens of commandSegments(command)) if (isLoopKeyword(tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)))) inLoop = true;
	for (const segment of programSegments(command)) {
		const { program, args, boundSec } = innerProgram(segment.program, segment.args);
		if (SHELLS.has(program)) {
			const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			const inner = flag === -1 || args[flag + 1] === undefined ? undefined : commandRefusal(args[flag + 1], guards);
			if (inner !== undefined) return inner;
		}
		if (HOST_PROGRAMS.has(program) || (guards.hostWrappers.includes(program) && args[0] === "ssh") || (program === "aws" && (args.includes("ec2-instance-connect") || (args.includes("ssm") && args.includes("start-session"))))) {
			return `Blocked: \`${program}\` — an agent seat has no host shell. ${waitWith(guards)}`;
		}
		if (program !== "sleep") continue;
		if (inLoop) return `Blocked: \`sleep\` in a while/until loop is polling. ${waitWith(guards)}`;
		if (boundSec !== undefined && boundSec <= MAX_SLEEP_SEC) continue;
		const seconds = sleepSeconds(args);
		if (seconds === undefined || seconds > MAX_SLEEP_SEC) return `Blocked: \`sleep ${args.join(" ")}\` waits longer than ${MAX_SLEEP_SEC}s or for a time the guard cannot read. ${waitWith(guards)}`;
	}
	return undefined;
}
