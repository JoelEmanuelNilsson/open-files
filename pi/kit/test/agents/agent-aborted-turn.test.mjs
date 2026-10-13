/**
 * Joel aborts the seat's turn, offline: the children are their own sessions,
 * keep running, and still deliver (issues/31 (h)).
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, mainSeat, quiet, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { until } from "../support/async-waits.mjs";

// ---------------------------------------------------------------------------
// Joel aborts the turn: the children are their own sessions and keep running
// (issues/31 (h)). Two died with an abort on 2026-09-04.
// ---------------------------------------------------------------------------
{
	console.log("\nan aborted turn leaves the children running");
	const seat = await mainSeat();
	scriptFor("start two then abort", [
		[call("Agent", { description: "survivor one", prompt: "Survive the abort, one.", name: "survivor-1" }), call("Agent", { description: "survivor two", prompt: "Survive the abort, two.", name: "survivor-2" })],
		{ delay: 4000, content: [text("never reached")] },
	]);
	scriptFor("Survive the abort, one.", [{ delay: 1500, content: [text("one survived")] }]);
	scriptFor("Survive the abort, two.", [{ delay: 1500, content: [text("two survived")] }]);
	const turn = seat.session.prompt("start two then abort");
	await until(() => seat.events.filter((e) => e.channel === "subagents:started").length === 2, 5000);
	await seat.session.abort();
	await turn.catch(() => {});
	const landed = await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 10000);
	check("both children finish after the parent's turn is aborted", landed, JSON.stringify(seat.events.map((e) => [e.channel, e.name, e.status])));
	check("with their answers, not an aborted stub", seat.events.filter((e) => e.channel === "subagents:completed").map((e) => e.result).sort().join("|") === "one survived|two survived", JSON.stringify(seat.events.filter((e) => e.channel === "subagents:completed").map((e) => e.result)));
	await quiet(seat);
	const arrived = seat.customs().map((m) => m.content).join("\n");
	check("and their results still delivered themselves, not lost with the abort", arrived.includes("<result>one survived</result>") && arrived.includes("<result>two survived</result>"), arrived.slice(0, 200));
	const causes = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data.stoppedBy);
	check("and no record names a stop cause, because nothing stopped them", causes.every((c) => c === undefined), JSON.stringify(causes));
	seat.session.dispose();
}

await finish();
