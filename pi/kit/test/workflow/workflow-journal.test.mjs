/**
 * The workflow journal, offline: keyed on content, and served only into the
 * world the prior run started in.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
// 2. the journal: keyed on content, served only into the world it started in
// ---------------------------------------------------------------------------
{
	const { workflowCacheKey, WorkflowJournal, readWorkflowJournal } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-journal.ts`);
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

await finish();
