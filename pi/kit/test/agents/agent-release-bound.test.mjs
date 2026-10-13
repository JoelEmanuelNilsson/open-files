/**
 * A run's release finishes whatever its steps do, offline: a runtime dispose
 * that never settles is cut off at the step bound and named in the stop's
 * result, a throwing log and record write still free the slot, and a record
 * write that throws during a retire's cut-off still ends every run.
 */

import { check, finish } from "../support/check-harness.mjs";
import { DefaultResourceLoader, getAgentDir, inFlightRig, jiti, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

const { liveAgentsOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
const { AgentRuntime, gate, deps, port, prompted } = await inFlightRig();
const terminal = (record) => !["queued", "running"].includes(record.status);

{
	console.log("\na runtime dispose that never settles");
	const seat = "release-dispose-hangs-seat";
	const childLoader = async ({ cwd }) => {
		const hangsOnShutdown = (pi) => pi.on("session_shutdown", () => new Promise(() => {}));
		const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [hangsOnShutdown] });
		await loader.reload();
		return loader;
	};
	const runtime = new AgentRuntime({ ...deps(), childLoader }, port(seat, []), []);
	scriptFor("Release dispose hangs.", [{ delay: 30000, content: [text("never")] }]);
	await runtime.spawn({ description: "hangs", prompt: "Release dispose hangs.", name: "release-dispose-hangs" });
	await until(() => prompted("Release dispose hangs."), 5000);
	const started = Date.now();
	const stopped = await runtime.stop("release-dispose-hangs", "TaskStop").then((record) => record, (error) => error);
	const took = Date.now() - started;
	check("the stop resolves at the step bound, not never", stopped?.status === "stopped" && took >= 1500 && took < 4000, `${stopped?.status ?? stopped?.message} after ${took}ms`);
	check("and its result names the dispose that did not finish", (stopped?.result ?? "").includes("runtime dispose did not finish within 2 s"), stopped?.result);
	check("and the slot is free", liveAgentsOf(seat).size === 0, `live=${liveAgentsOf(seat).size}`);
	await runtime.retire("shutdown");
}

{
	console.log("\na throwing log and a throwing record write");
	const seat = "release-log-persist-throw-seat";
	const runtime = new AgentRuntime(
		deps(),
		port(seat, [], {
			persist: (record) => {
				if (terminal(record)) throw new Error("stale ctx on appendEntry");
			},
			log: () => {
				throw new Error("stale ctx on hasUI");
			},
		}),
		[],
	);
	scriptFor("Release log persist throw.", [{ delay: 30000, content: [text("never")] }]);
	await runtime.spawn({ description: "throws", prompt: "Release log persist throw.", name: "release-log-persist-throw" });
	await until(() => prompted("Release log persist throw."), 5000);
	const stopped = await Promise.race([runtime.stop("release-log-persist-throw", "TaskStop").then((record) => record, (error) => error), new Promise((resolve) => setTimeout(() => resolve("pending"), 4000))]);
	check("the stop resolves", stopped !== "pending" && stopped?.status === "stopped", stopped?.status ?? stopped?.message ?? stopped);
	check("and the slot is free", liveAgentsOf(seat).size === 0, `live=${liveAgentsOf(seat).size}`);
	check("and the result names the failed write", (stopped?.result ?? "").includes("record write failed: stale ctx on appendEntry"), stopped?.result);
	await runtime.retire("shutdown");
}

{
	console.log("\na record write that throws during a retire's cut-off");
	const seat = "release-retire-persist-throw-seat";
	let throwing = false;
	const runtime = new AgentRuntime(
		deps(),
		port(seat, [], {
			persist: () => {
				if (throwing) throw new Error("stale ctx on appendEntry");
			},
		}),
		[],
	);
	const names = ["release-cut-one", "release-cut-two"];
	for (const name of names) scriptFor(`${name} works.`, [[text(`${name} done`)]]);
	const removing = gate("remove");
	for (const name of names) await runtime.spawn({ description: name, prompt: `${name} works.`, name, isolation: "worktree" });
	await until(() => removing.reached && names.every((name) => prompted(`${name} works.`)), 5000);
	throwing = true;
	const retired = await Promise.race([runtime.retire("shutdown").then(() => "retired"), new Promise((resolve) => setTimeout(() => resolve("pending"), 6000))]);
	removing.open();
	const records = names.map((name) => runtime.registry.byName(name));
	check("the retire resolves", retired === "retired", retired);
	check("and every run ends: no slot is left live", liveAgentsOf(seat).size === 0, `live=${liveAgentsOf(seat).size}`);
	check("and each run's record is terminal", records.every((record) => record !== undefined && terminal(record)), records.map((record) => record?.status).join());
}

await finish();
