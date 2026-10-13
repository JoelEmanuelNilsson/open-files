/**
 * One run's lifecycle, offline, at the edges where a start, a stop, a send and
 * a settle overlap: refused spawns leave no worktree, a message to a stopping
 * run resumes it, two sends resume once, a resumed worktree agent gets its
 * worktree back and settles it, a stop while starting ends the agent stopped,
 * two spawns under one name each run, a failed worktree settle is reported,
 * and a superseded run resumed by task id holds its name in memory and on reload.
 */

import { check, finish } from "../support/check-harness.mjs";
import { inFlightRig, jiti, lastUserText, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";

const { liveAgentsOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
const rig = await inFlightRig();
const { AgentRuntime, repo, gate, deps, port, prompted } = rig;
const worktreeCount = () => execSync("git worktree list", { cwd: repo, encoding: "utf8" }).trim().split("\n").length;
const promptsWith = (fragment) => requests.filter((r) => lastUserText({ messages: r.messages }).includes(fragment)).length;
const settledIn = (runtime, seat) => until(() => liveAgentsOf(seat).size === 0 && runtime.registry.all().every((record) => !["queued", "running"].includes(record.status)), 8000);
const loggingExec = (log, over = {}) => {
	const exec = deps().exec;
	return async (command, args, options) => {
		if (command === "git" && args[0] === "worktree" && ["add", "lock", "unlock", "remove"].includes(args[1])) {
			log.push(args[1]);
			if (over[args[1]]) return over[args[1]]();
		}
		return exec(command, args, options);
	};
};

{
	console.log("\nisolation and cwd together");
	const runtime = new AgentRuntime(deps(), port("life-cwd-seat", []), []);
	const before = worktreeCount();
	const refused = await runtime.spawn({ description: "both", prompt: "Life both.", name: "life-both", isolation: "worktree", cwd: repo }).then(() => undefined, (error) => error);
	check("a spawn naming both isolation and cwd is refused", refused?.reason === "cwd", refused?.message);
	check("and leaves `git worktree list` unchanged", worktreeCount() === before, `${before} -> ${worktreeCount()}`);
	await runtime.retire("shutdown");
}

{
	console.log("\na message sent while a stop is in flight");
	const runtime = new AgentRuntime(deps(), port("life-stop-send-seat", []), []);
	scriptFor("Life long turn.", [{ delay: 30000, content: [text("long")] }]);
	scriptFor("LIFE-LATE-MSG", [[text("got the late message")]]);
	const spawned = await runtime.spawn({ description: "long", prompt: "Life long turn.", name: "life-stop-send" });
	await until(() => prompted("Life long turn."), 5000);
	const stopping = runtime.stop(spawned.taskId, "TaskStop");
	const sent = await runtime.send("life-stop-send", "LIFE-LATE-MSG", false, "Joel").then((outcome) => outcome.kind, (error) => `threw ${error.message}`);
	await stopping;
	await settledIn(runtime, "life-stop-send-seat");
	check("a message to a stopping run resumes it once the stop settles", sent === "resumed", sent);
	check("and reaches the model", await until(() => prompted("LIFE-LATE-MSG"), 5000));
	await runtime.retire("shutdown");
}

{
	console.log("\ntwo sends to one finished agent in one tick");
	let loads = 0;
	const base = deps();
	const runtime = new AgentRuntime({ ...base, childLoader: (options) => (loads++, base.childLoader(options)) }, port("life-double-seat", []), []);
	scriptFor("Life double first.", [[text("first done")]]);
	scriptFor("LIFE-DOUBLE-A", [[text("a done")]]);
	scriptFor("LIFE-DOUBLE-B", [[text("b done")]]);
	const spawned = await runtime.spawn({ description: "double", prompt: "Life double first.", name: "life-double" });
	await until(() => runtime.registry.byTaskId(spawned.taskId)?.status === "completed", 8000);
	loads = 0;
	const kinds = await Promise.all(["LIFE-DOUBLE-A", "LIFE-DOUBLE-B"].map((message) => runtime.send("life-double", message, false, "Joel").then((outcome) => outcome.kind, (error) => `threw ${error.message}`)));
	await settledIn(runtime, "life-double-seat");
	check("two concurrent sends resume the agent once", loads === 1, `loads=${loads} kinds=${kinds}`);
	check("the first resumes, the second is queued behind it", kinds.join() === "resumed,queued", kinds.join());
	check("and both messages reach the model", await until(() => prompted("LIFE-DOUBLE-A") && prompted("LIFE-DOUBLE-B"), 5000));
	await runtime.retire("shutdown");
}

for (const [label, keep, reattach] of [
	["removed at its first settle", false, "add"],
	["kept at its first settle", true, "lock"],
]) {
	console.log(`\nresuming a worktree agent whose worktree was ${label}`);
	const seat = `life-resume-${reattach}-seat`;
	const name = `life-resume-${reattach}`;
	const log = [];
	const runtime = new AgentRuntime({ ...deps(), exec: loggingExec(log) }, port(seat, []), []);
	scriptFor(`Life resume ${reattach} first.`, [{ delay: 300, content: [text("first done")] }]);
	scriptFor(`LIFE-RESUME-${reattach}`, [[text("resumed done")]]);
	const spawned = await runtime.spawn({ description: "worktree", prompt: `Life resume ${reattach} first.`, name, isolation: "worktree" });
	if (keep) fs.writeFileSync(`${spawned.cwd}/left.txt`, "uncommitted");
	await until(() => runtime.registry.byTaskId(spawned.taskId)?.status === "completed", 8000);
	check(`its first settle unlocks the worktree (${label})`, log.join() === (keep ? "add,unlock" : "add,unlock,remove"), log.join());
	log.length = 0;
	const sent = await runtime.send(name, `LIFE-RESUME-${reattach}`, false, "Joel").then((outcome) => outcome.kind, (error) => `threw ${error.message}`);
	await settledIn(runtime, seat);
	const record = runtime.registry.byTaskId(spawned.taskId);
	check(`the resume reattaches the worktree with ${reattach} and the second settle unlocks it`, sent === "resumed" && log[0] === reattach && log.includes("unlock"), `${sent}: ${log.join()}`);
	check(`and the resumed result says where the work went (${label})`, /Worktree (kept at|on branch)/.test(record?.result ?? ""), record?.result);
	await runtime.retire("shutdown");
}

{
	console.log("\na stop while the agent is starting");
	const runtime = new AgentRuntime(deps(), port("life-stop-start-seat", []), []);
	scriptFor("Life stop while starting.", [[text("should not run")]]);
	const loading = gate("loader");
	const spawning = runtime.spawn({ description: "starting", prompt: "Life stop while starting.", name: "life-stop-start" }).catch((error) => error);
	await until(() => loading.reached, 5000);
	const stopping = runtime.stop("life-stop-start", "TaskStop").then((record) => record, (error) => error);
	loading.open();
	const stopped = await stopping;
	await spawning;
	await settledIn(runtime, "life-stop-start-seat");
	check("a stop while starting ends the agent stopped", stopped?.status === "stopped" && runtime.registry.byName("life-stop-start")?.status === "stopped", stopped?.status ?? stopped?.message);
	check("and it never prompts", !prompted("Life stop while starting."));
	await runtime.retire("shutdown");
}

{
	console.log("\ntwo spawns under one name at once");
	const persisted = [];
	const runtime = new AgentRuntime(deps(), port("life-same-name-seat", persisted), []);
	scriptFor("Life same name one.", [[text("one done")]]);
	scriptFor("Life same name two.", [[text("two done")]]);
	const loading = gate("loader");
	const spawns = ["one", "two"].map((n) => runtime.spawn({ description: n, prompt: `Life same name ${n}.`, name: "life-twin" }).catch((error) => error));
	await until(() => loading.reached, 5000);
	loading.open();
	await Promise.all(spawns);
	const taskIds = [...new Set(persisted.filter((record) => record.name === "life-twin").map((record) => record.taskId))];
	await settledIn(runtime, "life-same-name-seat");
	const statuses = taskIds.map((taskId) => runtime.registry.byTaskId(taskId)?.status);
	check("each spawn's record runs and completes under its own task id", taskIds.length === 2 && statuses.every((status) => status === "completed"), statuses.join());
	check("and each prompt reaches the model once", promptsWith("Life same name one.") === 1 && promptsWith("Life same name two.") === 1, `${promptsWith("Life same name one.")} ${promptsWith("Life same name two.")}`);
	await runtime.retire("shutdown");
}

{
	console.log("\na terminal record write that throws");
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(String(error?.message ?? error));
	process.on("unhandledRejection", onUnhandled);
	const seat = "life-persist-throws-seat";
	const runtime = new AgentRuntime(deps(), port(seat, [], { persist: (record) => { if (record.status === "completed") throw new Error("stale ctx on appendEntry"); } }), []);
	scriptFor("Life persist throws.", [[text("work done")]]);
	const spawned = await runtime.spawn({ description: "persist", prompt: "Life persist throws.", name: "life-persist-throws" });
	const released = await until(() => liveAgentsOf(seat).size === 0, 4000);
	process.off("unhandledRejection", onUnhandled);
	const record = runtime.registry.byTaskId(spawned.taskId);
	check("the run still releases its slot", released, `live=${liveAgentsOf(seat).size}`);
	check("and nothing escapes as an unhandled rejection", unhandled.length === 0, unhandled.join());
	check("and the record's result names the failed write", record?.status === "completed" && (record.result ?? "").includes("record write failed: stale ctx on appendEntry"), `${record?.status}: ${record?.result}`);
	await runtime.retire("shutdown");
}

{
	console.log("\na message queued while starting, then a stop");
	const runtime = new AgentRuntime(deps(), port("life-stop-queued-seat", []), []);
	scriptFor("Life stop queued.", [[text("should not run")]]);
	const loading = gate("loader");
	const spawning = runtime.spawn({ description: "queued", prompt: "Life stop queued.", name: "life-stop-queued" }).catch((error) => error);
	await until(() => loading.reached, 5000);
	const sent = await runtime.send("life-stop-queued", "LIFE-QUEUED-FIRST line\nsecond line", false, "Joel").then((outcome) => outcome.kind, (error) => `threw ${error.message}`);
	const stopping = runtime.stop("life-stop-queued", "TaskStop").then((record) => record, (error) => error);
	loading.open();
	const stopped = await stopping;
	await spawning;
	check("the message is queued, the stop ends the agent stopped", sent === "queued" && stopped?.status === "stopped", `${sent} ${stopped?.status ?? stopped?.message}`);
	check("and its result names the undelivered message by its first line", /1 queued message not delivered/.test(stopped?.result ?? "") && (stopped?.result ?? "").includes("- LIFE-QUEUED-FIRST line") && !(stopped?.result ?? "").includes("second line"), stopped?.result);
	await runtime.retire("shutdown");
}

{
	console.log("\na worktree settle that throws");
	const log = [];
	const runtime = new AgentRuntime({ ...deps(), exec: loggingExec(log, { unlock: () => Promise.reject(new Error("unlock exploded")) }) }, port("life-settle-throws-seat", []), []);
	scriptFor("Life settle throws.", [[text("work done")]]);
	const spawned = await runtime.spawn({ description: "throws", prompt: "Life settle throws.", name: "life-settle-throws", isolation: "worktree" });
	await settledIn(runtime, "life-settle-throws-seat");
	const record = runtime.registry.byTaskId(spawned.taskId);
	check("the result says the worktree settle failed and where the worktree was kept", (record?.result ?? "").includes(`worktree settle failed: unlock exploded; kept at ${spawned.cwd}`), record?.result);
	await runtime.retire("shutdown");
}

{
	console.log("\na superseded run resumed by task id");
	const { AGENT_RECORD_ENTRY, readAgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const seat = "life-resume-superseded-seat";
	const persisted = [];
	const runtime = new AgentRuntime(deps(), port(seat, persisted), []);
	scriptFor("Life superseded older.", [[text("older done")]]);
	scriptFor("Life superseded newer.", [[text("newer done")]]);
	scriptFor("LIFE-SUPERSEDED-RESUME", [[text("older resumed")]]);
	const older = await runtime.spawn({ description: "older", prompt: "Life superseded older.", name: "life-twice" });
	await settledIn(runtime, seat);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const newer = await runtime.spawn({ description: "newer", prompt: "Life superseded newer.", name: "life-twice" });
	await settledIn(runtime, seat);
	const holderBefore = runtime.registry.byName("life-twice")?.taskId;
	await new Promise((resolve) => setTimeout(resolve, 5));
	const sent = await runtime.send(older.taskId, "LIFE-SUPERSEDED-RESUME", false, "Joel").then((outcome) => outcome.kind, (error) => `threw ${error.message}`);
	await settledIn(runtime, seat);
	const inMemory = runtime.registry.byName("life-twice")?.taskId;
	const reloaded = readAgentRegistry(persisted.map((data) => ({ type: "custom", customType: AGENT_RECORD_ENTRY, data })), seat).get("life-twice")?.taskId;
	check("the newer spawn holds the name until the older run is resumed", holderBefore === newer.taskId, `${holderBefore} vs newer ${newer.taskId}`);
	check("the resumed run holds it in memory", sent === "resumed" && inMemory === older.taskId, `${sent}: ${inMemory} vs older ${older.taskId}`);
	check("and the same run holds it after a reload from the persisted entries", reloaded === inMemory, `reloaded ${reloaded}, in memory ${inMemory}`);
	await runtime.retire("shutdown");
}

await finish();
