/**
 * A child's own agents reach the seat's dock: the lifecycle events a child's
 * engine emits on its session's bus are re-emitted on the seat's, naming the
 * child as their parent. Grandchildren arrive the same way, one hop per level.
 */

import { check, eq, finish } from "../support/check-harness.mjs";
import { call, mainSeat, quiet, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { until } from "../support/async-waits.mjs";

{
	console.log("\nnested agents reach the seat's dock");
	const seat = await mainSeat();
	scriptFor("start a lead with a worker", [
		[call("Agent", { description: "lead job", prompt: "Lead the nested work.", subagent_type: "lead", name: "boss" })],
		[text("started")],
	]);
	scriptFor("Lead the nested work.", [
		[call("Agent", { description: "nested job", prompt: "Do the nested job.", subagent_type: "lead", name: "hand" })],
		[text("lead waiting")],
	]);
	scriptFor("Do the nested job.", [[call("Agent", { description: "deepest job", prompt: "Do the deepest job.", name: "tip" })], [text("hand waiting")]]);
	scriptFor("Do the deepest job.", [[text("deepest done")]]);
	await seat.session.prompt("start a lead with a worker");
	await seat.session.waitForIdle();
	const settled = (description) => seat.events.find((e) => e.channel === "subagents:completed" && e.description === description);
	check("the grandchild's completion reaches the seat", await until(() => settled("deepest job") !== undefined && settled("nested job") !== undefined, 8000));
	const lead = seat.events.find((e) => e.channel === "subagents:started" && e.name === "boss");
	const nested = settled("nested job");
	eq("the seat's own child names no parent", lead?.parentId, undefined);
	eq("the child's agent names the child as its parent", nested?.parentId, lead?.id);
	eq("and the grandchild's names the grandchild's parent, not the seat's child", settled("deepest job")?.parentId, nested?.id);
	// A name addresses an agent inside the seat that launched it; this seat has no agent by that name.
	check("a forwarded event carries no name this seat could address", seat.events.filter((e) => e.parentId !== undefined).every((e) => e.name === undefined));
	await quiet(seat);
	seat.session.dispose();
}

{
	console.log("\nthe dock's stop reaches the engine that owns a nested agent");
	const seat = await mainSeat();
	scriptFor("start a lead whose worker waits", [
		[call("Agent", { description: "waiting lead", prompt: "Lead the waiting work.", subagent_type: "lead", name: "boss" })],
		[text("started")],
	]);
	scriptFor("Lead the waiting work.", [[call("Agent", { description: "slow job", prompt: "Do the slow job.", name: "slow" })], [text("lead waiting")]]);
	scriptFor("Do the slow job.", [{ delay: 4000, content: [text("too late")] }]);
	await seat.session.prompt("start a lead whose worker waits");
	await seat.session.waitForIdle();
	const startedNested = () => seat.events.find((e) => e.channel === "subagents:started" && e.description === "slow job");
	await until(() => startedNested() !== undefined, 3000);
	const agentId = startedNested()?.id;
	const requestId = `agent-dock-nested-${Date.now()}`;
	let reply;
	seat.bus.on(`subagents:rpc:stop:reply:${requestId}`, (r) => { reply = r; });
	seat.bus.emit("subagents:rpc:stop", { requestId, agentId });
	await until(() => reply !== undefined, 2000);
	eq("the stop of a nested agent is answered on the dock's reply channel", reply, { success: true });
	check("and the nested agent settles as stopped", await until(() => seat.events.some((e) => e.channel === "subagents:failed" && e.id === agentId && e.status === "stopped"), 2000));
	await quiet(seat);
	seat.session.dispose();
}

await finish();
