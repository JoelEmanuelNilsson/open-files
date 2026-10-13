/**
 * A workflow child's journal `after` is the journal as it stood when the
 * engine sent its first prompt, not when it was handed over, offline.
 * The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, childRequestFor, mainSeat, onLifecycle, quiet, scriptFor, text } from "../support/workflow-seat.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";

// R: a child's journal `after` is the journal as it stood when the engine sent its first prompt, not when it was handed over
{
	console.log("\nWorkflow: a child starts when its first prompt goes out");
	const seat = await mainSeat();
	const settledAt = {};
	onLifecycle.at = (event) => {
		if (event.channel === "subagents:completed" && event.name === "early") settledAt.early = Date.now();
	};
	// The prefix stagger holds `late` until `early`'s first turn ends; `early` then settles while `late`'s session is still starting.
	globalThis.__workflowTestSpawnDelayMs = 1500;
	const source = (early) => `${META}return parallel([() => agent('${early}', { label: 'early' }), () => agent('Answer late.', { label: 'late' })])`;
	scriptFor("run the early-late workflow", [[call("Workflow", { script: source("Answer early v1.") })], [text("started")]]);
	scriptFor("Answer early v1.", [[text("early v1")]]);
	scriptFor("Answer early v2.", [[text("early v2")]]);
	scriptFor("Answer late.", [[text("late saw early v1")], [text("late saw early v2")]]);
	await seat.session.prompt("run the early-late workflow");
	await seat.session.waitForIdle();
	const finished = () => seat.events.filter((e) => e.type === "workflow" && e.channel === "subagents:completed");
	await until(() => finished().length === 1, 15000);
	await quiet(seat);
	const first = seat.toolResults().at(-1)?.content[0].text ?? "";
	const scriptPath = /Script: (\S+)/.exec(first)?.[1] ?? "";
	const runId = /Run ID: (\S+)/.exec(first)?.[1] ?? "";
	const journal = fs.readFileSync(path.join(path.dirname(scriptPath), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const lateSent = childRequestFor("Answer late.")?.at ?? 0;
	check("the late child's first prompt went out after the early one settled", settledAt.early !== undefined && lateSent > settledAt.early, `${settledAt.early} · ${lateSent}`);
	check("so its journal line counts the early one's", journal.map((l) => `${l.label}:${l.after}`).join() === "early:0,late:1", JSON.stringify(journal));
	const edited = path.join(path.dirname(scriptPath), "..", "early-edited.js");
	fs.writeFileSync(edited, source("Answer early v2."));
	scriptFor("resume the early-late workflow", [[call("Workflow", { scriptPath: edited, resumeFromRunId: runId })], [text("resumed")]]);
	await seat.session.prompt("resume the early-late workflow");
	await seat.session.waitForIdle();
	await until(() => finished().length === 2, 15000);
	await quiet(seat);
	check("editing the early child re-runs the late one live on resume, never serving what it computed from the old world", finished()[1]?.result?.includes('"late saw early v2"') === true, finished()[1]?.result);
	onLifecycle.at = undefined;
	globalThis.__workflowTestSpawnDelayMs = 0;
	seat.session.dispose();
}

await finish();
