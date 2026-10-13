/**
 * What a workflow's result says, offline: a big return value as a path and a
 * head, a dead run's verdict delivered once, and the failures and the resume
 * line. The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, mainSeat, quiet, scriptFor, text } from "../support/workflow-seat.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// E: a big return value enters the parent as a path and a head (ticket 58)
{
	console.log("\nWorkflow: the return value's path and head");
	const seat = await mainSeat();
	const blob = "x".repeat(1_000_000);
	scriptFor("run the fat workflow", [[call("Workflow", { script: `${META}return { blob: 'x'.repeat(1000000), items: ['a', 'b', 'c'] }` })], [text("started")]]);
	await seat.session.prompt("run the fat workflow");
	await seat.session.waitForIdle();
	const runDir = path.dirname(/Script: (\S+)/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1] ?? "");
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 8000);
	await quiet(seat);
	const fat = seat.events.find((e) => e.channel === "subagents:completed" && e.type === "workflow")?.result ?? "";
	const lines = fat.split("\n");
	check("a 1 MB return value costs the parent a couple of thousand chars, not a hundred thousand", fat.length < 3000, String(fat.length));
	check("the first line is the size and the path of the whole value", lines[0] === `[workflow result: 1000060 chars; whole value at ${runDir}/result.json]`, lines[0]);
	check("the shape names every top-level key with its type and size", lines[1] === "Shape: object with 2 keys" && lines[2] === "  .blob \u2014 string of 1000000 chars" && lines[3] === "  .items \u2014 array of 3", lines.slice(1, 4).join(" · "));
	check("and the jq that reads the rest is written out, filter and path", lines[4] === `Read the rest with jq, e.g. jq '.blob' ${runDir}/result.json`, lines[4]);
	check("a sample of the value itself follows, exactly 2000 chars", lines[5] === "First 2000 chars:" && lines.slice(6).join("\n").length === 2000, `${lines[5]} · ${lines.slice(6).join("\n").length}`);
	check("result.json holds the whole value", JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")).blob === blob);

	// 2 KB is what a workflow usually returns, and it lands whole: the head is for
	// the audit that returns hundreds of KB, not a tax on every run.
	scriptFor("run the thin workflow", [[call("Workflow", { script: `${META}return { note: 'y'.repeat(2000) }` })], [text("started")]]);
	await seat.session.prompt("run the thin workflow");
	await seat.session.waitForIdle();
	const thinDir = path.dirname(/Script: (\S+)/.exec(seat.toolResults()[1]?.content[0].text ?? "")?.[1] ?? "");
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 8000);
	await quiet(seat);
	const thin = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1];
	check("a 2 KB value lands whole, no head, and its result.json is written all the same", JSON.parse(thin?.result ?? "{}").note === "y".repeat(2000) && fs.readFileSync(path.join(thinDir, "result.json"), "utf8") === thin?.result, thin?.result?.slice(0, 80));

	const landed = () => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow");
	scriptFor("run the bigint workflow", [[call("Workflow", { script: `${META}return 10n` })], [text("started")]]);
	await seat.session.prompt("run the bigint workflow");
	await seat.session.waitForIdle();
	await until(() => landed().length === 3, 8000);
	await quiet(seat);
	check("a bigint return value lands as its String(), and the run settles", landed()[2]?.status === "completed" && landed()[2]?.result === "10", `${landed()[2]?.status} · ${landed()[2]?.result}`);

	scriptFor("run the unrecorded workflow", [[call("Workflow", { script: `${META}await new Promise((resolve) => setTimeout(resolve, 300)); return 'kept'` })], [text("started")]]);
	await seat.session.prompt("run the unrecorded workflow");
	await seat.session.waitForIdle();
	const lockedDir = path.dirname(/Script: (\S+)/.exec(seat.toolResults()[3]?.content[0].text ?? "")?.[1] ?? "");
	fs.chmodSync(path.join(lockedDir, "run.json"), 0o444);
	await until(() => landed().length === 4, 8000);
	await quiet(seat);
	fs.chmodSync(path.join(lockedDir, "run.json"), 0o644);
	check("a run.json that cannot be written still lets the run settle, and the result says so", landed()[3]?.status === "completed" && /^kept\n\n\[run\.json not updated: EACCES/.test(landed()[3]?.result ?? ""), `${landed()[3]?.status} · ${landed()[3]?.result}`);

	scriptFor("run the unwritable workflow", [[call("Workflow", { script: `${META}await new Promise((resolve) => setTimeout(resolve, 1500)); return { ok: 1 }` })], [text("started")]]);
	await seat.session.prompt("run the unwritable workflow");
	await seat.session.waitForIdle();
	const blockedDir = path.dirname(/Script: (\S+)/.exec(seat.toolResults()[4]?.content[0].text ?? "")?.[1] ?? "");
	fs.mkdirSync(path.join(blockedDir, "result.json"));
	await until(() => landed().length === 5, 8000);
	await quiet(seat);
	check("a result.json that cannot be written is named in a short result too", /^\{\n? *"ok": 1\n?\}\n\[result\.json not written: EISDIR/.test(landed()[4]?.result ?? ""), `${landed()[4]?.status} · ${landed()[4]?.result}`);
	seat.session.dispose();

	const { headWorkflowResult } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-result-text.ts`);
	const unwritten = headWorkflowResult({ blob }, JSON.stringify({ blob }), { path: "/nowhere/result.json", writeError: "ENOSPC: no space left on device" }).split("\n");
	check("a failed disk write is named on the first line, never a file that is not there", unwritten[0] === "[workflow result: 1000011 chars; the whole value could not be written to /nowhere/result.json: ENOSPC: no space left on device]", unwritten[0]);
	check("and no jq is offered for a file nobody wrote", !unwritten.some((line) => line.startsWith("Read the rest with jq")), unwritten.join(" | "));
	const listed = headWorkflowResult([{ file: "a.ts" }], `[\n${" ".repeat(9000)}\n]`, { path: "/tmp/result.json" }).split("\n");
	check("an array says its length, the shape of its first element, and jq's index filter", listed[1] === "Shape: array of 1" && listed[2] === "  [0] \u2014 object with 1 keys" && listed[3] === "Read the rest with jq, e.g. jq '.[0]' /tmp/result.json", listed.slice(1, 4).join(" · "));
}

// G: a run that dies delivers its verdict exactly once (ticket 56)
{
	console.log("\nWorkflow: a dead run's verdict arrives once");
	const seat = await mainSeat();
	scriptFor("run the broken workflow", [[call("Workflow", { script: `${META}return pipeline(args.tests, (t) => agent('Do ' + t))` })], [text("started")]]);
	await seat.session.prompt("run the broken workflow");
	await seat.session.waitForIdle();
	const taskId = /Task ID: (a[0-9a-f]{12})/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1];
	await until(() => seat.events.some((e) => e.channel === "subagents:failed" && e.type === "workflow"), 8000);
	await quiet(seat);
	const carrying = () => seat.customs().filter((m) => m.content.includes(`<task-id>${taskId}</task-id>`));
	check("a script that throws at start fails the run with the reason", seat.events.some((e) => e.channel === "subagents:failed" && e.type === "workflow" && /tests/.test(e.error ?? "")), seat.events.filter((e) => e.type === "workflow").map((e) => `${e.channel}:${e.status}`).join());
	check("its verdict reaches the conversation once", carrying().length === 1, `${carrying().length} · ${seat.customs().map((m) => m.content.slice(0, 80)).join(" | ")}`);
	scriptFor("stop it and wait on it", [[call("TaskStop", { name: "count-things" })], [call("TaskOutput", { names: ["count-things"], block: false })], [text("ok")]]);
	await seat.session.prompt("stop it and wait on it");
	await seat.session.waitForIdle();
	const stopText = seat.toolResults()[1]?.content[0].text ?? "";
	check("TaskStop on the dead run says it ended, with its verdict and where that went", stopText.startsWith('Agent "count-things" already ended (error);') && stopText.includes("delivered to your conversation"), stopText);
	const waitText = seat.toolResults()[2]?.content[0].text ?? "";
	check("TaskOutput on it promises no later landing", !waitText.includes("do not wait again") && waitText.includes("delivered to your conversation"), waitText);
	// Ticket 56's sequence: another run lands, then a fresh turn. Neither may bring
	// the dead run's verdict back as news.
	scriptFor("run a good workflow", [[call("Workflow", { script: `${META}return 'fine'` })], [text("started")]]);
	await seat.session.prompt("run a good workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 8000);
	await quiet(seat);
	scriptFor("anything else", [[text("nothing else")]]);
	await seat.session.prompt("anything else");
	await seat.session.waitForIdle();
	await quiet(seat);
	check("and no later landing or turn brings it back", carrying().length === 1, `${carrying().length} · ${seat.customs().map((m) => m.content.slice(0, 80)).join(" | ")}`);
	seat.session.dispose();
}

// H: the result names what went wrong — failed agents, dropped items and tasks — and how to resume
{
	console.log("\nWorkflow: failures in the result");
	const seat = await mainSeat();
	const LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
	const source = `${META}const counted = await parallel([...args.fruits.map((f) => () => agent('Count the ' + f + '.', { label: 'count:' + f })), () => { throw new Error('no such fruit') }]); const kiwis = await pipeline(['kiwi'], () => { throw new Error('bad kiwi') }); return { counted, kiwis }`;
	scriptFor("run the fruit workflow", [[call("Workflow", { script: source, args: { fruits: ["limes", "figs"] } })], [text("started")]]);
	scriptFor("Count the limes.", [[text("4 limes")]]);
	scriptFor("Count the figs.", [{ error: LIMIT }, [text("7 figs")]]);
	await seat.session.prompt("run the fruit workflow");
	await seat.session.waitForIdle();
	const scriptPath = /Script: (\S+)/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1] ?? "";
	const runId = /Run ID: (wf_[a-z0-9-]{6,})/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1];
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 8000);
	await quiet(seat);
	const landed = seat.events.find((e) => e.channel === "subagents:completed" && e.type === "workflow")?.result ?? "";
	const lines = landed.split("\n");
	const after = lines.slice(lines.indexOf("}") + 1);
	check("the value comes first, whole", JSON.parse(lines.slice(0, lines.indexOf("}") + 1).join("\n")).counted[0] === "4 limes", landed);
	check("then the counts: agents run, and how many of them failed", after[1] === "[agents: 2 run (1 failed)]", after.join(" | "));
	check("then one line per failure, in the order they happened", after[3] === "[failures: 3]" && after.length >= 7, after.join(" | "));
	check("a child killed by a usage limit is named, with the provider's words and its reset time", after.some((l) => l.startsWith('- agent "count:figs" (#2) failed: ') && l.includes(LIMIT)), after.join(" | "));
	check("a dropped parallel task and a dropped pipeline item are lines of their own", after.some((l) => /^- parallel task at index 2 dropped: .*no such fruit/.test(l)) && after.some((l) => /^- pipeline item at index 0 dropped: .*bad kiwi/.test(l)), after.join(" | "));
	const resume = after.find((l) => l.startsWith("[resume]")) ?? "";
	check("the result says how to resume, and to wait out a usage limit first", resume.includes(`Workflow({scriptPath: "${scriptPath}", resumeFromRunId: "${runId}"})`) && resume.includes("usage limit") && resume.includes("resets"), resume);
	const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(scriptPath), "run.json"), "utf8"));
	check("run.json keeps every failure, structured", manifest.failures?.length === 3 && manifest.failures.some((f) => f.kind === "agent" && f.ordinal === 2 && f.reason.includes(LIMIT)) && manifest.failures.some((f) => f.kind === "item" && f.index === 0), JSON.stringify(manifest.failures));

	// The resume line is a call the parent can make as printed: it names no args, so the prior run's carry over.
	scriptFor("resume the fruit workflow", [[call("Workflow", { scriptPath, resumeFromRunId: runId })], [text("resumed")]]);
	await seat.session.prompt("resume the fruit workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 8000);
	await quiet(seat);
	const resumed = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1]?.result ?? "";
	check("resumed as printed, the finished agent replays and only the failed one runs again", resumed.startsWith(`[resumed from ${runId} — 1 cached]`) && resumed.includes('"7 figs"') && resumed.includes("[agents: 1 run, 1 cached]"), resumed);

	// A run that errors reports its failures and its resume line too, not only the error.
	scriptFor("run the plum workflow", [[call("Workflow", { script: `${META}const n = await agent('Count the plums.', { label: 'count:plums' }); if (n === null) throw new Error('no plum count'); return n` })], [text("started")]]);
	scriptFor("Count the plums.", [{ error: "invalid_request: the plums are not countable" }]);
	await seat.session.prompt("run the plum workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:failed" && e.type === "workflow"), 8000);
	await quiet(seat);
	const errored = seat.events.find((e) => e.channel === "subagents:failed" && e.type === "workflow");
	const erroredLines = errored?.result?.split("\n") ?? [];
	check("an errored run keeps its error and carries the failures block", errored?.status === "error" && errored.error?.includes("no plum count") && erroredLines[0] === "[agents: 1 run (1 failed)]" && erroredLines.some((l) => l.startsWith('- agent "count:plums" (#1) failed: ') && l.includes("the plums are not countable")), `${errored?.error} · ${errored?.result}`);
	check("and the resume line", erroredLines.some((l) => l.startsWith("[resume] Workflow({scriptPath: ") && l.includes("resumeFromRunId")), errored?.result);
	check("the notification shows both the error and the failures", seat.customs().some((m) => m.content.includes("<status>error</status>") && m.content.includes("the plums are not countable") && m.content.includes("[resume]")), seat.customs().map((m) => m.content.slice(0, 120)).join(" | "));
	seat.session.dispose();

	const { workflowRunReport, WORKFLOW_RESULT_FAILURES_SHOWN, WORKFLOW_FAILURE_REASON_MAX_CHARS } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-result-text.ts`);
	const { WorkflowRunStore } = await jiti.import(`${KIT_ROOT}/lib/workflow/workflow-run-store.ts`);
	const store = new WorkflowRunStore();
	store.start({ runId: "wf_bound", taskId: "a1", name: "bound", description: "", startedAt: 0 });
	for (let ordinal = 1; ordinal <= 25; ordinal++) {
		store.apply("wf_bound", { type: "agent-start", ordinal, label: undefined, phase: undefined });
		store.apply("wf_bound", { type: "agent-failed", ordinal, reason: ordinal === 1 ? "x".repeat(5000) : `reason ${ordinal}` });
	}
	store.apply("wf_bound", { type: "agent-start", ordinal: 26, label: "by-hand", phase: undefined });
	store.apply("wf_bound", { type: "agent-skipped", ordinal: 26, reason: "by-hand skipped by hand" });
	const where = { scriptPath: "/runs/wf_bound/script.js", journalPath: "/runs/wf_bound/journal.jsonl", manifestPath: "/runs/wf_bound/run.json", runId: "wf_bound" };
	const report = workflowRunReport(store.get("wf_bound"), where, "completed");
	const failureLines = report.filter((l) => l.startsWith("- "));
	check("the failures shown are bounded, the rest counted and pointed at", WORKFLOW_RESULT_FAILURES_SHOWN === 20 && failureLines.length === 20 && report.includes("… and 6 more in /runs/wf_bound/run.json (.failures)"), report.join(" | "));
	check("counts separate a skip from a failure", report[0] === "[agents: 26 run (25 failed, 1 skipped)]" && report[1] === "[failures: 26]", report.slice(0, 2).join(" | "));
	check("an agent with no label is named by its ordinal", failureLines[1] === "- agent #2 failed: reason 2", failureLines[1]);
	const { WORKFLOW_PARAMS, WORKFLOW_RESUME_RULE } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-tool-text.ts`);
	const resumeLine = report.find((l) => l.startsWith("[resume]")) ?? "";
	check("the resume line states the journal's rule in the words the resumeFromRunId parameter uses", typeof WORKFLOW_RESUME_RULE === "string" && resumeLine.includes(WORKFLOW_RESUME_RULE) && WORKFLOW_PARAMS.resumeFromRunId.includes(WORKFLOW_RESUME_RULE) && !resumeLine.includes("runs the others again"), resumeLine);
	check("a reason as long as a provider's response body is cut", failureLines[0].length < WORKFLOW_FAILURE_REASON_MAX_CHARS + 40 && failureLines[0].endsWith("…"), String(failureLines[0].length));

	store.start({ runId: "wf_dropped", taskId: "a2", name: "dropped", description: "", startedAt: 0 });
	store.apply("wf_dropped", { type: "rejection-unhandled", reason: "dropped" });
	const droppedReport = workflowRunReport(store.get("wf_dropped"), { ...where, runId: "wf_dropped" }, "completed");
	check("a promise the script left rejected is a failure line of its own, and a log line", droppedReport[0] === "[failures: 1]" && droppedReport[1] === "- a promise the script never handled rejected: dropped" && store.get("wf_dropped")?.logs.at(-1) === "unhandled rejection: dropped", `${droppedReport.join(" | ")} · ${store.get("wf_dropped")?.logs.join()}`);
}

await finish();
