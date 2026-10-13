/**
 * The `Workflow` tool on a real seat, offline: a background run whose return
 * value delivers itself and resumes from its journal, args sent as a JSON
 * string, a spawn the engine refuses, and a script that does not parse.
 * The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, childRequestFor, lastUserText, mainSeat, quiet, scriptFor, text } from "../support/workflow-seat.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// A: start, run two children, return value delivers itself
{
	console.log("\nWorkflow: background run, children, the return value on landing");
	const seat = await mainSeat();
	const source = `${META}phase('Count'); const counts = await pipeline(args, (item) => agent('Count the ' + item + '.', { label: 'count:' + item })); log('counted ' + counts.length); return { counts }`;
	scriptFor("run the count workflow", [[call("Workflow", { script: source, args: ["apples", "pears"] })], [text("started")]]);
	scriptFor("Count the apples.", [[text("3 apples")]]);
	scriptFor("Count the pears.", [[text("5 pears")]]);
	await seat.session.prompt("run the count workflow");
	await seat.session.waitForIdle();
	const launch = seat.toolResults()[0]?.content[0].text ?? "";
	const runId = /Run ID: (wf_[a-z0-9-]{6,})/.exec(launch)?.[1];
	const scriptPath = /Script: (\S+)/.exec(launch)?.[1];
	check("Workflow returns at once with name, task id, run id and the persisted script path", /Name: count-things\nTask ID: a[0-9a-f]{12}\n/.test(launch) && runId !== undefined && scriptPath?.endsWith(`/workflows/${runId}/script.js`), launch);
	check("the script is persisted verbatim under the session dir", scriptPath !== undefined && fs.readFileSync(scriptPath, "utf8") === source);
	check("run.json records the session, so resume can refuse another session's run", JSON.parse(fs.readFileSync(path.join(path.dirname(scriptPath), "run.json"), "utf8")).sessionId === seat.session.sessionId);
	check("the tool result's details are the rows' contract", seat.toolResults()[0]?.details?.status === "background" && seat.toolResults()[0].details.subagentType === "workflow" && seat.toolResults()[0].details.runId === runId);
	const finished = await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 8000);
	check("the run completed in the background", finished, seat.events.map((e) => `${e.channel}:${e.type}:${e.status}`).join());
	const runDone = seat.events.find((e) => e.channel === "subagents:completed" && e.type === "workflow");
	check("the run's completed event carries the return value and the cost rollup", runDone?.result?.includes('"counts"') && runDone.result.includes("3 apples") && runDone.usage.cost.total > 0, runDone?.result);
	check("one child per item ran, in the dock's events, on the workflow's labels", seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "worker").map((e) => e.name).sort().join() === "count:apples,count:pears");
	const childRequest = childRequestFor("Count the apples.");
	const firstMessage = childRequest ? lastUserText({ messages: childRequest.messages }) : "";
	check("the child's first message opens with the worker tail", firstMessage.startsWith("<sub_agent_context>\nYou are a **worker** named `count:apples`"), firstMessage.slice(0, 300));
	check("the child contract sits once inside the tail, verbatim, all three paragraphs", firstMessage.includes("\nYour final assistant message IS the return value of a function call in a program.\nIt is not a message to a human.") && firstMessage.includes("You have no access to the conversation that created this task. Everything you need\nis in the prompt below.") && firstMessage.includes("You were given one item: do it with your own tools, and if it is too big say so in\nyour return value.") && firstMessage.endsWith("Count the apples."), firstMessage);
	check("the child holds StructuredOutput and not Workflow", childRequest !== undefined && childRequest.tools.some((t) => t.name === "StructuredOutput") && !childRequest.tools.some((t) => t.name === "Workflow"));
	check("progress events: phase, two starts, two dones, one log", seat.progress.filter((p) => p.type === "agent-start").length === 2 && seat.progress.filter((p) => p.type === "agent-done").length === 2 && seat.progress.some((p) => p.type === "log" && p.message === "counted 2") && seat.progress.some((p) => p.type === "phase" && p.title === "Count"));

	await until(() => seat.customs().length > 0, 5000);
	await seat.session.waitForIdle();
	const notices = seat.customs();
	check("exactly one notification delivers itself: the workflow's, not its children's", notices.length === 1 && notices[0].content.includes("<agent-name>count-things</agent-name>") && !notices[0].content.includes("count:apples"), notices.map((n) => n.content.slice(0, 120)).join(" | "));
	check("it carries the return value, whole, then the count of its agents", notices[0]?.content.includes('<result>{\n  "counts": [\n    "3 apples",\n    "5 pears"\n  ]\n}\n\n[agents: 2 run]\n[spent: &lt;$0.01]</result>'), notices[0]?.content);
	check("a run with no failures names none and offers no resume", !notices[0]?.content.includes("[failures") && !notices[0]?.content.includes("resumeFromRunId"), notices[0]?.content);
	const records = seat.records();
	check("children are registry entries, flagged workflowChild and read at settle", records.some((r) => r.name === "count:apples" && r.workflowChild === true && r.status === "completed" && r.readBy === "spawner"));
	check("the run is a registry entry of type workflow", records.some((r) => r.type === "workflow" && r.name === "count-things" && r.status === "completed"));
	const childCost = [...new Map(records.filter((r) => r.workflowChild).map((r) => [r.name, r])).values()].reduce((sum, r) => sum + r.costUsd, 0);
	const manifestCost = JSON.parse(fs.readFileSync(path.join(path.dirname(scriptPath), "run.json"), "utf8")).costUsd;
	check("run.json, the run's record and the event carry the children's summed cost", childCost > 0 && [manifestCost, records.findLast((r) => r.type === "workflow")?.costUsd, runDone.usage.cost.total].every((n) => Math.abs(n - childCost) < 1e-9), JSON.stringify([childCost, manifestCost, records.filter((r) => r.type === "workflow").map((r) => r.costUsd), runDone.usage.cost.total]));
	const journal = fs.readFileSync(path.join(path.dirname(scriptPath), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("the journal has one record per child with its actual return value", journal.length === 2 && journal.some((j) => j.result === "3 apples" && j.label === "count:apples"));

	// resume: same script, same args → 100% cache hit, N cached printed
	scriptFor("resume it", [[call("Workflow", { scriptPath, resumeFromRunId: runId, args: ["apples", "pears"] })], [text("resumed")]]);
	const spawnsBefore = seat.events.filter((e) => e.channel === "subagents:created" && e.type === "worker").length;
	await seat.session.prompt("resume it");
	await seat.session.waitForIdle();
	const resumeLaunch = seat.toolResults()[1]?.content[0].text ?? "";
	const { WORKFLOW_RESUME_RULE } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-tool-text.ts`);
	check("the resume launch names the prior run and its journal size, and states the rule in the words the result's [resume] line uses", resumeLaunch.includes(`Resuming ${runId}: 2 journalled result(s). ${WORKFLOW_RESUME_RULE}`), resumeLaunch);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 8000);
	check("no child ran: the journal answered every call", seat.events.filter((e) => e.channel === "subagents:created" && e.type === "worker").length === spawnsBefore);
	const resumed = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1];
	check("a resumed run prints N cached above the same return value", resumed?.result?.startsWith(`[resumed from ${runId} \u2014 2 cached]\n{`) && resumed.result.includes("5 pears"), resumed?.result);
	const first = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[0];
	check("the resumed run takes over the run's name and task id, as the engine's resume keeps an agent's", resumed?.name === "count-things" && typeof resumed.id === "string" && resumed.id === first?.id, `${resumed?.name} ${resumed?.id} ${first?.id}`);
	check("the resume re-opens the run's dock row on subagents:resumed, not a second row on subagents:created", seat.events.filter((e) => e.channel === "subagents:created" && e.type === "workflow").length === 1 && seat.events.some((e) => e.channel === "subagents:resumed" && e.type === "workflow" && e.id === first?.id));
	const { workflowRunsOf } = await jiti.import(`${KIT_ROOT}/lib/workflow/workflow-run-store.ts`);
	check("the row's run view is the resumed run's", workflowRunsOf(seat.session.sessionId).byTaskId(first?.id)?.runId !== runId);
	check("progress marked both as cached", seat.progress.filter((p) => p.type === "agent-cached").length === 2);
	const byOldId = seat.records().filter((r) => r.taskId === first?.id).at(-1);
	check("the old task id now names the resumed run, which TaskOutput and TaskStop resolve by name or id", byOldId?.name === "count-things" && byOldId.sessionId !== runId && byOldId.result?.startsWith(`[resumed from ${runId}`), JSON.stringify(byOldId)?.slice(0, 200));
	seat.session.dispose();
}

// F: a string-encoded args payload and the real object reach the script as the same value (ticket 55)
{
	console.log("\nWorkflow: args as a JSON string");
	const seat = await mainSeat();
	const source = `${META}return { tests: args.tests, first: args.tests[0] }`;
	scriptFor("run it with stringified args", [[call("Workflow", { script: source, args: '{"tests":["a.ts","b.ts"]}' })], [text("started")]]);
	await seat.session.prompt("run it with stringified args");
	await seat.session.waitForIdle();
	const stringRunDir = path.dirname(/Script: (\S+)/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1] ?? "");
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 8000);
	await quiet(seat);
	const fromString = seat.events.find((e) => e.channel === "subagents:completed" && e.type === "workflow")?.result ?? "";
	check("the script sees the object the string encoded, not the string", JSON.parse(fromString).first === "a.ts" && JSON.parse(fromString).tests.length === 2, fromString);
	check("the manifest records the parsed value, never the raw string", JSON.parse(fs.readFileSync(path.join(stringRunDir, "run.json"), "utf8")).args.tests[0] === "a.ts");
	check("the run logs one line saying it parsed them, so /workflows says it", seat.progress.some((p) => p.type === "log" && p.message === "args arrived as a JSON string and were parsed into the value they encode"), seat.progress.filter((p) => p.type === "log").map((p) => p.message).join(" | "));

	scriptFor("run it with real args", [[call("Workflow", { script: source, args: { tests: ["a.ts", "b.ts"] } })], [text("started")]]);
	await seat.session.prompt("run it with real args");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 8000);
	await quiet(seat);
	const fromObject = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1]?.result ?? "";
	check("a real object and its string form are the same run", fromObject === fromString && fromObject !== "", `${fromObject} vs ${fromString}`);

	scriptFor("run it with prose args", [[call("Workflow", { script: `${META}return { got: args, type: typeof args }`, args: "plain text" })], [text("started")]]);
	await seat.session.prompt("run it with prose args");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 3, 8000);
	await quiet(seat);
	const prose = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[2]?.result ?? "";
	check("a string that is not JSON reaches the script as the string", JSON.parse(prose).got === "plain text" && JSON.parse(prose).type === "string", prose);
	seat.session.dispose();
}

// K: a spawn the engine refuses (an unknown type) is the script's own error, as in Claude Code: catchable, and null in its slot
{
	console.log("\nWorkflow: a refused spawn");
	const seat = await mainSeat();
	scriptFor("run the typo workflow", [[call("Workflow", { script: `${META}const slots = await parallel([() => agent('Typo one.', { type: 'nope' }), () => 'other']); let caught; try { await agent('Typo two.', { type: 'nope' }) } catch (e) { caught = e.message } return { slots, caught }` })], [text("started")]]);
	await seat.session.prompt("run the typo workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed")), 8000);
	await quiet(seat);
	const landed = seat.events.find((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed"));
	const value = landed?.status === "completed" ? JSON.parse(landed.result.slice(0, landed.result.indexOf("\n}") + 2)) : undefined;
	check("an unknown type rejects that agent() alone: a catch sees the engine's words and a parallel slot is null", value?.slots?.[0] === null && value.slots[1] === "other" && value.caught?.startsWith('Unknown subagent_type "nope"'), `${landed?.status} \u00b7 ${landed?.result ?? landed?.error}`);
	check("and the dropped slot is a failure line of the result", landed?.result?.includes('- parallel task at index 0 dropped: Unknown subagent_type "nope"'), landed?.result);
	check("each refused agent is counted failed, never left unfinished, and the caught one is named too", landed?.result?.includes("[agents: 2 run (2 failed)]") && landed.result.includes('\n- agent #2 failed: Unknown subagent_type "nope"'), landed?.result);
	seat.session.dispose();
}

// S: a script that does not parse is refused by the call, at its line in the script as written, and never becomes a run
{
	console.log("\nWorkflow: a script that does not parse");
	const seat = await mainSeat();
	const broken = "export const meta = {\n  name: 'broken',\n  description: 'Does not parse',\n};\nconst x = 1;\n  foo(}\nreturn x;\n";
	scriptFor("run the broken workflow", [[call("Workflow", { script: broken })], [call("Workflow", { script: "export const meta = { name: 'importer', description: 'Imports' }\nreturn import('node:fs')" })], [text("refused")]]);
	await seat.session.prompt("run the broken workflow");
	await seat.session.waitForIdle();
	const [syntax, imported] = seat.toolResults().map((m) => ({ err: m.isError, text: m.content[0].text }));
	check("a syntax error is refused by the call, naming script.js:LINE:COL of the script as written, the source line and the caret", syntax?.err === true && /\/workflows\/wf_[0-9a-f]+\/script\.js:6:7: SyntaxError: Unexpected token '\}'\n  foo\(\}\n      \^$/.test(syntax.text), syntax?.text);
	const { IMPORT_REFUSED } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-sandbox.ts`);
	check("import() is refused by the call too", imported?.err === true && imported.text === IMPORT_REFUSED, imported?.text);
	check("neither became a run", !seat.events.some((e) => e.type === "workflow"), seat.events.map((e) => `${e.channel}:${e.type}`).join());
	const refusedDir = path.dirname(/(\/\S+\/script\.js):/.exec(syntax?.text ?? "")?.[1] ?? "");
	const refusedManifest = fs.existsSync(path.join(refusedDir, "run.json")) ? JSON.parse(fs.readFileSync(path.join(refusedDir, "run.json"), "utf8")) : undefined;
	check("the script.js it names sits beside a run.json that says it was refused", fs.existsSync(path.join(refusedDir, "script.js")) && refusedManifest?.status === "error" && refusedManifest.error === syntax?.text, JSON.stringify(refusedManifest));
	seat.session.dispose();
}

await finish();
