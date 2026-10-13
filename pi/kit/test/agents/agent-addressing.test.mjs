/**
 * Addressing an agent, offline: `TaskStop` on a run that ended, a task id
 * wherever a name goes, and the record of who stopped an agent.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, jiti, mainSeat, quiet, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

// ---------------------------------------------------------------------------
// TaskStop on a run that has already ended names the verdict (ticket 56)
//
// "is not running (error)" reads like an unknown name, so a seat that had just
// been handed the error went looking for the run instead of reading it.
// ---------------------------------------------------------------------------
{
	console.log("\nTaskStop on a run that already ended");
	const seat = await mainSeat();
	scriptFor("start one and stop it too late", [
		[call("Agent", { description: "brief job", prompt: "Be quick.", name: "quickie" })],
		{ delay: 700, content: [call("TaskStop", { name: "quickie" })] },
		[text("ok")],
	]);
	scriptFor("Be quick.", [[text("Done already.")]]);
	await seat.session.prompt("start one and stop it too late");
	await seat.session.waitForIdle();
	const late = seat.toolResults()[1]?.content[0].text ?? "";
	check("TaskStop on an ended run says it ended and which verdict it reached", late.startsWith('Agent "quickie" already ended (completed);'), late);
	check("and says where that verdict went, rather than sounding like an unknown name", late.includes("queued for your conversation") && !late.includes("is not running"), late);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A task id addresses an agent wherever its name does: the Agent and Workflow
// results print one next to "TaskOutput waits for it now" (Joel's defect 4)
// ---------------------------------------------------------------------------
{
	console.log("\na task id addresses an agent");
	const seat = await mainSeat();
	scriptFor("start the tagged one", [[call("Agent", { description: "tagged job", prompt: "Take a while, tagged.", name: "tagged" })], [text("started")]]);
	scriptFor("Take a while, tagged.", [{ delay: 1500, content: [text("tagged done")] }]);
	await seat.session.prompt("start the tagged one");
	await seat.session.waitForIdle();
	const taskId = /Task ID: (a[0-9a-f]{12})/.exec(seat.toolResults().at(-1)?.content[0].text ?? "")?.[1] ?? "no task id";
	scriptFor("wait for it by id", [[call("TaskOutput", { names: [taskId] })], [text("waited")]]);
	await seat.session.prompt("wait for it by id");
	await seat.session.waitForIdle();
	const waited = seat.toolResults().at(-1)?.content[0].text ?? "";
	check("TaskOutput waits on a task id and returns that agent's result", waited.includes("<result>tagged done</result>") && !waited.includes("Unknown agents"), waited);
	await quiet(seat);
	scriptFor("message it by id", [[call("SendMessage", { to: taskId, message: "one more, by id" })], [text("sent")]]);
	scriptFor("one more, by id", [[text("again")]]);
	await seat.session.prompt("message it by id");
	await seat.session.waitForIdle();
	const sentById = seat.toolResults().at(-1)?.content[0].text ?? "";
	check("SendMessage to a task id resumes that agent", sentById.startsWith("tagged resumed from its transcript"), sentById);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.name === "tagged").length === 2, 5000);
	await quiet(seat);
	scriptFor("stop it by id", [[call("TaskStop", { name: taskId })], [call("TaskOutput", { names: ["nobody", "a000000000000"] })], [text("done")]]);
	await seat.session.prompt("stop it by id");
	await seat.session.waitForIdle();
	const [stopped, unknown] = seat.toolResults().slice(-2).map((m) => m.content[0].text);
	check("TaskStop on a task id finds the agent", stopped?.startsWith('Agent "tagged" already ended (completed);'), stopped);
	check("names that are all unknown are reported as unknown, with no claim that there is nothing to report", unknown === "Unknown agents: nobody, a000000000000 — run ListAgents to see targets.", unknown);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A task id names its own run: once the name is reused, the older run's id
// must not reach the newest run under that name.
// ---------------------------------------------------------------------------
{
	console.log("\na task id from a run whose name was reused");
	const seat = await mainSeat();
	const taskIdOf = () => /Task ID: (a[0-9a-f]{12})/.exec(seat.toolResults().at(-1)?.content[0].text ?? "")?.[1] ?? "no task id";
	scriptFor("start the slow twin", [[call("Agent", { description: "slow twin", prompt: "Twin, slowly.", name: "twin" })], [text("started")]]);
	scriptFor("Twin, slowly.", [{ delay: 1200, content: [text("slow twin done")] }]);
	await seat.session.prompt("start the slow twin");
	await seat.session.waitForIdle();
	const slowId = taskIdOf();
	scriptFor("start the quick twin", [[call("Agent", { description: "quick twin", prompt: "Twin, quickly.", name: "twin" })], [text("started")]]);
	scriptFor("Twin, quickly.", [[text("quick twin done")]]);
	await seat.session.prompt("start the quick twin");
	await seat.session.waitForIdle();
	check("the name was reused under a new task id", taskIdOf() !== slowId && taskIdOf() !== "no task id", `${slowId} ${taskIdOf()}`);
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.result?.includes("quick twin done")), 3000);
	await quiet(seat);
	scriptFor("wait for the slow twin by id", [[call("TaskOutput", { names: [slowId] })], [text("waited")]]);
	await seat.session.prompt("wait for the slow twin by id");
	await seat.session.waitForIdle();
	const waited = seat.toolResults().at(-1)?.content[0].text ?? "";
	check("TaskOutput on the older run's task id waits for that run and returns its result", waited.includes("slow twin done") && !waited.includes("quick twin done"), waited);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// The agent view's follow-up key goes through `followUp`, which must resolve a
// task id the way `send` does, or a streaming agent gets a steer instead.
// ---------------------------------------------------------------------------
{
	console.log("\na follow-up addressed by task id");
	const { agentRuntimeOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const seat = await mainSeat();
	scriptFor("start the talker", [[call("Agent", { description: "talker", prompt: "Talk slowly.", name: "talker" })], [text("started")]]);
	scriptFor("Talk slowly.", [{ delay: 1500, content: [text("first answer")] }]);
	scriptFor("and after that", [[text("second answer")]]);
	await seat.session.prompt("start the talker");
	await seat.session.waitForIdle();
	const taskId = /Task ID: (a[0-9a-f]{12})/.exec(seat.toolResults().at(-1)?.content[0].text ?? "")?.[1] ?? "no task id";
	const runtime = agentRuntimeOf(seat.session.sessionId);
	await until(() => runtime?.liveRun(taskId)?.isStreaming === true, 3000);
	const child = runtime.liveRun(taskId);
	const followed = [];
	const followUp = child.followUp.bind(child);
	child.followUp = (message) => { followed.push(message); return followUp(message); };
	const delivered = await runtime.followUp(taskId, "and after that");
	check("a task id reaches the streaming agent's own follow-up queue", followed.join() === "and after that" && delivered.kind === "queued" && delivered.record.taskId === taskId, JSON.stringify({ followed, kind: delivered.kind }));
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "talker"), 5000);
	await quiet(seat);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Every stop names its caller (issues/31 (h)). The status is `stopped` whoever
// asked, so without this the session file cannot say which of five paths ran.
// ---------------------------------------------------------------------------
{
	console.log("\na stopped agent records who stopped it");
	const { claimScreen } = await jiti.import(`${KIT_ROOT}/lib/process/human-notice.ts`);
	const said = [];
	const release = claimScreen((message) => said.push(message));
	const seat = await mainSeat();
	scriptFor("start one and stop it", [[call("Agent", { description: "long runner", prompt: "Run for a while.", name: "long-runner" })], [call("TaskStop", { name: "long-runner" })], [text("stopped it")]]);
	scriptFor("Run for a while.", [{ delay: 30000, content: [text("too late")] }]);
	await seat.session.prompt("start one and stop it");
	await seat.session.waitForIdle();
	release();
	// issues/31 (h): the stop that killed two children was found in the record
	// hours later. A live line names the caller while Joel is still watching.
	check("the stop says on the screen who asked for it, as it happens", said.includes("agent long-runner: stopping \u2014 asked by TaskStop"), JSON.stringify(said));
	const last = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === "long-runner").pop()?.data;
	check("the record says it was stopped", last?.status === "stopped", String(last?.status));
	check("and the session file names the caller, so the next 11:33 is answerable", last?.stoppedBy === "TaskStop", String(last?.stoppedBy));
	seat.session.dispose();
}

await finish();
