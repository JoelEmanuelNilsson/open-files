/**
 * The agent engine when a seat's session ends with work in flight, offline:
 * quit and /new retiring a live worktree child, and a child that ignores
 * abort. The seats are
 * `support/session-lifecycle-seat.mjs`'s.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, lastRecordOf, liveCount, mainSeat, scriptFor, seam, tempRepo, text } from "../support/session-lifecycle-seat.mjs";
import { loadPerCore, sleep, until } from "../support/async-waits.mjs";
import { childExtensionsList } from "../support/child-extensions.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sink = fs.mkdtempSync(path.join(os.tmpdir(), "retire-tasks-"));
process.env.PI_KIT_BACKGROUND_DIR = sink;
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts", "extensions/bash/index.ts");

// ---------------------------------------------------------------------------
// Retire: a shutdown nothing follows stops the runs while the seat can still
// write, so the file says `stopped` with the final cost and the worktree
// outcome instead of a `running` the fold later reads as `lost`.
// ---------------------------------------------------------------------------

console.log("\nquit and /new stop a live worktree child: stopped, final cost, worktree settled");
for (const via of ["quit", "new"]) {
	console.log(`  -- via ${via}`);
	const tag = `retire-${via}`;
	const repo = tempRepo();
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	const seat = await mainSeat({ cwd: repo });
	const main = seat.session();
	const file = main.sessionFile;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "works in a worktree", prompt: `${tag} child works`, name: tag, isolation: "worktree" })], [text("spawned")]]);
	scriptFor(`${tag} child works`, [[call("read", { path: "notes.txt" })], { content: [text("never finished")], live: { attach } }]);
	await main.prompt(`Spawn the ${tag} child`);
	await Promise.race([attached, sleep(8000 * loadPerCore())]);
	const worktree = lastRecordOf(file, tag)?.cwd;
	if (via === "quit") await seat.runtime.dispose();
	else await seat.runtime.newSession({});
	const record = lastRecordOf(file, tag);
	check(`${via}: the child's last record in the old file reads stopped, by shutdown`, record?.status === "stopped" && record.stoppedBy === "shutdown", `${record?.status} by ${record?.stoppedBy}`);
	check(`${via}: with its final cost`, record?.costUsd > 0, String(record?.costUsd));
	check(`${via}: and its worktree settled: removed, and the result says so`, worktree !== undefined && worktree !== repo && !fs.existsSync(worktree) && /Worktree on branch `agent\/[^`]+` had no changes and was removed\./.test(record?.result ?? ""), `${worktree} exists ${worktree !== undefined && fs.existsSync(worktree)}; result ${JSON.stringify(record?.result)}`);
	check(`${via}: nothing of it is live afterwards`, await until(() => liveCount() === 0, 3000), String(liveCount()));
	if (via === "new") seat.session().dispose();
	fs.rmSync(repo, { recursive: true, force: true });
}

console.log("\na child that ignores abort is cut off at the bound");
{
	const tag = "deaf-child";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	const seat = await mainSeat();
	const main = seat.session();
	const file = main.sessionFile;
	const runtime = seam.agentRuntimeOf(main.sessionId);
	scriptFor(`Spawn the ${tag}`, [[call("Agent", { description: "ignores abort", prompt: `${tag} works`, name: tag })], [text("spawned")]]);
	scriptFor(`${tag} works`, [{ content: [text("late words")], live: { attach }, ignoreAbort: true }]);
	await main.prompt(`Spawn the ${tag}`);
	const controls = await Promise.race([attached, sleep(8000 * loadPerCore())]);
	const started = Date.now();
	const quit = await Promise.race([seat.runtime.dispose().then(() => "returned"), sleep(6000 * loadPerCore()).then(() => "hung")]);
	const took = Date.now() - started;
	const record = lastRecordOf(file, tag);
	check("quit returns at the bound, not never", quit === "returned" && took >= 1500 && took < 4000 * loadPerCore(), `${quit} after ${took}ms`);
	check("stopped is written for the straggler", record?.status === "stopped" && record.stoppedBy === "shutdown", `${record?.status} by ${record?.stoppedBy}`);
	let refusal = "";
	try { runtime?.host.model(); } catch (error) { refusal = error.message; }
	check("and the link is retired", /is retired/.test(refusal), refusal);
	const bytes = fs.readFileSync(file);
	controls?.end();
	await until(() => liveCount() === 0, 3000);
	await sleep(100);
	check("the straggler's own late settle writes nothing", fs.readFileSync(file).equals(bytes));
}

console.log("\na child cut off at the bound names the background task its end killed");
{
	const tag = "deaf-tasker";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	const seat = await mainSeat();
	const main = seat.session();
	const file = main.sessionFile;
	scriptFor(`Spawn the ${tag}`, [[call("Agent", { description: "ignores abort", prompt: `${tag} works`, name: tag })], [text("spawned")]]);
	scriptFor(`${tag} works`, [
		[call("bash", { command: "echo $$; sleep 61", run_in_background: true })],
		{ content: [text("late words")], live: { attach }, ignoreAbort: true },
	]);
	await main.prompt(`Spawn the ${tag}`);
	const controls = await Promise.race([attached, sleep(8000 * loadPerCore())]);
	const log = fs.readdirSync(sink).find((name) => name.endsWith(".log"));
	await until(() => log !== undefined && fs.readFileSync(path.join(sink, log), "utf8").trim() !== "", 3000);
	const pid = log === undefined ? NaN : Number(fs.readFileSync(path.join(sink, log), "utf8").trim());
	await seat.runtime.dispose();
	const record = lastRecordOf(file, tag);
	check("the cut-off record names the task, killed when the agent ended", record?.status === "stopped" && /Background task 1 `echo \$\$; sleep 61` killed when the agent ended/.test(record?.result ?? ""), `${record?.status}: ${record?.result}`);
	const alive = (target) => {
		try { process.kill(target, 0); return true; } catch { return false; }
	};
	check("and the task is dead, its sleep with its shell", pid > 0 && (await until(() => !alive(pid) && !alive(-pid), 3000)), String(pid));
	controls?.end();
	await until(() => liveCount() === 0, 3000);
}

fs.rmSync(sink, { recursive: true, force: true });
await finish();
