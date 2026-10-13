/**
 * The workflow runtime over a fake spawner that answers at once, offline: the
 * scheduler (pipeline without a barrier, parallel as a barrier, the
 * semaphore), the caps that throw, the failure table, the banned globals, the
 * journal replay and a stop, held down without a model in the loop.
 */

import { check, checkThrows, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { loadPerCore, sleep, until } from "../support/async-waits.mjs";
import { inChild } from "../support/workflow-child-run.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// `true`, or the message: compare with `=== true`, because a missed throw's message is truthy.
const throwsWith = async (fn, fragment) => {
	try { await fn(); return `no throw`; }
	catch (error) { const m = error instanceof Error ? error.message : String(error); return m.includes(fragment) ? true : m; }
};

// ---------------------------------------------------------------------------
// 3. the runtime over a fake spawner: scheduler, caps, failure table, bans, resume
// ---------------------------------------------------------------------------
{
	const { runWorkflow, WORKFLOW_CAPS, WorkflowRunError } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-runtime.ts`);
	const { WorkflowJournal, readWorkflowJournal } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-journal.ts`);
	console.log("\nruntime");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-runtime-"));
	let journalN = 0;
	const waitUntil = async (condition, ms = 2000) => {
		if (!(await until(condition, ms, 1))) throw new Error("waitUntil: timed out");
	};
	/** A gated run that never settles fails the check instead of hanging the suite. */
	const within = (promise, ms = 2000) => Promise.race([promise, sleep(ms * loadPerCore()).then(() => { throw new Error(`no settle within ${ms} ms`); })]);

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

	check("the caps are the ruled numbers", WORKFLOW_CAPS.itemsPerCall === 4096 && WORKFLOW_CAPS.lifetimeAgents === 1000 && WORKFLOW_CAPS.concurrency === 16, JSON.stringify(WORKFLOW_CAPS));

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
		// b's stage 1 holds until a's stage 2 has answered, bounded, so a barrier shows as order however slow the machine.
		let aReachedStage2;
		const aAtStage2 = new Promise((resolve) => (aReachedStage2 = resolve));
		const spawner = fakeSpawner(async (r) => {
			if (r.prompt === "s1:b") await Promise.race([aAtStage2, sleep(5000 * loadPerCore())]);
			order.push(r.prompt);
			if (r.prompt.startsWith("s2:S1:A")) aReachedStage2();
			return r.prompt.toUpperCase();
		});
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
		await checkThrows("> 4096 items in one parallel() call throws", () => run(`${META}return parallel(Array.from({length: 4097}, () => () => agent('x')))`), "too many items (4097); cap is 4096");
		await checkThrows("> 4096 items in one pipeline() call throws", () => run(`${META}return pipeline(Array.from({length: 4097}, (_, i) => i), (n) => agent('x' + n))`), "too many items (4097); cap is 4096");
		check("exactly 4096 items is allowed", (await run(`${META}return (await parallel(Array.from({length: 4096}, (_, i) => () => agent('x' + i)))).length`, { caps: { lifetimeAgents: 5000 } })).value === 4096);
		await checkThrows("the lifetime agent cap throws, even inside a pipeline stage", () => run(`${META}return pipeline([1,2,3,4,5,6], (n) => agent('a' + n))`, { caps: { lifetimeAgents: 5 } }), "workflow exceeded 5 total agents");
		await checkThrows("the real lifetime cap is 1000: the 1001st agent() throws", () => run(`${META}for (let i = 0; i < 1001; i++) await agent('n' + i); return 'done'`), "workflow exceeded 1000 total agents");
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

	// An option agent() does not know throws, instead of running a default worker
	// (Joel's defect 5). Claude Code's names for type and thinking get pi's named.
	{
		const spawner = fakeSpawner(() => "ok");
		await checkThrows("agent({agentType}) throws, naming pi's key", () => run(`${META}return agent('x', { agentType: 'explore' })`, { spawner }), "unknown agent() option agentType: pi calls it type");
		await checkThrows("agent({effort}) throws, naming pi's key", () => run(`${META}return agent('x', { effort: 'low' })`, { spawner }), "unknown agent() option effort: pi calls it thinking");
		await checkThrows("any other unknown option throws, listing the known ones", () => run(`${META}return agent('x', { labl: 'a' })`, { spawner }), "unknown agent() option labl: the options are schema, reply, model, thinking, type, isolation, label, phase, stallMs, prefixStaggerMs, prefixWarmMs, cwd");
		check("and no child ran for any of them", spawner.calls.length === 0, String(spawner.calls.length));
		await checkThrows("agent({cwd}) must be absolute", () => run(`${META}return agent('x', { cwd: 'rel/dir' })`, { spawner }), "agent() option cwd must be an absolute path");
		const placed = fakeSpawner(() => "ok");
		await run(`${META}return agent('x', { cwd: '/tmp' })`, { spawner: placed });
		check("an absolute cwd reaches the spawner", placed.calls[0]?.options.cwd === "/tmp", JSON.stringify(placed.calls[0]?.options));
	}

	// Medium to xhigh exist. Anything else is refused where the option is parsed, not
	// clamped somewhere downstream.
	{
		for (const level of ["off", "minimal", "low", "max", "enormous"]) {
			await checkThrows(`agent({thinking: '${level}'}) throws, naming the legal values`, () => run(`${META}return agent('x', { thinking: '${level}' })`), `agent() option thinking must be one of "medium", "high", "xhigh", got '${level}'`);
		}
		const omitted = fakeSpawner(() => "ok");
		await run(`${META}return agent('x')`, { spawner: omitted });
		check("agent() without thinking leaves the level to the type: a worker runs at medium", omitted.calls[0] !== undefined && omitted.calls[0].options.thinking === undefined, JSON.stringify(omitted.calls[0]?.options));
		for (const level of ["medium", "high", "xhigh"]) {
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
		const counted = await run(`${META}const reads = {}; const options = new Proxy({ schema: { type: 'object' }, model: 'm', thinking: 'high', type: 'worker', isolation: 'worktree', label: 'l', phase: 'p', stallMs: 1, prefixStaggerMs: 1, prefixWarmMs: 1, cwd: '/tmp' }, { get(target, key) { reads[key] = (reads[key] ?? 0) + 1; return target[key] } }); await agent('x', options); return reads`, { spawner: fakeSpawner(() => ({})) });
		const readTwice = Object.entries(counted.value).filter(([, n]) => n > 1).map(([key]) => key);
		check("every option is read exactly once", Object.keys(counted.value).length === 12 && readTwice.length === 0, JSON.stringify(counted.value));
		const replied = fakeSpawner(() => ({}));
		await run(`${META}return agent('x', { reply: 'R5' })`, { spawner: replied });
		check("agent({reply: 'R5'}) is the R5 schema", replied.calls[0]?.options.schema?.required?.join() === "file,summary,decide", JSON.stringify(replied.calls[0]?.options));
		const stalling = fakeSpawner(() => "ok");
		await run(`${META}return agent('x', { stallMs: 1000 })`, { spawner: stalling });
		check("agent({stallMs}) reaches the spawner; a non-positive one is an author error", stalling.calls[0]?.options.stallMs === 1000 && (await throwsWith(() => run(`${META}return agent('x', { stallMs: 0 })`, { spawner: stalling }), "stallMs must be a positive number of milliseconds")) === true, JSON.stringify(stalling.calls[0]?.options));
		const staggered = fakeSpawner(() => "ok");
		await run(`${META}return agent('x', { prefixStaggerMs: 10, prefixWarmMs: 20 })`, { spawner: staggered, caps: { concurrency: 4 } });
		check("the prefix durations reach the spawner, with the run's concurrency for it to skip on", staggered.calls[0]?.options.prefixStaggerMs === 10 && staggered.calls[0]?.options.prefixWarmMs === 20 && staggered.calls[0]?.concurrency === 4, `${JSON.stringify(staggered.calls[0]?.options)} \u00b7 ${staggered.calls[0]?.concurrency}`);
		await checkThrows("a non-positive prefix duration is an author error", () => run(`${META}return agent('x', { prefixWarmMs: -1 })`, { spawner: staggered }), "prefixWarmMs must be a positive number of milliseconds");

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
		await checkThrows("an unknown agent type is an author error: it throws", () => run(`${META}return agent('x', { type: 'nope' })`, { spawner: refusing }), 'Unknown subagent_type "nope"');
		const refusalMark = events.length;
		const refusedJournal = path.join(dir, `j${journalN}.jsonl`);
		const typo = fakeSpawner((r) => { if (r.options.type === "nope") throw new Error('Unknown subagent_type "nope"'); return "fine"; });
		const refusedOut = await run(`${META}let caught; try { await agent('typo', { type: 'nope' }) } catch (e) { caught = e.message } return { caught, after: await agent('next') }`, { spawner: typo });
		const refusedEvents = events.slice(refusalMark).filter((e) => e.ordinal === 1).map((e) => `${e.type}:${e.reason ?? ""}`);
		check("a refused spawn settles its agent as failed with the engine's words, so no row stays running", refusedOut.value.caught === 'Unknown subagent_type "nope"' && refusedEvents.join() === 'agent-start:,agent-failed:Unknown subagent_type "nope"', `${JSON.stringify(refusedOut.value)} · ${refusedEvents.join()}`);
		const refusedLines = fs.readFileSync(refusedJournal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("and journals nothing: no child ran, so a resume holds nothing back on its account", refusedLines.length === 1 && refusedLines[0].result === "fine" && refusedLines[0].after === 0, JSON.stringify(refusedLines));
		await checkThrows("a script that throws rejects with its message", () => run(`${META}throw new Error('author bug')`), "author bug");
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
		for (const [expression, fragment] of cases) {
			const verdict = await banned(expression, fragment);
			check(`${expression} throws`, verdict === true, String(verdict));
		}
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
		const { WORKFLOW_SCRIPT_TIMEOUT_MS, IMPORT_REFUSED } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-sandbox.ts`);
		check("the production cap on the synchronous start is 30 s", WORKFLOW_SCRIPT_TIMEOUT_MS === 30_000, String(WORKFLOW_SCRIPT_TIMEOUT_MS));
		await checkThrows("an endless loop in the synchronous start ends the run with the vm's own timeout message", () => run(`${META}while (true) {}`, { scriptTimeoutMs: 200 }), "timed out");

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

		await checkThrows("import() is refused before the script runs: it would reject with a host error", () => run(`${META}return import('node:fs')`), IMPORT_REFUSED);
		await checkThrows("import() is refused however it is spaced", () => run(`${META}return import /* c */ ('node:fs')`), IMPORT_REFUSED);
		const words = await run(`${META}// import('node:fs') in a comment\nreturn ['import("x")', \`import \${'y'}\`, /import\\(/.source, { imports: 1, important: 2 }.important]`);
		check("the word import in a string, template, comment, regex or a longer identifier runs", JSON.stringify(words.value) === JSON.stringify(['import("x")', "import y", "import\\(", 2]), JSON.stringify(words.value));
		await checkThrows("a property named import is refused too: the declared false positive", () => run(`${META}return ({ import: 1 }).import`), IMPORT_REFUSED);

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
		await checkThrows("setTimeout needs a function: a string is never compiled", () => run(`${META}setTimeout('1', 1)`), "setTimeout() needs a function");
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
		// Finished c, a, b by hand: timers 15ms apart reorder on a loaded machine.
		const first = gatedSpawner();
		const firstRun = run(items, { spawner: first, caps: { concurrency: 3 } });
		for (const prompt of ["item c", "item a", "item b"]) await first.finish(prompt);
		await firstRun;
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
		await checkThrows("a stopped run's later agent() calls throw rather than spawn", () => run(`${META}return agent('x')`, { signal: controller.signal }), "workflow stopped");
	}

	check("WorkflowRunError is exported for the extension to classify", typeof WorkflowRunError === "function");
	fs.rmSync(dir, { recursive: true, force: true });
}

await finish();
