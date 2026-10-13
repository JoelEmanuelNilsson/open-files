/**
 * The engine tells a workflow run when a child started, offline: a child's
 * journal `after` is the count at its first prompt, not when its report came
 * back. The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, mainSeat, quiet, scriptFor, text } from "../support/workflow-seat.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";

{
	console.log("\nWorkflow: the engine tells the run when a child started");
	const seat = await mainSeat();
	// `slow` sends its first prompt at once and settles last; `quick` finishes in between. Its line not
	// counting `quick` is what shows the engine said when `slow` started: the report comes back too late.
	scriptFor("run the slow-quick workflow", [[call("Workflow", { script: `${META}return parallel([() => agent('Answer slowly.', { label: 'slow', prefixStaggerMs: 1 }), () => agent('Answer quickly.', { label: 'quick', prefixStaggerMs: 1 })])` })], [text("started")]]);
	scriptFor("Answer slowly.", [{ delay: 4000, content: [text("slow answer")] }]);
	scriptFor("Answer quickly.", [{ delay: 2000, content: [text("quick answer")] }]);
	await seat.session.prompt("run the slow-quick workflow");
	await seat.session.waitForIdle();
	const script = /Script: (\S+)/.exec(seat.toolResults().at(-1)?.content[0].text ?? "")?.[1] ?? "";
	await until(() => seat.events.some((e) => e.type === "workflow" && e.channel === "subagents:completed"), 15000);
	await quiet(seat);
	const journal = fs.readFileSync(path.join(path.dirname(script), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("a child's journal `after` is the count at its first prompt, not when its report came back", journal.map((l) => `${l.label}:${l.after}`).join() === "quick:0,slow:0", JSON.stringify(journal));
	seat.session.dispose();
}

await finish();
