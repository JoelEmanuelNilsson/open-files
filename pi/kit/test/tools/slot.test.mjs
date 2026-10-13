/**
 * `bin/slot`, the machine-wide core budget: the exit code, SLOT_CORES, first
 * come first served, and reclaiming a holder that died. Each check runs
 * against its own state directory, never the machine's.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SLOT = path.resolve(KIT_ROOT, "../../bin/slot");

function stateDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "slot-"));
}

function run(state, args, budget = "4") {
	return spawnSync(SLOT, args, { env: { ...process.env, SLOT_STATE_DIR: state, SLOT_BUDGET: budget }, encoding: "utf8", timeout: 20_000 });
}

function start(state, args, budget = "4") {
	const child = spawn(SLOT, args, { env: { ...process.env, SLOT_STATE_DIR: state, SLOT_BUDGET: budget }, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
	return { child, done };
}

function entries(state, dir) {
	return fs.existsSync(path.join(state, dir)) ? fs.readdirSync(path.join(state, dir)).length : 0;
}

async function until(test, ms = 10_000) {
	const end = Date.now() + ms;
	while (!test()) {
		if (Date.now() > end) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
}

console.log("slot");
{
	const state = stateDir();
	check("the command's exit code is slot's", run(state, ["--cores", "1", "--", "sh", "-c", "exit 7"]).status === 7);
	check("a usage error is 64 and runs nothing", run(state, ["--cores", "1", "sh"]).status === 64 && run(state, ["mystery", "1", "--", "true"]).status === 64);
	check("SLOT_CORES carries the cores asked for", run(state, ["--cores", "3", "--", "sh", "-c", "echo $SLOT_CORES"]).stdout.trim() === "3");
	check("the quick pool reserves 2, whatever its old <n>", run(state, ["quick", "3", "--", "sh", "-c", "echo $SLOT_CORES"]).stdout.trim() === "2");
	check("a request over the budget is cut to the budget", run(state, ["--cores", "9", "--", "sh", "-c", "echo $SLOT_CORES"], "4").stdout.trim() === "4");
	fs.writeFileSync(path.join(state, "budget"), "5\n");
	check("the budget file sets the budget when SLOT_BUDGET is unset", spawnSync(SLOT, ["--cores", "9", "--", "sh", "-c", "echo $SLOT_CORES"], { env: { ...process.env, SLOT_STATE_DIR: state, SLOT_BUDGET: "" }, encoding: "utf8" }).stdout.trim() === "5");
}
{
	const state = stateDir();
	const order = path.join(state, "order");
	const log = (name, seconds) => ["sh", "-c", `echo ${name} >> ${order}; sleep ${seconds}`];
	const a = start(state, ["--cores", "3", "--", ...log("a", 1.5)]);
	await until(() => fs.existsSync(order));
	const b = start(state, ["--cores", "4", "--", ...log("b", 0.5)]);
	await until(() => entries(state, "queue") === 1);
	// c fits beside a, but b is ahead of it in the queue.
	const c = start(state, ["--cores", "1", "--", ...log("c", 0)]);
	const [, , waited] = await Promise.all([a.done, b.done, c.done]);
	check("waiters are served first come, first served, not by what fits", fs.readFileSync(order, "utf8") === "a\nb\nc\n", fs.readFileSync(order, "utf8"));
	check("a waiter prints who holds the cores", waited.stderr.includes("Held by:") && waited.stderr.includes("sleep 1.5"), waited.stderr);
}
{
	const state = stateDir();
	const holder = start(state, ["--cores", "2", "--", "sleep", "30"], "2");
	await until(() => entries(state, "held") === 1);
	holder.child.kill("SIGKILL");
	await holder.done;
	const t0 = Date.now();
	const next = run(state, ["--cores", "2", "--", "true"], "2");
	check("a dead holder's cores are reclaimed", next.status === 0 && Date.now() - t0 < 5_000, `status ${next.status} after ${Date.now() - t0}ms`);
}

await finish();
