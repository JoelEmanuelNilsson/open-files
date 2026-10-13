/**
 * The workflow prefix stagger, offline: one leader per prompt prefix, then
 * the key is warm.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { loadPerCore, sleep } from "../support/async-waits.mjs";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
// 3b. the prefix stagger: one leader per prompt prefix, then warm
// ---------------------------------------------------------------------------
{
	const { WORKFLOW_PREFIX_STAGGER_MS, WORKFLOW_PREFIX_WARM_MS, WorkflowPrefixStagger, workflowPrefixKey } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-prefix-stagger.ts`);
	console.log("\nprefix stagger");
	const signal = new AbortController().signal;
	const wide = { concurrency: 8, staggerMs: 400, warmMs: 60_000 };
	// Settled before the next macrotask: "at once" as a fact rather than a wall-clock guess a loaded machine can miss.
	const atOnce = (promise) => Promise.race([promise.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
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
		check("the key is warm after it: the next same-key child spawns at once", await atOnce(stagger.take("k", wide, signal)));
	}

	{
		const stagger = new WorkflowPrefixStagger();
		await stagger.take("k", wide, signal);
		const start = Date.now();
		await Promise.all([stagger.take("k", wide, signal), stagger.take("k", wide, signal)]);
		const waited = Date.now() - start;
		check("with no first turn the waiters spawn at the cap \u2014 late, never never", waited >= wide.staggerMs - 30 && waited < wide.staggerMs * 4 * loadPerCore(), `${waited}ms`);
	}

	{
		const stagger = new WorkflowPrefixStagger();
		await stagger.take(workflowPrefixKey({ type: "worker" }), wide, signal);
		check("a different key does not wait on another key's leader", await atOnce(stagger.take(workflowPrefixKey({ type: "explore" }), wide, signal)));
	}

	{
		const solo = new WorkflowPrefixStagger();
		const one = { ...wide, concurrency: 1 };
		await solo.take("k", one, signal);
		check("concurrency 1 skips the stagger: nothing overlaps, so nothing waits", (await atOnce(solo.take("k", one, signal))) && (await atOnce(solo.take("k", one, signal))));
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

await finish();
