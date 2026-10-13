/**
 * A spawn still in flight when its seat retires, offline, released within the
 * retire's bound and past it: the child never prompts and its worktree is
 * settled. The child loader is held at `inFlightRig`'s gate.
 */

import { check, finish } from "../support/check-harness.mjs";
import { inFlightRig, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { sleep, until } from "../support/async-waits.mjs";
import fs from "node:fs";

{
	console.log("\na spawn in flight at retire");
	const { AgentRuntime, repo, gate, deps, port, lastOf, prompted } = await inFlightRig();

	for (const [label, releaseAfterMs] of [["within the bound", 100], ["past the bound", 2500]]) {
		const persisted = [];
		const name = `late-spawn-${releaseAfterMs}`;
		const prompt = `Late spawn ${releaseAfterMs} works.`;
		const runtime = new AgentRuntime(deps(), port(`${name}-seat`, persisted), []);
		scriptFor(prompt, [[text("late spawn done")]]);
		const loading = gate("loader");
		const spawning = runtime.spawn({ description: "spawned as the seat quits", prompt, name, isolation: "worktree" }).catch((error) => error);
		await until(() => loading.reached, 5000);
		const worktree = lastOf(persisted, name)?.cwd;
		const retiring = runtime.retire("shutdown");
		await sleep(releaseAfterMs);
		loading.open();
		await retiring;
		await spawning;
		await sleep(500);
		check(`a child whose spawn was in flight at retire (${label}) never prompts`, !prompted(prompt));
		check(`and its worktree is settled (${label})`, worktree !== undefined && worktree !== repo && !fs.existsSync(worktree), `${worktree} exists ${worktree !== undefined && fs.existsSync(worktree)}`);
		if (releaseAfterMs < 2000) {
			const record = lastOf(persisted, name);
			check("within the bound, the retire waits for it and writes it stopped", record?.status === "stopped" && record.stoppedBy === "shutdown" && /had no changes and was removed/.test(record.result ?? ""), `${record?.status} by ${record?.stoppedBy}: ${record?.result}`);
		}
	}

}

await finish();
