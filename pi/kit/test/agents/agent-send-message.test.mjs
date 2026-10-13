/**
 * `SendMessage`, `ListAgents` and `TaskStop` by name, offline: a running agent
 * is steered, a finished one resumed from its transcript, a stop keeps the
 * text so far and takes the agent's own agents with it, and the dock's stop
 * request is answered on its reply channel.
 */

import { check, finish } from "../support/check-harness.mjs";
import { SessionManager, call, jiti, lastUserText, mainSeat, quiet, requests, runtimeOver, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

// ---------------------------------------------------------------------------
// SendMessage: a running agent is steered, a finished one is resumed by name
// ---------------------------------------------------------------------------
{
	console.log("\nSendMessage, ListAgents, TaskStop");
	const seat = await mainSeat();
	scriptFor("start then message", [
		[call("Agent", { description: "listener job", prompt: "Listen for a while.", name: "listener" }, "toolu_spawn_listener")],
		[call("SendMessage", { to: "listener", message: "also count the tests" })],
		[text("sent")],
	]);
	scriptFor("Listen for a while.", [{ delay: 300, content: [call("ListAgents", {})] }, [text("Heard: done listening.")]]);
	await seat.session.prompt("start then message");
	await seat.session.waitForIdle();
	const sent = seat.toolResults()[1];
	check("a message to a running agent is queued for its next step", sent?.content[0].text === "Sent to listener; it reads the message at its next step.", sent?.content[0]?.text);
	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 3000);
	const steered = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("also count the tests")));
	check("the child saw the message in its conversation", steered !== undefined);
	const steeredText = steered?.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join(""))).find((t) => t.includes("also count the tests"));
	check("stamped with its sender, so the child knows who asked and where the answer goes", steeredText?.startsWith("[From your parent, the main session. SendMessage can't reach it; anything it needs goes in your final reply.]\n\nalso count the tests"), steeredText);
	await quiet(seat);

	scriptFor("message the finished one", [[call("SendMessage", { to: "listener", message: "one more thing" }, "toolu_resume_listener")], [text("resumed")]]);
	scriptFor("one more thing", [[text("Resumed and done.")]]);
	await seat.session.prompt("message the finished one");
	await seat.session.waitForIdle();
	const resumed = seat.toolResults()[2];
	check("a message to a finished agent resumes it from its transcript", /^listener resumed from its transcript with your message \(task a[0-9a-f]{12}\)/.test(resumed?.content[0].text ?? ""), resumed?.content[0]?.text);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 3000);
	await quiet(seat);
	const resumedRequest = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("one more thing")));
	check("with its context intact: the earlier conversation precedes the new message", resumedRequest !== undefined && resumedRequest.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("ListAgents")) && resumedRequest.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("also count the tests")));
	const record = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data).filter((d) => d.name === "listener");
	// The task id is the agent's, not the run's: a fresh one gave the dock two
	// rows under one name, the older still asserting `completed` while it ran.
	check("the name still maps to one record and one task id across the resume", record.length >= 6 && record[record.length - 1].result === "Resumed and done." && record[0].taskId === record[record.length - 1].taskId);
	check("the resume announces itself on its own channel, so the row is revived rather than doubled", seat.events.filter((e) => e.channel === "subagents:resumed" && e.name === "listener").length === 1 && seat.events.filter((e) => e.channel === "subagents:created" && e.name === "listener").length === 1);

	scriptFor("who is there", [[call("ListAgents", {})], [text("listed")]]);
	await seat.session.prompt("who is there");
	await seat.session.waitForIdle();
	const listed = seat.toolResults()[3];
	// Money is diagnosis, and this row is where the model reads it (map C15).
	// It is never on a dock row: Joel reads time there.
	check("ListAgents reports a settled agent's cost — the model's only money", /\$/.test(listed?.content[0].text ?? ""), listed?.content[0]?.text);
	check("ListAgents: name, type, status, run time, cost, last result", /^listener \u00b7 worker \u00b7 completed \u00b7 ran \d+s( \u00b7 (\$[\d,.]+|<\$0\.01))? \u00b7 Resumed and done\.$/.test(listed?.content[0].text ?? ""), listed?.content[0]?.text);

	// One tool-use id per delivery. A resume used to reuse the `Agent` call's
	// id, so a genuinely new result looked exactly like a redelivery of the old
	// one (observed 2026-09-03: three runs, three task ids, one tool-use id).
	const deliveries = seat.customs().map((m) => m.content).join("\n");
	const useIds = [...deliveries.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)].map((m) => m[1]);
	check("each delivery carries its own tool-use id", useIds.length === 2 && new Set(useIds).size === 2, useIds.join());
	check("the first is the Agent call's, the resumed run's is the SendMessage call's", useIds[0] === "toolu_spawn_listener" && useIds[1] === "toolu_resume_listener", useIds.join());

	scriptFor("message nobody", [[call("SendMessage", { to: "ghost", message: "hi" })], [text("ok")]]);
	await seat.session.prompt("message nobody");
	await seat.session.waitForIdle();
	check("an unknown name is refused with a pointer to ListAgents", seat.toolResults()[4]?.isError === true && seat.toolResults()[4].content[0].text.includes('No agent named "ghost"'));
	check("on the main seat the refusal has no up-channel clause: there is no seat above it", seat.toolResults()[4]?.content[0].text === 'No agent named "ghost" among the agents you started. Run ListAgents to see targets.', seat.toolResults()[4]?.content[0].text);

	// TaskStop keeps the result so far and stops the agent's own agents.
	scriptFor("start a lead and stop it", [
		[call("Agent", { description: "lead job", prompt: "Lead the work.", subagent_type: "lead", name: "boss" })],
		[call("TaskStop", { name: "boss" })],
		[text("stopped")],
	]);
	scriptFor("Lead the work.", [
		[text("Starting a worker."), call("Agent", { description: "sub job", prompt: "Do the sub job.", name: "hand" })],
		{ delay: 2000, content: [text("never reached")] },
	]);
	scriptFor("Do the sub job.", [{ delay: 3000, content: [text("sub done")] }]);
	await seat.session.prompt("start a lead and stop it");
	await seat.session.waitForIdle();
	const stopped = seat.toolResults()[6];
	check("TaskStop stops a running agent and keeps its text so far", stopped?.content[0].text.startsWith("Stopped boss.") && stopped.content[0].text.includes("Starting a worker."), stopped?.content[0]?.text);
	const failed = seat.events.filter((e) => e.channel === "subagents:failed");
	check("the dock hears it as failed with status stopped", failed.some((e) => e.name === "boss" && e.status === "stopped"), JSON.stringify(failed.map((e) => [e.name, e.status])));
	const { liveAgentCount } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
	check("and the lead's own worker is gone with it", await until(() => liveAgentCount() === 0, 3000));

	// The dock's stop request, answered on its reply channel.
	scriptFor("start for the dock", [[call("Agent", { description: "dock job", prompt: "Wait for the dock.", name: "docked" })], [text("ok")]]);
	scriptFor("Wait for the dock.", [{ delay: 3000, content: [text("too late")] }]);
	await seat.session.prompt("start for the dock");
	await seat.session.waitForIdle();
	const taskId = seat.events.filter((e) => e.channel === "subagents:started").at(-1).id;
	let reply;
	const requestId = `agent-dock-1-${Date.now()}`;
	seat.bus.on(`subagents:rpc:stop:reply:${requestId}`, (r) => { reply = r; });
	seat.bus.emit("subagents:rpc:stop", { requestId, agentId: taskId });
	await until(() => reply !== undefined, 3000);
	check("subagents:rpc:stop by task id replies {success: true}", reply?.success === true, JSON.stringify(reply));
	let refusal;
	seat.bus.on(`subagents:rpc:stop:reply:${requestId}-again`, (r) => { refusal = r; });
	seat.bus.emit("subagents:rpc:stop", { requestId: `${requestId}-again`, agentId: taskId });
	await until(() => refusal !== undefined, 3000);
	check("a second stop is refused with a reason the dock can show", refusal?.success === false && /not running/.test(refusal.error), JSON.stringify(refusal));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A message to a live agent between turns returns at once; the turn it starts is the agent's
// ---------------------------------------------------------------------------
{
	// Observed 2026-09-25: a lead whose turn had ended, still live because its
	// worker ran, was prompted inside the sender's SendMessage. The sender sat
	// in that tool call for the lead's whole next turn (53 minutes), and Esc
	// could not end it.
	console.log("\nSendMessage to a live agent between turns");
	const { agentIsSettled } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const seat = await mainSeat();
	scriptFor("start a waiting lead", [[call("Agent", { description: "waiting lead", prompt: "Wait on your worker.", subagent_type: "lead", name: "waiter" })], [text("started")]]);
	scriptFor("Wait on your worker.", [[call("Agent", { description: "slow job", prompt: "Take your time.", name: "slowhand" })], [text("waiting on slowhand")]]);
	scriptFor("Take your time.", [{ delay: 4000, content: [text("slow done")] }]);
	await seat.session.prompt("start a waiting lead");
	await seat.session.waitForIdle();
	const leadTurnEnded = () => requests.some((r) => r.messages.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("Name: slowhand")));
	check("the lead ended its turn with its worker still running", await until(leadTurnEnded, 3000));
	await new Promise((resolve) => setTimeout(resolve, 100));

	scriptFor("message the waiting lead", [[call("SendMessage", { to: "waiter", message: "check the queue while you wait" })], [text("sent")]]);
	scriptFor("check the queue while you wait", [{ delay: 1500, content: [text("checked")] }]);
	await seat.session.prompt("message the waiting lead");
	await seat.session.waitForIdle();
	const sent = seat.toolResults().at(-1);
	check("the message is queued for the idle lead", sent?.content[0].text === "Sent to waiter; it reads the message at its next step.", sent?.content[0]?.text);
	const waiterRecords = () => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === "waiter").map((e) => e.data);
	const answered = () => waiterRecords().some((d) => agentIsSettled(d.status));
	const leadSaid = (t) => SessionManager.open(waiterRecords()[0].sessionFile).getEntries().some((e) => e.type === "message" && e.message.role === "assistant" && JSON.stringify(e.message.content).includes(t));
	check("the sender's turn ended before the lead's turn on that message did", !leadSaid("checked") && !answered(), "the SendMessage call waited for the lead's turn");
	check("the lead's run took the message as its next turn", await until(() => requests.some((r) => lastUserText(r).includes("check the queue while you wait")), 3000));
	check("and the lead still settles once its turn and its worker are done", await until(answered, 8000));
	await quiet(seat);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Messages go down the tree only: a child's answer goes in its final reply
// ---------------------------------------------------------------------------
{
	console.log("\na child cannot message the seat that started it");
	const { UP_CHANNEL_LINE } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-tool-text.ts`);
	const seat = await mainSeat();
	scriptFor("start one that answers up", [[call("Agent", { description: "upward job", prompt: "Answer the main session.", name: "upward" })], [text("started")]]);
	scriptFor("Answer the main session.", [[call("SendMessage", { to: "main", message: "done" })], [text("answered in my reply")]]);
	await seat.session.prompt("start one that answers up");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "upward"), 5000);
	await quiet(seat);
	const upward = SessionManager.open(seat.session.sessionFile).getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data).filter((d) => d.name === "upward").at(-1);
	const refusal = SessionManager.open(upward.sessionFile).getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult").map((e) => e.message.content.map((b) => b.text).join(""))[0];
	check("SendMessage to \"main\" is refused with the rule and the one channel up", refusal === `No agent named "main" among the agents you started. ${UP_CHANNEL_LINE} Run ListAgents to see targets.`, refusal);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A resume past the cache window is refused: it would re-bill the whole context
// ---------------------------------------------------------------------------
{
	console.log("\na seat's message to a cold agent is refused");
	const { coldResumeText } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-tool-text.ts`);
	const NOW = 10_000_000_000;
	const settled = (name, idleMs) => ({
		name, taskId: `a${name.padEnd(12, "0").slice(0, 12)}`, ownerSessionId: "cold-seat", sessionId: `child-${name}`, description: name, type: "worker", status: "completed",
		depth: 1, sessionFile: undefined, cwd: KIT_ROOT, branch: undefined, model: "scripted/scripted-1", thinking: undefined, result: "done", error: undefined,
		readBy: "spawner", readAt: NOW - idleMs, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: NOW - idleMs - 1000, completedAt: NOW - idleMs,
		toolCallId: undefined, workflowChild: false, stoppedBy: undefined,
	});
	const runtime = await runtimeOver({ sessionId: "cold-seat", now: () => NOW }, [settled("coldone", 40 * 60_000), settled("warmone", 4 * 60_000)]);
	const outcome = (name, from) => runtime.send(name, "one more thing", false, from).then(() => "delivered", (error) => `${error.reason}: ${error.message}`);
	const cold = await outcome("coldone", "seat");
	check("a seat's message to an agent idle 40 min is refused with the fresh-agent rule", cold === `cold: ${coldResumeText("coldone", 40 * 60_000)}`, cold);
	check("the refusal says the cache is cold and names the brief", /cache is cold, so resuming it would re-bill its whole context\. Start a fresh agent with a tight brief/.test(cold), cold);
	// Past the gate the stub has no transcript to reopen, so `no-transcript` is the proof the gate let it through.
	const warm = await outcome("warmone", "seat");
	check("an agent idle 4 min passes the gate to its resume", warm.startsWith("no-transcript:"), warm);
	const joel = await outcome("coldone", "Joel");
	check("Joel typing into a cold agent is his call, not refused", joel.startsWith("no-transcript:"), joel);
}

await finish();
