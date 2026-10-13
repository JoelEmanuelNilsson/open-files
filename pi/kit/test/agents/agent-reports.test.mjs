/**
 * What a child hands back, offline: a bounded report, the numbers a finished
 * agent reports, a child stopped by its own context ladder, and the report as
 * the last substantive message, surviving a sign-off.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, jiti, lastUserText, mainSeat, quiet, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

// ---------------------------------------------------------------------------
// The wait board: settled, timeout, interrupted — with a fake clock
// ---------------------------------------------------------------------------
{
	console.log("\na report longer than 20,000 characters arrives whole");
	const seat = await mainSeat();
	const long = `done: mapped it\n${"x".repeat(45_000)}\nopen: none`;
	scriptFor("start a mapper", [[call("Agent", { description: "maps the code", prompt: "Map it all.", name: "mapper" })], [text("started")]]);
	scriptFor("Map it all.", [[text(long)]]);
	await seat.session.prompt("start a mapper");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "mapper"), 8000);
	const completed = seat.events.find((e) => e.channel === "subagents:completed" && e.name === "mapper");
	check("the completed result is the report, byte for byte", completed?.result === long, String(completed?.result?.length));
	await until(() => seat.customs().some((c) => c.content.includes("<task-notification>")), 5000);
	const notice = seat.customs().find((c) => c.content.includes("<task-notification>"))?.content ?? "";
	check("the delivery carries all of it and no truncation marker", notice.includes(long) && !notice.includes("[report truncated"), String(notice.length));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// What a finished agent reports: context size, not the billed sum (issues/31 (d))
// ---------------------------------------------------------------------------
{
	console.log("\nthe numbers a finished agent reports");
	const seat = await mainSeat();
	scriptFor("start a re-reader", [[call("Agent", { description: "re-read files", prompt: "Read it three times.", name: "rereader" })], [text("started")]]);
	scriptFor("Read it three times.", [[call("ListAgents", {})], [call("ListAgents", {})], [text("Read it.")]]);
	await seat.session.prompt("start a re-reader");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "rereader"), 8000);
	await quiet(seat);
	scriptFor("what did it report", [[text("read")]]);
	await seat.session.prompt("what did it report");
	await seat.session.waitForIdle();
	const reported = seat.customs().at(-1)?.content ?? "";
	const usage = /<total_tokens>(\d+)<\/total_tokens><output_tokens>(\d+)<\/output_tokens>/.exec(reported);
	const child = requests.filter((r) => lastUserText({ messages: r.messages }).includes("Read it three times."));
	const billed = child.map((r) => 10 * (r.messages.length + 1) + 5);
	check("the token count is the last message's usage — the context size", usage !== null && Number(usage[1]) === billed.at(-1), `${usage?.[1]} vs last ${billed.at(-1)} of ${billed.join()}`);
	check("not the billed sum, which every cached re-read inflates", usage !== null && Number(usage[1]) < billed.reduce((a, b) => a + b, 0), `${usage?.[1]} vs sum ${billed.reduce((a, b) => a + b, 0)}`);
	check("and it says how much the agent wrote: every message's output side, summed", usage !== null && Number(usage[2]) === 5 * child.length, `${usage?.[2]} for ${child.length} messages`);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A report is the last substantive message, not the last message (ticket 57).
//
// Replayed from the shape of the `test-audit` transcript of 2026-09-05: the
// worker wrote its report, one of its own children's results landed, it said
// "that data was already in the report above" — and that sentence was the whole
// of what its parent received.
// ---------------------------------------------------------------------------
{
	console.log("\na report is the last substantive message");
	const { childReport, SIGN_OFF_NOTE } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-child-report.ts`);
	const says = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
	const calls = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] });
	const result = () => ({ role: "toolResult", content: [{ type: "text", text: "output" }] });
	const delivery = () => ({ role: "custom", customType: "subagent-notification", content: "<task-notification>a child's result</task-notification>" });
	const asked = () => ({ role: "user", content: [{ type: "text", text: "a new question" }] });
	const session = (...messages) => ({ messages });
	const report = `report: ${"x".repeat(3000)}`;
	const signOff = "That data was already in the report above — nothing changes.";

	const landed = childReport(session(asked(), calls(), result(), says(report), delivery(), says(signOff)), signOff);
	check("the report lands, with the sign-off after it and a line saying why", landed === `${report}\n\n${signOff}\n\n${SIGN_OFF_NOTE}`, landed?.slice(0, 80));
	check("a child that writes only a sign-off delivers the sign-off", childReport(session(asked(), says(signOff)), signOff) === signOff);
	check("a report that is the last message is delivered untouched", childReport(session(asked(), calls(), result(), says(report)), report) === report);
	// The window closes where the child was last asked something: a resumed run
	// answers the new question and never re-delivers the report it already sent.
	check("a resumed run delivers its answer, not the report it delivered before", childReport(session(says(report), delivery(), says(signOff), asked(), says("No, X is fine.")), "No, X is fine.") === "No, X is fine.");
	// And where work happened after the long text, the long text is superseded.
	check("a long message from before the last tool call is not the report", childReport(session(asked(), says(report), calls(), result(), says("done")), "done") === "done");
	check("a child that said nothing has no result", childReport(session(asked()), "") === undefined);
}

// ---------------------------------------------------------------------------
// The same fault through the engine: a worker whose own child lands after it
// has written its report. What reaches the parent is the report.
// ---------------------------------------------------------------------------
{
	console.log("\na worker's report survives its sign-off");
	const seat = await mainSeat();
	const report = `Findings: ${"x".repeat(3000)}`;
	const signOff = "That data was already in the report above — nothing changes.";
	scriptFor("start the auditor", [[call("Agent", { description: "audits the suite", prompt: "Audit it.", name: "auditor" })], [text("started")]]);
	scriptFor("Audit it.", [[call("Agent", { description: "a slow look", prompt: "Look slowly.", name: "looker" })], [text(report)], [text(signOff)]]);
	scriptFor("Look slowly.", [{ delay: 1200, content: [text("looked")] }]);
	await seat.session.prompt("start the auditor");
	const recordOf = (name) => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === name).pop()?.data;
	await until(() => recordOf("auditor")?.status === "completed", 15000);
	const settled = recordOf("auditor");
	check("the sign-off did not replace the report", settled?.result?.startsWith(report), settled?.result?.slice(0, 80));
	check("the sign-off still rides along, with the reason it does", settled?.result?.includes(signOff) && settled.result.endsWith("[report taken from the message before the sign-off]"), settled?.result?.slice(-120));
	seat.session.dispose();
}

await finish();
