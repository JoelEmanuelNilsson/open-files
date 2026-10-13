/**
 * What counts as progress to workflow stall detection, offline: ticks and
 * streamed tokens, a streaming leader that has not ended its first turn, and
 * a fresh attempt's journal `after` (ticket 54 §4). The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, mainSeat, quiet, scriptFor, text } from "../support/workflow-seat.mjs";
import { sleep, until } from "../support/async-waits.mjs";
import { importPi } from "../support/pi-package.mjs";
import fs from "node:fs";
import path from "node:path";

{
	console.log("\nWorkflow: stall detection, what counts as progress");
	const seat = await mainSeat();

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
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 1, 15000);
	await quiet(seat);
	const ticked = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[0];
	check("a child that keeps ticking past stallMs in total, never gapping it, is left alone", ticked?.result?.split("\n")[0] === "kept working" && !seat.events.some((e) => e.name === "ticker" && e.status === "stopped"), `${ticked?.result ?? ticked?.error} · ${seat.events.filter((e) => e.name === "ticker").map((e) => `${e.channel}:${e.status}`).join()}`);

	// Streamed tokens are progress: a long thinking turn emits nothing but message_update.
	scriptFor("run the streaming workflow", [[call("Workflow", { script: `${META}return agent('Think out loud.', { label: 'streamer', stallMs: 600 })` })], [text("started")]]);
	scriptFor("Think out loud.", [{ chunks: ["thinking", " and", " thinking", " and", " done"], gapMs: 200 }]);
	await seat.session.prompt("run the streaming workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 2, 15000);
	await quiet(seat);
	const streamed = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[1];
	check("a child that only streams past stallMs — no tool call, no turn end — is left alone", streamed?.result?.split("\n")[0] === "thinking and thinking and done" && !seat.events.some((e) => e.name === "streamer" && e.status === "stopped"), `${streamed?.result ?? streamed?.error} · ${seat.events.filter((e) => e.name === "streamer").map((e) => `${e.channel}:${e.status}`).join()}`);

	// The stagger keys on turn_end alone: a streaming leader has not written its prefix yet.
	// The cap is two minutes so a loaded machine's slow turn_end cannot be mistaken for it.
	scriptFor("run the two-streamer workflow", [[call("Workflow", { script: `${META}return parallel([() => agent('Stream first.', { label: 'leader', prefixStaggerMs: 120000 }), () => agent('Stream second.', { label: 'sibling', prefixStaggerMs: 120000 })])` })], [text("started")]]);
	scriptFor("Stream first.", [{ chunks: ["a", "b", "c", "d"], gapMs: 200 }]);
	scriptFor("Stream second.", [[text("second done")]]);
	await seat.session.prompt("run the two-streamer workflow");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:created" && e.name === "leader"), 5000);
	const leaderAt = Date.now();
	const sibling = await until(() => seat.events.some((e) => e.channel === "subagents:created" && e.name === "sibling"), 8000);
	const waited = Date.now() - leaderAt;
	check("a streamed delta is not the leader's first turn: the same-key sibling waits for turn_end", sibling && waited >= 500 && waited < 60_000, `${waited}ms`);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 3, 15000);
	await quiet(seat);

	// A fresh attempt starts in the world as it is then: a sibling that finished during the stall is in its journal `after`.
	scriptFor("run the late-start workflow", [[call("Workflow", { script: `${META}return parallel([() => agent('Stall once, then answer.', { label: 'late', stallMs: 800, prefixStaggerMs: 1 }), () => agent('Answer at once.', { label: 'early', prefixStaggerMs: 1 })])` })], [text("started")]]);
	scriptFor("Stall once, then answer.", [{ delay: 20000, content: [text("too late")] }, [text("late answer")]]);
	scriptFor("Answer at once.", [[text("early answer")]]);
	await seat.session.prompt("run the late-start workflow");
	await seat.session.waitForIdle();
	const lateScript = /Script: (\S+)/.exec(seat.toolResults().at(-1)?.content[0].text ?? "")?.[1] ?? "";
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 4, 15000);
	await quiet(seat);
	const lateJournal = fs.readFileSync(path.join(path.dirname(lateScript), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("a restarted child's journal `after` counts the sibling that finished during its stall", lateJournal.map((l) => `${l.label}:${l.after}`).join() === "early:0,late:1", lateJournal.map((l) => `${l.label}:${l.after}`).join());
	// Compaction streams nothing the watcher sees: pi's `compaction_start` stops the clock and `compaction_end` restarts it.
	const { AgentSession } = await importPi("dist/index.js");
	const sessions = [];
	const subscribe = AgentSession.prototype.subscribe;
	AgentSession.prototype.subscribe = function (listener) {
		sessions.push(this);
		return subscribe.call(this, listener);
	};
	scriptFor("run the compacting workflow", [[call("Workflow", { script: `${META}return agent('Compact, then answer.', { label: 'compactor', stallMs: 1000 })` })], [text("started")]]);
	scriptFor("Compact, then answer.", [{ delay: 2600, content: [text("compacted answer")] }]);
	await seat.session.prompt("run the compacting workflow");
	await seat.session.waitForIdle();
	const child = await until(() => sessions.some((s) => s !== seat.session && s.isStreaming), 5000).then(() => sessions.find((s) => s !== seat.session && s.isStreaming));
	child._emit({ type: "compaction_start", reason: "threshold" });
	await sleep(1900);
	child._emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow").length === 5, 15000);
	await quiet(seat);
	AgentSession.prototype.subscribe = subscribe;
	const compacted = seat.events.filter((e) => e.channel === "subagents:completed" && e.type === "workflow")[4];
	check("a child that compacts for longer than stallMs is left alone", compacted?.result?.split("\n")[0] === "compacted answer" && !seat.events.some((e) => e.name === "compactor" && e.status === "stopped"), `${compacted?.result ?? compacted?.error} · ${seat.events.filter((e) => e.name === "compactor").map((e) => `${e.channel}:${e.status}`).join()}`);
	seat.session.dispose();
}

await finish();
