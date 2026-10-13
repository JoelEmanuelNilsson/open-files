import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notice } from "../../lib/process/human-notice.ts";
import { childSeatOf } from "../../lib/session/seat-identity.ts";
import { agentGuards } from "./agent-guard-opt-in.ts";
import { scanRefusal } from "./bash-scan-guard.ts";
import { hostSleepRefusal } from "./host-sleep-guard.ts";
import { installRefusal } from "./install-guard.ts";
import { killRefusal } from "./kill-guard.ts";
import { worktreeFenceRefusal } from "./worktree-fence.ts";

export default function toolCallGuard(pi: ExtensionAPI) {
	const home = homedir();

	pi.on("tool_call", (event, ctx) => {
		try {
			const childSeat = childSeatOf(ctx.sessionManager.getSessionId());
			const repoGuards = childSeat === undefined ? undefined : agentGuards(ctx.cwd);
			// SAFETY: tool_call input is the tool's argument object; every field read is type-checked
			const input = event.input as Record<string, unknown> | undefined;
			const reason = scanRefusal(event.toolName, input, { home });
			if (reason !== undefined) return { block: true, reason };
			const agentReason = repoGuards !== undefined ? (hostSleepRefusal(event.toolName, input, repoGuards) ?? installRefusal(event.toolName, input, ctx.cwd)) : undefined;
			if (agentReason !== undefined) return { block: true, reason: agentReason };
			const fenceReason = childSeat !== undefined ? worktreeFenceRefusal(event.toolName, input, ctx.cwd, home) : undefined;
			if (fenceReason !== undefined) return { block: true, reason: fenceReason };
			const killReason = killRefusal(event.toolName, input, { ownTree: descendantsOfThisProcess, stopMine: hasStopMine(ctx.cwd) });
			if (killReason !== undefined) return { block: true, reason: killReason };
			return undefined;
		} catch (error) {
			notice(ctx, `tool-call-guard: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
	});
}

function descendantsOfThisProcess(): ReadonlySet<number> {
	const children = new Map<number, number[]>();
	try {
		for (const line of execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5000 }).split("\n")) {
			const [pid, ppid] = line.trim().split(/\s+/).map(Number);
			if (Number.isInteger(pid) && Number.isInteger(ppid)) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
		}
	} catch {
		return new Set();
	}
	const found = new Set<number>();
	const queue = [...(children.get(process.pid) ?? [])];
	while (queue.length > 0) {
		// SAFETY: the loop condition guarantees queue is non-empty
		const pid = queue.pop() as number;
		if (found.has(pid)) continue;
		found.add(pid);
		queue.push(...(children.get(pid) ?? []));
	}
	return found;
}

function hasStopMine(cwd: string): boolean {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, "scripts", "stop-mine.mjs"))) return true;
		if (dirname(dir) === dir) return false;
	}
}
