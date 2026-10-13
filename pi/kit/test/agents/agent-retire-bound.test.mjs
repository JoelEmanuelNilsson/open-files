/**
 * A retire at its bound, offline: a settle still removing its worktree is cut
 * off there, a run that finished keeps the status it reached, and a spawn or
 * resume that begins once the seat is retiring is refused. The git removal is
 * held at `inFlightRig`'s gates.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, inFlightRig, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { loadPerCore, sleep, until } from "../support/async-waits.mjs";
import path from "node:path";

{
	console.log("\na retire at its bound");
	const { AgentRuntime, repo, gate, deps, port, lastOf, prompted } = await inFlightRig();

	{
		const persisted = [];
		const runtime = new AgentRuntime(deps(), port("slow-remove-seat", persisted), []);
		scriptFor("Slow remove works.", [{ delay: 30000, content: [text("never")] }]);
		const removing = gate("remove");
		await runtime.spawn({ description: "a worktree child", prompt: "Slow remove works.", name: "slow-remove", isolation: "worktree" });
		await until(() => prompted("Slow remove works."), 5000);
		const started = Date.now();
		await runtime.retire("shutdown");
		const took = Date.now() - started;
		const record = lastOf(persisted, "slow-remove");
		check("a settle still removing its worktree at the bound is cut off there", removing.reached && took >= 1500 && took < 4000 * loadPerCore(), `removal reached ${removing.reached}, retire took ${took}ms`);
		check("and stopped is written for it, never left running", record?.status === "stopped" && record.stoppedBy === "shutdown", `${record?.status} by ${record?.stoppedBy}`);
		const writes = persisted.length;
		removing.open();
		await sleep(500);
		check("its own settle, once the removal ends, writes nothing", persisted.length === writes, `${persisted.length - writes} late writes`);
	}

	{
		const persisted = [];
		const runtime = new AgentRuntime(deps(), port("finished-at-bound-seat", persisted), []);
		scriptFor("Finished child works.", [[text("finished before quit")]]);
		const removing = gate("remove");
		await runtime.spawn({ description: "finished, removing at quit", prompt: "Finished child works.", name: "finished-at-bound", isolation: "worktree" });
		await until(() => removing.reached, 5000);
		await runtime.retire("shutdown");
		const record = lastOf(persisted, "finished-at-bound");
		check("a run that finished and is still removing its worktree at the bound is written with the status it reached, not stopped", record?.status === "completed" && record.stoppedBy === undefined && record.result?.includes("finished before quit") === true, `${record?.status} by ${record?.stoppedBy}: ${record?.result}`);
		const writes = persisted.length;
		removing.open();
		await sleep(300);
		check("and its late settle, once the removal ends, leaves that record alone", persisted.length === writes && lastOf(persisted, "finished-at-bound") === record, `${persisted.length - writes} late writes`);
	}

	{
		const earlier = { name: "earlier", taskId: "t-earlier", ownerSessionId: "closing-seat", type: "worker", description: "d", status: "completed", depth: 1, sessionFile: path.join(AGENT_DIR, "no-such-transcript.jsonl"), sessionId: "s-earlier", cwd: repo, branch: undefined, model: "m", result: "r", error: undefined, readBy: "tool", readAt: Date.now(), toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: Date.now(), completedAt: Date.now(), toolCallId: undefined, workflowChild: false };
		const persisted = [];
		const runtime = new AgentRuntime(deps(), port("closing-seat", persisted), [earlier]);
		const retiring = runtime.retire("shutdown");
		const spawned = await runtime.spawn({ description: "too late", prompt: "Too late works.", name: "too-late", isolation: "worktree" }).then(() => undefined, (error) => error);
		const resumed = await runtime.send("earlier", "Too late.", false, "seat").then(() => undefined, (error) => error);
		await retiring;
		await sleep(300);
		check("a spawn that begins once the seat is retiring is refused, saying why", spawned?.reason === "retiring" && !persisted.some((r) => r.name === "too-late"), `${spawned?.reason}: ${spawned?.message}`);
		check("and so is a resume", resumed?.reason === "retiring", `${resumed?.reason}: ${resumed?.message}`);
	}

}

await finish();
