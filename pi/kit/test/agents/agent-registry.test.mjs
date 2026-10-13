/**
 * The agent registry and delivery rules, over stub runtimes: the registry's
 * latest-wins fold, the wait board, taking a result exactly once, who arrives
 * when, a detached runtime, a refused delivery, a workflow's child, the
 * runtime seam, and how long a delivery waited. No session runs here: a
 * scripted session would prove the wiring and hide the arithmetic.
 */

import { check, finish } from "../support/check-harness.mjs";
import { jiti, runtimeOver } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";

// ---------------------------------------------------------------------------
// The registry fold: latest wins, owner-scoped, lost runs
// ---------------------------------------------------------------------------
{
	const { readAgentRegistry, readAgentRuns, AgentRegistry, AGENT_RECORD_ENTRY, resetAgentNameCounters } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	resetAgentNameCounters();
	console.log("\nthe registry");
	const rec = (over) => ({ name: "w", taskId: "a1", ownerSessionId: "me", type: "worker", description: "d", status: "queued", depth: 1, sessionFile: undefined, sessionId: "c", cwd: "/", branch: undefined, model: "m", result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, ...over });
	const entry = (data) => ({ type: "custom", customType: AGENT_RECORD_ENTRY, data });
	const read = readAgentRegistry([entry(rec()), entry(rec({ status: "running" })), entry(rec({ status: "completed", result: "done" })), entry(rec({ name: "other", ownerSessionId: "someone-else", status: "completed" })), entry(rec({ name: "cut", taskId: "a2", status: "running" })), { type: "message" }, entry({ junk: true })], "me");
	check("latest entry per name wins", read.get("w")?.status === "completed" && read.get("w").result === "done");
	check("another session's records are not mine", !read.has("other"));
	check("a run the process ended under reads as lost", read.get("cut")?.status === "lost");
	check("junk is skipped, not half-read", read.size === 2);
	const reused = [entry(rec({ taskId: "old", status: "running" })), entry(rec({ taskId: "new", status: "running", startedAt: 2 })), entry(rec({ taskId: "new", status: "completed", result: "new done", startedAt: 2 })), entry(rec({ taskId: "old", status: "completed", result: "old done" }))];
	check("a name two runs share reads as the run started last, even when the older one wrote last", readAgentRegistry(reused, "me").get("w")?.result === "new done", readAgentRegistry(reused, "me").get("w")?.result);
	check("and both runs stay counted per task id", [...readAgentRuns(reused, "me").values()].map((run) => run.result).join() === "old done,new done");
	const levels = readAgentRegistry([entry(rec({ status: "completed", thinking: "xhigh" })), entry(rec({ name: "odd", taskId: "a3", status: "completed", thinking: "enormous" }))], "me");
	check("the persisted thinking level reads back, so a resume runs at it", levels.get("w")?.thinking === "xhigh", String(levels.get("w")?.thinking));
	check("a level that does not exist reads as none", levels.get("odd")?.thinking === undefined && levels.has("odd"));
	const persisted = [];
	const registry = new AgentRegistry((r) => persisted.push(r), read.values());
	check("nextName counts per type", registry.nextName("worker") === "worker-1" && registry.nextName("w") === "w-1" && registry.nextName("cut") === "cut-1");
	// The 2026-09-03 collision: one counter per registry gave two seats on
	// different branches of the tree the same `worker-1`.
	const sibling = new AgentRegistry(() => {});
	check("a second registry in the process never reissues a name", sibling.nextName("worker") === "worker-2" && registry.nextName("worker") === "worker-3", `${sibling.nextName}`);
	sibling.put(rec({ name: "worker-9", taskId: "a9x" }));
	check("a name the caller chose is never auto-issued afterwards", registry.nextName("worker") === "worker-10");
	check("names read back from a session file raise the counter too", new AgentRegistry(() => {}, [rec({ name: "lead-4", taskId: "b1" })]).nextName("lead") === "lead-5");
	registry.put(rec({ name: "w", taskId: "a9", status: "queued" }));
	check("reusing a name starts a new run under it; the old run stays by task id", registry.byName("w").taskId === "a9" && registry.byTaskId("a1")?.status === "completed" && persisted.length === 1);
	check("live() lists queued and running only", registry.live().map((r) => r.name).join() === "w");
}

// ---------------------------------------------------------------------------
// One name, one holder: memory equals reload after every write
// ---------------------------------------------------------------------------
{
	const { readAgentRegistry, AgentRegistry, AGENT_RECORD_ENTRY } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	console.log("\nthe one-name rule");
	const rec = (over) => ({ name: "dup", taskId: "A", ownerSessionId: "me", type: "worker", description: "d", status: "running", depth: 1, sessionFile: undefined, sessionId: "c", cwd: "/", branch: undefined, model: "m", result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, ...over });
	const persisted = [];
	const registry = new AgentRegistry((r) => persisted.push({ type: "custom", customType: AGENT_RECORD_ENTRY, data: r }));
	const steps = [
		["spawn A", rec({ taskId: "A", startedAt: 1 }), "A"],
		["spawn B", rec({ taskId: "B", startedAt: 2 }), "B"],
		["resume A, the newest start", rec({ taskId: "A", startedAt: 3 }), "A"],
		["B settles after the holder wrote", rec({ taskId: "B", startedAt: 2, status: "completed", result: "b" }), "A"],
		["a run started before both arrives last", rec({ taskId: "C", startedAt: 0 }), "A"],
		["A settles", rec({ taskId: "A", startedAt: 3, status: "completed", result: "a" }), "A"],
		["a run with the same start arrives later", rec({ taskId: "D", startedAt: 3 }), "D"],
	];
	for (const [label, record, holder] of steps) {
		registry.put(record);
		const reloaded = readAgentRegistry(persisted, "me").get("dup");
		check(`${label}: memory and reload both name ${holder}`, registry.byName("dup").taskId === holder && reloaded?.taskId === holder, `${registry.byName("dup").taskId} / ${reloaded?.taskId}`);
	}
}

// ---------------------------------------------------------------------------
{
	const { AgentWaitBoard } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-wait-board.ts`);
	const { interruptedWaitText } = await jiti.import(`${KIT_ROOT}/extensions/agent-engine/agent-tool-replies.ts`);
	console.log("\nthe wait board");
	const timers = [];
	const clock = { setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } };
	const board = new AgentWaitBoard(clock);
	check("a condition already true returns without a timer", (await board.wait(() => true, 1000)).kind === "settled" && timers.length === 0);
	let done = false;
	const waiting = board.wait(() => done, 1000);
	check("a pending wait arms one timer", timers.length === 1 && board.size === 1);
	board.notify();
	check("notify with the condition still false keeps waiting", board.size === 1);
	done = true;
	board.notify();
	check("notify with the condition true settles it and clears the timer", (await waiting).kind === "settled" && timers.length === 0 && board.size === 0);
	const timing = board.wait(() => false, 500);
	timers[0].fn();
	check("the clock running out is a timeout", (await timing).kind === "timeout");
	const typed = board.wait(() => false, 500);
	board.interrupt("Joel");
	const outcome = await typed;
	check("Joel typing interrupts every wait, agents untouched", outcome.kind === "interrupted" && outcome.by === "Joel" && timers.length === 0);
	const controller = new AbortController();
	const aborted = board.wait(() => false, 500, controller.signal);
	controller.abort();
	check("an aborted turn ends the wait too", (await aborted).kind === "interrupted");
	check("the ruled wording", interruptedWaitText("Joel", 1, 3) === "interrupted by Joel — 1 of 3 done");
}

// ---------------------------------------------------------------------------
// A result is marked read only where its text is handed back (C7)
//
// The 2026-09-03 shape was a result consumed by a path that never printed it:
// `TaskOutput` said nothing while `ListAgents` showed the completion. The
// registry no longer lets anyone set `readBy` — `update` keeps the value it
// found, and a take marks its batch only around a hand that takes the text,
// putting it back when the hand refuses or throws — so the only way to consume
// a result is to deliver it.
// ---------------------------------------------------------------------------
{
	console.log("\ntaking a result reads it exactly once");
	const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const done = { name: "pin", taskId: "a1", ownerSessionId: "seat", type: "worker", description: "d", status: "completed", depth: 1, sessionFile: undefined, sessionId: "c", cwd: "/", branch: undefined, model: "m", result: "The whole reply.", error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: 2, toolCallId: undefined, workflowChild: false };
	const runtime = await runtimeOver({ sessionId: "seat" }, [done]);
	const registry = runtime.registry;
	check("registry.update cannot flip readBy — the value survives the change", registry.update("pin", { readBy: "conversation", status: "completed" })?.readBy === undefined);
	let thrown;
	try {
		runtime.takeUnread(["pin"], () => {
			throw new Error("the reader blew up");
		}, "tool");
	} catch (error) {
		thrown = error;
	}
	check("a hand that throws leaves the result unread — nothing is lost", thrown?.message === "the reader blew up" && registry.byName("pin").readBy === undefined);
	let handed;
	const batch = runtime.takeUnread(undefined, (notification) => {
		handed = notification.content;
	}, "tool");
	check("takeUnread records which path read it, not merely that something did", handed.includes("<result>The whole reply.</result>") && batch.content === handed && registry.byName("pin").readBy === "tool" && typeof registry.byName("pin").readAt === "number");
	check("and a second take finds nothing", runtime.takeUnread(["pin"], () => check("never handed twice", false), "tool") === undefined);
	// `handed` is the weakest claim and the only one that may be upgraded: a
	// result given to pi's queue becomes `conversation` when — and only when — the
	// harness has seen the message in the session file.
	const two = { ...done, name: "pin2", taskId: "a2" };
	const reg2 = new AgentRegistry(() => {}, [two]);
	reg2.consume([two], "handed", 10, () => true);
	check("a handed result is not claimed to be in any conversation", reg2.byName("pin2").readBy === "handed");
	reg2.markHandedSeen("pin2", "a2", 20);
	check("and becomes `conversation` only on the upgrade", reg2.byName("pin2").readBy === "conversation" && reg2.byName("pin2").readAt === 20);
	reg2.consume([reg2.byName("pin2")], "handed", 30, () => true);
	check("never the other way round: the strongest claim made stands", reg2.byName("pin2").readBy === "conversation" && reg2.byName("pin2").readAt === 20);
	const three = { ...done, name: "pin3", taskId: "a3" };
	const reg3 = new AgentRegistry(() => {}, [three]);
	reg3.markHandedSeen("pin3", "a3", 40);
	check("seeing a message is no delivery: an unread result stays unread", reg3.byName("pin3").readBy === undefined);

	// The mark comes first, but only a taken hand writes it: a refusal leaves the file as it was.
	const written = [];
	const four = { ...done, name: "pin4", taskId: "a4" };
	const reg4 = new AgentRegistry((record) => written.push(record), [four]);
	let seenUnread;
	const refused = reg4.consume([four], "handed", 50, () => { seenUnread = reg4.byName("pin4").readBy; return false; });
	check("a refused hand writes nothing: no mark-then-restore pair", refused === false && written.length === 0 && reg4.byName("pin4").readBy === undefined, `${written.length} writes`);
	check("and the batch read as taken while the hand ran", seenUnread === "handed");
	reg4.consume([four], "tool", 60, () => true);
	check("a taken hand writes the mark once", written.length === 1 && written[0].readBy === "tool" && written[0].readAt === 60, JSON.stringify(written.map((r) => r.readBy)));
	// A hand that ends in a later, valid delivery of the same run: the refusal must not undo it.
	const five = { ...done, name: "pin5", taskId: "a5" };
	const reg5 = new AgentRegistry(() => {}, [five]);
	reg5.consume([five], "handed", 70, () => {
		reg5.put({ ...reg5.byName("pin5"), readBy: undefined, readAt: undefined });
		reg5.consume([reg5.byName("pin5")], "tool", 71, () => true);
		return false;
	});
	check("a refusal restores only a record still carrying its own mark", reg5.byName("pin5").readBy === "tool" && reg5.byName("pin5").readAt === 71, `${reg5.byName("pin5").readBy}@${reg5.byName("pin5").readAt}`);
	// A write during the hand persisted the mark; the restore must reach the file too.
	const restored = [];
	const six = { ...done, name: "pin6", taskId: "a6" };
	const reg6 = new AgentRegistry((record) => restored.push(record), [six]);
	reg6.consume([six], "handed", 80, () => { reg6.update("pin6", { toolUses: 9 }); return false; });
	check("a mark another write persisted is restored in the file as well", reg6.byName("pin6").readBy === undefined && reg6.byName("pin6").toolUses === 9 && restored.at(-1)?.readBy === undefined && restored.at(-1)?.toolUses === 9, JSON.stringify(restored.map((r) => `${r.readBy}:${r.toolUses}`)));
}

// ---------------------------------------------------------------------------
// Who arrives when (ticket 09, ruled 2026-09-04)
//
// Driven through `publishSettled` with a stub host, because the rule is about
// *which* settles reach the seat and in what grouping — a scripted session
// would only prove the same decision through four seconds of real timing.
// ---------------------------------------------------------------------------
{
	console.log("\nwho arrives when");
	const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const record = (name, type, over = {}) => ({ name, taskId: `t-${name}`, ownerSessionId: "seat", type, description: `${name} job`, status: "running", depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: "/", branch: undefined, model: "m", result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, workflowChild: false, ...over });
	const delivered = [];
	const runtime = await runtimeOver({ sessionId: "seat", types: [{ name: "explore", delivery: "batch" }], deliver: (notification) => delivered.push(notification) });
	const registry = runtime.registry;
	const settle = (name, type, result) => {
		registry.put(record(name, type, { status: "completed", result, completedAt: 2 }));
		runtime.publishSettled(registry.byName(name));
	};
	const explorers = ["e1", "e2", "e3", "e4"];
	for (const name of explorers) registry.put(record(name, "explore"));
	registry.put(record("w1", "worker"));
	settle("e1", "explore", "e1 found it.");
	settle("e2", "explore", "e2 found it.");
	check("an explorer holds while its siblings are still reading", delivered.length === 0, JSON.stringify(delivered.map((d) => d.details.name)));
	// A worker alongside them proves the batch is explorers-only: its result needs
	// a decision, so it must not queue behind reading material.
	settle("w1", "worker", "The worker's answer.");
	check("a worker delivers alone the moment it lands, live siblings or not", delivered.length === 1 && delivered[0].content.includes("<result>The worker's answer.</result>") && !delivered[0].content.includes("e1 found it."), delivered[0]?.content?.slice(0, 120));
	settle("e3", "explore", "e3 found it.");
	check("still nothing while the last explorer reads", delivered.length === 1);
	settle("e4", "explore", "e4 found it.");
	check("the last explorer to land brings all four, in one message", delivered.length === 2 && explorers.every((name) => delivered[1].content.includes(`<result>${name} found it.</result>`)) && delivered[1].content.startsWith("4 agents finished."), delivered[1]?.content?.slice(0, 120));
	check("one delivery carries the other three in its details, for the row", delivered[1]?.details.others?.length === 3, JSON.stringify(delivered[1]?.details.others?.map((d) => d.name)));
	// `handed`, not `conversation`: `deliver` gives the message to pi's queue and
	// gets nothing back, so this path may not claim the text has arrived anywhere.
	check("and every result was handed exactly once (C7)", registry.all().every((r) => r.readBy === "handed"), registry.all().filter((r) => r.readBy !== "handed").map((r) => `${r.name}:${r.readBy}`).join());
	check("the instruction rides both deliveries", delivered.every((d) => d.content.trimEnd().endsWith("Ending your turn silently is allowed and expected.")));
	// A run that died is a verdict like any other: it delivers once and is marked
	// read, so nothing downstream may hand it over a second time (issues/56).
	registry.put(record("dead", "worker", { status: "error", error: "it blew up", completedAt: 3 }));
	runtime.publishSettled(registry.byName("dead"));
	check("an errored run delivers its verdict once and is marked read, exactly like a completed one", delivered.length === 3 && delivered[2].content.includes("it blew up") && registry.byName("dead").readBy === "handed", `${delivered.length} · ${registry.byName("dead")?.readBy}`);
}

// ---------------------------------------------------------------------------
// The seat's session scope refuses a turn before its first user turn and at
// shutdown; the result must then wait, unread, for the next turn to carry it.
// ---------------------------------------------------------------------------
{
	console.log("\na delivery the seat refuses");
	const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const record = (name, over = {}) => ({ name, taskId: `t-${name}`, ownerSessionId: "seat", type: "worker", description: `${name} job`, status: "running", depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: "/", branch: undefined, model: "m", result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, workflowChild: false, ...over });
	let offered = 0;
	const runtime = await runtimeOver({ sessionId: "seat", deliver: () => { offered++; return false; } }, [record("r1")]);
	const registry = runtime.registry;
	runtime.publishSettled(registry.put({ ...registry.byName("r1"), status: "completed", result: "r1 done", completedAt: 2 }));
	check("it was offered once and stays unread", offered === 1 && registry.byName("r1").readBy === undefined, `${offered} · ${registry.byName("r1").readBy}`);
	const carried = runtime.takeForTurn(() => false, () => {});
	check("the next turn carries it and marks it read", carried?.content.includes("r1 done") === true && registry.byName("r1").readBy === "conversation");

	// An idle seat's `sendMessage` starts the turn at once, so pi's `agent_start`
	// handlers run inside `deliver`, before the batch is marked read.
	let handed = 0;
	const inner = await runtimeOver({ sessionId: "seat", deliver: () => { handed++; inner.offerUnread(); return true; } }, [record("r2")]);
	const reentrant = inner.registry;
	inner.publishSettled(reentrant.put({ ...reentrant.byName("r2"), status: "completed", result: "r2 done", completedAt: 2 }));
	check("a delivery that re-offers from inside itself hands the result once", handed === 1 && reentrant.byName("r2").readBy === "handed", `${handed} · ${reentrant.byName("r2").readBy}`);
}

// ---------------------------------------------------------------------------
// A workflow's child is the workflow's to read, never this seat's (ticket 23).
// `unread()` is the one list every delivery path is built from, so the rule
// belongs there rather than in each caller (38's finding 5).
// ---------------------------------------------------------------------------
{
	console.log("\na workflow's child is never this seat's to read");
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const runtime = await runtimeOver({ sessionId: "unread-seat" });
	const registry = runtime.registry;
	const record = (name, extra) => ({ name, taskId: `t-${name}`, ownerSessionId: "unread-seat", type: "worker", description: "a job", status: "completed", stoppedBy: undefined, depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: KIT_ROOT, branch: undefined, model: "scripted/scripted-1", result: "done", error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: 2, toolCallId: undefined, workflowChild: false, ...extra });
	registry.put(record("ordinary"));
	registry.put(record("workflow-child", { workflowChild: true }));
	check("the ordinary child is unread; the workflow's is not in the list at all", runtime.unread().map((r) => r.name).join() === "ordinary", runtime.unread().map((r) => r.name).join());
	check("and no delivery can take it: takeUnread hands over the same list", runtime.takeUnread(["workflow-child"], () => {}, "tool") === undefined);
}

// ---------------------------------------------------------------------------
// The seam's counterpart (38's finding 7): every published entry pins a
// runtime, its registry and every child session it held.
// ---------------------------------------------------------------------------
{
	console.log("\nthe runtime seam has a counterpart");
	const seam = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const runtime = { marker: "a runtime" };
	seam.publishAgentRuntime("seam-session", runtime);
	check("a published runtime is found by its session id", seam.agentRuntimeOf("seam-session") === runtime);
	seam.forgetAgentRuntime("seam-session");
	check("and the session's end drops it", seam.agentRuntimeOf("seam-session") === undefined);
}

// ---------------------------------------------------------------------------
// A seat has no present, so the reader's clock is stamped where the text is
// read (ticket 60).
//
// `deliver` hands pi's queue a frozen string and a followUp is appended at the
// end of the turn in flight: on 2026-09-05 an explorer's result waited 167
// seconds and its notification still printed `waited-ms 0`.
// ---------------------------------------------------------------------------
{
	console.log("\na delivery that waited says how long");
	const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	let clock = 1_000_000;
	const delivered = [];
	const runtime = await runtimeOver({ sessionId: "seat", deliver: (n) => delivered.push(n), now: () => clock });
	const registry = runtime.registry;
	const record = (name, over = {}) => ({ name, taskId: `t-${name}`, ownerSessionId: "seat", type: "explore", description: `${name} job`, status: "completed", depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: "/", branch: undefined, model: "m", result: `${name} found it.`, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: clock, toolCallId: undefined, workflowChild: false, ...over });
	registry.put(record("ccwf2"));
	runtime.publishSettled(registry.byName("ccwf2"));
	check("the queued text says when it was queued and claims nothing about when it is read", delivered[0]?.content.includes("<queued-at>") && !delivered[0].content.includes("<settled-ago>") && !delivered[0].content.includes("waited-ms"), delivered[0]?.content?.slice(0, 300));
	// The turn in flight runs for 167 seconds; only now does the text land.
	clock += 167_000;
	let turnMessage;
	runtime.takeForTurn(() => true, (n) => { turnMessage = n; });
	check("a delivery the harness has already seen is not repeated into the turn", turnMessage === undefined);
	check("the record is in the conversation only now that the harness has seen it", registry.byName("ccwf2").readBy === "conversation" && registry.byName("ccwf2").readAt === clock);
	// The seat's present, stamped where the text is read: subtract it from the
	// frozen `<queued-at>` above and the 167-second wait is arithmetic, not a guess.
	registry.put(record("prompt", { completedAt: clock }));
	let read;
	runtime.takeUnread(["prompt"], (n) => { read = n.content; }, "conversation");
	check("the turn that reads a result stamps the reader's clock", read?.includes(`<read-at>${new Date(clock).toISOString()}</read-at>`), read?.slice(0, 400));
	check("a queued delivery carries no reader's clock, because its text is frozen", !delivered[0].content.includes("<read-at>"), delivered[0]?.content?.slice(0, 300));
	check("nothing prints prose about lateness", !read.includes("late-delivery") && !delivered[0].content.includes("late-delivery"));
	// A tool result is rendered where it is returned, so there the relative number
	// is the honest one — no queue sits between it and the reader.
	registry.put(record("tooled", { completedAt: clock - 5_000 }));
	let returned;
	runtime.takeUnread(["tooled"], (n) => { returned = n.content; }, "tool");
	check("a result returned by a tool carries its age, not an absolute a seat cannot read", returned?.includes("<settled-ago>5s before you read this</settled-ago>") && !returned.includes("<queued-at>"), returned?.slice(0, 300));
}

await finish();
