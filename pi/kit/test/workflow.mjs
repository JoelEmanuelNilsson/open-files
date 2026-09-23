/**
 * The `Workflow` tool, offline.
 *
 * Three layers, each pinned at its own seam before the next builds on it:
 *
 *   1. The pure parts — `meta` extraction, the cache key and journal, the
 *      schema check — through their exports.
 *   2. The runtime — `runWorkflow` over a fake spawner that answers at once,
 *      so the scheduler (pipeline without a barrier, parallel as a barrier,
 *      the semaphore), the caps that throw, the banned globals and the
 *      journal replay are held down without a model in the loop.
 *   3. The extension — real pi sessions on the scripted provider of
 *      `agent-engine.mjs`: `Workflow` returns at once, children carry the
 *      workflow tail, `StructuredOutput` validates at the tool boundary and
 *      the model retries, the return value drains into the next turn, resume
 *      prints `N cached`, and `TaskStop` stops a running workflow.
 */

import "./env.mjs";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
// Strictly true: `throwsWith` answers a missed throw with a message, which is truthy.
const check = (name, ok, extra = typeof ok === "string" ? ok : "") => {
	if (ok === true) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const throwsWith = async (fn, fragment) => {
	try { await fn(); return `no throw`; }
	catch (error) { const m = error instanceof Error ? error.message : String(error); return m.includes(fragment) ? true : m; }
};

// ---------------------------------------------------------------------------
// 1. meta: a pure literal, or a loud refusal
// ---------------------------------------------------------------------------
{
	const { extractWorkflowMeta } = await jiti.import(`${ROOT}/lib/workflow-meta.ts`);
	console.log("\nmeta extraction");
	const source = [
		"// leading comment",
		"export const meta = {",
		"  name: 'review-changes',",
		"  description: \"Review changed files across dimensions, verify each finding\",",
		"  whenToUse: `when asked`,",
		"  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'a {brace} in a string', model: 'sonnet' }], // trailing comment",
		"  count: 3, ratio: -1.5, on: true, off: false, none: null,",
		"};",
		"const x = await agent('hi');",
		"return x;",
	].join("\n");
	const out = extractWorkflowMeta(source);
	check("reads name and description", out.meta.name === "review-changes" && out.meta.description === "Review changed files across dimensions, verify each finding");
	check("reads nested phases with detail and model", out.meta.phases.length === 2 && out.meta.phases[1].detail === "a {brace} in a string" && out.meta.phases[1].model === "sonnet", JSON.stringify(out.meta.phases));
	check("reads numbers, booleans, null and a template string without interpolation", out.meta.count === 3 && out.meta.ratio === -1.5 && out.meta.on === true && out.meta.off === false && out.meta.none === null && out.meta.whenToUse === "when asked");
	check("the body is the script minus the meta declaration", out.body.includes("const x = await agent('hi');") && !out.body.includes("export const meta") && out.body.startsWith("// leading comment"), out.body.slice(0, 60));
	check("a semicolon-less declaration works too", extractWorkflowMeta("export const meta = { name: 'a', description: 'b' }\nreturn 1").meta.name === "a");
	check("a variable in meta is refused, naming the rule", await throwsWith(() => extractWorkflowMeta("const n = 'a'\nexport const meta = { name: n, description: 'b' }"), "meta must be a pure literal"));
	check("a call in meta is refused", await throwsWith(() => extractWorkflowMeta("export const meta = { name: 'a'.trim(), description: 'b' }"), "meta must be a pure literal"));
	check("a spread in meta is refused", await throwsWith(() => extractWorkflowMeta("export const meta = { ...base, name: 'a', description: 'b' }"), "meta must be a pure literal"));
	check("template interpolation in meta is refused", await throwsWith(() => extractWorkflowMeta("export const meta = { name: `a${1}`, description: 'b' }"), "meta must be a pure literal"));
	check("a script without meta is refused", await throwsWith(() => extractWorkflowMeta("const meta = { name: 'a' }\nreturn 1"), "script must begin with `export const meta = {...}`"));
	check("meta without a name is refused", await throwsWith(() => extractWorkflowMeta("export const meta = { description: 'b' }"), "meta needs name and description"));
	check("meta without a description is refused", await throwsWith(() => extractWorkflowMeta("export const meta = { name: 'a' }"), "meta needs name and description"));
	check("an unterminated meta is refused", await throwsWith(() => extractWorkflowMeta("export const meta = { name: 'a', description: 'b'"), "meta must be a pure literal"));
	check("a TypeScript annotation is refused as not pure", await throwsWith(() => extractWorkflowMeta("export const meta: Meta = { name: 'a', description: 'b' }"), "script must begin with `export const meta = {...}`"));
}

// ---------------------------------------------------------------------------
// 2. the journal: keyed on content, served only into the world it started in
// ---------------------------------------------------------------------------
{
	const { workflowCacheKey, WorkflowJournal, readWorkflowJournal } = await jiti.import(`${ROOT}/lib/workflow-journal.ts`);
	console.log("\njournal");
	const base = workflowCacheKey("Review src/db.ts", {});
	check("the key is a sha256 hex", /^[0-9a-f]{64}$/.test(base));
	check("label, phase, stallMs and the prefix durations are display-or-behaviour only: excluded from the key", workflowCacheKey("Review src/db.ts", { label: "x", phase: "Review", stallMs: 1000, prefixStaggerMs: 10, prefixWarmMs: 20 }) === base);
	check("prompt, schema, model, thinking, type and isolation all change the key", new Set([base, workflowCacheKey("Review src/db.ts!", {}), workflowCacheKey("Review src/db.ts", { schema: { type: "object" } }), workflowCacheKey("Review src/db.ts", { model: "sonnet" }), workflowCacheKey("Review src/db.ts", { thinking: "high" }), workflowCacheKey("Review src/db.ts", { type: "explore" }), workflowCacheKey("Review src/db.ts", { isolation: "worktree" })]).size === 7);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-journal-"));
	const call = (key) => ({ key, label: undefined, prompt: `prompt of ${key}` });
	const priorPath = path.join(dir, "prior.jsonl");
	const prior = new WorkflowJournal(priorPath);
	prior.append({ key: "k1", result: { n: 1 }, label: "first", prompt: "p1", after: 0 });
	prior.append({ key: "k1", result: { n: 2 }, label: "second", prompt: "p1", after: 0 });
	prior.appendFailed("k2");
	prior.append({ key: "k3", result: 3, label: undefined, prompt: "p3", after: 3 });
	prior.append({ key: "k4", result: 4, label: undefined, prompt: "p4", after: 2 });
	check("the journal counts the lines it has written: a live agent's `after`", prior.written === 5, String(prior.written));
	prior.close();
	const lines = fs.readFileSync(priorPath, "utf8").trim().split("\n");
	check("one JSON line per finished agent, with key, result, label, prompt and after", lines.length === 5 && JSON.parse(lines[0]).key === "k1" && JSON.parse(lines[0]).result.n === 1 && JSON.parse(lines[0]).prompt === "p1" && JSON.parse(lines[3]).after === 3);
	check("a died child writes {type:'failed', key} — no result, never a cached null", JSON.stringify(JSON.parse(lines[2])) === JSON.stringify({ type: "failed", key: "k2" }), lines[2]);
	check("each prior result knows its place in finish order; a failed line holds one too", readWorkflowJournal(priorPath).get("k4")?.[0]?.position === 4 && readWorkflowJournal(priorPath).get("k2") === undefined);

	const replayPath = path.join(dir, "next.jsonl");
	const replay = new WorkflowJournal(replayPath, readWorkflowJournal(priorPath));
	check("take serves the unused results for a key in occurrence order", replay.take(call("k1"))?.result.n === 1 && replay.take(call("k1"))?.result.n === 2);
	check("a third identical call misses", replay.take(call("k1")) === undefined);
	check("an unknown key misses", replay.take(call("nope")) === undefined);
	check("a failed key is a miss, so a resumed run re-runs it", replay.take(call("k2")) === undefined);
	check("an agent that started before a death still hits", replay.take(call("k4"))?.result === 4);
	check("an agent that started after a death misses: it may have seen the dead agent's effects", replay.take(call("k3")) === undefined);
	check("the replay is counted: N cached, with no null count", replay.replaySummary() === "3 cached", replay.replaySummary());
	replay.close();
	const replayed = fs.readFileSync(replayPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("every hit is journalled again with its original `after`, mapped onto the new run's lines", replayed.map((l) => `${l.key}@${l.after}`).join() === "k1@0,k1@0,k4@2", replayed.map((l) => `${l.key}@${l.after}`).join());
	const twinPath = path.join(dir, "twins.jsonl");
	const twins = new WorkflowJournal(twinPath);
	twins.append({ ...call("a"), result: "A", after: 0 });
	twins.append({ ...call("b"), result: "B", after: 0 });
	twins.close();
	const resumedPath = path.join(dir, "twins-resumed.jsonl");
	const resumed = new WorkflowJournal(resumedPath, readWorkflowJournal(twinPath));
	resumed.take(call("a"));
	resumed.take(call("b"));
	resumed.close();
	const again = new WorkflowJournal(path.join(dir, "twins-again.jsonl"), readWorkflowJournal(resumedPath));
	check("so resuming a resumed run serves two independent calls in either order", again.take(call("b"))?.result === "B" && again.take(call("a"))?.result === "A", again.replaySummary());
	again.close();
	const reordered = new WorkflowJournal(path.join(dir, "reordered.jsonl"), readWorkflowJournal(replayPath));
	check("…and still refuses a call before what it really depended on", reordered.take(call("k4")) === undefined && reordered.take(call("k1")) !== undefined && reordered.take(call("k1")) !== undefined && reordered.take(call("k4"))?.result === 4);
	reordered.close();

	const early = new WorkflowJournal(path.join(dir, "early.jsonl"), readWorkflowJournal(priorPath));
	check("a result whose earlier finishes have not been replayed yet misses", early.take(call("k4")) === undefined);
	early.close();

	for (const [how, finish] of [["completes", (j) => j.append({ ...call("live"), result: 1, after: j.written })], ["dies", (j) => j.appendFailed("live")]]) {
		const live = new WorkflowJournal(path.join(dir, `live-${how}.jsonl`), readWorkflowJournal(priorPath));
		const first = live.take(call("k1"));
		finish(live);
		check(`once a live agent ${how}, nothing replays: the run's world has left the prior run's`, first?.result.n === 1 && live.take(call("k1")) === undefined);
		live.close();
	}

	const oldPath = path.join(dir, "old.jsonl");
	fs.writeFileSync(oldPath, ['{"key":"old","result":1,"prompt":"p"}', '{"key":"first","result":0,"prompt":"p","after":0}', '{"key":"behind","result":2,"prompt":"p","after":1}'].join("\n"));
	const old = readWorkflowJournal(oldPath);
	check("a line with no `after` (an older journal) is never served, and still blocks what started after it", !old.has("old") && old.get("behind")?.[0]?.position === 2);
	const oldReplay = new WorkflowJournal(path.join(dir, "old-next.jsonl"), old);
	check("…while what started before it still hits", oldReplay.take(call("first"))?.result === 0 && oldReplay.take(call("behind")) === undefined);
	oldReplay.close();
	check("a missing prior journal reads as empty", readWorkflowJournal(path.join(dir, "missing.jsonl")).size === 0);
	fs.writeFileSync(path.join(dir, "torn.jsonl"), '{"key":"a","result":1,"after":0}\n{"key":"b","res');
	check("a torn last line is skipped, the rest kept", readWorkflowJournal(path.join(dir, "torn.jsonl")).get("a")?.length === 1);
	fs.rmSync(dir, { recursive: true, force: true });
}

// One run in a fresh process: a regression kills that process, never this file, and the JIT starts cold.
const inChild = (body, host = "", flags = []) => {
	const source = `
		import ${JSON.stringify(`${ROOT}/test/env.mjs`)};
		import fs from "node:fs"; import os from "node:os"; import path from "node:path";
		const { createJiti } = await import(${JSON.stringify(`${PI}/node_modules/jiti/lib/jiti.mjs`)});
		const jiti = createJiti(${JSON.stringify(`${ROOT}/test/`)}, { interopDefault: true, moduleCache: false });
		const { runWorkflow } = await jiti.import(${JSON.stringify(`${ROOT}/lib/workflow-runtime.ts`)});
		const { WorkflowJournal } = await jiti.import(${JSON.stringify(`${ROOT}/lib/workflow-journal.ts`)});
		const journal = new WorkflowJournal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-child-")), "j.jsonl"));
		const events = [];
		${host}
		let out, error;
		try {
			out = await runWorkflow({ source: ${JSON.stringify(`export const meta = { name: 'wf', description: 'test' }\n${body}`)}, args: undefined, journal, spawner: { run: async (r) => ({ kind: "completed", value: r.prompt }) }, emit: (e) => events.push(e), signal: new AbortController().signal });
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.name + ": " + thrown.message : "not an Error: " + String(thrown);
		}
		console.log("RESULT " + JSON.stringify({ value: out?.value, error, failures: events.filter((e) => e.type === "rejection-unhandled").map((e) => e.reason), listeners: process.listenerCount("unhandledRejection") }));
	`;
	const child = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", source], { cwd: ROOT, encoding: "utf8", timeout: 20_000 });
	const line = /^RESULT (.*)$/m.exec(child.stdout)?.[1];
	return { status: child.status, stdout: child.stdout, stderr: child.stderr, result: line === undefined ? undefined : JSON.parse(line), shown: `exit ${child.status} · ${child.stdout.trim()} · ${child.stderr.trim().split("\n").slice(0, 4).join(" / ")}` };
};

// ---------------------------------------------------------------------------
// 3. the runtime over a fake spawner: scheduler, caps, failure table, bans, resume
// ---------------------------------------------------------------------------
{
	const { runWorkflow, WORKFLOW_CAPS, WorkflowRunError } = await jiti.import(`${ROOT}/lib/workflow-runtime.ts`);
	const { WorkflowJournal, readWorkflowJournal } = await jiti.import(`${ROOT}/lib/workflow-journal.ts`);
	console.log("\nruntime");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-runtime-"));
	let journalN = 0;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitUntil = async (condition, ms = 2000) => {
		const end = Date.now() + ms;
		while (!condition()) {
			if (Date.now() > end) throw new Error("waitUntil: timed out");
			await sleep(1);
		}
	};
	/** A gated run that never settles fails the check instead of hanging the suite. */
	const within = (promise, ms = 2000) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`no settle within ${ms} ms`); })]);

	/**
	 * A spawner whose children finish when the test says so, in the order it
	 * says: `finish(prompt, value?)` waits for that child to start, settles it
	 * and yields until the runtime has journalled it. A child starts as it is
	 * handed over, unless `callsStarted` is false and it never says so.
	 */
	function gatedSpawner({ callsStarted = true } = {}) {
		const calls = [];
		const pending = new Map();
		return {
			calls,
			run(request, signal) {
				calls.push(request.prompt);
				if (callsStarted) request.started();
				return new Promise((resolve) => {
					pending.set(request.prompt, resolve);
					signal.addEventListener("abort", () => resolve({ kind: "died", reason: "aborted" }), { once: true });
				});
			},
			started: (prompt) => pending.has(prompt),
			async finish(prompt, value = `r:${prompt}`) {
				await waitUntil(() => pending.has(prompt));
				const resolve = pending.get(prompt);
				pending.delete(prompt);
				resolve(value !== null && typeof value === "object" && "kind" in value ? value : { kind: "completed", value });
				await sleep(5);
			},
		};
	}

	/**
	 * A spawner that answers from a function of the prompt. `answer` may return
	 * a report or a plain value (→ completed) or throw; `delay` in ms per call.
	 */
	function fakeSpawner(answer, { delay = 0 } = {}) {
		const calls = [];
		let inFlight = 0;
		let maxInFlight = 0;
		return {
			calls,
			get maxInFlight() { return maxInFlight; },
			async run(request, signal) {
				calls.push(request);
				request.started();
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				try {
					const wait = typeof delay === "function" ? delay(request) : delay;
					if (wait > 0) await new Promise((resolve, reject) => { const t = setTimeout(resolve, wait); signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true }); });
					const out = await answer(request);
					return out !== null && typeof out === "object" && "kind" in out ? out : { kind: "completed", value: out };
				} finally {
					inFlight--;
				}
			},
		};
	}
	/** The prompts a spawner was asked to run, sorted: which calls ran live. */
	const prompts = (spawner) => spawner.calls.map((c) => (typeof c === "string" ? c : c.prompt)).sort().join();
	const events = [];
	const run = (source, { args, spawner = fakeSpawner((r) => `answer to ${r.prompt}`), prior, caps, signal, scriptTimeoutMs } = {}) =>
		runWorkflow({ source, args, spawner, journal: new WorkflowJournal(path.join(dir, `j${journalN++}.jsonl`), prior), emit: (e) => events.push(e), signal: signal ?? new AbortController().signal, caps, scriptTimeoutMs });
	const META = "export const meta = { name: 'wf', description: 'test' }\n";

	check("the caps are the ruled numbers", WORKFLOW_CAPS.itemsPerCall === 4096 && WORKFLOW_CAPS.lifetimeAgents === 1000 && WORKFLOW_CAPS.concurrency === Math.min(16, Math.max(1, os.cpus().length - 2)), JSON.stringify(WORKFLOW_CAPS));

	{
		const out = await run(`${META}const a = await agent('one'); return { a, args, doubled: args.map((x) => x * 2), meta: typeof meta }`, { args: [1, 2] });
		check("returns the script's return value; agent() returns the child's text", out.value.a === "answer to one", JSON.stringify(out.value));
		check("args arrive verbatim as JSON (a real array: args.map works)", out.value.doubled.join() === "2,4");
		check("meta is read and returned; it is not a global in the body", out.meta.name === "wf" && out.value.meta === "undefined");
		check("the run counts its agents", out.agentsRun === 1);
	}

	// pipeline: no barrier, (prev, original, index), a throwing stage drops the item
	{
		const order = [];
		const spawner = fakeSpawner((r) => { order.push(r.prompt); return r.prompt.toUpperCase(); }, { delay: (r) => (r.prompt === "s1:b" ? 60 : 1) });
		const out = await run(`${META}return pipeline(['a', 'b'], (item, orig, i) => agent('s1:' + item), (prev, orig, i) => agent('s2:' + prev + ':' + orig + ':' + i))`, { spawner });
		check("pipeline runs every item through every stage", out.value.join() === "S2:S1:A:A:0,S2:S1:B:B:1", out.value.join());
		check("pipeline has no barrier: a's stage 2 starts before b's stage 1 ends", order.indexOf("s2:S1:A:a:0") < order.indexOf("s1:b"), order.join(" "));
		check("stage callbacks get (prevResult, originalItem, index)", out.value[1] === "S2:S1:B:B:1");
		const dropped = await run(`${META}return pipeline([1, 2, 3], (n) => { if (n === 2) throw new Error('bad item'); return agent('x' + n) }, (prev) => agent('y' + prev))`);
		check("a stage that throws drops that item to null and skips its remaining stages", dropped.value[0] === "answer to yanswer to x1" && dropped.value[1] === null && dropped.value[2] === "answer to yanswer to x3" && dropped.agentsRun === 4, JSON.stringify(dropped.value));
		const dead = fakeSpawner((r) => (r.prompt === "find" ? { kind: "died", reason: "crashed" } : `did: ${r.prompt}`));
		const deadOut = await run(`${META}return pipeline(['x'], () => agent('find'), (prev) => agent('verify ' + JSON.stringify(prev)))`, { spawner: dead });
		check("a dead child's null ends its item: the next stage never runs on it", deadOut.value[0] === null && dead.calls.map((c) => c.prompt).join() === "find", `${JSON.stringify(deadOut.value)} · ${dead.calls.map((c) => c.prompt).join()}`);
		const filtered = fakeSpawner((r) => r.prompt);
		const filteredMark = events.length;
		const filteredOut = await run(`${META}return pipeline([null, 'keep', 'drop'], (item) => (item === 'drop' ? null : agent('a:' + item)), (prev) => agent('b:' + prev), () => 'reached')`, { spawner: filtered });
		check("a null item or a stage that returns null ends that item; the others go on", JSON.stringify(filteredOut.value) === JSON.stringify([null, "reached", null]) && filtered.calls.map((c) => c.prompt).join() === "a:keep,b:a:keep", `${JSON.stringify(filteredOut.value)} · ${filtered.calls.map((c) => c.prompt).join()}`);
		check("and neither is reported as a failure: the null is the script's own choice", !events.slice(filteredMark).some((e) => e.type.endsWith("-failed")), JSON.stringify(events.slice(filteredMark)));
		const undef = await run(`${META}return pipeline([1], () => undefined, (prev) => prev === undefined ? 'undefined flows on' : 'lost')`);
		check("undefined is not null: a stage that returns nothing still feeds the next", undef.value[0] === "undefined flows on", JSON.stringify(undef.value));
	}

	// parallel: a barrier that never rejects
	{
		const out = await run(`${META}const r = await parallel([() => agent('p1'), () => { throw new Error('boom') }, async () => { await agent('p3'); throw new Error('later') }]); return r`);
		check("parallel returns every slot; a throwing thunk is null, the call never rejects", out.value[0] === "answer to p1" && out.value[1] === null && out.value[2] === null, JSON.stringify(out.value));
		check("parallel awaits all thunks before returning (barrier)", out.agentsRun === 2);
		check("a rejected parallel would have thrown; it did not", Array.isArray(out.value));
		const mark = events.length;
		await run(`${META}return parallel([() => agent('p1'), () => { throw new Error('boom') }, () => agent('p3')])`);
		const failed = events.slice(mark).filter((e) => e.type === "task-failed");
		check("a failed thunk's event names its index, so the result can say which task dropped", failed.length === 1 && failed[0].index === 1 && failed[0].reason.includes("boom"), JSON.stringify(failed));
	}

	// the caps throw — explicit error, never silent truncation
	{
		check("> 4096 items in one parallel() call throws", await throwsWith(() => run(`${META}return parallel(Array.from({length: 4097}, () => () => agent('x')))`), "too many items (4097); cap is 4096"));
		check("> 4096 items in one pipeline() call throws", await throwsWith(() => run(`${META}return pipeline(Array.from({length: 4097}, (_, i) => i), (n) => agent('x' + n))`), "too many items (4097); cap is 4096"));
		check("exactly 4096 items is allowed", (await run(`${META}return (await parallel(Array.from({length: 4096}, (_, i) => () => agent('x' + i)))).length`, { caps: { lifetimeAgents: 5000 } })).value === 4096);
		check("the lifetime agent cap throws, even inside a pipeline stage", await throwsWith(() => run(`${META}return pipeline([1,2,3,4,5,6], (n) => agent('a' + n))`, { caps: { lifetimeAgents: 5 } }), "workflow exceeded 5 total agents"));
		check("the real lifetime cap is 1000: the 1001st agent() throws", await throwsWith(() => run(`${META}for (let i = 0; i < 1001; i++) await agent('n' + i); return 'done'`), "workflow exceeded 1000 total agents"));
		const spawner = fakeSpawner(() => "ok", { delay: 5 });
		await run(`${META}return parallel(Array.from({length: 10}, (_, i) => () => agent('c' + i)))`, { spawner, caps: { concurrency: 3 } });
		check("concurrent agent() calls are capped: excess queue", spawner.maxInFlight === 3 && spawner.calls.length === 10, String(spawner.maxInFlight));
		// A caller arriving between a release and the woken waiter's turn must not take the slot:
		// sweep the arrival across every microtask hop of that window.
		const overs = [];
		for (let hops = 0; hops <= 60; hops++) {
			const swept = fakeSpawner((r) => r.prompt);
			await run(`${META}const a = agent('A'); const w = agent('W'); let p = Promise.resolve(); for (let i = 0; i < ${hops}; i++) p = p.then(() => {}); const late = p.then(() => agent('late')); return await Promise.all([a, w, late])`, { spawner: swept, caps: { concurrency: 1 } });
			if (swept.maxInFlight !== 1) overs.push(`${hops} hops: ${swept.maxInFlight} in flight`);
		}
		check("the cap holds at every arrival time: a released slot goes straight to the next waiter", overs.length === 0, overs.join(", "));
	}

	// Ticket 37: a child's result is an object or the contract cannot exist, so a
	// script asking for anything else stops the run before a child is spawned.
	{
		const refusals = [
			["{ type: 'array', items: { type: 'string' } }", 'agent() option schema must be a JSON Schema with type "object", got "array"'],
			["{ properties: {} }", 'agent() option schema must be a JSON Schema with type "object", got no type'],
			["'a string'", "agent() option schema must be a JSON Schema object, got string"],
		];
		for (const [schema, message] of refusals) {
			const spawner = fakeSpawner(() => "ok");
			check(`agent({schema: ${schema}}) stops the run, naming the rule, before any child`, (await throwsWith(() => run(`${META}return pipeline([1], () => agent('x', { schema: ${schema} }))`, { spawner }), message)) === true && spawner.calls.length === 0);
		}
	}

	// Low to max exist. Anything else is refused where the option is parsed, not
	// clamped somewhere downstream.
	{
		for (const level of ["off", "minimal", "enormous"]) {
			check(`agent({thinking: '${level}'}) throws, naming the legal values`, await throwsWith(() => run(`${META}return agent('x', { thinking: '${level}' })`), `agent() option thinking must be one of "low", "medium", "high", "xhigh", "max", got '${level}'`));
		}
		for (const level of ["low", "medium", "high", "xhigh", "max"]) {
			const spawner = fakeSpawner(() => "ok");
			await run(`${META}return agent('x', { thinking: '${level}' })`, { spawner });
			check(`agent({thinking: '${level}'}) reaches the spawner`, spawner.calls[0]?.options.thinking === level, JSON.stringify(spawner.calls[0]?.options));
		}
	}

	// Ticket 54 §1: judgement has two homes, Joel and the script. A child gets one
	// item and does it; an item that needs a lead was cut too big.
	{
		const spawner = fakeSpawner(() => "ok");
		let thrown;
		try { await run(`${META}return agent('x', { type: 'lead' })`, { spawner }); } catch (error) { thrown = error; }
		check("agent({type: 'lead'}) throws a TypeError before any spawn, naming the script as the judge", thrown instanceof TypeError && thrown.message.includes("a workflow child cannot be a lead \u2014 the script is the judge; split the item in the script instead") && spawner.calls.length === 0, `${thrown?.constructor?.name}: ${thrown?.message} \u00b7 ${spawner.calls.length} spawns`);
		// A getter answers each read afresh: a value checked on one read and used from another is not the value checked.
		const shifty = fakeSpawner(() => "ok");
		const shifted = await run(`${META}let n = 0; try { return await agent('x', { get type() { return ++n >= 2 ? 'lead' : 'general-purpose' } }) } catch (e) { return e.message }`, { spawner: shifty });
		check("a type getter that turns to 'lead' after the check never reaches the spawner", shifty.calls.every((c) => c.options.type !== "lead"), `${JSON.stringify(shifted.value)} \u00b7 ${shifty.calls.map((c) => c.options.type).join()}`);
		const counted = await run(`${META}const reads = {}; const options = new Proxy({ schema: { type: 'object' }, model: 'm', thinking: 'high', type: 'worker', isolation: 'worktree', label: 'l', phase: 'p', stallMs: 1, prefixStaggerMs: 1, prefixWarmMs: 1 }, { get(target, key) { reads[key] = (reads[key] ?? 0) + 1; return target[key] } }); await agent('x', options); return reads`, { spawner: fakeSpawner(() => ({})) });
		const readTwice = Object.entries(counted.value).filter(([, n]) => n > 1).map(([key]) => key);
		check("every option is read exactly once", Object.keys(counted.value).length === 10 && readTwice.length === 0, JSON.stringify(counted.value));
		const stalling = fakeSpawner(() => "ok");
		await run(`${META}return agent('x', { stallMs: 1000 })`, { spawner: stalling });
		check("agent({stallMs}) reaches the spawner; a non-positive one is an author error", stalling.calls[0]?.options.stallMs === 1000 && (await throwsWith(() => run(`${META}return agent('x', { stallMs: 0 })`, { spawner: stalling }), "stallMs must be a positive number of milliseconds")) === true, JSON.stringify(stalling.calls[0]?.options));
		const staggered = fakeSpawner(() => "ok");
		await run(`${META}return agent('x', { prefixStaggerMs: 10, prefixWarmMs: 20 })`, { spawner: staggered, caps: { concurrency: 4 } });
		check("the prefix durations reach the spawner, with the run's concurrency for it to skip on", staggered.calls[0]?.options.prefixStaggerMs === 10 && staggered.calls[0]?.options.prefixWarmMs === 20 && staggered.calls[0]?.concurrency === 4, `${JSON.stringify(staggered.calls[0]?.options)} \u00b7 ${staggered.calls[0]?.concurrency}`);
		check("a non-positive prefix duration is an author error", await throwsWith(() => run(`${META}return agent('x', { prefixWarmMs: -1 })`, { spawner: staggered }), "prefixWarmMs must be a positive number of milliseconds"));

		for (const type of ["explore", "worker"]) {
			const allowed = fakeSpawner(() => "ok");
			await run(`${META}return agent('x', { type: '${type}' })`, { spawner: allowed });
			check(`agent({type: '${type}'}) reaches the spawner`, allowed.calls[0]?.options.type === type, JSON.stringify(allowed.calls[0]?.options));
		}
	}

	// the failure table
	{
		const died = fakeSpawner((r) => (r.prompt === "dies" ? { kind: "died", reason: "terminal API error" } : "fine"));
		const out = await run(`${META}return [await agent('dies'), await agent('lives')]`, { spawner: died });
		check("a child that dies on a terminal error is null; the run is still valid", out.value[0] === null && out.value[1] === "fine");
		const diedFile = path.join(dir, `j${journalN - 1}.jsonl`);
		const diedLines = fs.readFileSync(diedFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("the death is journalled as a failed line, with no result line for it", diedLines.length === 2 && diedLines.some((l) => l.type === "failed") && !diedLines.some((l) => "result" in l && l.result === null), JSON.stringify(diedLines));
		check("a failed line never loads as a prior result", [...readWorkflowJournal(diedFile).values()].flat().length === 1);
		const skipMark = events.length;
		const skipped = fakeSpawner(() => ({ kind: "died", reason: "dozer skipped by hand", skipped: true }));
		const skippedOut = await run(`${META}return agent('skip me')`, { spawner: skipped });
		const skipEvents = events.slice(skipMark);
		check("a child a user skipped is null like any other death", skippedOut.value === null);
		check("but it is announced as a skip, not a failure", skipEvents.some((e) => e.type === "agent-skipped" && e.reason === "dozer skipped by hand") && !skipEvents.some((e) => e.type === "agent-failed"), JSON.stringify(skipEvents));
		const skipFile = path.join(dir, `j${journalN - 1}.jsonl`);
		check("and journalled as failed, so a resume runs it again", [...readWorkflowJournal(skipFile).values()].flat().length === 0);
		const exhausted = fakeSpawner((r) => (r.prompt === "item 2" ? { kind: "schema-exhausted", reason: "/ must have required property 'ok'" } : { ok: true }));
		const exhaustMark = events.length;
		const fanned = await run(`${META}const S = { type: 'object' }; return await parallel([1, 2, 3, 4].map((i) => () => agent('item ' + i, { schema: S })))`, { spawner: exhausted });
		check("one child that never fits its schema is null in its slot; its siblings keep their results", JSON.stringify(fanned.value) === JSON.stringify([{ ok: true }, null, { ok: true }, { ok: true }]), JSON.stringify(fanned.value));
		const exhaustedEvents = events.slice(exhaustMark).filter((e) => e.type === "agent-failed");
		check("it is announced as a failure carrying the validator's last errors", exhaustedEvents.length === 1 && exhaustedEvents[0].reason === "/ must have required property 'ok'", JSON.stringify(exhaustedEvents));
		const exhaustedFile = path.join(dir, `j${journalN - 1}.jsonl`);
		const exhaustedLines = fs.readFileSync(exhaustedFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("and journalled as failed, so a resume re-runs it", exhaustedLines.filter((l) => l.type === "failed").length === 1 && [...readWorkflowJournal(exhaustedFile).values()].flat().length === 3, JSON.stringify(exhaustedLines));
		const refusing = fakeSpawner(() => { throw new Error('Unknown subagent_type "nope"'); });
		check("an unknown agent type is an author error: it throws", await throwsWith(() => run(`${META}return agent('x', { type: 'nope' })`, { spawner: refusing }), 'Unknown subagent_type "nope"'));
		const refusalMark = events.length;
		const refusedJournal = path.join(dir, `j${journalN}.jsonl`);
		const typo = fakeSpawner((r) => { if (r.options.type === "nope") throw new Error('Unknown subagent_type "nope"'); return "fine"; });
		const refusedOut = await run(`${META}let caught; try { await agent('typo', { type: 'nope' }) } catch (e) { caught = e.message } return { caught, after: await agent('next') }`, { spawner: typo });
		const refusedEvents = events.slice(refusalMark).filter((e) => e.ordinal === 1).map((e) => `${e.type}:${e.reason ?? ""}`);
		check("a refused spawn settles its agent as failed with the engine's words, so no row stays running", refusedOut.value.caught === 'Unknown subagent_type "nope"' && refusedEvents.join() === 'agent-start:,agent-failed:Unknown subagent_type "nope"', `${JSON.stringify(refusedOut.value)} · ${refusedEvents.join()}`);
		const refusedLines = fs.readFileSync(refusedJournal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("and journals nothing: no child ran, so a resume holds nothing back on its account", refusedLines.length === 1 && refusedLines[0].result === "fine" && refusedLines[0].after === 0, JSON.stringify(refusedLines));
		check("a script that throws rejects with its message", await throwsWith(() => run(`${META}throw new Error('author bug')`), "author bug"));
		let typed;
		try { await run(`${META}const x: string = 'a'; return x`); } catch (error) { typed = error; }
		check("TypeScript in the body is a syntax error, reported", typed?.name === "SyntaxError", `${typed?.constructor?.name}: ${typed?.message}`);
	}

	// the clock and the RNG are banned, on every path to them; a date from explicit arguments is not
	{
		const banned = async (expression, fragment) => {
			const out = await run(`${META}try { return { value: String(${expression}) } } catch (e) { return { threw: e.message } }`);
			return out.value.threw?.includes(fragment) ? true : JSON.stringify(out.value);
		};
		const cases = [
			["Date.now()", "Date.now() is unavailable in workflow scripts (it would break resume)"],
			["Math.random()", "Math.random() is unavailable in workflow scripts (it would break resume)"],
			["new Date()", "Date() and new Date() with no arguments are unavailable in workflow scripts (it would break resume)"],
			["Date()", "Date() and new Date() with no arguments are unavailable"],
			["Date(0)", "Date() and new Date() with no arguments are unavailable"],
			["new (new Date(0).constructor)()", "Date() and new Date() with no arguments are unavailable"],
			["new (Object.getPrototypeOf(new Date(0)).constructor)()", "Date() and new Date() with no arguments are unavailable"],
			["new Date(0).constructor.now()", "Date.now() is unavailable"],
			["Reflect.construct(Date, [])", "Date() and new Date() with no arguments are unavailable"],
			["new (class extends Date {})()", "Date() and new Date() with no arguments are unavailable"],
			["Temporal.Now.instant()", "Temporal.Now is unavailable in workflow scripts (it would break resume)"],
			["Temporal.Now.plainDateTimeISO()", "Temporal.Now is unavailable"],
			["Temporal.Now.zonedDateTimeISO()", "Temporal.Now is unavailable"],
			["new Intl.DateTimeFormat('en', { timeStyle: 'long' }).format()", "Intl.DateTimeFormat format() with no date is unavailable in workflow scripts (it would break resume)"],
			["new Intl.DateTimeFormat('en').formatToParts()", "Intl.DateTimeFormat format() with no date is unavailable"],
		];
		for (const [expression, fragment] of cases) check(`${expression} throws`, await banned(expression, fragment));
		const trapped = await run(`${META}let real; Object.prototype.get = (target) => (real = target); Date.x; delete Object.prototype.get; return typeof real`);
		check("a proxy trap the Date shim lacks is not looked up on Object.prototype, where the script would get the real Date", trapped.value === "undefined", String(trapped.value));
		const dated = await run(`${META}const utc = new Intl.DateTimeFormat('en', { timeZone: 'UTC' }); return [new Date(0).toISOString(), Date.UTC(2020, 0), new (class extends Date {})(0).getTime(), utc.format(new Date(0)), utc.formatToParts(0)[0].value, String(Temporal.Instant.fromEpochMilliseconds(0)), typeof process, typeof require, typeof fetch]`);
		check("a date from explicit arguments still works: Date, Date.UTC, a subclass, Intl and Temporal", JSON.stringify(dated.value.slice(0, 6)) === JSON.stringify(["1970-01-01T00:00:00.000Z", 1577836800000, 0, "1/1/1970", "1", "1970-01-01T00:00:00Z"]), JSON.stringify(dated.value));
		check("no process, require or fetch in the sandbox", dated.value.slice(6).every((t) => t === "undefined"), JSON.stringify(dated.value));
		const zone = (await run(`${META}try { return Temporal.Now.timeZoneId() } catch (e) { return e.message }`)).value;
		check("the host's time zone stays readable through Temporal as through Intl", zone === Intl.DateTimeFormat().resolvedOptions().timeZone, String(zone));
		const hostTimed = (await run(`${META}return [typeof Atomics, typeof FinalizationRegistry, typeof SharedArrayBuffer, typeof WeakRef, typeof WebAssembly]`)).value;
		check("the built-ins that run on the host's or the GC's schedule are gone: Atomics, FinalizationRegistry, SharedArrayBuffer, WeakRef, WebAssembly", hostTimed.every((t) => t === "undefined"), JSON.stringify(hostTimed));
		// Every global a script sees was reviewed for a clock, an entropy source or a host-timed callback; a new one fails here until it is.
		const reviewed = ["AggregateError", "Array", "ArrayBuffer", "AsyncDisposableStack", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date", "DisposableStack", "Error", "EvalError", "Float16Array", "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array", "Intl", "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "SuppressedError", "Symbol", "SyntaxError", "Temporal", "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakSet", "agent", "args", "clearTimeout", "console", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis", "isFinite", "isNaN", "log", "parallel", "parseFloat", "parseInt", "phase", "pipeline", "setTimeout", "undefined", "unescape"];
		const globals = (await run(`${META}return Object.getOwnPropertyNames(globalThis).sort()`)).value;
		const unreviewed = globals.filter((name) => !reviewed.includes(name));
		check("every global the script sees is on the reviewed list", unreviewed.length === 0 && globals.length === reviewed.length, `new: ${unreviewed.join()} · gone: ${reviewed.filter((name) => !globals.includes(name)).join()}`);
	}

	// no host object ever reaches the script: every path a probe found, and the ones like it
	{
		const { WORKFLOW_SCRIPT_TIMEOUT_MS, IMPORT_REFUSED } = await jiti.import(`${ROOT}/lib/workflow-sandbox.ts`);
		check("the production cap on the synchronous start is 30 s", WORKFLOW_SCRIPT_TIMEOUT_MS === 30_000, String(WORKFLOW_SCRIPT_TIMEOUT_MS));
		check("an endless loop in the synchronous start ends the run with the vm's own timeout message", await throwsWith(() => run(`${META}while (true) {}`, { scriptTimeoutMs: 200 }), "timed out"));

		// `foreign` is true for a value whose constructor's constructor is not the context's own Function.
		const FOREIGN = "const foreign = (v) => { try { return v.constructor.constructor !== Function } catch { return false } };\n";
		const paths = await run(`${META}${FOREIGN}const pending = agent('x'); let caught; try { await agent(5) } catch (e) { caught = e }
			const t = setTimeout(() => {}, 1); clearTimeout(t);
			return {
				'log.constructor': foreign(log), 'agent.constructor': foreign(agent), 'console.log.constructor': foreign(console.log),
				'the array parallel returns': foreign(await parallel([])), 'the array pipeline returns': foreign(await pipeline([1], (x) => x)),
				'the promise agent returns': foreign(pending), 'the object agent resolves': foreign(await pending),
				'a caught hook error': foreign(caught), 'a timer id': foreign(t), 'setTimeout': foreign(setTimeout),
				'globalThis': foreign(globalThis), 'args': foreign(args),
			}`, { args: { a: 1 }, spawner: fakeSpawner(() => ({ n: 1 })) });
		const leaked = Object.entries(paths.value).filter(([, isForeign]) => isForeign !== false).map(([name]) => name);
		check("no hook, hook result, hook promise, caught hook error, timer id or global is a host object", leaked.length === 0 && Object.keys(paths.value).length === 12, leaked.join(", ") || JSON.stringify(paths.value));

		// A host promise resolved with a script value reads its `then`, and calls it if it is a function. The context's own
		// adoption reads a thunk's or a stage's result once, as it returns; any read beyond that is the host's.
		const thenables = await run(`${META}const counted = () => { const o = { reads: 0 }; Object.defineProperty(o, 'then', { get() { o.reads++; return undefined } }); return o };
			const item = counted(); const [same] = await pipeline([item]);
			const thunked = counted(); await parallel([() => thunked]);
			const staged = counted(); await pipeline([1], () => staged);
			return { item: item.reads, same: same === item, thunked: thunked.reads, staged: staged.reads }`);
		check("the host never reads a script value's then: not an item with no stages, not what a thunk or a stage returns", JSON.stringify(thenables.value) === JSON.stringify({ item: 0, same: true, thunked: 1, staged: 1 }), JSON.stringify(thenables.value));

		const probe3 = await run(`${META}const r = {}; try { r.viaLog = log.constructor('return typeof process')() } catch (e) { r.viaLog = e.constructor === EvalError } try { r.viaArray = (await parallel([])).constructor.constructor('return typeof process')() } catch (e) { r.viaArray = e.constructor === EvalError } return r`);
		check("probe 3: log.constructor and parallel's array reach only the context's Function, which cannot compile", probe3.value.viaLog === true && probe3.value.viaArray === true, JSON.stringify(probe3.value));
		check("eval and new Function throw EvalError: the context compiles no string", JSON.stringify((await run(`${META}const r = []; for (const f of [() => eval('1'), () => new Function('return 1'), () => (async () => {}).constructor('return 1')]) { try { f(); r.push('ran') } catch (e) { r.push(e.constructor === EvalError) } } return r`)).value) === "[true,true,true]");

		const frames = await run(`${META}${FOREIGN}Error.prepareStackTrace = (e, sites) => sites;
			const leaks = []; const scan = (where) => { for (const site of new Error().stack) for (const v of [site.getFunction(), site.getThis()]) if (v != null && foreign(v)) leaks.push(where) };
			scan('start');
			await agent('x', { get label() { scan('an options getter the host reads'); return 'l' } });
			await pipeline([1], (x) => { scan('a stage'); return x });
			await parallel([() => scan('a thunk')]);
			await new Promise((resolve) => setTimeout(() => { scan('a timer'); resolve() }, 1));
			return leaks`);
		check("no stack frame hands the script a host function or receiver: at start, in a getter the host reads, a stage, a thunk, a timer", Array.isArray(frames.value) && frames.value.length === 0, JSON.stringify(frames.value));

		// Near the stack limit the call into the host overflows, and V8 raises that RangeError in the host's realm.
		// Each hook is called at every depth on the way back up, from the deepest, until 20 calls in a row have not
		// thrown, from eight starting depths; a warm JIT narrows the window to nothing, so the run gets a cold process.
		const deep = inChild(`${FOREIGN}const ids = []; for (let i = 0; i < 4000; i++) ids.push(setTimeout(() => {}, 1000));
			const hooks = { log: () => log('x'), phase: () => phase('p'), console: () => console.log('x'), setTimeout: () => setTimeout(() => {}, 1), clearTimeout: () => clearTimeout(ids.pop()), agent: () => agent('x'), parallel: () => parallel([]), pipeline: () => pipeline([], (x) => x) };
			const leaks = []; let thrown = 0;
			for (const [name, call] of Object.entries(hooks)) {
				const caught = [];
				for (let pad = 0; pad < 8; pad++) {
					let calm = 0;
					const dive = () => { try { dive() } catch {} if (calm < 20) { try { const r = call(); calm++; if (r instanceof Promise) r.then(undefined, (e) => caught.push(e)) } catch (e) { calm = 0; caught.push(e) } } };
					const padded = (k) => (k > 0 ? padded(k - 1) : dive());
					padded(pad);
				}
				for (let i = 0; i < 5; i++) await null;
				thrown += caught.length;
				if (caught.some((e) => foreign(e))) leaks.push(name);
			}
			const everywhere = () => { try { everywhere() } catch {} try { log('deep') } catch {} };
			everywhere();
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { leaks, thrown, after: await agent('after') }`);
		check("a hook called at the stack limit throws only the context's errors: log, phase, console, setTimeout, clearTimeout, agent, parallel, pipeline", deep.result?.value.leaks.length === 0 && deep.result.value.thrown > 0, deep.result === undefined ? deep.shown : JSON.stringify(deep.result.value));
		check("and leaves the run whole: a timer still fires and a hook still answers", deep.result?.value.after === "after", deep.result === undefined ? deep.shown : JSON.stringify(deep.result.value));

		check("import() is refused before the script runs: it would reject with a host error", await throwsWith(() => run(`${META}return import('node:fs')`), IMPORT_REFUSED));
		check("import() is refused however it is spaced", await throwsWith(() => run(`${META}return import /* c */ ('node:fs')`), IMPORT_REFUSED));
		const words = await run(`${META}// import('node:fs') in a comment\nreturn ['import("x")', \`import \${'y'}\`, /import\\(/.source, { imports: 1, important: 2 }.important]`);
		check("the word import in a string, template, comment, regex or a longer identifier runs", JSON.stringify(words.value) === JSON.stringify(['import("x")', "import y", "import\\(", 2]), JSON.stringify(words.value));
		check("a property named import is refused too: the declared false positive", await throwsWith(() => run(`${META}return ({ import: 1 }).import`), IMPORT_REFUSED));

		const objects = fakeSpawner(() => ({ n: 1, list: [1, 2] }));
		const cloned = await run(`${META}const a = await agent('x'); return { owned: a.constructor.constructor === Function, listOwned: Array.isArray(a.list), n: a.n }`, { spawner: objects });
		check("an agent() object result is the context's own object, never the host's", cloned.value.owned === true && cloned.value.listOwned === true && cloned.value.n === 1, JSON.stringify(cloned.value));

		const mixed = fakeSpawner((r) => (r.prompt === "dies" ? { kind: "died", reason: "x" } : "plain"));
		const kept = await run(`${META}return [typeof (await agent('s')), await agent('s'), await agent('dies')]`, { spawner: mixed });
		check("a string result stays a string and a dead child stays null", kept.value[0] === "string" && kept.value[1] === "plain" && kept.value[2] === null, JSON.stringify(kept.value));

		let thrown;
		try { await run(`${META}throw new RangeError('boom')`); } catch (error) { thrown = error; }
		check("the script's own error comes back as a host error with its name and message", thrown instanceof RangeError && thrown.message === "boom", `${thrown?.constructor?.name}: ${thrown?.message}`);
		const failedMark = events.length;
		await run(`${META}return parallel([() => { throw new Error('boom') }])`);
		check("a thunk's error is reported by its message, not its toString", events.slice(failedMark).find((e) => e.type === "task-failed")?.reason === "boom", JSON.stringify(events.slice(failedMark)));
		const shaped = await run(`${META}return { when: new Date(0), list: [1] }`);
		check("the return value arrives as host data: JSON", Object.getPrototypeOf(shaped.value) === Object.prototype && shaped.value.when === "1970-01-01T00:00:00.000Z" && Array.isArray(shaped.value.list), JSON.stringify(shaped.value));
		const unwritable = await Promise.all([
			["const c = {}; c.self = c; return c", "TypeError", "circular"],
			["return { get x() { throw new RangeError('boom') } }", "RangeError", "boom"],
			["return { n: 10n }", "TypeError", "BigInt"],
			["const c = Object.create(null); c.self = c; return c", "TypeError", "circular"],
			["return () => 1", "TypeError", "a function"],
			["return pipeline", "TypeError", "a function"],
			["return class {}", "TypeError", "a function"],
		].map(([body, name, fragment]) => run(`${META}${body}`).then((out) => `returned ${JSON.stringify(out.value)}`, (error) => (error.name === name && error.message.startsWith("the return value is not JSON: ") && error.message.includes(fragment) ? true : `${error.name}: ${error.message}`))));
		check("a return value JSON cannot write (a cycle, a throwing getter, a bigint inside, a function) ends the run with the reason; it never comes back as its String()", unwritable.every((r) => r === true), unwritable.join(" · "));
		const unheld = await Promise.all(["10n", "Symbol('s')", "undefined", "NaN"].map((expression) => run(`${META}return ${expression}`).then((out) => out.value, (error) => `threw ${error.message}`)));
		check("a bigint, a symbol or undefined comes back as its String(), so the host always gets JSON", ["10", "Symbol(s)", "undefined", null].every((expected, i) => unheld[i] === expected), unheld.map(String).join(" · "));
	}

	// a run-level stop ends the run however the script handles it, and a script past its end parks
	{
		const probes = fakeSpawner((r) => r.prompt);
		const verdict = await throwsWith(() => run(`${META}try { await agent('x', { schema: 5 }) } catch (e) {} return 'kept going'`, { spawner: probes }), "agent() option schema must be a JSON Schema object, got number");
		check("a run-level error the script catches still ends the run", verdict === true, String(verdict));
		const rethrown = await throwsWith(() => run(`${META}const r = await parallel([async () => { try { await agent('x', { schema: 5 }) } catch (e) { throw new Error('laundered') } }]); return r`), "agent() option schema must be a JSON Schema object");
		check("so does one a thunk catches and replaces with its own error: parallel never sees it", rethrown === true, String(rethrown));
		const looping = fakeSpawner((r) => r.prompt);
		const looped = await throwsWith(() => run(`${META}for (let i = 0; i < 50; i++) { await agent('probe ' + i); try { await agent('bad', { schema: 5 }) } catch (e) {} } return 'looped'`, { spawner: looping }), "agent() option schema");
		await sleep(20);
		check("a script looping on a caught run-level error parks: nothing after the end reaches the host", looped === true && prompts(looping) === "probe 0", `${looped} · ${prompts(looping)}`);
		const late = fakeSpawner((r) => r.prompt, { delay: 5 });
		const finished = await run(`${META}agent('slow').then(() => agent('after the end')); return 'done'`, { spawner: late });
		await sleep(30);
		check("a hook called after the run completed never runs", finished.value === "done" && prompts(late) === "slow", prompts(late));
		const queued = fakeSpawner((r) => r.prompt, { delay: 20 });
		const dropped = await run(`${META}agent('a'); agent('b'); agent('c'); return 'done'`, { spawner: queued, caps: { concurrency: 1 } });
		const atSettle = queued.calls.length;
		await sleep(80);
		check("agent() calls still queued on the semaphore when the run completes never spawn", dropped.value === "done" && atSettle === 1 && prompts(queued) === "a", `${atSettle} at settle · ${prompts(queued)}`);
		const signals = [];
		const capped = { calls: [], async run(request, signal) { this.calls.push(request); signals.push(signal); await sleep(40); return { kind: "completed", value: request.prompt }; } };
		const capVerdict = await throwsWith(() => run(`${META}agent('a'); agent('b'); await agent('c'); return 'unreached'`, { spawner: capped, caps: { concurrency: 1, lifetimeAgents: 2 } }), "exceeded 2 total agents");
		const cappedAtSettle = capped.calls.length;
		await sleep(80);
		check("a run-level error ends the run for the queue too: the child in flight is signalled, the queued one never spawns", capVerdict === true && cappedAtSettle === 1 && capped.calls.length === 1 && signals[0]?.aborted === true, `${capVerdict} · ${cappedAtSettle} → ${capped.calls.length} · aborted ${signals[0]?.aborted}`);
		// A spawner accounts for its child — its cost — after the signal; a run that settled first would report without it.
		let accounted = 0;
		const lingering = { async run(request, signal) { await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); await sleep(30); accounted++; return { kind: "died", reason: "aborted" }; } };
		const stopper = new AbortController();
		const lingered = run(`${META}return agent('lingers')`, { spawner: lingering, signal: stopper.signal });
		await sleep(20);
		stopper.abort();
		const stopVerdict = await throwsWith(() => lingered, "workflow stopped");
		check("a stopped run settles only once the spawner has returned for every child in flight", stopVerdict === true && accounted === 1, `${stopVerdict} · ${accounted} accounted`);
		const strayed = await run(`${META}agent('stray'); return 'early'`, { spawner: lingering });
		check("so does a run whose script returned with a child still going", strayed.value === "early" && accounted === 2, `${strayed.value} · ${accounted} accounted`);
		const controller = new AbortController();
		const stopping = fakeSpawner((r) => r.prompt, { delay: 5000 });
		const stoppedRun = run(`${META}for (;;) { try { await agent('slow') } catch (e) {} }`, { spawner: stopping, signal: controller.signal });
		await sleep(20);
		controller.abort();
		check("a stop ends a script that catches everything, and it parks", (await throwsWith(() => within(stoppedRun), "workflow stopped")) === true && stopping.calls.length === 1, String(stopping.calls.length));
	}

	// the script owns the context's prototypes: the sandbox's own machinery never runs what it put there
	{
		// Promise.prototype.then asks the promise's constructor for its species, and the script owns Promise.prototype.
		// The script's own awaits go through `own`, which pins a promise's constructor, so only the sandbox's then() is left to trip.
		const SPECIES = "class Evil { constructor() { throw new Error('species says no') } }\nconst own = (p) => Object.defineProperty(p, 'constructor', { value: Promise });\n";
		const timer = inChild(`${SPECIES}await null; setTimeout(() => {}, 10); Promise.prototype.constructor = { [Symbol.species]: Evil }; await { then(resolve) { setTimeout(resolve, 30) } }; return 'done'`);
		check("a species the script plants on Promise.prototype never reaches the host through a timer", timer.status === 0 && timer.result?.value === "done", timer.shown);
		const returned = inChild(`${SPECIES}await null; Promise.prototype.constructor = { [Symbol.species]: Evil }; return 'done'`);
		check("nor through the return: the run still ends", returned.status === 0 && returned.result?.value === "done", returned.shown);
		const hooked = inChild(`${SPECIES}await null; Promise.prototype.constructor = { [Symbol.species]: Evil }; const a = await own(agent('x')); log('l'); const [s] = await own(pipeline([1], (n) => n + 1)); const [t] = await own(parallel([() => 't'])); return [a, s, t]`);
		check("nor through a hook, a stage or a thunk", hooked.status === 0 && JSON.stringify(hooked.result?.value) === JSON.stringify(["x", 2, "t"]), hooked.shown);
		const replacedThen = inChild("await null; const then = Promise.prototype.then; Promise.prototype.then = function () {}; const own = (p) => Object.defineProperty(p, 'constructor', { value: Promise }); const [s] = await own(pipeline([1], (n) => n + 1)); return s");
		check("nor does a then the script replaces: a stage's result still comes back", replacedThen.status === 0 && replacedThen.result?.value === 2, replacedThen.shown);

		// The host classifies a hook's error, and a script value thrown through a getter the host read is one: a proxy's traps must not run there.
		const TRAPS = "const trapped = new Proxy({}, { getPrototypeOf() { throw 42 } }); const revocable = Proxy.revocable({}, {}); revocable.revoke(); const revoked = revocable.proxy;\n";
		const viaOptions = inChild(`${TRAPS}const r = []; for (const value of [trapped, revoked]) { try { await agent('x', { get model() { throw value } }) } catch (e) { r.push(e instanceof Error) } } return r`);
		check("a proxy thrown from an agent() option getter rejects that call with an error; the host runs none of its traps", viaOptions.status === 0 && JSON.stringify(viaOptions.result?.value) === "[true,true]", viaOptions.shown);
		const viaLength = inChild(`${TRAPS}const r = []; for (const value of [trapped, revoked]) { try { await pipeline(new Proxy([], { get(t, k) { if (k === 'length') throw value; return t[k] } }), (x) => x) } catch (e) { r.push(e instanceof Error) } } return r`);
		check("so is one thrown from a pipeline's length", viaLength.status === 0 && JSON.stringify(viaLength.result?.value) === "[true,true]", viaLength.shown);
		const listened = inChild(`${TRAPS}try { await agent('x', { get model() { throw trapped } }) } catch (e) { return 'caught' } return 'no'`, "process.on('unhandledRejection', () => {});");
		check("and with a listener of the host's own, the call still settles", listened.status === 0 && listened.result?.value === "caught", listened.shown);
		const ownError = await run(`${META}try { await agent('x', { get model() { throw new RangeError('mine') } }) } catch (e) { return [e.name, e.message] }`);
		check("an error of the script's own thrown there comes back with its name and message", JSON.stringify(ownError.value) === JSON.stringify(["RangeError", "mine"]), JSON.stringify(ownError.value));

		// Handing a rejection over makes a context error and reads its name, which the script can make throw; that throw ends the run, never the seat.
		const hostRejected = inChild("Object.defineProperty(TypeError.prototype, 'name', { get() { throw 1 } }); try { await agent(5) } catch (e) { return 'caught' } return 'no'");
		check("an error name the script made throw, read as the host's rejection is handed over, ends the run with an Error; the seat lives", hostRejected.status === 0 && hostRejected.result?.error === "Error: 1", hostRejected.shown);
		const scriptRejected = inChild("Object.defineProperty(Error.prototype, 'name', { get() { throw 2 } }); try { await agent('x', { get model() { throw 'plain' } }) } catch (e) { return 'caught' } return 'no'");
		check("so does one read as the script's own thrown value is handed back", scriptRejected.status === 0 && scriptRejected.result?.error === "Error: 2", scriptRejected.shown);

		// A species that throws a value nothing can print breaks the script's own first await: the run ends with that, and stays ended.
		const spawned = fakeSpawner((r) => r.prompt);
		let unprintable;
		try {
			await run(`${META}const Orig = Promise; let armed = true;
				class Evil { constructor(ex) { if (armed) { armed = false; Orig.prototype.constructor = Orig; throw { toString() { throw 1 } } } return new Orig(ex) } }
				Orig.prototype.constructor = { [Symbol.species]: Evil };
				for (let i = 0; i < 3; i++) { await new Orig((r) => setTimeout(r, 5)); log('still running ' + i); await agent('after ' + i) }
				return 'done'`, { spawner: spawned });
		} catch (error) {
			unprintable = error;
		}
		await sleep(60);
		check("a script error nothing can print ends the run with an Error, and nothing runs after", unprintable instanceof Error && unprintable.message === "an error that cannot be printed" && spawned.calls.length === 0, `${unprintable?.message} · ${prompts(spawned)}`);
	}

	// A hook the host runs synchronously (`phase`, `log`) that throws ends the run, and nothing queued behind it reaches the host.
	{
		const spawned = fakeSpawner((r) => r.prompt);
		const logged = [];
		const emit = (e) => {
			if (e.type === "phase") throw new Error("emit failed");
			if (e.type === "log") logged.push(e.message);
		};
		const verdict = await throwsWith(() => within(runWorkflow({ source: `${META}phase('a'); log('after'); const x = await agent('p'); return x`, args: undefined, spawner: spawned, journal: new WorkflowJournal(path.join(dir, `j${journalN++}.jsonl`)), emit, signal: new AbortController().signal })), "emit failed");
		check("a phase whose emit throws ends the run with that error; the log and agent() queued after it never reach the host", verdict === true && logged.length === 0 && spawned.calls.length === 0, `${verdict} · ${logged.join()} · ${prompts(spawned)}`);
	}

	// setTimeout and clearTimeout: the script's own, cleared when the run ends
	{
		const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
		const mark = events.length;
		const out = await run(`${META}const order = [];
			await new Promise((resolve) => setTimeout((a, b) => { order.push(a + b); resolve() }, 5, 'x', 'y'));
			const cancelled = setTimeout(() => order.push('cancelled'), 1); clearTimeout(cancelled);
			setTimeout(() => { throw new Error('tick failed') }, 1);
			setTimeout(async () => { throw new Error('async tick failed') }, 1);
			await new Promise((resolve) => setTimeout(resolve, 20));
			return order`);
		check("setTimeout runs its callback with its extra arguments; clearTimeout cancels", JSON.stringify(out.value) === JSON.stringify(["xy"]), JSON.stringify(out.value));
		const logged = events.slice(mark).filter((e) => e.type === "log").map((e) => e.message);
		check("a callback that throws, or rejects, is logged, not fatal", logged.includes("setTimeout callback threw: tick failed") && logged.includes("setTimeout callback threw: async tick failed"), JSON.stringify(logged));
		const stack = await run(`${META}return await new Promise((resolve) => setTimeout(() => resolve(new Error('here').stack), 1))`);
		check("a timer callback runs from a microtask, so a stack it reads names none of the host's frames", typeof stack.value === "string" && stack.value.includes("workflow.js") && !/node:|\.ts:/.test(stack.value), stack.value);
		check("setTimeout needs a function: a string is never compiled", await throwsWith(() => run(`${META}setTimeout('1', 1)`), "setTimeout() needs a function"));
		const before = timeouts();
		const completed = await run(`${META}setTimeout(() => {}, 60000); return 1`);
		check("a timer still pending when the run completes is cleared", completed.value === 1 && timeouts() === before, `${before} → ${timeouts()}`);
		const controller = new AbortController();
		const pending = run(`${META}setTimeout(() => {}, 60000); await new Promise(() => {})`, { signal: controller.signal });
		await sleep(10);
		controller.abort();
		await throwsWith(() => pending, "workflow stopped");
		check("a stop clears the script's timers", timeouts() === before, `${before} → ${timeouts()}`);
	}

	// phase and log
	{
		events.length = 0;
		await run(`${META}phase('Scan'); log('hello'); await agent('a'); await agent('b', { phase: 'Fix', label: 'fix:b' }); console.log('via', 'console'); console.info('info'); console.warn('warn'); console.error('error'); console.debug('debug')`);
		const types = events.map((e) => e.type);
		check("phase() and log() emit events; console.log, info, warn, error and debug all reach the log", types.includes("phase") && events.filter((e) => e.type === "log").map((e) => e.message).join() === "hello,via console,info,warn,error,debug", events.filter((e) => e.type === "log").map((e) => e.message).join());
		const printedMark = events.length;
		await run(`${META}const bare = Object.create(null); bare.k = 1; const loop = {}; loop.self = loop; const unprintable = Object.create(null); unprintable.self = unprintable; console.log('obj', { a: [1, 'x'] }, [2, 3], null, undefined, 4n); console.log(bare); console.log(loop); console.log(unprintable, Symbol('s'), Object.create(null)); return 'printed'`);
		const printed = events.slice(printedMark).filter((e) => e.type === "log").map((e) => e.message);
		check("console prints an object as its JSON, falls back to String(), and prints '[object]' for one neither can write rather than throwing", printed.join("|") === 'obj {"a":[1,"x"]} [2,3] null undefined 4|{"k":1}|[object Object]|[object] Symbol(s) {}', printed.join("|"));
		const starts = events.filter((e) => e.type === "agent-start");
		check("an agent takes the current phase unless opts.phase says otherwise; label is the display name", starts[0].phase === "Scan" && starts[1].phase === "Fix" && starts[1].label === "fix:b" && starts[0].label === undefined, JSON.stringify(starts));
	}

	// resume: a journalled result is served only into the world its agent started in
	{
		const lastJournal = () => path.join(dir, `j${journalN - 1}.jsonl`);
		let n = 0;
		const numbered = () => fakeSpawner((r) => `r:${r.prompt}#${n++}`);

		const source = `${META}const a = await agent('one'); const b = await parallel([() => agent('two'), () => agent('two')]); const c = await agent('three:' + a); return [a, b, c]`;
		const first = numbered();
		const one = await run(source, { spawner: first });
		const priorFile = lastJournal();
		check("first run: every agent ran", first.calls.length === 4 && one.value[2] === "r:three:r:one#0#3", JSON.stringify(one.value));
		const again = numbered();
		const two = await run(source, { spawner: again, prior: readWorkflowJournal(priorFile) });
		check("an unchanged script replays whole: no child runs, the same value comes back", again.calls.length === 0 && JSON.stringify(two.value) === JSON.stringify(one.value) && two.replaySummary === "4 cached", `${prompts(again)} · ${two.replaySummary}`);
		check("two byte-identical calls take two cached entries, in order", two.value[1].join() === one.value[1].join());
		check("the resumed run's own journal is whole: every hit journalled again", [...readWorkflowJournal(lastJournal()).values()].flat().length === 4);
		const edited = numbered();
		const three = await run(source.replace("agent('one')", "agent('one!')"), { spawner: edited, prior: readWorkflowJournal(priorFile) });
		check("an edited call runs live, and so does everything that starts after it finishes", prompts(edited) === "one!,three:r:one!#4,two,two" && three.replaySummary === "0 cached", `${prompts(edited)} · ${three.replaySummary}`);
	}

	// A call whose input is a side effect, not text: its prompt is unchanged, its world is not.
	{
		let file = 0;
		const notes = () => fakeSpawner((r) => {
			const written = /^write (\d+)/.exec(r.prompt);
			if (written) { file = Number(written[1]); return "written"; }
			return `file holds ${file}`;
		});
		const first = await run(`${META}await agent('write 1 to notes.txt'); return await agent('read notes.txt')`, { spawner: notes() });
		const resumed = notes();
		const second = await run(`${META}await agent('write 2 to notes.txt'); return await agent('read notes.txt')`, { spawner: resumed, prior: readWorkflowJournal(path.join(dir, `j${journalN - 1}.jsonl`)) });
		check("an unchanged read after an edited write runs live: it never serves the old file", first.value === "file holds 1" && second.value === "file holds 2" && prompts(resumed) === "read notes.txt,write 2 to notes.txt", `${second.value} · ${prompts(resumed)}`);
	}

	{
		const items = `${META}return parallel(['a', 'b', 'c'].map((x) => () => agent('item ' + x)))`;
		const first = fakeSpawner((r) => `r:${r.prompt}`, { delay: (r) => ({ "item a": 30, "item b": 45, "item c": 5 })[r.prompt] });
		await run(items, { spawner: first, caps: { concurrency: 3 } });
		const order = fs.readFileSync(path.join(dir, `j${journalN - 1}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).prompt).join();
		const resumed = fakeSpawner((r) => `NEW:${r.prompt}`);
		const out = await run(items.replace("'b'", "'B!'"), { spawner: resumed, prior: readWorkflowJournal(path.join(dir, `j${journalN - 1}.jsonl`)) });
		check("editing one of three parallel items re-runs it alone; its siblings hit", order === "item c,item a,item b" && prompts(resumed) === "item B!" && out.value.join() === "r:item a,NEW:item B!,r:item c" && out.replaySummary === "2 cached", `${order} · ${prompts(resumed)} · ${out.value.join()}`);
	}

	{
		const stages = `${META}return pipeline(['a', 'b', 'c'], (x) => agent('s1:' + x), (prev, x) => agent('s2:' + x))`;
		const controller = new AbortController();
		const first = gatedSpawner();
		const stopped = run(stages, { spawner: first, caps: { concurrency: 4 }, signal: controller.signal }).catch((error) => error.message);
		for (const prompt of ["s1:a", "s1:b", "s1:c", "s2:b", "s2:a"]) await first.finish(prompt);
		await waitUntil(() => first.started("s2:c"));
		controller.abort();
		const stopMessage = await within(stopped);
		const stoppedFile = path.join(dir, `j${journalN - 1}.jsonl`);
		const lines = fs.readFileSync(stoppedFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("a stopped pipeline journals what finished, stage 2 out of order, and nothing for the child in flight", stopMessage === "workflow stopped" && lines.map((l) => `${l.prompt}@${l.after}`).join() === "s1:a@0,s1:b@0,s1:c@0,s2:b@2,s2:a@1", lines.map((l) => `${l.prompt}@${l.after}`).join());
		const second = gatedSpawner();
		const resuming = run(stages, { spawner: second, caps: { concurrency: 4 }, prior: readWorkflowJournal(stoppedFile) });
		await second.finish("s2:c");
		const resumed = await within(resuming);
		check("its resume hits every finished agent and runs only the one that was in flight", second.calls.join() === "s2:c" && resumed.replaySummary === "5 cached" && resumed.value.join() === "r:s2:a,r:s2:b,r:s2:c", `${second.calls.join()} · ${resumed.replaySummary}`);
		const third = fakeSpawner((r) => `NEW:${r.prompt}`);
		const again = await run(stages, { spawner: third, caps: { concurrency: 4 }, prior: readWorkflowJournal(path.join(dir, `j${journalN - 1}.jsonl`)) });
		check("resuming the resumed run hits every agent", third.calls.length === 0 && again.replaySummary === "6 cached" && again.value.join() === "r:s2:a,r:s2:b,r:s2:c", `${prompts(third)} · ${again.replaySummary}`);
	}

	{
		const stages = `${META}return pipeline(['a', 'b', 'c'], (x) => agent('s1:' + x), (prev, x) => agent('s2:' + x))`;
		const first = gatedSpawner();
		const running = run(stages, { spawner: first, caps: { concurrency: 4 } });
		await first.finish("s1:b");
		await waitUntil(() => first.started("s2:b"));
		await first.finish("s1:a", { kind: "died", reason: "crashed" });
		for (const prompt of ["s1:c", "s2:b", "s2:c"]) await first.finish(prompt);
		await within(running);
		const second = gatedSpawner();
		const resuming = run(stages, { spawner: second, caps: { concurrency: 4 }, prior: readWorkflowJournal(path.join(dir, `j${journalN - 1}.jsonl`)) });
		await waitUntil(() => second.started("s1:a") && second.started("s2:c"));
		const liveBeforeTheRerunEnds = [...second.calls].sort().join();
		for (const prompt of ["s1:a", "s2:c", "s2:a"]) await second.finish(prompt);
		const resumed = await within(resuming);
		check("a died item re-runs, with every agent that started after its death; those that started before hit", liveBeforeTheRerunEnds === "s1:a,s2:c" && resumed.replaySummary === "3 cached" && resumed.value.join() === "r:s2:a,r:s2:b,r:s2:c", `${liveBeforeTheRerunEnds} · ${resumed.replaySummary} · ${resumed.value.join()}`);
	}

	{
		// A spawner that holds a child back (the prefix stagger) says when it really starts it.
		let aDone;
		const aFinished = new Promise((resolve) => { aDone = resolve; });
		const holding = {
			calls: [],
			async run(request) {
				this.calls.push(request.prompt);
				if (request.prompt === "A") { aDone(); return { kind: "completed", value: "a" }; }
				await aFinished;
				await sleep(5);
				request.started();
				return { kind: "completed", value: "b" };
			},
		};
		const source = `${META}return parallel([() => agent('A'), () => agent('B')])`;
		await run(source, { spawner: holding, caps: { concurrency: 2 } });
		const heldFile = path.join(dir, `j${journalN - 1}.jsonl`);
		const held = fs.readFileSync(heldFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const resumed = fakeSpawner((r) => r.prompt);
		await run(source.replace("'A'", "'A!'"), { spawner: resumed, prior: readWorkflowJournal(heldFile) });
		check("a child held back by its spawner takes its `after` when it really starts, so it re-runs when what finished first changes", held.find((l) => l.prompt === "B")?.after === 1 && prompts(resumed) === "A!,B", `${JSON.stringify(held)} · ${prompts(resumed)}`);
	}

	{
		// B is handed off with A, and A finishes while B runs: whether B's `after` counts A is decided by when B says it started.
		const afterOfB = async (says) => {
			const gate = gatedSpawner({ callsStarted: says });
			const running = run(`${META}return parallel([() => agent('A'), () => agent('B')])`, { spawner: gate, caps: { concurrency: 2 } });
			await gate.finish("A");
			await gate.finish("B");
			await within(running);
			return fs.readFileSync(path.join(dir, `j${journalN - 1}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.prompt === "B")?.after;
		};
		const saidAt = await afterOfB(true);
		const neverSaid = await afterOfB(false);
		check("a spawner that says when its child started records the count at that start", saidAt === 0, String(saidAt));
		check("one that never says records the count as the report comes back, never the earlier count at hand-off", neverSaid === 1, String(neverSaid));
	}

	// stop: the abort signal ends the run and the in-flight child
	{
		const controller = new AbortController();
		const slow = fakeSpawner(() => "late", { delay: 5000 });
		const running = run(`${META}const a = await agent('slow'); return a`, { spawner: slow, signal: controller.signal });
		await sleep(20);
		controller.abort();
		const verdict = await throwsWith(() => running, "workflow stopped");
		check("aborting rejects the run with 'workflow stopped' and does not wait for the child", verdict === true, String(verdict));
		check("a stopped run's later agent() calls throw rather than spawn", await throwsWith(() => run(`${META}return agent('x')`, { signal: controller.signal }), "workflow stopped"));
	}

	check("WorkflowRunError is exported for the extension to classify", typeof WorkflowRunError === "function");
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3a. a script's unhandled rejection is its run's failure; any other is Node's
// ---------------------------------------------------------------------------
{
	console.log("\nunhandled rejections, each in its own process");
	const dropped = inChild("Promise.reject(new Error('dropped')); return 1");
	check("a promise the script drops in its last tick is a failure of the run, not a crash, and the run still returns", dropped.status === 0 && dropped.result?.value === 1 && dropped.result.failures.join() === "dropped", dropped.shown);
	check("no listener is left behind once the run has settled", dropped.result?.listeners === 0, dropped.shown);
	const midRun = inChild("(async () => { await agent('a'); throw new TypeError('floating') })(); await agent('b'); await agent('c'); return 2");
	check("so is one that rejects mid-run, after the script moved on", midRun.status === 0 && midRun.result?.value === 2 && midRun.result.failures.join() === "floating", midRun.shown);
	const reparented = inChild("const p = Promise.reject(new Error('reparented')); Object.setPrototypeOf(p, {}); return 3");
	check("a promise the script re-parents onto one of its own objects is still its own", reparented.status === 0 && reparented.result?.failures.join() === "reparented", reparented.shown);
	const foreign = inChild("await new Promise((resolve) => setTimeout(resolve, 200)); return 4", "setTimeout(() => Promise.reject(new Error('the host dropped this')), 20);");
	check("a host rejection during a run keeps Node's own behaviour: the process dies with it", foreign.status === 1 && foreign.result === undefined && foreign.stderr.includes("the host dropped this"), foreign.shown);
	const heard = inChild("await new Promise((resolve) => setTimeout(resolve, 200)); Promise.reject(new Error('mine')); return 5", "const heard = []; process.on('unhandledRejection', (reason) => heard.push(reason.message)); setTimeout(() => Promise.reject(new Error('the host dropped this')), 20); process.on('exit', () => console.log('HEARD ' + heard.join()));");
	check("with a listener of its own, the host hears every rejection as before and the run claims only the script's", heard.status === 0 && heard.result?.failures.join() === "mine" && /^HEARD the host dropped this,mine$/m.test(heard.stdout), heard.shown);
	const warned = inChild("await new Promise((resolve) => setTimeout(resolve, 200)); Promise.reject(new Error('mine')); return 6", "setTimeout(() => Promise.reject(new Error('the host dropped this')), 20);", ["--unhandled-rejections=warn"]);
	check("where Node only warns, the host's rejection is warned and the run still claims the script's later one: the listener that stepped aside came back", warned.status === 0 && warned.result?.value === 6 && warned.result.failures.join() === "mine" && warned.stderr.includes("the host dropped this"), warned.shown);
}

// ---------------------------------------------------------------------------
// 3b. the prefix stagger: one leader per prompt prefix, then warm
// ---------------------------------------------------------------------------
{
	const { WORKFLOW_PREFIX_STAGGER_MS, WORKFLOW_PREFIX_WARM_MS, WorkflowPrefixStagger, workflowPrefixKey } = await jiti.import(`${ROOT}/lib/workflow-prefix-stagger.ts`);
	console.log("\nprefix stagger");
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const signal = new AbortController().signal;
	const wide = { concurrency: 8, staggerMs: 400, warmMs: 60_000 };
	check("the ruled durations: 5 s behind the leader, 270 s warm", WORKFLOW_PREFIX_STAGGER_MS === 5000 && WORKFLOW_PREFIX_WARM_MS === 270_000, `${WORKFLOW_PREFIX_STAGGER_MS} \u00b7 ${WORKFLOW_PREFIX_WARM_MS}`);
	check(
		"the key is model, thinking, type and whether there is a schema \u2014 never the schema itself",
		new Set([workflowPrefixKey({}), workflowPrefixKey({ model: "sonnet" }), workflowPrefixKey({ thinking: "high" }), workflowPrefixKey({ type: "explore" }), workflowPrefixKey({ schema: { type: "object" } })]).size === 5 &&
			workflowPrefixKey({ schema: { type: "object" } }) === workflowPrefixKey({ schema: { type: "array" } }) &&
			workflowPrefixKey({ label: "a", phase: "b", isolation: "worktree" }) === workflowPrefixKey({}),
		workflowPrefixKey({ model: "sonnet", schema: { type: "object" } }),
	);

	{
		const stagger = new WorkflowPrefixStagger();
		const spawned = [];
		const leader = await stagger.take("k", wide, signal);
		spawned.push("leader");
		const second = stagger.take("k", wide, signal).then(() => spawned.push("second"));
		const third = stagger.take("k", wide, signal).then(() => spawned.push("third"));
		await sleep(80);
		check("the first same-key child spawns at once; the second and third wait for its first turn", spawned.join() === "leader", spawned.join());
		leader.firstTurn();
		await Promise.all([second, third]);
		check("the leader's first turn releases every waiter", spawned.join() === "leader,second,third", spawned.join());
		const warm = Date.now();
		await stagger.take("k", wide, signal);
		check("the key is warm after it: the next same-key child spawns at once", Date.now() - warm < 100, `${Date.now() - warm}ms`);
	}

	{
		const stagger = new WorkflowPrefixStagger();
		await stagger.take("k", wide, signal);
		const start = Date.now();
		await Promise.all([stagger.take("k", wide, signal), stagger.take("k", wide, signal)]);
		const waited = Date.now() - start;
		check("with no first turn the waiters spawn at the cap \u2014 late, never never", waited >= wide.staggerMs - 30 && waited < wide.staggerMs * 4, `${waited}ms`);
	}

	{
		const stagger = new WorkflowPrefixStagger();
		await stagger.take(workflowPrefixKey({ type: "worker" }), wide, signal);
		const start = Date.now();
		await stagger.take(workflowPrefixKey({ type: "explore" }), wide, signal);
		check("a different key does not wait on another key's leader", Date.now() - start < 100, `${Date.now() - start}ms`);
	}

	{
		const solo = new WorkflowPrefixStagger();
		const one = { ...wide, concurrency: 1 };
		await solo.take("k", one, signal);
		const start = Date.now();
		await solo.take("k", one, signal);
		await solo.take("k", one, signal);
		check("concurrency 1 skips the stagger: nothing overlaps, so nothing waits", Date.now() - start < 100, `${Date.now() - start}ms`);
	}

	{
		const stagger = new WorkflowPrefixStagger();
		const dying = await stagger.take("k", wide, signal);
		const start = Date.now();
		const waiter = stagger.take("k", wide, signal);
		await sleep(40);
		dying.release();
		await waiter;
		check("a leader that dies before its first turn releases its waiters", Date.now() - start < wide.staggerMs, `${Date.now() - start}ms`);
		const after = [];
		await stagger.take("k", wide, signal);
		after.push("new leader");
		stagger.take("k", wide, signal).then(() => after.push("its waiter"));
		await sleep(40);
		check("\u2014 and leaves no warm key: the next child leads, and is waited on", after.join() === "new leader", after.join());
	}
}

// ---------------------------------------------------------------------------
// 4. structured output: validated at the tool boundary, three attempts
// ---------------------------------------------------------------------------
{
	const so = await jiti.import(`${ROOT}/lib/workflow-structured-output.ts`);
	console.log("\nstructured output");
	const schema = { type: "object", additionalProperties: false, required: ["file", "fixed"], properties: { file: { type: "string" }, fixed: { type: "boolean" } } };
	check("the tool is named StructuredOutput and allows 3 attempts", so.STRUCTURED_OUTPUT_TOOL_NAME === "StructuredOutput" && so.STRUCTURED_OUTPUT_MAX_ATTEMPTS === 3);
	check("a valid value passes", so.validateStructuredOutput(schema, { file: "a.ts", fixed: true }).ok === true);
	const bad = so.validateStructuredOutput(schema, { file: 1, extra: 2 });
	check("an invalid value fails with every error named by path", bad.ok === false && bad.errors.includes("/file") && bad.errors.includes("fixed") && bad.errors.includes("additional"), bad.errors);
	check("a non-object schema (an array of strings) validates too", so.validateStructuredOutput({ type: "array", items: { type: "string" } }, ["a"]).ok === true && so.validateStructuredOutput({ type: "array", items: { type: "string" } }, [1]).ok === false);
	// Ticket 37: `result` was `Type.Unknown`, a property with no type at all, and
	// every model filled it with a string of JSON — 180 rejections out of 180.
	check("the tool's `result` parameter is a typed object, so the provider constrains the call", so.STRUCTURED_OUTPUT_PARAMS.properties.result.type === "object" && so.STRUCTURED_OUTPUT_PARAMS.required.includes("result"), JSON.stringify(so.STRUCTURED_OUTPUT_PARAMS));
	check("a `result` sent as a string of JSON is parsed before pi validates it", JSON.stringify(so.prepareStructuredOutputArguments({ result: '{"file":"a.ts","fixed":true}' })) === '{"result":{"file":"a.ts","fixed":true}}');
	check("an unparseable string and a real object are passed through untouched", so.prepareStructuredOutputArguments({ result: "not json" }).result === "not json" && so.prepareStructuredOutputArguments({ result: { a: 1 } }).result.a === 1);
	check("only an object schema may be a contract, so the declared type can never contradict it", so.structuredOutputSchemaRefusal(schema) === undefined && so.structuredOutputSchemaRefusal({ type: "array", items: { type: "string" } })?.includes('type "object"') === true && so.structuredOutputSchemaRefusal({ properties: {} })?.includes("no type") === true && so.structuredOutputSchemaRefusal("x")?.includes("got string") === true);
	check("declaring a contract on a non-object schema throws where it is constructed", await throwsWith(() => so.declareStructuredOutput("parent-0", "bad", { type: "array" }), 'StructuredOutput schema must be a JSON Schema with type "object"'));

	const instruction = so.structuredOutputInstruction(schema);
	check("the instruction tells the child to call StructuredOutput once, last, with the schema inline", instruction.includes("call StructuredOutput exactly once, as your final action") && instruction.includes('"required"') && instruction.includes("fixed"), instruction);

	const contract = so.declareStructuredOutput("parent-1", "fix:a.ts", schema);
	check("a declared contract is found by parent session and child name", so.structuredOutputContractOf("parent-1", "fix:a.ts") === contract && so.structuredOutputContractOf("parent-1", "other") === undefined);
	const first = so.recordStructuredOutputAttempt(contract, { file: 1 });
	const second = so.recordStructuredOutputAttempt(contract, { file: "a", fixed: "yes" });
	check("two bad attempts are rejected with the errors and the attempts left", first.kind === "rejected" && first.attemptsLeft === 2 && second.kind === "rejected" && second.attemptsLeft === 1 && second.errors.includes("/fixed"), JSON.stringify([first, second]));
	const third = so.recordStructuredOutputAttempt(contract, { file: "a", fixed: true });
	check("a good third attempt is accepted and settles the outcome with the value", third.kind === "accepted" && (await contract.outcome).fixed === true);
	check("a further call after acceptance is refused as already recorded", so.recordStructuredOutputAttempt(contract, { file: "b", fixed: true }).kind === "already-recorded");
	so.forgetStructuredOutput("parent-1", "fix:a.ts");
	check("forget removes it", so.structuredOutputContractOf("parent-1", "fix:a.ts") === undefined);

	const doomed = so.declareStructuredOutput("parent-1", "doomed", schema);
	doomed.outcome.catch(() => {});
	so.recordStructuredOutputAttempt(doomed, {});
	check("a turn that ends without a call counts as an attempt", so.noteStructuredOutputMissed(doomed).kind === "rejected");
	const last = so.recordStructuredOutputAttempt(doomed, {});
	check("the third failure is exhausted and the outcome rejects", last.kind === "exhausted" && (await doomed.outcome.then(() => "resolved", (e) => e.message)).includes("3 attempts"));
	so.forgetStructuredOutput("parent-1", "doomed");
}

// ---------------------------------------------------------------------------
// 4b. args: a JSON string that encodes an object or an array *is* that value (ticket 55)
// ---------------------------------------------------------------------------
{
	const { coerceWorkflowArgs } = await jiti.import(`${ROOT}/lib/workflow-args.ts`);
	console.log("\nargs coercion");
	const object = coerceWorkflowArgs('{"tests":["a.ts"],"n":2}');
	check("a JSON-string object arrives as the object", object.coerced === true && object.value.tests[0] === "a.ts" && object.value.n === 2, JSON.stringify(object));
	const array = coerceWorkflowArgs("[1,2]");
	check("a JSON-string array arrives as the array", array.coerced === true && Array.isArray(array.value) && array.value.length === 2);
	check("text that is not JSON stays the string it is", coerceWorkflowArgs("plain text").value === "plain text" && coerceWorkflowArgs("plain text").coerced === false);
	check("a JSON scalar stays the string it is: a script may want one", ["7", "true", "null", '"quoted"'].every((s) => coerceWorkflowArgs(s).value === s && coerceWorkflowArgs(s).coerced === false));
	check("a real object, a real array and undefined pass through untouched", coerceWorkflowArgs({ a: 1 }).value.a === 1 && coerceWorkflowArgs([3]).value[0] === 3 && coerceWorkflowArgs(undefined).value === undefined && [{ a: 1 }, [3], undefined].every((v) => coerceWorkflowArgs(v).coerced === false));
}

// ---------------------------------------------------------------------------
// 5. the ruled words: Claude Code's description with our gate, under budget
// ---------------------------------------------------------------------------
{
	const t = await jiti.import(`${ROOT}/lib/workflow-tool-text.ts`);
	console.log("\nthe ruled words");
	const d = t.WORKFLOW_DESCRIPTION;
	check("opens with Claude Code's first paragraph, verbatim", d.startsWith("Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background \u2014 this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress."));
	check("the opt-in gate is gone (C20): no ultracode, no 'explicitly opted', no size guideline", !/ultracode|explicitly opted|ONLY call this tool|under 50 agents/.test(d));
	check("says when a workflow fits: many things, fix until green, scout first, one pass", d.includes("the same job runs on many things") && d.includes("until it is green") && d.includes("Scout first") && d.includes("One child per item, one pass; tests are the check, not reviewers."));
	check("keeps the meta paragraph verbatim", d.includes("Every script must begin with `export const meta = {...}`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's `name`, a one-line `description` and optionally `phases` \u2014 one `{ title, detail? }` per phase() call, titles matched exactly. Pass the script inline via `script` \u2014 do not Write it to a file first, and do not also set the tool's `name` input (that selects a saved workflow); it is plain JavaScript, not TypeScript."));
	check("points at the workflow-authoring skill", d.includes("load the `workflow-authoring` skill"));
	const tokens = t.estimateWorkflowTextTokens(d);
	check(`the description is under ~500 tokens (chars/4 = ${tokens.byFour}, chars/3.7 = ${tokens.byThreeSeven})`, tokens.byThreeSeven <= 520, `${d.length} chars`);
	const all = d + Object.values(t.WORKFLOW_PARAMS).join("\n");
	const allTokens = t.estimateWorkflowTextTokens(all);
	check(`with the parameter descriptions: chars/4 = ${allTokens.byFour}, chars/3.7 = ${allTokens.byThreeSeven}`, allTokens.byThreeSeven <= 800);
	check("scriptPath takes precedence over script and name, in its own words", t.WORKFLOW_PARAMS.scriptPath.includes("Takes precedence over `script` and `name`."));
	check("args is a raw JSON value, in Claude Code's words", t.WORKFLOW_PARAMS.args.includes("NOT as a JSON-encoded string"));
	check("resume: same-session only; a live prior run is stopped first", t.WORKFLOW_PARAMS.resumeFromRunId.includes("Same-session only") && t.WORKFLOW_PARAMS.resumeFromRunId.includes("stopped first"));
	check("resume promises what the journal keeps: an edited, new or failed call re-runs with everything that starts after it", t.WORKFLOW_PARAMS.resumeFromRunId.includes("an edited, new or failed call re-runs, and so does every call that starts after it finishes or fails") && !t.WORKFLOW_PARAMS.resumeFromRunId.includes("only edited or new calls re-run"));
	check("resume without args runs on the prior run's, and the description says so", t.WORKFLOW_PARAMS.resumeFromRunId.includes("Without args, the prior run's are used."));
	check("the description promises the failures along with the value", d.includes("only the return value comes back, with a line per failure"));
	check("wake is gone: a workflow's return value delivers itself (ticket 09, ruled)", t.WORKFLOW_PARAMS.wake === undefined, Object.keys(t.WORKFLOW_PARAMS).join());
	check("the run id pattern is Claude Code's", t.WORKFLOW_RUN_ID_PATTERN === "^wf_[a-z0-9-]{6,}$" && t.WORKFLOW_SCRIPT_MAX_LENGTH === 524288);
}

// ---------------------------------------------------------------------------
// 5b. the authoring skill: Claude Code's mechanics, none of its quality theatre
// ---------------------------------------------------------------------------
{
	console.log("\nthe authoring skill");
	const skill = fs.readFileSync(`${ROOT}/skills/workflow-authoring/SKILL.md`, "utf8");
	check("frontmatter names it workflow-authoring, as the tool description points", /^---\nname: workflow-authoring\ndescription: .+\n---\n/.test(skill));
	check("the Q67 line is in, verbatim", skill.includes("One child per item, one pass. Check by running the tests, not by spawning reviewers. Add a second pass only when Joel asks."));
	check("the child contract is quoted, both paragraphs", skill.includes("Your final assistant message IS the return value of a function call in a program.") && skill.includes("You have no access to the conversation that created this task."));
	check("the mechanics survive: hooks, pipeline default, the smell test, the caps, resume", ["pipeline(items, stage1, stage2, ...)", "parallel(thunks", "DEFAULT TO `pipeline()`", "Smell test", "min(16, available CPUs \u2212 2)", "4096", "1000", "resumeFromRunId", "journal.jsonl", "N cached"].every((s) => skill.includes(s)));
	check("the fix-until-green shape is in, with its four load-bearing notes", skill.includes("name: 'fix-until-green'") && skill.includes("every shell command lives in an agent") && skill.includes("round number is in every prompt") && skill.includes("group-by-file"));
	check("no quality patterns, no five shapes, no ultracode, no budget, no nesting (deferred to 26)", !/adversarial|judge panel|loop-until-dry|completeness critic|multi-modal|ultracode|budget\.|workflow\(nameOrRef|\*\*Understand\*\*|\*\*Migrate\*\* \u2014/i.test(skill), (skill.match(/adversarial|judge panel|loop-until-dry|completeness critic|multi-modal|ultracode|budget\.|workflow\(nameOrRef/gi) ?? []).join());
	check("the 54 ruling: one item per child, explore/worker only, no workflow in a child", ["One item = one thing one worker finishes with a clear check", "`lead` is refused", "A child may start explorers; it may not start a workflow.", "stallMs?", "Siblings share the machine."].every((s) => skill.includes(s)));
	check("the failure table matches the runtime: a schema failure and a null stage end a slot, never the run", skill.includes("| Schema validation fails 3× | that `agent()` → `null`") && skill.includes("| A stage returns `null` (a dead child's included), or an item is `null` | that item → `null`, remaining stages skipped |") && !skill.includes("throw — loud, even inside a stage"));
	check("resume is stated as the journal keeps it: happens-before, not the longest unchanged prefix", skill.includes("every call that starts after it finishes") && !skill.includes("longest unchanged prefix"));
	check("the sandbox as the runtime keeps it: every clock path, the timers, console, import, and the synchronous-start limit", ["`Date()`", "`Temporal.Now`", "`Intl.DateTimeFormat` `format()` with no date", "`setTimeout`/`clearTimeout` work, and are cleared when the run ends", "`console.log`/`info`/`warn`/`error`/`debug`", "the word `import` is refused", "`WeakRef` and `WebAssembly` are absent", "Local time and the default locale are the host's", "The 30 s timeout covers only the script's synchronous start"].every((s) => skill.includes(s)));
	check("a run-level stop is stated as final: catching it does not keep the run going", skill.includes("Catching one does not keep the run going"));
	const readme = fs.readFileSync(`${ROOT}/README.md`, "utf8");
	check("the README declares the in-process limit, the host-object rule, the deleted host-timed built-ins and the host's time zone", readme.includes("the 30 s timeout covers only the script's synchronous start") && readme.includes("The script never holds a host object") && readme.includes("the GC's schedule are deleted") && readme.includes("The host's time zone"));
	check("a stall is restarted fresh, and a long tool call is not a stall", skill.includes("while none of its tool calls is running") && skill.includes("started again fresh, 3 attempts in all; then `null`"));
	check("the failures are not silent: the result lists them, and a usage limit waits for its reset", skill.includes("None of the failures is silent") && skill.includes("resume after it resets") && skill.includes("without `args`, the prior run's are used"));
	check("and a null the script made itself is its own, not listed: the SKILL claims no more than the result shows", !skill.includes("None of those nulls is silent") && skill.includes("A `null` item you pass in, or a `null` your own stage returns, is yours and is not listed."));
	check("our dialect: type and thinking, not agentType and effort", skill.includes("thinking?") && skill.includes("type?") && !/agentType|effort\?/.test(skill));
}

// ---------------------------------------------------------------------------
// 6. the extension on real pi sessions, scripted model (harness as agent-engine.mjs)
// ---------------------------------------------------------------------------
const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
fs.mkdirSync(path.join(AGENT_DIR, "agents"));
fs.mkdirSync(path.join(AGENT_DIR, "workflows"));
fs.writeFileSync(path.join(AGENT_DIR, "agents", "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(AGENT_DIR, "sessions");
// Holds a child's session start for `globalThis.__workflowTestSpawnDelayMs`: the window in which a spawn is in flight.
fs.writeFileSync(path.join(AGENT_DIR, "slow-spawn.mjs"), "export default async function () { const ms = globalThis.__workflowTestSpawnDelayMs ?? 0; if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms)); }\n");
process.env.PI_AGENT_CHILD_EXTENSIONS = `${ROOT}/extensions/agent-engine.ts:${ROOT}/extensions/workflow.ts:${path.join(AGENT_DIR, "slow-spawn.mjs")}`;

const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await import(`${PI}/dist/index.js`);
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`);

const script = new Map();
const requests = [];
const scriptFor = (userText, steps) => script.set(userText, [...steps]);
const lastUserText = (context) => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const t = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		if (t.includes("<task-notification>")) continue;
		return t;
	}
	return "";
};
const text = (t) => ({ type: "text", text: t });
const call = (name, args, id = `call_${Math.random().toString(16).slice(2, 8)}`) => ({ type: "toolCall", id, name, arguments: args });

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	let aborted = false;
	options?.signal?.addEventListener("abort", () => {
		if (aborted) return;
		aborted = true;
		const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() };
		stream.push({ type: "error", reason: "aborted", error: { ...partial, errorMessage: "Request was aborted" } });
		stream.end();
	}, { once: true });
	requests.push({ at: Date.now(), model: model.id, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), messages: context.messages });
	const key = [...script.keys()].filter((k) => lastUserText(context).includes(k)).sort((a, b) => b.length - a.length)[0];
	const steps = key === undefined ? undefined : script.get(key);
	const step = steps?.shift() ?? [text(`(no script for: ${lastUserText(context).slice(0, 60)})`)];
	// `error` ends the turn the way a provider refusal does: stopReason error, the provider's text as errorMessage.
	if (!Array.isArray(step) && step.error !== undefined) {
		const failed = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: step.error, timestamp: Date.now() };
		setTimeout(() => {
			if (aborted) return;
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end();
		}, step.delay ?? 5);
		return stream;
	}
	// `chunks` streams one text delta at a time, `gapMs` apart: the only way to write a step
	// that is alive for longer than its stall window without a tool call or a turn end in it.
	const chunks = Array.isArray(step) ? undefined : step.chunks;
	const content = chunks !== undefined ? [text(chunks.join(""))] : Array.isArray(step) ? step : step.content;
	const delay = (Array.isArray(step) ? undefined : step.delay) ?? 5;
	const stopReason = content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
	const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
	setTimeout(async () => {
		if (aborted) return;
		stream.push({ type: "start", partial: { ...message, content: [] } });
		if (chunks !== undefined) {
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			for (const chunk of chunks) {
				await sleep(step.gapMs ?? 100);
				if (aborted) return;
				stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: message });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
			stream.push({ type: "done", reason: stopReason, message });
			stream.end();
			return;
		}
		content.forEach((block, i) => {
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex: i, partial: message });
				stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: message });
				stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: message });
			} else {
				stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
				stream.push({ type: "toolcall_delta", contentIndex: i, delta: JSON.stringify(block.arguments), partial: message });
				stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message });
			}
		});
		stream.push({ type: "done", reason: stopReason, message });
		stream.end();
	}, delay);
	return stream;
}

const SCRIPTED_MODEL = { id: "scripted-1", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
const scriptedProvider = (pi) => {
	pi.registerProvider("scripted", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: [SCRIPTED_MODEL] });
};
const modelRuntime = await ModelRuntime.create({});

/** Set to act on a lifecycle event the moment it is emitted, inside the emitting call. */
const onLifecycle = { at: undefined };

async function mainSeat({ cwd = ROOT } = {}) {
	const events = [];
	const progress = [];
	const observer = (pi) => {
		for (const channel of ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed", "subagents:resumed"]) pi.events.on(channel, (payload) => { events.push({ channel, ...payload }); onLifecycle.at?.({ channel, ...payload }); });
		pi.events.on("workflow:progress", (payload) => progress.push(payload));
	};
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		eventBus: createEventBus(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [`${ROOT}/extensions/agent-engine.ts`, `${ROOT}/extensions/workflow.ts`],
		extensionFactories: [scriptedProvider, observer],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd, thinkingLevel: "off", noTools: "builtin", resourceLoader: loader, sessionManager: SessionManager.create(cwd), modelRuntime });
	await session.bindExtensions({ mode: "print" });
	await session.setModel(modelRuntime.getModel("scripted", "scripted-1"));
	return {
		session,
		events,
		progress,
		toolResults: () => session.messages.filter((m) => m.role === "toolResult"),
		customs: () => session.messages.filter((m) => m.role === "custom"),
		records: () => session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data),
	};
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Idle with nothing in flight, delivery included. A settle now opens a turn of
 * its own (ticket 09), so a test that prompts straight after one would be
 * prompting a busy seat.
 */
async function quiet(seat) {
	await until(() => seat.session.isStreaming, 300);
	await seat.session.waitForIdle();
}
async function until(condition, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await sleep(10);
	}
	return true;
}
const META = "export const meta = { name: 'count-things', description: 'Count each thing', phases: [{ title: 'Count' }] }\n";
const childRequestFor = (fragment) => requests.find((r) => lastUserText({ messages: r.messages }).includes(fragment));

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
	check("the child's first message opens with the worker tail and carries the workflow-child line", firstMessage.startsWith("<sub_agent_context>\nYou are a **worker** named `count:apples`") && firstMessage.includes("Your final message IS the return value of a function call in a program. Return raw data \u2014 no preamble, no summary of what you did."), firstMessage.slice(0, 300));
	check("the brief is preceded by the child contract, verbatim, all three paragraphs", firstMessage.includes("</sub_agent_context>\n\nYour final assistant message IS the return value of a function call in a program.\nIt is not a message to a human.") && firstMessage.includes("You have no access to the conversation that created this task. Everything you need\nis in the prompt below.") && firstMessage.includes("You may start explorers to read for you. You may not start a workflow: you were\ngiven one item; do it, and if it is too big say so in your return value.") && firstMessage.endsWith("Count the apples."), firstMessage);
	check("the child holds Workflow and StructuredOutput too (same array on every seat)", childRequest !== undefined && ["Agent", "Workflow", "StructuredOutput"].every((n) => childRequest.tools.some((t) => t.name === n)));
	check("progress events: phase, two starts, two dones, one log", seat.progress.filter((p) => p.type === "agent-start").length === 2 && seat.progress.filter((p) => p.type === "agent-done").length === 2 && seat.progress.some((p) => p.type === "log" && p.message === "counted 2") && seat.progress.some((p) => p.type === "phase" && p.title === "Count"));

	await until(() => seat.customs().length > 0, 5000);
	await seat.session.waitForIdle();
	const notices = seat.customs();
	check("exactly one notification delivers itself: the workflow's, not its children's", notices.length === 1 && notices[0].content.includes("<agent-name>count-things</agent-name>") && !notices[0].content.includes("count:apples"), notices.map((n) => n.content.slice(0, 120)).join(" | "));
	check("it carries the return value, whole, then the count of its agents", notices[0]?.content.includes('<result>{\n  "counts": [\n    "3 apples",\n    "5 pears"\n  ]\n}\n\n[agents: 2 run]</result>'), notices[0]?.content);
	check("a run with no failures names none and offers no resume", !notices[0]?.content.includes("[failures") && !notices[0]?.content.includes("resumeFromRunId"), notices[0]?.content);
	const records = seat.records();
	check("children are registry entries, flagged workflowChild and read at settle", records.some((r) => r.name === "count:apples" && r.workflowChild === true && r.status === "completed" && r.readBy === "spawner"));
	check("the run is a registry entry of type workflow", records.some((r) => r.type === "workflow" && r.name === "count-things" && r.status === "completed"));
	const journal = fs.readFileSync(path.join(path.dirname(scriptPath), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("the journal has one record per child with its actual return value", journal.length === 2 && journal.some((j) => j.result === "3 apples" && j.label === "count:apples"));

	// resume: same script, same args → 100% cache hit, N cached printed
	scriptFor("resume it", [[call("Workflow", { scriptPath, resumeFromRunId: runId, args: ["apples", "pears"] })], [text("resumed")]]);
	const spawnsBefore = seat.events.filter((e) => e.channel === "subagents:created" && e.type === "worker").length;
	await seat.session.prompt("resume it");
	await seat.session.waitForIdle();
	const resumeLaunch = seat.toolResults()[1]?.content[0].text ?? "";
	const { WORKFLOW_RESUME_RULE } = await jiti.import(`${ROOT}/lib/workflow-tool-text.ts`);
	check("the resume launch names the prior run and its journal size, and states the rule in the words the result's [resume] line uses", resumeLaunch.includes(`Resuming ${runId}: 2 journalled result(s). ${WORKFLOW_RESUME_RULE}`), resumeLaunch);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 8000);
	check("no child ran: the journal answered every call", seat.events.filter((e) => e.channel === "subagents:created" && e.type === "worker").length === spawnsBefore);
	const resumed = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1];
	check("a resumed run prints N cached above the same return value", resumed?.result?.startsWith(`[resumed from ${runId} \u2014 2 cached]\n{`) && resumed.result.includes("5 pears"), resumed?.result);
	check("the resumed run got its own name: latest wins, the first stays by task id", resumed?.name === "count-things-1");
	check("progress marked both as cached", seat.progress.filter((p) => p.type === "agent-cached").length === 2);
	seat.session.dispose();
}

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
	check("agent() returned the validated object, not the child's text", runDone?.result === '{\n  "file": "a.ts",\n  "fixed": true\n}\n\n[agents: 1 run]', runDone?.result);
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
	check("StructuredOutput outside a workflow child is refused", refusals[5]?.err && refusals[5].text === "StructuredOutput is only for a workflow child with a schema in its prompt. Reply in plain text instead.", refusals[5]?.text);

	// Ticket 54 §1: a child has hands, not judgement — it may not start a workflow.
	scriptFor("run the nesting workflow", [[call("Workflow", { script: `${META}return agent('Do the one item.', { label: 'nester' })` })], [text("started")]]);
	scriptFor("Do the one item.", [[call("Workflow", { script: META })], [text("did the item myself")]]);
	await seat.session.prompt("run the nesting workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "nester"), 8000);
	await quiet(seat);
	const nested = requests.filter((r) => lastUserText({ messages: r.messages }).includes("Do the one item.")).flatMap((r) => r.messages.filter((m) => m.role === "toolResult")).find((m) => JSON.stringify(m.content).includes("may not start a workflow"));
	check("a workflow child calling Workflow is refused, and told what to do instead", nested?.isError === true && nested.content[0].text === "A workflow child may not start a workflow. Do the item you were given; start explorers to read for you; if the item is too big, say so in your return value.", JSON.stringify(nested?.content));
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

// D: stall detection — no tokens, no tool call and no turn end for stallMs, with no tool running, is a stall (ticket 54 §4)
{
	console.log("\nWorkflow: stall detection");
	const seat = await mainSeat();
	scriptFor("run the dozing workflow", [[call("Workflow", { script: `${META}return { got: await agent('Doze off.', { label: 'dozer', stallMs: 1000 }) }` })], [text("started")]]);
	scriptFor("Doze off.", [{ delay: 20000, content: [text("eventually")] }, { delay: 20000, content: [text("eventually")] }, { delay: 20000, content: [text("eventually")] }]);
	await seat.session.prompt("run the dozing workflow");
	await seat.session.waitForIdle();
	const landed = await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.type === "workflow"), 15000);
	await quiet(seat);
	const dozed = seat.events.find((e) => e.channel === "subagents:completed" && e.type === "workflow");
	const dozers = seat.events.filter((e) => e.channel === "subagents:failed" && e.name.startsWith("dozer") && e.status === "stopped").map((e) => e.name);
	check("a child that stalls on every attempt is started fresh three times in all, then its slot is null", landed && dozed?.result?.startsWith('{\n  "got": null\n}') && dozers.join() === "dozer,dozer-1,dozer-2", `${dozed?.result} · ${dozers.join()}`);
	check("the failure reads as a stall on all three attempts, in seconds", seat.progress.some((p) => p.type === "agent-failed" && p.reason === "stalled on all 3 attempts (no progress for 1s each)"), seat.progress.filter((p) => p.type === "agent-failed").map((p) => p.reason).join());
	const retryLogs = seat.progress.filter((p) => p.type === "log" && p.message.startsWith("dozer stalled"));
	check("each fresh start is written to the run log", retryLogs.map((p) => p.message).join(" | ") === "dozer stalled (no progress for 1s); starting it again fresh, attempt 2 of 3 | dozer stalled (no progress for 1s); starting it again fresh, attempt 3 of 3", retryLogs.map((p) => p.message).join(" | "));

	// A hung stream is what a stall means, and a fresh attempt is the remedy.
	scriptFor("run the napping workflow", [[call("Workflow", { script: `${META}return agent('Nap once.', { label: 'napper', stallMs: 800 })` })], [text("started")]]);
	scriptFor("Nap once.", [{ delay: 20000, content: [text("too late")] }, [text("awake now")]]);
	await seat.session.prompt("run the napping workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 15000);
	await quiet(seat);
	const napped = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1];
	check("a child that stalls once and answers on its second attempt returns that answer", napped?.result?.split("\n")[0] === "awake now" && !seat.progress.some((p) => p.type === "agent-failed" && p.reason.includes("napper")), `${napped?.result ?? napped?.error}`);

	// A tool that runs silent past stallMs — a test suite, a build — is work, not a stall.
	scriptFor("run the slow-tool workflow", [[call("Workflow", { script: `${META}return agent('Run the slow tool.', { label: 'builder', stallMs: 600 })` })], [text("started")]]);
	scriptFor("Run the slow tool.", [[call("bash", { command: "sleep 1.5; echo built" })], [text("build finished")]]);
	await seat.session.prompt("run the slow-tool workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 3, 15000);
	await quiet(seat);
	const built = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[2];
	const builderTool = requests.filter((r) => lastUserText({ messages: r.messages }).includes("Run the slow tool.")).flatMap((r) => r.messages.filter((m) => m.role === "toolResult")).find((m) => m.toolName === "bash");
	check("a child whose one tool call runs silent for longer than stallMs is left alone", builderTool !== undefined && JSON.stringify(builderTool.content).includes("built") && built?.result?.split("\n")[0] === "build finished" && !seat.events.some((e) => e.name?.startsWith("builder") && e.status === "stopped"), `${built?.result ?? built?.error} · ${JSON.stringify(builderTool?.content)} · ${seat.events.filter((e) => e.name?.startsWith("builder")).map((e) => `${e.name}:${e.channel}:${e.status}`).join()}`);

	// A child that keeps ticking outlives stallMs many times over: the gap is what counts.
	scriptFor("run the ticking workflow", [[call("Workflow", { script: `${META}return agent('Keep working.', { label: 'ticker', stallMs: 600 })` })], [text("started")]]);
	scriptFor("Keep working.", [
		{ delay: 200, content: [call("ListAgents", {})] },
		{ delay: 200, content: [call("ListAgents", {})] },
		{ delay: 200, content: [call("ListAgents", {})] },
		{ delay: 200, content: [call("ListAgents", {})] },
		{ delay: 200, content: [text("kept working")] },
	]);
	await seat.session.prompt("run the ticking workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 4, 15000);
	await quiet(seat);
	const ticked = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[3];
	check("a child that keeps ticking past stallMs in total, never gapping it, is left alone", ticked?.result?.split("\n")[0] === "kept working" && !seat.events.some((e) => e.name === "ticker" && e.status === "stopped"), `${ticked?.result ?? ticked?.error} · ${seat.events.filter((e) => e.name === "ticker").map((e) => `${e.channel}:${e.status}`).join()}`);

	// Streamed tokens are progress: a long thinking turn emits nothing but message_update.
	scriptFor("run the streaming workflow", [[call("Workflow", { script: `${META}return agent('Think out loud.', { label: 'streamer', stallMs: 600 })` })], [text("started")]]);
	scriptFor("Think out loud.", [{ chunks: ["thinking", " and", " thinking", " and", " done"], gapMs: 200 }]);
	await seat.session.prompt("run the streaming workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 5, 15000);
	await quiet(seat);
	const streamed = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[4];
	check("a child that only streams past stallMs — no tool call, no turn end — is left alone", streamed?.result?.split("\n")[0] === "thinking and thinking and done" && !seat.events.some((e) => e.name === "streamer" && e.status === "stopped"), `${streamed?.result ?? streamed?.error} · ${seat.events.filter((e) => e.name === "streamer").map((e) => `${e.channel}:${e.status}`).join()}`);

	// The stagger keys on turn_end alone: a streaming leader has not written its prefix yet.
	scriptFor("run the two-streamer workflow", [[call("Workflow", { script: `${META}return parallel([() => agent('Stream first.', { label: 'leader', prefixStaggerMs: 4000 }), () => agent('Stream second.', { label: 'sibling', prefixStaggerMs: 4000 })])` })], [text("started")]]);
	scriptFor("Stream first.", [{ chunks: ["a", "b", "c", "d"], gapMs: 200 }]);
	scriptFor("Stream second.", [[text("second done")]]);
	await seat.session.prompt("run the two-streamer workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:created" && e.name === "leader"), 5000);
	const leaderAt = Date.now();
	const sibling = await until(() => seat.events.some((e) => e.channel === "subagents:created" && e.name === "sibling"), 8000);
	const waited = Date.now() - leaderAt;
	check("a streamed delta is not the leader's first turn: the same-key sibling waits for turn_end", sibling && waited >= 500 && waited < 3500, `${waited}ms`);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 6, 15000);
	await quiet(seat);

	// A fresh attempt starts in the world as it is then: a sibling that finished during the stall is in its journal `after`.
	scriptFor("run the late-start workflow", [[call("Workflow", { script: `${META}return parallel([() => agent('Stall once, then answer.', { label: 'late', stallMs: 800, prefixStaggerMs: 1 }), () => agent('Answer at once.', { label: 'early', prefixStaggerMs: 1 })])` })], [text("started")]]);
	scriptFor("Stall once, then answer.", [{ delay: 20000, content: [text("too late")] }, [text("late answer")]]);
	scriptFor("Answer at once.", [[text("early answer")]]);
	await seat.session.prompt("run the late-start workflow");
	await seat.session.waitForIdle();
	const lateScript = /Script: (\S+)/.exec(seat.toolResults().at(-1)?.content[0].text ?? "")?.[1] ?? "";
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 7, 15000);
	await quiet(seat);
	const lateJournal = fs.readFileSync(path.join(path.dirname(lateScript), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("a restarted child's journal `after` counts the sibling that finished during its stall", lateJournal.map((l) => `${l.label}:${l.after}`).join() === "early:0,late:1", lateJournal.map((l) => `${l.label}:${l.after}`).join());
	seat.session.dispose();
}

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
	seat.session.dispose();

	const { headWorkflowResult } = await jiti.import(`${ROOT}/extensions/workflow.ts`);
	const unwritten = headWorkflowResult({ blob }, JSON.stringify({ blob }), { path: "/nowhere/result.json", writeError: "ENOSPC: no space left on device" }).split("\n");
	check("a failed disk write is named on the first line, never a file that is not there", unwritten[0] === "[workflow result: 1000011 chars; the whole value could not be written to /nowhere/result.json: ENOSPC: no space left on device]", unwritten[0]);
	check("and no jq is offered for a file nobody wrote", !unwritten.some((line) => line.startsWith("Read the rest with jq")), unwritten.join(" | "));
	const listed = headWorkflowResult([{ file: "a.ts" }], `[\n${" ".repeat(9000)}\n]`, { path: "/tmp/result.json" }).split("\n");
	check("an array says its length, the shape of its first element, and jq's index filter", listed[1] === "Shape: array of 1" && listed[2] === "  [0] \u2014 object with 1 keys" && listed[3] === "Read the rest with jq, e.g. jq '.[0]' /tmp/result.json", listed.slice(1, 4).join(" · "));
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
	check("then one line per failure, in the order they happened", after[2] === "[failures: 3]" && after.length >= 6, after.join(" | "));
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

	const { workflowRunReport, WORKFLOW_RESULT_FAILURES_SHOWN, WORKFLOW_FAILURE_REASON_MAX_CHARS } = await jiti.import(`${ROOT}/extensions/workflow.ts`);
	const { WorkflowRunStore } = await jiti.import(`${ROOT}/lib/workflow-runs.ts`);
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
	const { WORKFLOW_PARAMS, WORKFLOW_RESUME_RULE } = await jiti.import(`${ROOT}/lib/workflow-tool-text.ts`);
	const resumeLine = report.find((l) => l.startsWith("[resume]")) ?? "";
	check("the resume line states the journal's rule in the words the resumeFromRunId parameter uses", typeof WORKFLOW_RESUME_RULE === "string" && resumeLine.includes(WORKFLOW_RESUME_RULE) && WORKFLOW_PARAMS.resumeFromRunId.includes(WORKFLOW_RESUME_RULE) && !resumeLine.includes("runs the others again"), resumeLine);
	check("a reason as long as a provider's response body is cut", failureLines[0].length < WORKFLOW_FAILURE_REASON_MAX_CHARS + 40 && failureLines[0].endsWith("…"), String(failureLines[0].length));

	store.start({ runId: "wf_dropped", taskId: "a2", name: "dropped", description: "", startedAt: 0 });
	store.apply("wf_dropped", { type: "rejection-unhandled", reason: "dropped" });
	const droppedReport = workflowRunReport(store.get("wf_dropped"), { ...where, runId: "wf_dropped" }, "completed");
	check("a promise the script left rejected is a failure line of its own, and a log line", droppedReport[0] === "[failures: 1]" && droppedReport[1] === "- a promise the script never handled rejected: dropped" && store.get("wf_dropped")?.logs.at(-1) === "unhandled rejection: dropped", `${droppedReport.join(" | ")} · ${store.get("wf_dropped")?.logs.join()}`);
}

// I: a child whose spawn or nudge is still in flight when the run ends is stopped as it lands
{
	console.log("\nWorkflow: a child that lands after its run ended");
	const { descendantStoppers } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const seat = await mainSeat();
	const settledAs = (name) => seat.events.filter((e) => e.name === name && (e.channel === "subagents:completed" || e.channel === "subagents:failed")).map((e) => e.status);
	// The stop lands inside the engine's spawn, between the record going up and the child's session starting,
	// and the session takes 500 ms to start: the run has ended long before the child lands.
	globalThis.__workflowTestSpawnDelayMs = 500;
	let runTaskId;
	onLifecycle.at = (event) => {
		if (event.channel === "subagents:created" && event.type === "workflow") runTaskId = event.id;
		if (event.channel === "subagents:created" && event.name === "orphan") void descendantStoppers().get(runTaskId)?.();
	};
	scriptFor("run the orphan workflow", [[call("Workflow", { script: `${META}return agent('Outlive the run.', { label: 'orphan' })` })], [text("started")]]);
	scriptFor("Outlive the run.", [{ delay: 3000, content: [text("outlived it")] }]);
	await seat.session.prompt("run the orphan workflow");
	await seat.session.waitForIdle();
	await until(() => settledAs("orphan").length > 0, 6000);
	await quiet(seat);
	check("a child whose spawn was in flight when the run was stopped is stopped once it lands, not left to run", settledAs("orphan").join() === "stopped" && seat.events.some((e) => e.channel === "subagents:failed" && e.type === "workflow" && e.status === "stopped"), `${settledAs("orphan").join()} · ${seat.events.filter((e) => e.type === "workflow").map((e) => `${e.channel}:${e.status}`).join()}`);

	// The same for the nudge: the run is stopped while the engine resumes a schema child.
	onLifecycle.at = (event) => {
		if (event.channel === "subagents:created" && event.type === "workflow") runTaskId = event.id;
		if (event.channel === "subagents:resumed" && event.name === "forgetter") void descendantStoppers().get(runTaskId)?.();
	};
	scriptFor("run the forgetful workflow", [[call("Workflow", { script: `${META}return agent('Forget the call.', { label: 'forgetter', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } })` })], [text("started")]]);
	scriptFor("Forget the call.", [[text("no call from me")]]);
	scriptFor("You ended without calling StructuredOutput", [{ delay: 3000, content: [call("StructuredOutput", { result: { n: 1 } })] }, [text("done")]]);
	await seat.session.prompt("run the forgetful workflow");
	await seat.session.waitForIdle();
	await until(() => settledAs("forgetter").length > 1, 6000);
	await quiet(seat);
	check("a child whose nudge was in flight when the run was stopped is stopped once it resumes, not left to run", settledAs("forgetter").join() === "completed,stopped", settledAs("forgetter").join());
	onLifecycle.at = undefined;
	globalThis.__workflowTestSpawnDelayMs = 0;
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
	const { agentRuntimeOf } = await jiti.import(`${ROOT}/lib/agent-runtime-seam.ts`);
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
	const { agentRuntimeOf } = await jiti.import(`${ROOT}/lib/agent-runtime-seam.ts`);
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

// P: a restart after a stall comes after a child ran, so the engine refusing it is that child's death, never a refused spawn
{
	console.log("\nWorkflow: a restart the engine refuses");
	const { agentRuntimeOf } = await jiti.import(`${ROOT}/lib/agent-runtime-seam.ts`);
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

fs.rmSync(AGENT_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
