/**
 * Stopping a workflow, offline: `TaskStop` on a run and its children, the
 * call's refusals, a stalled child whose restart the engine refuses, and a run
 * the session's end stops. The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, META, call, lastUserText, mainSeat, quiet, requests, scriptFor, text } from "../support/workflow-seat.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// C: TaskStop stops a running workflow and its children; refusals; StructuredOutput on the main seat
{
	console.log("\nWorkflow: stop, refusals");
	const seat = await mainSeat();
	scriptFor("run the slow workflow", [[call("Workflow", { script: `${META}return agent('Take ages.', { label: 'slow' })` })], [text("started")]]);
	// One cheap turn first, so the child has spent something by the time it is stopped.
	scriptFor("Take ages.", [[call("ListAgents", {})], { delay: 5000, content: [text("finally")] }]);
	await seat.session.prompt("run the slow workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:started" && e.name === "slow"), 3000);
	await quiet(seat);
	scriptFor("stop it", [[call("TaskStop", { name: "count-things" })], [text("stopped")]]);
	await seat.session.prompt("stop it");
	await seat.session.waitForIdle();
	const stopText = seat.toolResults()[1]?.content[0].text ?? "";
	check("TaskStop by the workflow's name stops it and says how to resume", stopText.startsWith("Stopped count-things.") && stopText.includes("resumeFromRunId"), stopText);
	await quiet(seat);
	const stopped = seat.events.find((e) => e.channel === "subagents:failed" && e.type === "workflow");
	check("the run settles as stopped", stopped?.status === "stopped");
	check("and its cost counts what the child it stopped had spent", stopped?.usage?.cost?.total > 0, JSON.stringify(stopped?.usage));
	check("the in-flight child was stopped too", seat.events.some((e) => e.channel === "subagents:failed" && e.name === "slow" && e.status === "stopped"), seat.events.filter((e) => e.name === "slow").map((e) => `${e.channel}:${e.status}`).join());
	scriptFor("list them", [[call("ListAgents", {})], [text("listed")]]);
	await seat.session.prompt("list them");
	await seat.session.waitForIdle();
	check("ListAgents shows the run as a workflow row", /count-things \u00b7 workflow \u00b7 stopped/.test(seat.toolResults()[2]?.content[0].text ?? ""), seat.toolResults()[2]?.content[0].text);

	scriptFor("refusals", [
		[call("Workflow", {})],
		[call("Workflow", { script: "const meta = 1" })],
		[call("Workflow", { name: "no-such" })],
		[call("Workflow", { scriptPath: "/nowhere/x.js" })],
		[call("Workflow", { script: META, resumeFromRunId: "wf_000000" })],
		[call("StructuredOutput", { result: { any: "thing" } })],
		[text("refused")],
	]);
	await seat.session.prompt("refusals");
	await seat.session.waitForIdle();
	const refusals = seat.toolResults().slice(3).map((m) => ({ err: m.isError, text: m.content[0].text }));
	check("no script at all is refused", refusals[0]?.err && refusals[0].text.includes("needs one of `script`, `scriptPath` or `name`"), refusals[0]?.text);
	check("a script without meta is refused with the rule", refusals[1]?.err && refusals[1].text.includes("script must begin with `export const meta = {...}`"));
	check("an unknown saved name is refused, naming the directory", refusals[2]?.err && refusals[2].text.includes('Unknown workflow name "no-such"') && refusals[2].text.includes("/workflows/no-such.js"));
	check("an unreadable scriptPath is refused", refusals[3]?.err && refusals[3].text.includes("Unreadable scriptPath /nowhere/x.js"));
	check("an unknown resumeFromRunId is refused", refusals[4]?.err && refusals[4].text.includes("No run wf_000000"));
	check("StructuredOutput outside a workflow child does not exist: pi has no such tool on the seat", refusals[5]?.err && refusals[5].text === "Tool StructuredOutput not found", refusals[5]?.text);

	// Ticket 54 §1: a child has hands, not judgement — it may not start a workflow.
	scriptFor("run the nesting workflow", [[call("Workflow", { script: `${META}return agent('Do the one item.', { label: 'nester' })` })], [text("started")]]);
	scriptFor("Do the one item.", [[call("Workflow", { script: META })], [text("did the item myself")]]);
	await seat.session.prompt("run the nesting workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "nester"), 8000);
	await quiet(seat);
	const nested = requests.filter((r) => lastUserText({ messages: r.messages }).includes("Do the one item.")).flatMap((r) => r.messages.filter((m) => m.role === "toolResult")).find((m) => JSON.stringify(m.content).includes("Tool Workflow not found"));
	check("a workflow child has no Workflow tool: its type file lists none", nested?.isError === true && nested.content[0].text === "Tool Workflow not found", JSON.stringify(nested?.content));
	check("the refused child did its item and the run landed on its value", seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow" && e.result?.startsWith("did the item myself\n")), seat.events.filter((e) => e.type === "workflow").map((e) => `${e.channel}:${e.status}`).join());

	// a saved workflow by name
	fs.writeFileSync(path.join(AGENT_DIR, "workflows", "saved.js"), `export const meta = { name: 'saved', description: 'A saved one' }\nreturn 'from ' + args.who`);
	scriptFor("run the saved one", [[call("Workflow", { name: "saved", args: { who: "disk" } })], [text("started")], [text("woken")]]);
	await seat.session.prompt("run the saved one");
	await seat.session.waitForIdle();
	const woke = await until(() => seat.customs().some((m) => m.content.includes("<result>from disk</result>")), 5000);
	check("a saved workflow runs by name with args and delivers the return value as its own turn", woke, seat.customs().map((m) => m.content.slice(0, 80)).join(" | "));
	seat.session.dispose();
}

// P: a restart after a stall comes after a child ran, so the engine refusing it is that child's death, never a refused spawn
{
	console.log("\nWorkflow: a restart the engine refuses");
	const { agentRuntimeOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const seat = await mainSeat();
	// A worktree that cannot be made for the second attempt, simulated at the seam.
	const runtime = agentRuntimeOf(seat.session.sessionId);
	const spawn = runtime.spawn.bind(runtime);
	let spawns = 0;
	runtime.spawn = (request) => (request.prompt.includes("Hang, then be refused.") && ++spawns === 2 ? Promise.reject(new Error("worktree add failed")) : spawn(request));
	scriptFor("run the refused-restart workflow", [[call("Workflow", { script: `${META}let got; try { got = await agent('Hang, then be refused.', { label: 'hanger', stallMs: 800 }) } catch (e) { got = 'threw: ' + e.message } return { got, after: await agent('Then go on.', { label: 'next' }) }` })], [text("started")]]);
	scriptFor("Hang, then be refused.", [{ delay: 20000, content: [text("too late")] }]);
	scriptFor("Then go on.", [[text("went on")]]);
	await seat.session.prompt("run the refused-restart workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed")), 15000);
	await quiet(seat);
	const landed = seat.events.find((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed"));
	check("the stalled child whose restart was refused is null in the value, and the run goes on", landed?.status === "completed" && landed.result?.startsWith('{\n  "got": null,\n  "after": "went on"\n}'), `${landed?.status} · ${landed?.result ?? landed?.error}`);
	check("its death names the refused restart and the engine's words", /- agent "hanger" \(#1\) failed: .*restart refused: worktree add failed/.test(landed?.result ?? ""), landed?.result);
	const scriptPath = /Script: (\S+)/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1] ?? "";
	const journal = fs.readFileSync(path.join(path.dirname(scriptPath), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("and it is journalled as failed, so the agent after it is not served on a resume", journal.length === 2 && journal[0].type === "failed" && journal[1].result === "went on" && journal[1].after === 1, JSON.stringify(journal));
	seat.session.dispose();
}

// Q: a run the session's end stops still settles into its own session's store, and run.json keeps its failures
{
	console.log("\nWorkflow: a run stopped by the session's end");
	const seat = await mainSeat();
	const sessionId = seat.session.sessionId;
	scriptFor("run the shutdown workflow", [[call("Workflow", { script: `${META}const fell = await agent('Fall at once.', { label: 'faller' }); await agent('Hold the run open.', { label: 'holder' }); return fell` })], [text("started")]]);
	scriptFor("Fall at once.", [{ error: "invalid_request: the faller fell" }]);
	scriptFor("Hold the run open.", [{ delay: 20000, content: [text("too late")] }]);
	await seat.session.prompt("run the shutdown workflow");
	await seat.session.waitForIdle();
	const scriptPath = /Script: (\S+)/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1] ?? "";
	const manifestFile = path.join(path.dirname(scriptPath), "run.json");
	await until(() => seat.events.some((e) => e.channel === "subagents:created" && e.name === "holder"), 5000);
	await seat.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await until(() => JSON.parse(fs.readFileSync(manifestFile, "utf8")).status !== "running", 8000);
	const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	check("run.json of a run the session's end stopped keeps the failure it had", manifest.status === "stopped" && manifest.failures?.length === 1 && manifest.failures[0].reason.includes("the faller fell"), JSON.stringify({ status: manifest.status, failures: manifest.failures }));
	check("and the ended session's run store is not made again by the run settling late", globalThis.__piKitWorkflowRuns?.has(sessionId) === false, String(globalThis.__piKitWorkflowRuns?.has(sessionId)));
	seat.session.dispose();
}

await finish();
