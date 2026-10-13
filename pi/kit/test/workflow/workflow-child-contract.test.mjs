/**
 * A workflow child's name and contract, offline: `StructuredOutput` validated
 * and nudged, siblings that share a label, blank and padded labels and names,
 * a nudge that cannot be sent, and a child named otherwise than asked.
 * The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, childRequestFor, lastUserText, mainSeat, onLifecycle, quiet, requests, scriptFor, text } from "../support/workflow-seat.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// B: schema — validated at the tool boundary, the model retries, agent() returns the object
{
	console.log("\nWorkflow: structured output");
	const seat = await mainSeat();
	const schema = { type: "object", additionalProperties: false, required: ["file", "fixed"], properties: { file: { type: "string" }, fixed: { type: "boolean" } } };
	const source = `${META}const r = await agent('Fix a.ts.', { label: 'fix:a.ts', schema: ${JSON.stringify(schema)} }); return r`;
	scriptFor("run the fix workflow", [[call("Workflow", { script: source })], [text("started")]]);
	scriptFor("Fix a.ts.", [
		[call("StructuredOutput", { result: { file: "a.ts", fixed: "yes" } })],
		[call("StructuredOutput", { result: { file: "a.ts", fixed: true } })],
		[text("done")],
	]);
	await seat.session.prompt("run the fix workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 8000);
	await quiet(seat);
	const childRequest = childRequestFor("Fix a.ts.");
	const firstMessage = childRequest ? lastUserText({ messages: childRequest.messages }) : "";
	check("the child's prompt ends with the StructuredOutput instruction and the schema inline", firstMessage.includes("call StructuredOutput exactly once, as your final action") && firstMessage.includes('"required":["file","fixed"]'), firstMessage.slice(-300));
	const childToolResults = requests.filter((r) => lastUserText({ messages: r.messages }).includes("Fix a.ts.")).flatMap((r) => r.messages.filter((m) => m.role === "toolResult"));
	const rejected = childToolResults.find((m) => JSON.stringify(m.content).includes("Schema validation failed"));
	check("the bad value came back as an error tool result naming the path and the attempts left", rejected !== undefined && rejected.isError === true && JSON.stringify(rejected.content).includes("/fixed must be boolean") && JSON.stringify(rejected.content).includes("2 attempts left"), JSON.stringify(rejected?.content));
	const accepted = childToolResults.find((m) => JSON.stringify(m.content).includes("Recorded. You are done"));
	check("the good value was recorded", accepted !== undefined && accepted.isError !== true);
	const runDone = seat.events.find((e) => e.channel === "subagents:completed" && e.type === "workflow");
	check("agent() returned the validated object, not the child's text", runDone?.result === '{\n  "file": "a.ts",\n  "fixed": true\n}\n\n[agents: 1 run]\n[spent: <$0.01]', runDone?.result);
	const declared = childRequest?.tools?.find((t) => t.name === "StructuredOutput")?.parameters?.properties?.result;
	check("the child is shown a typed `result`: an object, not a property with no type (ticket 37)", declared?.type === "object", JSON.stringify(declared));


	// a child that ends without calling is nudged once (resume by name), then delivers
	scriptFor("run the forgetful workflow", [[call("Workflow", { script: `${META}return agent('Fix b.ts.', { label: 'fix:b.ts', schema: ${JSON.stringify(schema)} })` })], [text("started")]]);
	scriptFor("Fix b.ts.", [[text("I fixed it, in prose.")]]);
	scriptFor("You ended without calling StructuredOutput", [[call("StructuredOutput", { result: { file: "b.ts", fixed: true } })], [text("ok")]]);
	await seat.session.prompt("run the forgetful workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 8000);
	await quiet(seat);
	const forgetful = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1];
	check("a turn that ends without a call is nudged from its transcript and the second turn's value is returned", forgetful?.result?.includes('"file": "b.ts"'), forgetful?.result);
	// A resume announces itself on `subagents:resumed`, under the agent's own
	// task id, so the dock revives one row instead of drawing a second.
	check("the nudge went to the same agent, resumed under the same name", seat.events.filter((e) => e.channel === "subagents:created" && e.name === "fix:b.ts").length === 1 && seat.events.filter((e) => e.channel === "subagents:resumed" && e.name === "fix:b.ts").length === 1);
	check("no child result reached the conversation: the two notifications so far are the two runs'", seat.customs().length === 2 && seat.customs().every((m) => !m.content.includes("<agent-name>fix:")), seat.customs().map((m) => m.content.slice(0, 100)).join(" | "));

	// three failures: that slot is null and the run goes on
	scriptFor("run the doomed workflow", [[call("Workflow", { script: `${META}return pipeline([1], () => agent('Fix c.ts.', { label: 'fix:c.ts', schema: ${JSON.stringify(schema)} }))` })], [text("started")]]);
	scriptFor("Fix c.ts.", [
		[call("StructuredOutput", { result: { file: 1 } })],
		[call("StructuredOutput", { result: { file: 2 } })],
		[call("StructuredOutput", { result: { file: 3 } })],
		[text("giving up")],
	]);
	await seat.session.prompt("run the doomed workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 3, 8000);
	await quiet(seat);
	const doomed = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[2];
	check("schema validation failing 3× makes that slot null, even inside pipeline; the run completes", doomed?.status === "completed" && /^\[\s*null\s*\]\n\n\[agents: 1 run \(1 failed/.test(doomed.result ?? "") && /\[failures: 1\]\n- agent "fix:c\.ts" \(#1\) failed: [^\n]*schema validation/.test(doomed.result ?? ""), doomed?.result ?? doomed?.error);
	check("the tokens and cost a schema-exhausted child spent are the run's", doomed?.usage?.cost?.total > 0, JSON.stringify(doomed?.usage));
	const doomedFailure = seat.progress.find((p) => p.type === "agent-failed");
	check("the failure is announced with the validator's last errors", doomedFailure?.reason?.includes("schema validation") === true && doomedFailure.reason.includes("/file"), doomedFailure?.reason);
	check("the three runs deliver as three notifications", seat.customs().length === 3, seat.customs().map((m) => m.content.slice(0, 100)).join(" | "));

	// Ticket 37: every model — Haiku, Sonnet and Fable — sent `result` as a string
	// of JSON when the property had no type, 180 rejections out of 180.
	scriptFor("run the stringy workflow", [[call("Workflow", { script: `${META}return agent('Fix d.ts.', { label: 'fix:d.ts', schema: ${JSON.stringify(schema)} })` })], [text("started")]]);
	scriptFor("Fix d.ts.", [[call("StructuredOutput", { result: '{"file":"d.ts","fixed":true}' })], [text("done")]]);
	await seat.session.prompt("run the stringy workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 4, 8000);
	await quiet(seat);
	const stringy = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[3];
	check("a `result` sent as a string of JSON is parsed and accepted on the first attempt", stringy?.result?.includes('"file": "d.ts"') === true, stringy?.result ?? stringy?.error);
	seat.session.dispose();
}

// J: siblings that share a label get names of their own, even while their worktrees are still being made
{
	console.log("\nWorkflow: one name per child");
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-worktree-repo-"));
	const git = (args, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init -q -b main");
	git("-c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
	const seat = await mainSeat({ cwd: repo });
	// A 1 ms stagger lets the second sibling spawn while the first is still making its worktree.
	const schema = { type: "object", required: ["part"], properties: { part: { type: "number" } } };
	scriptFor("run the twin workflow", [[call("Workflow", { script: `${META}return parallel([1, 2].map((i) => () => agent('Fix twin part ' + i + '.', { label: 'twin', isolation: 'worktree', prefixStaggerMs: 1, schema: ${JSON.stringify(schema)} })))` })], [text("started")]]);
	scriptFor("Fix twin part 1.", [{ delay: 300, content: [call("StructuredOutput", { result: { part: 1 } })] }, [text("done")]]);
	scriptFor("Fix twin part 2.", [{ delay: 50, content: [call("StructuredOutput", { result: { part: 2 } })] }, [text("done")]]);
	await seat.session.prompt("run the twin workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed")), 15000);
	await quiet(seat);
	const twins = seat.events.filter((e) => e.channel === "subagents:created" && e.type !== "workflow").map((e) => e.name);
	const landed = seat.events.find((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed"));
	check("two siblings with one label, spawned at once, get two names", twins.length === 2 && new Set(twins).size === 2, twins.join());
	check("and each agent() returns its own child's value", landed?.result?.startsWith('[\n  {\n    "part": 1\n  },\n  {\n    "part": 2\n  }\n]'), `${landed?.status} · ${landed?.result ?? landed?.error}`);
	seat.session.dispose();
	fs.rmSync(repo, { recursive: true, force: true });
}

// L: a label is a name only once trimmed; an empty one is no label. The contract, the nudge and the engine all use that one name
{
	console.log("\nWorkflow: labels that are blank or padded");
	const seat = await mainSeat();
	const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
	scriptFor("run the label workflow", [[call("Workflow", { script: `${META}return parallel([() => agent('Blank label.', { label: '', schema: ${JSON.stringify(schema)} }), () => agent('Padded label.', { label: ' padded ', schema: ${JSON.stringify(schema)} })])` })], [text("started")]]);
	scriptFor("Blank label.", [[call("StructuredOutput", { result: { ok: true } })], [text("done")]]);
	scriptFor("Padded label.", [[text("no call yet")], [text("still none")]]);
	scriptFor("You ended without calling StructuredOutput", [[call("StructuredOutput", { result: { ok: true } })], [text("done")]]);
	await seat.session.prompt("run the label workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed")), 8000);
	await quiet(seat);
	const names = seat.events.filter((e) => e.channel === "subagents:created" && e.type !== "workflow").map((e) => e.name);
	const landed = seat.events.find((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed"));
	check("a blank label names the child as no label does, and a padded one is trimmed", names.length === 2 && names.includes("count-things:1") && names.includes("padded"), names.join());
	check("both children deliver: StructuredOutput finds its contract, and the nudge its child", landed?.status === "completed" && landed.result?.startsWith('[\n  {\n    "ok": true\n  },\n  {\n    "ok": true\n  }\n]'), `${landed?.status} · ${landed?.result ?? landed?.error}`);
	seat.session.dispose();
}

// M: once a child exists, whatever goes wrong is its death — journalled, reported, the run goes on — never a thrown agent()
{
	console.log("\nWorkflow: a nudge that cannot be sent");
	const { agentRuntimeOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const seat = await mainSeat();
	// The transcript goes the moment the child's first run settles: the nudge's resume has nothing to resume from.
	onLifecycle.at = (event) => {
		if (event.channel !== "subagents:completed" || event.name !== "amnesiac") return;
		const file = agentRuntimeOf(seat.session.sessionId)?.registry.byName("amnesiac")?.sessionFile;
		if (file !== undefined) fs.rmSync(file, { force: true });
	};
	const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
	scriptFor("run the amnesiac workflow", [[call("Workflow", { script: `${META}const lost = await agent('Forget and lose it.', { label: 'amnesiac', schema: ${JSON.stringify(schema)} }); return { lost, after: await agent('Then this.', { label: 'after' }) }` })], [text("started")]]);
	scriptFor("Forget and lose it.", [[text("no call from me")]]);
	scriptFor("Then this.", [[text("went on")]]);
	await seat.session.prompt("run the amnesiac workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed")), 8000);
	await quiet(seat);
	onLifecycle.at = undefined;
	const landed = seat.events.find((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed"));
	check("the child whose nudge failed is null in the value and the run goes on", landed?.status === "completed" && landed.result?.startsWith('{\n  "lost": null,\n  "after": "went on"\n}'), `${landed?.status} · ${landed?.result ?? landed?.error}`);
	check("it is counted and named as a failure, with the engine's reason", landed?.result?.includes("[agents: 2 run (1 failed)]") && /- agent "amnesiac" \(#1\) failed: .*no transcript on disk/.test(landed.result), landed?.result);
	const scriptPath = /Script: (\S+)/.exec(seat.toolResults()[0]?.content[0].text ?? "")?.[1] ?? "";
	const journal = fs.readFileSync(path.join(path.dirname(scriptPath), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("and journalled as failed, so the agent after it is not served on a resume", journal.length === 2 && journal[0].type === "failed" && journal[1].result === "went on" && journal[1].after === 1, JSON.stringify(journal));
	seat.session.dispose();
}

// N: a child's name is the engine's rule applied once, to every source it is made from — the label and the run's own name
{
	console.log("\nWorkflow: a padded workflow name names its children as the engine will");
	const seat = await mainSeat();
	const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
	scriptFor("run the padded workflow", [[call("Workflow", { script: `export const meta = { name: ' padded-wf ', description: 'test' }\nreturn agent('Unlabelled child.', { schema: ${JSON.stringify(schema)} })` })], [text("started")]]);
	scriptFor("Unlabelled child.", [[call("StructuredOutput", { result: { ok: true } })], [text("done")]]);
	await seat.session.prompt("run the padded workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed")), 8000);
	await quiet(seat);
	const created = seat.events.filter((e) => e.channel === "subagents:created").map((e) => e.name);
	const landed = seat.events.find((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed"));
	check("the run and its child are named trimmed, as the engine names any agent", created.join() === "padded-wf,padded-wf:1", created.join());
	check("the child's StructuredOutput finds its contract", landed?.status === "completed" && landed.result?.startsWith('{\n  "ok": true\n}'), `${landed?.status} · ${landed?.result ?? landed?.error}`);
	seat.session.dispose();
}

// O: a child the engine names otherwise than asked could reach neither its contract nor its nudge: it dies at once, saying so
{
	console.log("\nWorkflow: a child named otherwise than asked");
	const { agentRuntimeOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const seat = await mainSeat();
	// An engine whose naming drifted from the spawner's, simulated at the seam.
	const runtime = agentRuntimeOf(seat.session.sessionId);
	const spawn = runtime.spawn.bind(runtime);
	runtime.spawn = (request) => spawn(request.name === "drifter" ? { ...request, name: `${request.name}-drifted` } : request);
	const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
	scriptFor("run the drifted workflow", [[call("Workflow", { script: `${META}const drifted = await agent('Drift away.', { label: 'drifter', schema: ${JSON.stringify(schema)} }); return { drifted, after: await agent('Then that.', { label: 'after' }) }` })], [text("started")]]);
	scriptFor("Drift away.", [[call("StructuredOutput", { result: { ok: true } })], [text("done")]]);
	scriptFor("Then that.", [[text("went on")]]);
	await seat.session.prompt("run the drifted workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed")), 8000);
	await quiet(seat);
	const landed = seat.events.find((e) => e.type === "workflow" && (e.channel === "subagents:completed" || e.channel === "subagents:failed"));
	check("the misnamed child is null in the value and the run goes on", landed?.status === "completed" && landed.result?.startsWith('{\n  "drifted": null,\n  "after": "went on"\n}'), `${landed?.status} · ${landed?.result ?? landed?.error}`);
	check("its death names both names", /- agent "drifter" \(#1\) failed: .*drifter-drifted.*drifter/.test(landed?.result ?? ""), landed?.result);
	check("and it was stopped, not left running", runtime.registry.byName("drifter-drifted")?.status === "stopped", runtime.registry.byName("drifter-drifted")?.status);
	seat.session.dispose();
}

await finish();
