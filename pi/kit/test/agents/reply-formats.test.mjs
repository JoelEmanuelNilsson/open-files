/**
 * Reply formats R1-R5: the module's checks, the text a child's tail carries
 * (the child chooses; a parent's `reply` overrides), the one steer a reply that
 * breaks its cap or keys gets, and `agent({reply})` in a workflow.
 */

import "../support/suite-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "../support/check-harness.mjs";
import { SessionManager, call, jiti, lastUserText, mainSeat, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

const { REPLY_FORMATS, replyProblem, replySchema, renderReplyRule } = await jiti.import(`${KIT_ROOT}/lib/agents/reply-formats.ts`);

const GOOD = "R1\ndone: x\nsha: none: y\nfiles: a\nverified: green: t";
check("a reply in its format passes", replyProblem(GOOD, undefined, "/d") === undefined);
check("a reply without the ID line is refused", replyProblem("done: x", undefined, "/d")?.includes("first line"));
check("a reply over the cap names the cap and the detail directory", /is 700 chars, cap 600.*\/d/.test(replyProblem(`${GOOD}\n${"x".repeat(700 - GOOD.length - 1)}`, undefined, "/d") ?? ""));
check("a missing key is named", replyProblem("R1\ndone: x\nfiles: a\nverified: t", undefined, "/d")?.includes("`sha:`"));
check("an override refuses another ID", replyProblem(GOOD, "R2", "/d")?.includes("(R2)"));
check("the chooser lists all five and the detail directory", ["R1", "R2", "R3", "R4", "R5"].every((id) => renderReplyRule("/d", undefined).includes(`${id} (cap ${REPLY_FORMATS[id].cap} chars)`)) && renderReplyRule("/d", undefined).includes("/d"));
check("an override shows only its format", !renderReplyRule("/d", "R3").includes("R1 (cap") && renderReplyRule("/d", "R3").includes("Reply in R3"));
check("the workflow schema requires the format's keys", replySchema("R5").required.join() === "file,summary,decide");

// A child with formats on: the tail, the override, one steer.
delete process.env.PI_KIT_REPLY_FORMATS;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reply-formats-"));
{
	const seat = await mainSeat({ cwd });
	scriptFor("start it", [[call("Agent", { description: "reply test", prompt: "Do the thing.", name: "doer", reply: "R3" })], [text("started")]]);
	scriptFor("Do the thing.", [[text("all done, lots of prose")]]);
	scriptFor("the first line must be the format ID", [[text("R3\nrule: r\nverdict: holds\nnumbers: n=1\ncommand: c\ndetail: /x \u2014 y")], [text("still prose")]]);
	await seat.session.prompt("start it");
	await seat.session.waitForIdle();
	const settled = await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 5000);
	const first = requests.find((r) => lastUserText({ messages: r.messages }).includes("Do the thing."));
	const tail = first ? lastUserText({ messages: first.messages }) : "";
	check("the tail names the override and the absolute detail directory", tail.includes("Reply in R3") && tail.includes(path.join(fs.realpathSync(cwd), ".scratch")) || tail.includes(path.join(cwd, ".scratch")), tail.slice(0, 400));
	check("the detail directory is not created until the agent writes", !fs.existsSync(path.join(cwd, ".scratch")));
	const steered = requests.filter((r) => lastUserText({ messages: r.messages }).includes("the first line must be the format ID"));
	check("a reply that misses its format gets exactly one steer, and the corrected reply is the result", settled && steered.length === 1 && seat.events.find((e) => e.channel === "subagents:completed")?.result.startsWith("R3\n"), JSON.stringify(seat.events.map((e) => e.result)));
}
{
	const seat = await mainSeat({ cwd });
	scriptFor("start two", [[call("Agent", { description: "stubborn", prompt: "Be stubborn.", name: "stubborn" })], [text("started")]]);
	scriptFor("Be stubborn.", [[text("prose")]]);
	await seat.session.prompt("start two");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 5000);
	const first = requests.find((r) => lastUserText({ messages: r.messages }).includes("Be stubborn."));
	check("with no override the tail carries all five formats", first !== undefined && ["R1", "R2", "R3", "R4", "R5"].every((id) => lastUserText({ messages: first.messages }).includes(`${id} (cap`)));
	check("a second miss is delivered as it is: one steer only", requests.filter((r) => lastUserText({ messages: r.messages }).includes("the first line must be the format ID")).length === 2 && seat.events.find((e) => e.channel === "subagents:completed")?.result === "still prose");
}

finish();
