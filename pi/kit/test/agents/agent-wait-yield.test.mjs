/**
 * A bare `TaskOutput` that a message interrupts, offline: the yield counts the
 * agents it was waiting for, they keep running (issues/31 (g)), and it names
 * who sent the message — Joel, or the parent seat.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, jiti, mainSeat, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { sleep, until } from "../support/async-waits.mjs";

// ---------------------------------------------------------------------------
// A bare TaskOutput counts the agents it was waiting for (issues/31 (g))
// ---------------------------------------------------------------------------
{
	console.log("\nthe yield counts what is running");
	const seat = await mainSeat();
	scriptFor("start two and wait for anything", [
		[call("Agent", { description: "job one", prompt: "Take a while, one.", name: "slow-one" }), call("Agent", { description: "job two", prompt: "Take a while, two.", name: "slow-two" })],
		[call("TaskOutput", {})],
		[text("carrying on")],
		[text("steered reply")],
	]);
	scriptFor("Take a while, one.", [{ delay: 2500, content: [text("one done")] }]);
	scriptFor("Take a while, two.", [{ delay: 2500, content: [text("two done")] }]);
	const turn = seat.session.prompt("start two and wait for anything");
	await until(() => seat.toolResults().length === 2 && seat.session.isStreaming, 5000);
	await sleep(50);
	await seat.session.prompt("never mind", { streamingBehavior: "steer" });
	await until(() => seat.toolResults().length === 3, 3000);
	const yielded = seat.toolResults()[2]?.content[0].text ?? "";
	check("a nameless wait says how many of its agents are done, not 0 of 0", yielded.startsWith("interrupted by Joel — 0 of 2 done"), yielded.split("\n")[0]);
	await turn;
	await seat.session.waitForIdle();
	check("and both children kept running", await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 8000));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A child's wait names who interrupted it: Joel or its parent
// ---------------------------------------------------------------------------
{
	console.log("\na child's yield names the sender");
	const { agentRuntimeOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const seat = await mainSeat();
	const runtime = agentRuntimeOf(seat.session.sessionManager.getSessionId());
	scriptFor("start a waiter", [[call("Agent", { description: "waiter job", prompt: "Wait on a sleeper.", name: "waiter" })], [text("started")]]);
	scriptFor("Wait on a sleeper.", [[call("Agent", { description: "sleeper job", prompt: "Sleep a long while.", name: "sleeper" })], [call("TaskOutput", {})]]);
	scriptFor("Sleep a long while.", [{ delay: 6000, content: [text("slept")] }]);
	scriptFor("joel here", [{ delay: 800, content: [call("TaskOutput", {})] }]);
	scriptFor("parent here", [[call("TaskOutput", {})]]);
	scriptFor("parent again", [[text("waiter done")]]);
	scriptFor("tell the waiter", [[call("SendMessage", { to: "waiter", message: "parent here" })], [text("told")]]);
	scriptFor("tell the waiter again", [[call("SendMessage", { to: "waiter", message: "parent again" })], [text("told again")]]);
	await seat.session.prompt("start a waiter");
	await seat.session.waitForIdle();
	const waiter = () => runtime.liveRun(runtime.registry.byName("waiter").taskId);
	const waiterResults = () => (waiter()?.messages ?? []).filter((m) => m.role === "toolResult").map((m) => m.content[0]?.text ?? "");
	await until(() => waiterResults().length === 1 && waiter()?.isStreaming, 5000);
	await sleep(50);

	await runtime.send("waiter", "joel here", false, "Joel");
	await until(() => waiterResults().length === 2, 3000);
	check("Joel's message interrupts a child's wait as Joel", waiterResults()[1]?.startsWith("interrupted by Joel"), waiterResults()[1]);
	const joelText = waiter()?.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join(""))).at(-1);
	check("and reaches the child unstamped", joelText === "joel here", joelText);

	// The next TaskOutput is 800 ms away: the parent's message is pending when it starts.
	await seat.session.prompt("tell the waiter");
	await until(() => waiterResults().length === 3, 3000);
	check("a parent's message pending when the wait starts names the parent", waiterResults()[2]?.startsWith("interrupted by your parent (the main session)"), waiterResults()[2]);

	await until(() => waiter()?.isStreaming && waiter()?.messages.at(-1)?.role === "assistant" && waiter()?.messages.at(-1)?.content.some((b) => b.type === "toolCall"), 3000);
	await sleep(50);
	await seat.session.prompt("tell the waiter again");
	await until(() => waiterResults().length === 4, 3000);
	check("a parent's message during the wait names the parent", waiterResults()[3]?.startsWith("interrupted by your parent (the main session)"), waiterResults()[3]);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length >= 1, 10000);
	seat.session.dispose();
}

await finish();
