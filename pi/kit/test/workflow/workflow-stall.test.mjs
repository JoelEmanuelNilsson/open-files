/**
 * Workflow stall detection, offline: a child that stalls on every attempt, one
 * that answers on its second, and a silent tool that is work, not a stall
 * (ticket 54 §4). What counts as progress is `workflow-stall-progress.test.mjs`.
 * The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, lastUserText, mainSeat, quiet, requests, scriptFor, text } from "../support/workflow-seat.mjs";
import { loadPerCore, until } from "../support/async-waits.mjs";
import os from "node:os";
import path from "node:path";

// D: stall detection — no tokens, no tool call and no turn end for stallMs, with no tool running, is a stall (ticket 54 §4)
{
	console.log("\nWorkflow: stall detection");
	const seat = await mainSeat();
	// A child that must not stall gets a deadline stretched by the machine load, and its silent tool a proportionally longer sleep.
	const load = Math.ceil(loadPerCore());
	scriptFor("run the dozing workflow", [[call("Workflow", { script: `${META}return { got: await agent('Doze off.', { label: 'dozer', stallMs: 1000 }) }` })], [text("started")]]);
	scriptFor("Doze off.", [{ delay: 20000, content: [text("eventually")] }, { delay: 20000, content: [text("eventually")] }, { delay: 20000, content: [text("eventually")] }]);
	await seat.session.prompt("run the dozing workflow");
	await seat.session.waitForIdle();
	const landed = await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 15000);
	await quiet(seat);
	const dozed = seat.events.find((e) => e.channel === "subagents:completed" && e.type === "workflow");
	const dozers = seat.events.filter((e) => e.channel === "subagents:failed" && e.name.startsWith("dozer") && e.status === "stopped").map((e) => e.name);
	check("a child that stalls on every attempt is started fresh three times in all, then its slot is null", landed && dozed?.result?.startsWith('{\n  "got": null\n}') && dozers.join() === "dozer,dozer-1,dozer-2", `${dozed?.result} · ${dozers.join()}`);
	check("the failure reads as a stall on all three attempts, in seconds", seat.progress.some((p) => p.type === "agent-failed" && p.reason === "stalled on all 3 attempts (no progress for 1s each)"), seat.progress.filter((p) => p.type === "agent-failed").map((p) => p.reason).join());
	const retryLogs = seat.progress.filter((p) => p.type === "log" && p.message.startsWith("dozer stalled"));
	check("each fresh start is written to the run log", retryLogs.map((p) => p.message).join(" | ") === "dozer stalled (no progress for 1s); starting it again fresh, attempt 2 of 3 | dozer stalled (no progress for 1s); starting it again fresh, attempt 3 of 3", retryLogs.map((p) => p.message).join(" | "));

	// A hung stream is what a stall means, and a fresh attempt is the remedy.
	scriptFor("run the napping workflow", [[call("Workflow", { script: `${META}return agent('Nap once.', { label: 'napper', stallMs: ${800 * load} })` })], [text("started")]]);
	scriptFor("Nap once.", [{ delay: 20000, content: [text("too late")] }, [text("awake now")]]);
	await seat.session.prompt("run the napping workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 15000);
	await quiet(seat);
	const napped = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1];
	check("a child that stalls once and answers on its second attempt returns that answer", napped?.result?.split("\n")[0] === "awake now" && !seat.progress.some((p) => p.type === "agent-failed" && p.reason.includes("napper")), `${napped?.result ?? napped?.error}`);

	// A tool that runs silent past stallMs — a test suite, a build — is work, not a stall.
	scriptFor("run the slow-tool workflow", [[call("Workflow", { script: `${META}return agent('Run the slow tool.', { label: 'builder', stallMs: ${600 * load} })` })], [text("started")]]);
	scriptFor("Run the slow tool.", [[call("bash", { command: `sleep ${1.5 * load}; echo built` })], [text("build finished")]]);
	await seat.session.prompt("run the slow-tool workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 3, 15000);
	await quiet(seat);
	const built = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[2];
	const builderTool = requests.filter((r) => lastUserText({ messages: r.messages }).includes("Run the slow tool.")).flatMap((r) => r.messages.filter((m) => m.role === "toolResult")).find((m) => m.toolName === "bash");
	check("a child whose one tool call runs silent for longer than stallMs is left alone", builderTool !== undefined && JSON.stringify(builderTool.content).includes("built") && built?.result?.split("\n")[0] === "build finished" && !seat.events.some((e) => e.name?.startsWith("builder") && e.status === "stopped"), `${built?.result ?? built?.error} · ${JSON.stringify(builderTool?.content)} · ${seat.events.filter((e) => e.name?.startsWith("builder")).map((e) => `${e.name}:${e.channel}:${e.status}`).join()}`);

	process.env.PI_KIT_BACKGROUND_DIR = path.join(os.tmpdir(), `stall-background-${process.pid}`);
	// A child waiting on its own background command is working: it waits on the command with TaskOutput.
	scriptFor("run the waiting workflow", [[call("Workflow", { script: `${META}return agent('Wait on a background command.', { label: 'waiter', stallMs: ${600 * load} })` })], [text("started")]]);
	scriptFor("Wait on a background command.", [[call("bash", { command: `sleep ${2 * load}; echo background-done`, run_in_background: true })], [call("TaskOutput", { task: 1, timeout: 20_000 })], [text("it finished")]]);
	await seat.session.prompt("run the waiting workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 4, 20000);
	await quiet(seat);
	const waited = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[3];
	check("a child waiting on its background command with TaskOutput is not stopped as stalled", waited?.result?.includes("it finished") === true && !seat.events.some((e) => e.name?.startsWith("waiter") && e.status === "stopped"), `${waited?.result ?? waited?.error} · ${seat.events.filter((e) => e.name?.startsWith("waiter")).map((e) => `${e.name}:${e.channel}:${e.status}`).join()}`);

	// The pause is for a child that is waiting: one whose model stream hangs while it owns a task still stalls.
	scriptFor("run the hung-with-task workflow", [[call("Workflow", { script: `${META}return agent('Hang with a task.', { label: 'hanger', stallMs: 600 })` })], [text("started")]]);
	const hangs = { delay: 20000, content: [text("too late")] };
	scriptFor("Hang with a task.", [[call("bash", { command: "sleep 30", run_in_background: true })], hangs, [call("bash", { command: "sleep 30", run_in_background: true })], hangs, [call("bash", { command: "sleep 30", run_in_background: true })], hangs]);
	await seat.session.prompt("run the hung-with-task workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 5, 25000);
	await quiet(seat);
	const hangers = seat.events.filter((e) => e.channel === "subagents:failed" && e.name.startsWith("hanger") && e.status === "stopped").map((e) => e.name);
	check("a child whose model stream hangs while it owns a background task is stopped as stalled", hangers.join() === "hanger,hanger-1,hanger-2", hangers.join());

	seat.session.dispose();
}

await finish();
