/**
 * `TaskOutput`, offline: the explicit wait, the whole reply once, the yield to
 * Joel, and a delivery that must never eat the wait's result.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, mainSeat, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { loadPerCore, sleep, until } from "../support/async-waits.mjs";

// ---------------------------------------------------------------------------
// TaskOutput: the explicit wait, the full reply once, and the yield to Joel
// ---------------------------------------------------------------------------
{
	console.log("\nTaskOutput");
	const seat = await mainSeat();
	scriptFor("start and wait", [
		[call("Agent", { description: "slow job", prompt: "Take your time.", name: "slow" })],
		[call("TaskOutput", { names: ["slow"] })],
		[text("got it")],
	]);
	scriptFor("Take your time.", [{ delay: 400, content: [text("Slow result, in full.")] }]);
	await seat.session.prompt("start and wait");
	await seat.session.waitForIdle();
	const [, waited] = seat.toolResults();
	check("TaskOutput blocks until the agent settles and returns the whole reply", waited?.content[0].text.includes("<result>Slow result, in full.</result>"), waited?.content[0]?.text?.slice(0, 200));
	check("its details are the agents form carrying the notice shape, so the row can draw it", waited?.details?.kind === "agents" && waited.details.batch?.status === "completed" && waited.details.batch.name === "slow", JSON.stringify(waited?.details));
	check("delivered once: no notification is queued for the next turn as well", seat.customs().length === 0);

	scriptFor("wait again", [[call("TaskOutput", { names: ["slow"] })], [text("nothing new")]]);
	await seat.session.prompt("wait again");
	await seat.session.waitForIdle();
	const again = seat.toolResults()[2];
	// It says *how* it reached a reader and where the whole of it still is — never
	// that the conversation contains text the harness has not seen there.
	check("a reply already read is not returned again, and TaskOutput says by which path", again?.content[0].text.startsWith("Nothing unread.") && /\nslow · completed · returned to you by TaskOutput at \d\d:\d\d:\d\d \(\d+s ago\) · whole result: \S+\.jsonl$/.test(again?.content[0].text ?? ""), again?.content[0]?.text);
	check("the next turn carried no notification either", seat.customs().length === 0);

	scriptFor("check an unknown name", [[call("TaskOutput", { names: ["nobody"], block: false })], [text("ok")]]);
	await seat.session.prompt("check an unknown name");
	await seat.session.waitForIdle();
	check("an unknown name is named, not waited on", seat.toolResults()[3]?.content[0].text.startsWith("Unknown agents: nobody"));

	// Joel types while the seat is blocked in TaskOutput: the wait returns, the
	// child keeps running, and its result delivers itself when it lands.
	scriptFor("start and wait long", [
		[call("Agent", { description: "long job", prompt: "Take even longer.", name: "long" })],
		[call("TaskOutput", { names: ["long"] })],
		[text("carrying on")],
		[text("steered reply")],
	]);
	// Scaled with load so the child is still running when Joel types, however slowly the seat gets there.
	const longDelay = 1500 * loadPerCore();
	scriptFor("Take even longer.", [{ delay: longDelay, content: [text("Long result.")] }]);
	const turn = seat.session.prompt("start and wait long");
	await until(() => seat.toolResults().length === 5 && seat.session.isStreaming, 3000);
	await sleep(50);
	const typedAt = Date.now();
	await seat.session.prompt("hello from Joel", { streamingBehavior: "steer" });
	await until(() => seat.toolResults().length === 6, 3000);
	const interrupted = seat.toolResults()[5];
	check("TaskOutput returns early when Joel types", interrupted?.content[0].text.startsWith("interrupted by Joel — 0 of 1 done") && Date.now() - typedAt < longDelay * 2 / 3, interrupted?.content[0]?.text);
	await turn;
	await seat.session.waitForIdle();
	check("Joel's message still reached the model as a steer", seat.session.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("hello from Joel")));
	check("the child kept running", seat.events.filter((e) => e.channel === "subagents:completed").length === 1 && seat.session.messages.every((m) => m.role !== "custom" || !m.content.includes("Long result.")));
	const arrived = await until(() => seat.customs().some((m) => m.content.includes("<result>Long result.</result>")), 5000);
	await seat.session.waitForIdle();
	check("and its result arrived on its own, with nobody typing", arrived, seat.customs().map((m) => m.content.slice(0, 60)).join(" | "));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A delivery must never eat the wait's result (the 2026-09-03 "Nothing to report")
// ---------------------------------------------------------------------------
{
	console.log("\nTaskOutput vs the delivery");
	const seat = await mainSeat();
	scriptFor("wait on a waker", [
		[call("Agent", { description: "waking job", prompt: "Wake me when done.", name: "waker" })],
		[call("TaskOutput", { names: ["waker"] })],
		[text("read it")],
	]);
	scriptFor("Wake me when done.", [{ delay: 400, content: [text("Waker result.")] }]);
	await seat.session.prompt("wait on a waker");
	await seat.session.waitForIdle();
	const waitedOnWaker = seat.toolResults()[1];
	check("a settle's result is returned by the TaskOutput that was waiting for it", waitedOnWaker?.content[0].text.includes("<result>Waker result.</result>"), waitedOnWaker?.content[0]?.text?.slice(0, 200));
	check("TaskOutput never reports nothing while a matching result is unread", !/Nothing to report/.test(waitedOnWaker?.content[0].text ?? ""), waitedOnWaker?.content[0]?.text?.slice(0, 200));
	check("and the settle did not also deliver it to the conversation (C7: once)", seat.customs().length === 0);

	// The same race with no names: the wait claims every name.
	scriptFor("wait on anything", [[call("Agent", { description: "second waking job", prompt: "Wake me too.", name: "waker2" })], [call("TaskOutput", {})], [text("read that too")]]);
	scriptFor("Wake me too.", [{ delay: 400, content: [text("Second waker result.")] }]);
	await seat.session.prompt("wait on anything");
	await seat.session.waitForIdle();
	const waitedOnAny = seat.toolResults().at(-1);
	check("a nameless TaskOutput gets the result the delivery would have taken", waitedOnAny?.content[0].text.includes("<result>Second waker result.</result>"), waitedOnAny?.content[0]?.text?.slice(0, 200));
	check("still delivered once", seat.customs().length === 0);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// One TaskOutput brings a whole delivery unit: an explorer batch together, a worker alone
// ---------------------------------------------------------------------------
{
	console.log("\nTaskOutput and the explorer batch");
	const seat = await mainSeat();
	const explorer = (name, prompt) => call("Agent", { description: name, prompt, subagent_type: "explore", name });
	const resultsOf = (message) => (message?.content[0].text.match(/<result>/g) ?? []).length;

	const nine = Array.from({ length: 9 }, (_, i) => `nine-${i}`);
	scriptFor("nine explorers", [[...nine.map((name) => explorer(name, `Read for ${name}.`))], [call("TaskOutput", {})], [text("read all nine")]]);
	nine.forEach((name, i) => scriptFor(`Read for ${name}.`, [{ delay: 100 + i * 60, content: [text(`Reply of ${name}.`)] }]));
	await seat.session.prompt("nine explorers");
	await seat.session.waitForIdle();
	const all = seat.toolResults().at(-1);
	check("nine explorers in one message: one TaskOutput returns once, with nine replies", resultsOf(all) === 9 && nine.every((name) => all.content[0].text.includes(`Reply of ${name}.`)), all?.content[0]?.text?.slice(0, 200));
	check("and nothing is left for a second call or the conversation", seat.customs().length === 0);

	scriptFor("worker and batch", [
		[call("Agent", { description: "w", prompt: "Worker job.", subagent_type: "worker", name: "wk" }), explorer("x1", "Read x1."), explorer("x2", "Read x2.")],
		[call("TaskOutput", {})],
		[call("TaskOutput", {})],
		[text("both read")],
	]);
	scriptFor("Worker job.", [{ delay: 100, content: [text("Worker reply.")] }]);
	scriptFor("Read x1.", [{ delay: 300, content: [text("X1 reply.")] }]);
	scriptFor("Read x2.", [{ delay: 600, content: [text("X2 reply.")] }]);
	await seat.session.prompt("worker and batch");
	await seat.session.waitForIdle();
	const [first, second] = seat.toolResults().slice(-2);
	check("a worker started with a batch returns alone", first?.content[0].text.includes("Worker reply.") && resultsOf(first) === 1, first?.content[0]?.text?.slice(0, 200));
	check("the batch returns together in the next call", resultsOf(second) === 2 && second.content[0].text.includes("X1 reply.") && second.content[0].text.includes("X2 reply."), second?.content[0]?.text?.slice(0, 200));

	scriptFor("two batches", [
		[explorer("a1", "Read a1."), explorer("a2", "Read a2.")],
		[call("TaskOutput", {})],
		[explorer("b1", "Read b1."), explorer("b2", "Read b2.")],
		[call("TaskOutput", {})],
		[text("both batches read")],
	]);
	for (const [name, delay] of [["a1", 100], ["a2", 250], ["b1", 100], ["b2", 250]]) scriptFor(`Read ${name}.`, [{ delay, content: [text(`${name.toUpperCase()} reply.`)] }]);
	await seat.session.prompt("two batches");
	await seat.session.waitForIdle();
	const [batchA, batchB] = seat.toolResults().filter((r) => resultsOf(r) > 0).slice(-2);
	check("two batches: each call returns its own batch whole", resultsOf(batchA) === 2 && batchA.content[0].text.includes("A2 reply.") && resultsOf(batchB) === 2 && batchB.content[0].text.includes("B1 reply.") && !batchB.content[0].text.includes("A1 reply."), `${batchA?.content[0]?.text?.slice(0, 100)} | ${batchB?.content[0]?.text?.slice(0, 100)}`);

	scriptFor("name one", [[explorer("n1", "Read n1."), explorer("n2", "Read n2.")], [call("TaskOutput", { names: ["n1"] })], [text("named")]]);
	scriptFor("Read n1.", [{ delay: 100, content: [text("N1 reply.")] }]);
	scriptFor("Read n2.", [{ delay: 500, content: [text("N2 reply.")] }]);
	await seat.session.prompt("name one");
	await seat.session.waitForIdle();
	const named = seat.toolResults().at(-1);
	check("naming one explorer returns its whole batch", resultsOf(named) === 2 && named.content[0].text.includes("N2 reply."), named?.content[0]?.text?.slice(0, 200));

	scriptFor("partial", [[explorer("p1", "Read p1."), explorer("p2", "Read p2.")], [call("TaskOutput", { timeout: 300 })], [call("TaskOutput", {})], [text("partial done")]]);
	scriptFor("Read p1.", [{ delay: 50, content: [text("P1 reply.")] }]);
	scriptFor("Read p2.", [{ delay: 900, content: [text("P2 reply.")] }]);
	await seat.session.prompt("partial");
	await seat.session.waitForIdle();
	const [timedOut, rest] = seat.toolResults().slice(-2);
	check("a timeout with a partial batch returns no part of it and says who still runs", resultsOf(timedOut) === 0 && timedOut.content[0].text.includes("Still running: p2"), timedOut?.content[0]?.text?.slice(0, 200));
	check("the batch is then returned whole", resultsOf(rest) === 2, rest?.content[0]?.text?.slice(0, 200));

	const reviewer = (name, prompt) => call("Agent", { description: name, prompt, subagent_type: "reviewer", name });
	scriptFor("reviewers batch", [[reviewer("r1", "Review r1."), reviewer("r2", "Review r2.")], [call("TaskOutput", {})], [text("reviews read")]]);
	scriptFor("Review r1.", [{ delay: 100, content: [text("R1 reply.")] }]);
	scriptFor("Review r2.", [{ delay: 400, content: [text("R2 reply.")] }]);
	await seat.session.prompt("reviewers batch");
	await seat.session.waitForIdle();
	const reviews = seat.toolResults().at(-1);
	check("reviewers come back together in one TaskOutput", resultsOf(reviews) === 2 && reviews.content[0].text.includes("R1 reply.") && reviews.content[0].text.includes("R2 reply."), reviews?.content[0]?.text?.slice(0, 200));

	scriptFor("mixed types", [
		[explorer("mx1", "Read mx1."), reviewer("mr1", "Review mr1."), explorer("mx2", "Read mx2."), reviewer("mr2", "Review mr2.")],
		[call("TaskOutput", {})],
		[call("TaskOutput", {})],
		[text("both kinds read")],
	]);
	for (const [name, delay] of [["Read mx1.", 100], ["Read mx2.", 200], ["Review mr1.", 400], ["Review mr2.", 600]]) scriptFor(name, [{ delay, content: [text(`${name} done.`)] }]);
	await seat.session.prompt("mixed types");
	await seat.session.waitForIdle();
	const [kindA, kindB] = seat.toolResults().slice(-2);
	check("explorers and reviewers in flight together come back as two separate batches", resultsOf(kindA) === 2 && kindA.content[0].text.includes("Read mx1. done.") && kindA.content[0].text.includes("Read mx2. done.") && resultsOf(kindB) === 2 && kindB.content[0].text.includes("Review mr2. done."), `${kindA?.content[0]?.text?.slice(0, 120)} | ${kindB?.content[0]?.text?.slice(0, 120)}`);

	scriptFor("lead alone", [[call("Agent", { description: "l", prompt: "Lead job.", subagent_type: "lead", name: "ld1" }), call("Agent", { description: "l", prompt: "Lead job two.", subagent_type: "lead", name: "ld2" })], [call("TaskOutput", {})], [call("TaskOutput", {})], [text("leads read")]]);
	scriptFor("Lead job.", [{ delay: 100, content: [text("Lead one.")] }]);
	scriptFor("Lead job two.", [{ delay: 500, content: [text("Lead two.")] }]);
	await seat.session.prompt("lead alone");
	await seat.session.waitForIdle();
	const [leadA, leadB] = seat.toolResults().slice(-2);
	check("a type without delivery: batch returns each agent on its own", resultsOf(leadA) === 1 && leadA.content[0].text.includes("Lead one.") && resultsOf(leadB) === 1 && leadB.content[0].text.includes("Lead two."), `${leadA?.content[0]?.text?.slice(0, 120)} | ${leadB?.content[0]?.text?.slice(0, 120)}`);

	scriptFor("unasked batch", [[explorer("u1", "Read u1."), explorer("u2", "Read u2.")], [text("waiting")], [text("saw the batch")]]);
	scriptFor("Read u1.", [{ delay: 50, content: [text("U1 reply.")] }]);
	scriptFor("Read u2.", [{ delay: 400, content: [text("U2 reply.")] }]);
	await seat.session.prompt("unasked batch");
	const together = await until(() => seat.customs().length > 0, 5000);
	await seat.session.waitForIdle();
	check("unasked delivery is unchanged: the batch arrives as one message after the last lands", together && seat.customs().length === 1 && seat.customs()[0].content.includes("U1 reply.") && seat.customs()[0].content.includes("U2 reply."), seat.customs().map((m) => m.content.slice(0, 80)).join(" | "));
	seat.session.dispose();
}

await finish();
