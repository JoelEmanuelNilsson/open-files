/**
 * A child agent's background bash task, on real pi seats and a scripted model:
 * a child that waits for the task with `TaskOutput` is resumed with its exit
 * code; a child that ends with a task still running has it killed and named in
 * its result, and a stopped child's task is killed the same way.
 */

import { check, finish } from "../support/check-harness.mjs";
import { sleep, until } from "../support/async-waits.mjs";
import { childExtensionsList } from "../support/child-extensions.mjs";
import { createScriptedAgentDir, createScriptedModel, quietSeat, scriptedCall as call, scriptedMainSeat, scriptedText as text } from "../support/scripted-seat.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const { adoptBackgroundTask } = await kitJiti({ moduleCache: false }).import(`${KIT_ROOT}/lib/tools/background-tasks.ts`);

createScriptedAgentDir("agent-background-task", { "agents/lead.md": "---\nname: lead\ndescription: Coordinates a chunk end to end.\n---\n" });
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts", "extensions/bash/index.ts");
const scripted = createScriptedModel();
const { scriptFor } = scripted;
const SINK = fs.mkdtempSync(path.join(os.tmpdir(), "agent-background-task-"));
process.env.PI_KIT_BACKGROUND_DIR = path.join(SINK, "background");
// The engine's logs reach the notice sink when no UI is bound; keep them out of the real one.
process.env.XDG_STATE_HOME = SINK;
const gateFile = path.join(SINK, "gate");

const alive = (pid) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};
const completed = (seat, name) => seat.events.find((e) => (e.channel === "subagents:completed" || e.channel === "subagents:failed") && e.name === name);
/** When the child briefed with `prompt` asked for the turn that follows its backgrounded call: it is idle a step later. */
const backgroundedAt = (prompt) => scripted.requests.find((r) => r.messages.some((m) => JSON.stringify(m.content).includes(prompt)) && r.messages.at(-1)?.role === "toolResult" && JSON.stringify(r.messages.at(-1).content).includes("in the background as task"))?.at;

const seat = await scriptedMainSeat(scripted, { extensions: ["extensions/agent-engine/index.ts", "extensions/bash/index.ts"] });
seat.session.setActiveToolsByName([...seat.session.getActiveToolNames(), "TaskStop"]);

console.log("a child that waits on its background task with TaskOutput is resumed with the exit code");
{
	scriptFor("Start the builder", [[call("Agent", { description: "build", prompt: "Run the long build.", name: "builder" })], [text("spawned")]]);
	scriptFor("Run the long build.", [
		[call("bash", { command: `echo built; until [ -e ${gateFile} ]; do sleep 0.02; done; exit 3`, run_in_background: true })],
		[call("TaskOutput", { task: 1, timeout: 30_000 })],
		[text("the build exited 3")],
	]);
	await seat.session.prompt("Start the builder");
	const ended = await until(() => scripted.requests.some((r) => r.messages.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("Started in the background as task 1"))), 10_000, 20);
	check("the child's bash call was backgrounded, not refused", ended);
	check("the backgrounded result tells an agent to wait with TaskOutput before it ends", scripted.requests.some((r) => JSON.stringify(r.messages.at(-1)?.content ?? "").includes("a task still running when you end your turn is killed")));
	await sleep(500);
	check("the child waiting on the command is not done", completed(seat, "builder") === undefined, JSON.stringify(seat.events.map((e) => [e.channel, e.name])));
	fs.writeFileSync(gateFile, "");
	const settled = await until(() => completed(seat, "builder") !== undefined, 15_000, 20);
	const record = completed(seat, "builder");
	check("the command's end returns it to the child, and it finishes", settled && record?.channel === "subagents:completed", JSON.stringify(record));
	check("with the answer it gave after reading the exit code", record?.result?.includes("the build exited 3") && !record.result.includes("killed when the agent ended"), record?.result);
	const read = scripted.requests.find((r) => r.messages.at(-1)?.role === "toolResult" && JSON.stringify(r.messages.at(-1).content).includes("Failed (exit 3)"));
	check("the TaskOutput result carried the exit code", read !== undefined);
	await quietSeat(seat);
}

console.log("\na task that ends while its child is busy is steered in, and releases it");
{
	scriptFor("Start the quick one", [[call("Agent", { description: "quick", prompt: "Run the quick check.", name: "quick" })], [text("spawned")]]);
	scriptFor("Run the quick check.", [[call("bash", { command: "echo quick", run_in_background: true })], { delay: 1000, content: [text("still thinking")] }]);
	scriptFor("<background-task-notification>", [[text("the quick check passed")]]);
	await seat.session.prompt("Start the quick one");
	const settled = await until(() => completed(seat, "quick") !== undefined, 15_000, 20);
	check("the child finishes with the steered notice read", settled && completed(seat, "quick")?.result?.includes("the quick check passed"), JSON.stringify(completed(seat, "quick")));
	await quietSeat(seat);
}

console.log("\na child that ends with a task still running has it killed, and the parent is told");
{
	const pidFile = path.join(SINK, "sleeper.pid");
	scriptFor("Start the sleeper", [[call("Agent", { description: "sleep", prompt: "Sleep for a long time.", name: "sleeper" })], [text("spawned")]]);
	scriptFor("Sleep for a long time.", [[call("bash", { command: `echo $$ > ${pidFile}; sleep 60`, run_in_background: true })], [text("sleeping in the background")]]);
	await seat.session.prompt("Start the sleeper");
	const record = await until(() => completed(seat, "sleeper") !== undefined, 15_000, 20) ? completed(seat, "sleeper") : undefined;
	check("the child ends instead of waiting on its task", record?.status === "completed" && record?.result?.startsWith("sleeping in the background"), JSON.stringify(record));
	check("its result names the task: command, number, and that it was killed when the agent ended", /Background task 1 `echo .*sleep 60` killed when the agent ended \(log \S+\.log\)/.test(record?.result ?? ""), record?.result);
	const pidWritten = () => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8").trim()) > 0;
	check("the task wrote its pid", await until(pidWritten, 5_000, 20));
	const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
	check("and the task's process is dead", await until(() => !alive(pid), 5_000, 20));
	await quietSeat(seat);
}

console.log("\na stopped child's task is killed and the parent is told");
{
	const pidFile = path.join(SINK, "stopped.pid");
	scriptFor("Start the waiter", [[call("Agent", { description: "wait", prompt: "Wait on the remote run.", name: "waiter" })], [text("spawned")]]);
	scriptFor("Wait on the remote run.", [[call("bash", { command: `echo $$ > ${pidFile}; sleep 60`, run_in_background: true })], [call("TaskOutput", { task: 1, timeout: 60_000 })], [text("never reached")]]);
	await seat.session.prompt("Start the waiter");
	await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", 10_000, 20);
	const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
	await quietSeat(seat);
	check("the task is running while the child waits on it", alive(pid) && completed(seat, "waiter") === undefined);
	scriptFor("Stop the waiter", [[call("TaskStop", { name: "waiter" })], [text("stopped")]]);
	await seat.session.prompt("Stop the waiter");
	const record = await until(() => completed(seat, "waiter") !== undefined, 10_000, 20) ? completed(seat, "waiter") : undefined;
	check("the stop kills the task", await until(() => !alive(pid), 5_000, 20));
	check("and the stopped record names the killed task and its log", record?.status === "stopped" && /Background task 1 `echo .*sleep 60` killed when the agent ended \(log \S+\.log\)/.test(record?.result ?? ""), JSON.stringify(record));
	await quietSeat(seat);
}

console.log("\na lead waiting on its own agent stays live, then ends with its task killed");
{
	const SLOW_MS = 4000;
	scriptFor("Start the lead", [[call("Agent", { description: "lead", prompt: "Lead the slow work.", subagent_type: "lead", name: "boss" })], [text("spawned")]]);
	scriptFor("Lead the slow work.", [
		[call("Agent", { description: "slow", prompt: "Do the slow job.", name: "slow" })],
		[call("bash", { command: "sleep 60", run_in_background: true })],
		[text("lead waiting")],
		[text("worker done; still on my run")],
	]);
	scriptFor("Do the slow job.", [{ delay: SLOW_MS, content: [text("slow job done")] }]);
	await seat.session.prompt("Start the lead");
	await until(() => backgroundedAt("Lead the slow work.") !== undefined, 10_000, 20);
	await sleep(SLOW_MS / 2);
	check("while its agent runs the lead is live", completed(seat, "boss") === undefined);
	const record = (await until(() => completed(seat, "boss") !== undefined, 15_000, 20)) ? completed(seat, "boss") : undefined;
	check("once the agent is done the lead ends, its task killed and named", record?.status === "completed" && record?.result?.startsWith("worker done") && /Background task \d+ `sleep 60` killed when the agent ended/.test(record?.result ?? ""), JSON.stringify(record));
	await quietSeat(seat);
}

console.log("\nTaskStop by task number: your own task is killed with its group; another session's and unknown ones are refused");
{
	const childPid = path.join(SINK, "other.pid");
	scriptFor("Start the other", [[call("Agent", { description: "other", prompt: "Hold a task.", name: "other" })], [text("spawned")]]);
	scriptFor("Hold a task.", [[call("bash", { command: `echo $$ > ${childPid}; sleep 60`, run_in_background: true })], [call("TaskOutput", { task: 1, timeout: 60_000 })], [text("holding")]]);
	await seat.session.prompt("Start the other");
	await until(() => fs.existsSync(childPid) && fs.readFileSync(childPid, "utf8").trim() !== "", 10_000, 20);
	await quietSeat(seat);
	const stopTask = (params) => seat.tool("TaskStop").execute("stop", params).then((r) => r.content[0].text, (e) => String(e.message ?? e));
	const foreign = await stopTask({ task: 1 });
	check("a task of another session is refused, naming that it is not yours and what you hold", /No background task 1 of yours\. A task 1 belongs to another session.*Your running tasks: none/.test(foreign), foreign);
	check("and the other session's task still runs", alive(Number(fs.readFileSync(childPid, "utf8").trim())));
	const unknown = await stopTask({ task: 91 });
	check("an unknown id is refused, naming what exists", /No background task 91 of yours\. Your running tasks: none/.test(unknown), unknown);
	check("naming both or neither is refused", /exactly one/.test(await stopTask({ name: "other", task: 1 })) && /exactly one/.test(await stopTask({})));

	const mainPid = path.join(SINK, "mine.pid");
	scriptFor("Run mine", [[call("bash", { command: `echo $$ > ${mainPid}; sleep 60 & wait`, run_in_background: true })], [text("mine runs")]]);
	await seat.session.prompt("Run mine");
	await until(() => fs.existsSync(mainPid) && fs.readFileSync(mainPid, "utf8").trim() !== "", 10_000, 20);
	const pid = Number(fs.readFileSync(mainPid, "utf8").trim());
	check("the task runs", alive(pid));
	scriptFor("<background-task-notification>", [[text("noticed")]]);
	const stopResult = await seat.tool("TaskStop").execute("stop", { task: 1 });
	const stopped = stopResult.content[0].text;
	check("the stop says its notification follows", /Stopping background task 1; its notification follows/.test(stopped), stopped);
	check("and its details say the task is stopping, for the row", JSON.stringify(stopResult.details) === JSON.stringify({ kind: "task", id: 1, outcome: "stopping" }), JSON.stringify(stopResult.details));
	check("the process group is killed", await until(() => !alive(pid), 5_000, 20));
	const notified = () => seat.session.sessionManager.getEntries().find((e) => e.type === "custom_message" && e.customType === "background-task-notification" && /Killed/.test(String(e.content)));
	check("the normal notice says it was killed", await until(() => notified() !== undefined, 10_000, 20), String(notified()?.content));
	await quietSeat(seat);
	scriptFor("Stop the other", [[call("TaskStop", { name: "other" })], [text("stopped")]]);
	await seat.session.prompt("Stop the other");
	check("agent stop by name is unchanged", await until(() => completed(seat, "other")?.status === "stopped" || completed(seat, "other") !== undefined, 10_000, 20));
	await quietSeat(seat);
}

console.log("\nTaskOutput by task number: waits for the group, returns exit and tail once; no duplicate notice; foreign and unknown refused");
{
	const readTask = (params) => seat.tool("TaskOutput").execute("read", params).then((r) => r.content[0].text, (e) => String(e.message ?? e));
	const notices = (id) => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "background-task-notification" && String(e.content).includes(`<task-id>${id}</task-id>`));
	const before = await readTask({ task: 77 });
	check("an unknown task is refused, naming what exists", /No background task 77 of yours\. Your running tasks: none/.test(before), before);
	check("names and task together is refused", /not both/.test(await readTask({ task: 1, names: ["x"] })));

	const flag = path.join(SINK, "go");
	scriptFor("Run reader", [[call("bash", { command: `while [ ! -e ${flag} ]; do sleep 0.05; done; echo tail-line; exit 3`, run_in_background: true })], [text("reader runs")]]);
	await seat.session.prompt("Run reader");
	const id = [...new Set(seat.session.sessionManager.getEntries().flatMap((e) => String(JSON.stringify(e)).match(/background as task (\d+)/g) ?? []))].map((m) => Number(m.match(/\d+/)[0])).at(-1);
	const running = await readTask({ task: id, block: false });
	check("block false returns the state and tail so far without waiting", /still running/.test(running) && /Output so far/.test(running), running);
	const waiting = seat.tool("TaskOutput").execute("read", { task: id, timeout: 20_000 });
	fs.writeFileSync(flag, "");
	const result = await waiting;
	const finished = result.content[0].text;
	check("the wait returns the exit status and the tail", /Failed \(exit 3\)/.test(finished) && /tail-line/.test(finished), finished);
	check("and its details say how the task ended, for the row", JSON.stringify(result.details) === JSON.stringify({ kind: "task", id, outcome: "finished", exitCode: 3, signal: null }), JSON.stringify(result.details));
	await new Promise((resolve) => setTimeout(resolve, 300));
	await quietSeat(seat);
	check("its completion notice is not delivered a second time", notices(id).length === 0, String(notices(id).length));
	check("a task read to its end is no longer readable", /No background task/.test(await readTask({ task: id })));
	const timed = path.join(SINK, "never");
	scriptFor("Run timed", [[call("bash", { command: `while [ ! -e ${timed} ]; do sleep 0.05; done`, run_in_background: true })], [text("timed runs")]]);
	await seat.session.prompt("Run timed");
	const timedId = id + 1;
	const out = await readTask({ task: timedId, timeout: 200 });
	check("a wait that times out says so and keeps the task", /Timed out: task \d+ is still running/.test(out), out);
	fs.writeFileSync(timed, "");
	await until(() => notices(timedId).length > 0, 10_000, 20);
	check("an unread task still notifies once", notices(timedId).length === 1);
	await quietSeat(seat);
}

console.log("\nTaskOutput and TaskStop on a task whose result is already noticed or ended: what the model reads");
{
	const owner = seat.session.sessionManager.getSessionId();
	const readTask = (params) => seat.tool("TaskOutput").execute("read", params).then((r) => r.content[0].text, (e) => String(e.message ?? e));
	const stopTask = (params) => seat.tool("TaskStop").execute("stop", params).then((r) => r.content[0].text, (e) => String(e.message ?? e));
	const logPath = path.join(SINK, "fake.log");
	fs.writeFileSync(logPath, "fake-tail\n");
	let kills = 0;
	const adopt = (id, verdict) => {
		const proc = { kill: () => { kills++; return false; }, exitedWith: { exitCode: 4, signal: null } };
		return adoptBackgroundTask(owner, { id, command: `fake ${id}`, logPath }, proc, () => verdict, Date.now());
	};
	adopt(901, "turned").finished({ exitCode: 4, signal: null });
	const read = await readTask({ task: 901 });
	check("TaskOutput on a noticed task says its result is queued for the conversation and not to wait again", /Task 901 has ended; its result is queued for your conversation/.test(read) && /do not wait again/.test(read), read);
	const stopNoticed = await stopTask({ task: 901 });
	check("TaskStop on a noticed task says it already ended and its result is in the conversation", /Background task 901 already ended; its result is in your conversation/.test(stopNoticed), stopNoticed);
	check("no kill was sent for it", kills === 0);

	adopt(902, "not-now").finished({ exitCode: 4, signal: null });
	const stopEnded = await stopTask({ task: 902 });
	check("TaskStop on an ended, unnoticed task says it already ended and carries the result", /Background task 902 already ended:\n/.test(stopEnded) && /exit 4/.test(stopEnded) && /fake-tail/.test(stopEnded), stopEnded);
	check("and no kill was sent for that either", kills === 0);
}

seat.session.dispose();
fs.rmSync(SINK, { recursive: true, force: true });
await finish();
