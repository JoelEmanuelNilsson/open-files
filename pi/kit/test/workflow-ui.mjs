/**
 * The workflow UI (ticket 59): the run store the tree is folded into, the
 * grouped tasks list, and the two levels of the run view.
 *
 * Four of these are the ones worth having. **A run's children must not be rows
 * in the seat's list** — that was the flood, and the count in the bottom rule
 * was a lie for as long as it lasted — so the registry is driven with a run and
 * its children together. **The tree must survive the run's end**, because the
 * view is opened to watch a run finish, so the store is driven past the settle.
 * **An activity line is one line** with no result on it, so the formatter is
 * exercised on the shapes a tool call really takes. And **the boxes must hold
 * their right edge** whatever is inside them, so every rendered line is
 * measured.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const { visibleWidth } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/utils.js`);
const { readFileSync } = await import("node:fs");
const jiti = createJiti(import.meta.url, { interopDefault: true });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const activity = await jiti.import(`${ROOT}/lib/tool-activity-line.ts`);
const store = await jiti.import(`${ROOT}/lib/workflow-runs.ts`);
const registryModule = await jiti.import(`${ROOT}/extensions/agent-dock/agent-task-registry.ts`);
const listView = await jiti.import(`${ROOT}/extensions/agent-dock/background-tasks-view.ts`);
const runView = await jiti.import(`${ROOT}/extensions/agent-dock/workflow-run-view.ts`);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
};
const eq = (label, actual, expected) =>
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t, inverse: (t) => t, strikethrough: (t) => t };

// ---------------------------------------------------------------------------
console.log("workflow UI: one tool call, one line");
{
	const { toolActivityLine, ACTIVITY_LINE_MAX_CHARS, ACTIVITY_TAIL_LIMIT } = activity;
	eq("a shell call is its command", toolActivityLine("Bash", { command: "npm test" }), "Bash(npm test)");
	eq("a read is its path", toolActivityLine("Read", { path: "lib/wire.ts" }), "Read(lib/wire.ts)");
	eq("pi's own snake-cased path is the same argument", toolActivityLine("Edit", { file_path: "lib/wire.ts", oldText: "a" }), "Edit(lib/wire.ts)");
	eq("a search is its pattern", toolActivityLine("Grep", { pattern: "CONFIG_PATH", path: "src" }), "Grep(CONFIG_PATH)");
	eq("a call with no argument worth naming says the pairs", toolActivityLine("Sleep", { seconds: 300, unit: "s" }), "Sleep(seconds: 300, unit: \"s\")");
	eq("a call with no arguments at all is just its name", toolActivityLine("ListAgents", {}), "ListAgents()");
	eq("a newline never becomes a second row", toolActivityLine("Bash", { command: "a\n  b\nc" }), "Bash(a b c)");
	check("a heredoc cannot move into the registry whole", toolActivityLine("Bash", { command: "x".repeat(5_000) }).length <= ACTIVITY_LINE_MAX_CHARS);
	// The result is the thing this rendering does not have. A line that grew one
	// would be a receipt, and a receipt is two rows in a box that has four left.
	check("nothing about a result is representable here", toolActivityLine("Bash", { command: "npm test" }).split("\n").length === 1);
	eq("the tail is Claude Code's five", ACTIVITY_TAIL_LIMIT, 5);
}

// ---------------------------------------------------------------------------
console.log("\nworkflow UI: the run store");
{
	const { WorkflowRunStore, workflowRunPhases, SETTLED_RUN_GRACE_MS, RUN_LOG_LIMIT } = store;
	const runs = new WorkflowRunStore();
	runs.start({ runId: "wf_1", taskId: "run-1", name: "spec", description: "one agent per spec file", startedAt: 1_000 });
	eq("a run with no agents is still a run", runs.get("wf_1").agents.length, 0);
	runs.apply("wf_1", { type: "phase", title: "Scout" });
	runs.apply("wf_1", { type: "agent-start", ordinal: 1, label: "scout:a", phase: "Scout" });
	runs.apply("wf_1", { type: "agent-start", ordinal: 2, label: "scout:b", phase: "Scout" });
	runs.apply("wf_1", { type: "agent-start", ordinal: 3, label: "fix:a", phase: "Fix" });
	runs.noteSpawn("wf_1", 1, { taskId: "c1", prompt: "look at a" });
	runs.apply("wf_1", { type: "agent-done", ordinal: 1 });
	runs.apply("wf_1", { type: "agent-failed", ordinal: 3, reason: "patch did not apply" });

	// The join the whole view rests on: an ordinal is the run's key and a task
	// id is the engine's, and nothing before this connected them.
	eq("a spawned agent carries the engine's task id", runs.get("wf_1").agents[0].taskId, "c1");
	eq("and the prompt the script wrote, which nobody else keeps", runs.get("wf_1").agents[0].prompt, "look at a");
	eq("an agent nobody spawned has no task id to join on", runs.get("wf_1").agents[2].taskId, undefined);
	eq("a failure keeps its reason", runs.get("wf_1").agents[2].reason, "patch did not apply");

	const phases = workflowRunPhases(runs.get("wf_1"));
	eq("phases come out in the order they were first seen, numbered from one", phases.map((one) => [one.index, one.title]), [[1, "Scout"], [2, "Fix"]]);
	eq("each counts its own", phases.map((one) => `${one.done}/${one.total}`), ["1/2", "1/1"]);
	eq("a failed agent is finished, not running", phases[1].agents[0].state, "failed");

	const flat = new WorkflowRunStore();
	flat.start({ runId: "wf_2", taskId: "run-2", name: "sweep", description: "", startedAt: 0 });
	flat.apply("wf_2", { type: "agent-start", ordinal: 1, label: "a", phase: undefined });
	eq("a script that never calls phase() gets one group named after the run", workflowRunPhases(flat.get("wf_2")).map((one) => one.title), ["sweep"]);

	runs.apply("wf_1", { type: "log", message: "phase 2 dispatched" });
	runs.apply("wf_1", { type: "item-failed", index: 4, reason: "no schema" });
	eq("logs and dropped items share one tail", runs.get("wf_1").logs, ["phase 2 dispatched", "dropped: no schema"]);
	for (let at = 0; at < RUN_LOG_LIMIT + 10; at++) runs.apply("wf_1", { type: "log", message: `line ${at}` });
	eq("which is bounded", runs.get("wf_1").logs.length, RUN_LOG_LIMIT);

	// The whole of step 8: `live.delete(runId)` used to throw the tree away at
	// the instant the run ended, which is the instant a watcher is looking.
	runs.settle("wf_1", "completed", 9_000);
	eq("a settled run keeps its agents", runs.get("wf_1").agents.length, 3);
	eq("and says how it ended", [runs.get("wf_1").status, runs.get("wf_1").settledAt], ["completed", 9_000]);
	eq("an unknown run is not invented by an event", runs.get("wf_zzz"), undefined);
	runs.apply("wf_zzz", { type: "agent-start", ordinal: 1, label: "ghost", phase: undefined });
	eq("nor by any number of them", runs.get("wf_zzz"), undefined);
	eq("a run is reachable from its own dock row", runs.byTaskId("run-1").runId, "wf_1");

	const many = new WorkflowRunStore();
	for (let at = 0; at < 30; at++) {
		many.start({ runId: `r${at}`, taskId: `t${at}`, name: `run ${at}`, description: "", startedAt: at * 60_000 });
		many.settle(`r${at}`, "completed", at * 60_000);
	}
	check("old runs retire", many.list().length < 30, String(many.list().length));
	const graced = new WorkflowRunStore();
	for (let at = 0; at < 30; at++) {
		graced.start({ runId: `g${at}`, taskId: `u${at}`, name: `run ${at}`, description: "", startedAt: 0 });
		graced.settle(`g${at}`, "completed", 1_000);
	}
	eq("but never one that ended a moment ago", graced.list().length, 30);
	check("the grace is the dock's", SETTLED_RUN_GRACE_MS === 30_000);
}

// ---------------------------------------------------------------------------
console.log("\nworkflow UI: a run's children are the run's, not the seat's");
{
	const { AgentTaskRegistry, isWorkflowRunTask, SETTLED_WORKFLOW_CHILD_LIMIT } = registryModule;
	const registry = new AgentTaskRegistry();
	registry.applyLifecycleEvent("started", { id: "run-1", name: "spec", type: "workflow", runId: "wf_1", workflowChild: false }, 1_000);
	for (let at = 1; at <= 20; at++) registry.applyLifecycleEvent("started", { id: `c${at}`, name: `spec:${at}`, type: "worker", workflowChild: true }, 1_000);
	registry.applyLifecycleEvent("started", { id: "a1", name: "worker-1", type: "worker", description: "audit the loader" }, 1_000);

	eq("twenty-one rows become two", registry.list().map((task) => task.id), ["run-1", "a1"]);
	eq("and the count in the bottom rule is honest again", registry.liveCount(), 2);
	check("a child is still held, because the run's view is drawn from it", registry.get("c7") !== undefined);
	check("the run's row knows which run it is", isWorkflowRunTask(registry.get("run-1")));
	check("an ordinary agent's row is not a run", !isWorkflowRunTask(registry.get("a1")));
	check("a payload that says nothing about workflows is not a workflow child", registry.get("a1").workflowChild === false);

	// The tail is what a settled agent still has to show. It arrives one line per
	// progress event, on exactly the events a tool call forces.
	eq("an agent that has called nothing has an empty tail", registry.get("c1").activity, []);
	registry.applyProgressEvent({ id: "c1", toolUses: 1, activity: "Bash(npm test)" }, 2_000);
	registry.applyProgressEvent({ id: "c1", toolUses: 2, activity: "Read(a.ts)" }, 3_000);
	eq("each call lands once, in order", registry.get("c1").activity, ["Bash(npm test)", "Read(a.ts)"]);
	registry.applyProgressEvent({ id: "c1", toolUses: 3, lastActivityAt: 4_000 }, 4_000);
	eq("a progress event carrying no call adds no line", registry.get("c1").activity.length, 2);
	for (let at = 0; at < 10; at++) registry.applyProgressEvent({ id: "c1", toolUses: 4 + at, activity: `Bash(${at})` }, 5_000 + at);
	eq("the tail is a tail", registry.get("c1").activity, ["Bash(5)", "Bash(6)", "Bash(7)", "Bash(8)", "Bash(9)"]);
	registry.applyLifecycleEvent("completed", { id: "c1", workflowChild: true, result: "done" }, 9_000);
	eq("and it survives the agent it belongs to", registry.get("c1").activity.length, 5);

	// A run's rows retire on the run's scale, not the list's: a fan-out is bigger
	// than the twenty rows a human scrolls.
	check("a fan-out's rows are not evicted by their own siblings", SETTLED_WORKFLOW_CHILD_LIMIT > 20);
	const trimmed = new AgentTaskRegistry();
	for (let at = 0; at < SETTLED_WORKFLOW_CHILD_LIMIT + 10; at++) trimmed.applyLifecycleEvent("completed", { id: `x${at}`, workflowChild: true }, 1_000 + at * 60_000);
	check("though they do retire in the end", trimmed.get("x0") === undefined && trimmed.get(`x${SETTLED_WORKFLOW_CHILD_LIMIT}`) !== undefined);
}

// ---------------------------------------------------------------------------
console.log("\nworkflow UI: the grouped list");
{
	const { listEntries, workflowRowText, AGENT_GROUP_TITLE, WORKFLOW_GROUP_TITLE, BackgroundTasksView } = listView;
	const task = (over) => ({ id: "a1", name: "worker-1", type: "worker", description: "audit the wire", model: "", workflowChild: false, runId: undefined, status: "running", startedAt: 0, settledAt: undefined, durationMs: undefined, toolUses: undefined, lastActivityAt: undefined, totalTokens: undefined, costUsd: undefined, activity: [], result: undefined, error: undefined, outcome: undefined, stopRequested: false, ...over });
	const agent = task();
	const run = task({ id: "run-1", name: "spec", type: "workflow", description: "one per spec file", runId: "wf_1" });

	eq("one kind of task needs no headers to be told apart from itself", listEntries([agent, task({ id: "a2" })]).map((one) => one.kind), ["task", "task"]);
	eq("two kinds get headers, workflows last, one blank between", listEntries([agent, run]).map((one) => one.kind === "header" ? one.title : one.kind), ["Local agents", "task", "blank", "Dynamic workflows", "task"]);
	eq("the headers are the vendor's own words", [AGENT_GROUP_TITLE, WORKFLOW_GROUP_TITLE], ["Local agents", "Dynamic workflows"]);

	const runs = new store.WorkflowRunStore();
	runs.start({ runId: "wf_1", taskId: "run-1", name: "spec", description: "one per spec file", startedAt: 0 });
	for (const ordinal of [1, 2, 3]) runs.apply("wf_1", { type: "agent-start", ordinal, label: `spec:${ordinal}`, phase: undefined });
	runs.apply("wf_1", { type: "agent-done", ordinal: 1 });
	eq("a live run's row counts its agents", workflowRowText(run, runs.get("wf_1"), 5_000), "1/3 agents");
	eq("a stop asked for says so before it lands", workflowRowText({ ...run, stopRequested: true }, runs.get("wf_1"), 5_000), "stopping…");
	eq("a settled run says what it ran and what it cost", workflowRowText({ ...run, status: "completed", durationMs: 146_000 }, runs.get("wf_1"), 5_000), "1/3 agents · 2m 26s");

	const view = new BackgroundTasksView(theme, { tasks: () => [agent, run], runOf: (id) => runs.byTaskId(id), stop: () => {}, now: () => 5_000 }, () => {}, () => 40);
	const lines = view.render(80).map(plain);
	check("the header names the group and counts it", lines.some((line) => line.includes("Dynamic workflows (1)")), lines.join("\n"));
	check("a run is addressed by its name, not by its prose", lines.some((line) => line.includes("spec") && line.includes("1/3 agents")), lines.join("\n"));

	// Render order is nav order, and a header is not a place the cursor can be.
	const opened = [];
	const nav = new BackgroundTasksView(theme, { tasks: () => [agent, run], runOf: () => undefined, stop: () => {} }, (how) => opened.push(how), () => 40);
	nav.handleInput("\x1b[B");
	nav.handleInput("\r");
	eq("↓ from the first row lands on the next task, never on a header", opened.map((how) => how.id), ["run-1"]);
	const back = new BackgroundTasksView(theme, { tasks: () => [agent, run], runOf: () => undefined, stop: () => {} }, (how) => opened.push(how), () => 40);
	back.handleInput("\x1b[A");
	eq("↑ on the first row still closes, the way ↓ opened it", opened.at(-1).kind, "closed");
}

// ---------------------------------------------------------------------------
console.log("\nworkflow UI: the run view");
{
	const { WorkflowRunView, WORKFLOW_VIEW_OPTIONS, formatTokens, workflowViewMaxRows, ACTIVITY_LINES_SHOWN, PROMPT_LINES_SHOWN } = runView;
	const runs = new store.WorkflowRunStore();
	runs.start({ runId: "wf_1", taskId: "run-1", name: "spec-sweep", description: "one agent per spec file", startedAt: 0 });
	for (const ordinal of [1, 2, 3]) {
		runs.apply("wf_1", { type: "agent-start", ordinal, label: `spec:${ordinal}`, phase: "Sweep" });
		runs.noteSpawn("wf_1", ordinal, { taskId: `c${ordinal}`, prompt: "line one\nline two\nline three\nline four" });
	}
	runs.apply("wf_1", { type: "agent-done", ordinal: 1 });

	const tasks = {
		c1: { id: "c1", model: "anthropic/claude-fable-5-1", status: "completed", startedAt: 0, durationMs: 14_000, toolUses: 4, totalTokens: 31_500, lastActivityAt: 10_000, activity: ["Read(a.ts)", "Bash(npm test)", "Edit(a.ts)", "Bash(git diff)"], result: "I checked every spec and two of them drifted.", error: undefined },
		c2: { id: "c2", model: "anthropic/claude-fable-5-1", status: "running", startedAt: 0, durationMs: undefined, toolUses: 6, totalTokens: 32_200, lastActivityAt: 5_000, activity: ["Bash(sleep 300)"], result: undefined, error: undefined },
		c3: { id: "c3", model: "", status: "running", startedAt: 0, durationMs: undefined, toolUses: 0, totalTokens: undefined, lastActivityAt: undefined, activity: [], result: undefined, error: undefined },
	};
	const stopped = [];
	const deps = { run: () => runs.get("wf_1"), agentTask: (id) => tasks[id], stopRun: () => stopped.push("run"), stopAgent: (id) => stopped.push(id), now: () => 60_000, getTerminalRows: () => 40 };
	const make = () => new WorkflowRunView(theme, deps, (how) => stopped.push(how.kind), () => 40);

	check("the run view stands where the prompt box was, like the list", WORKFLOW_VIEW_OPTIONS.overlay === false);
	eq("a magnitude, one decimal — not the vendor's truncated `31.5…`", [formatTokens(31_500), formatTokens(900), formatTokens(0), formatTokens(undefined)], ["31.5k", "900", undefined, undefined]);
	check("the view takes more than half the screen: eight agent rows do not fit in less", workflowViewMaxRows(40) > 20);

	const level1 = make().render(100).map(plain);
	check("the run's name leads", level1.some((line) => line.trim().startsWith("spec-sweep")), level1.join("\n"));
	check("with its description and its counts on one line", level1.some((line) => line.includes("one agent per spec file") && line.includes("1/3 agents")), level1.join("\n"));
	check("the phase is a numbered row with its own count", level1.some((line) => plain(line).includes("1 Sweep") && line.includes("1/3")), level1.join("\n"));
	check("the box says the phase and how many agents are in it", level1.some((line) => line.includes("3 agents")), level1.join("\n"));
	check("a done agent shows its model, its tokens and its duration", level1.some((line) => line.includes("✓ spec:1") && line.includes("fable") && line.includes("31.5k") && line.includes("14s")), level1.join("\n"));
	check("a running one is a dot, not a word", level1.some((line) => line.includes("● spec:2")), level1.join("\n"));
	check("the byline offers the stop the run can take", level1.at(-1).includes("x stop workflow"), level1.at(-1));
	check("every line holds the width it was given", level1.every((line) => visibleWidth(line) <= 100), level1.map(visibleWidth).join(","));
	const boxed = level1.filter((line) => line.trimStart().startsWith("│"));
	eq("and the box holds one right edge", new Set(boxed.map(visibleWidth)).size, 1);

    // Level 2 is Joel's second case: what an agent is doing, without a transcript.
	const view = make();
	view.handleInput("\r");
	const level2 = view.render(100).map(plain);
	check("one agent, said to be the second of three", level2.some((line) => line.includes("spec:1 · 1/3")), level2.join("\n"));
	check("its state is a word and a glyph", level2.some((line) => line.includes("✓ Completed · fable")), level2.join("\n"));
	check("its stats are one line", level2.some((line) => line.includes("31.5k tok · 4 tool calls · 14s")), level2.join("\n"));
	check("the prompt shows two lines and says how many it is hiding", level2.some((line) => line.includes("Prompt · 4 lines · ⏎ expand")) && level2.some((line) => line.includes("… 2 more lines")), level2.join("\n"));
	eq("two, and the tail is three", [PROMPT_LINES_SHOWN, ACTIVITY_LINES_SHOWN], [2, 3]);
	check("the activity heading says how many calls are hidden", level2.some((line) => line.includes("Activity · last 3 of 4 tool calls")), level2.join("\n"));
	check("the newest three calls are there", level2.some((line) => line.includes("Edit(a.ts)")) && level2.some((line) => line.includes("Bash(git diff)")), level2.join("\n"));
	check("and the oldest, which is the fourth, is not", !level2.some((line) => line.includes("Read(a.ts)")), level2.join("\n"));
	// The whole difference from the box a single agent gets: no result, ever.
	check("no result is drawn beside a call", !level2.some((line) => line.includes("⎿")), level2.join("\n"));
	check("the agent's own last words are the outcome", level2.some((line) => line.includes("I checked every spec")), level2.join("\n"));
	check("every line still holds the width", level2.every((line) => visibleWidth(line) <= 100));

	view.handleInput("\r");
	check("enter expands the prompt", view.render(100).map(plain).some((line) => line.includes("line four")));
	view.handleInput("\x1b[B");
	const running = view.render(100).map(plain);
	check("↓ moves to the next agent", running.some((line) => line.includes("spec:2 · 2/3")), running.join("\n"));
	check("a running agent says it is running rather than claiming an outcome", running.some((line) => line.includes("● Running")) && running.some((line) => line.includes("Still running…")), running.join("\n"));
	check("its stats give the idle age in place of a duration it does not have", running.some((line) => line.includes("32.2k tok · 6 tool calls · idle 55s")), running.join("\n"));
	check("and its byline names the key for what it is: a skip", running.at(-1).includes("x skip"), running.at(-1));
	view.handleInput("x");
	eq("which reaches exactly that one agent", stopped.at(-1), "c2");
	view.handleInput("\x1b[B");
	const bare = view.render(100).map(plain);
	check("an agent that has done nothing says so rather than drawing empty blocks", bare.some((line) => line.includes("no tool calls yet")), bare.join("\n"));

	// Esc is a step back through the levels, not the way out of all of them.
	view.handleInput("\x1b");
	check("esc at an agent returns to the run", view.render(100).map(plain).some((line) => line.includes("3 agents")));
	view.handleInput("\x1b");
	eq("and esc at the run leaves", stopped.at(-1), "closed");

	// A settled run is exactly why the store keeps it.
	runs.settle("wf_1", "completed", 70_000);
	const after = make().render(100).map(plain);
	check("a finished run still draws its tree", after.some((line) => line.includes("✓ spec:1")), after.join("\n"));
	check("and says it is done", after.some((line) => line.includes("· done")), after.join("\n"));
	check("its byline no longer offers a stop", !after.at(-1).includes("stop"), after.at(-1));
	// A skip is a choice and a failure is not; the view must not say the same thing twice.
	runs.apply("wf_1", { type: "agent-skipped", ordinal: 2, reason: "spec:2 skipped by hand" });
	runs.apply("wf_1", { type: "agent-failed", ordinal: 3, reason: "terminal API error" });
	const mixed = make();
	const mixedRun = mixed.render(100).map(plain);
	check("a skipped agent has its own glyph, not the failure's cross", mixedRun.some((line) => line.includes("⊘ spec:2")) && mixedRun.some((line) => line.includes("✗ spec:3")), mixedRun.join("\n"));
	check("and the run's summary counts the two apart", mixedRun.some((line) => line.includes("1 failed · 1 skipped")), mixedRun.join("\n"));
	mixed.handleInput("\r");
	mixed.handleInput("\x1b[B");
	const skippedAgent = mixed.render(100).map(plain);
	check("the agent itself says Skipped, with why", skippedAgent.some((line) => line.includes("⊘ Skipped")) && skippedAgent.some((line) => line.includes("skipped by hand")), skippedAgent.join("\n"));
	check("and offers no skip key for an agent already skipped", !skippedAgent.at(-1).includes("x skip"), skippedAgent.at(-1));

	const gone = new WorkflowRunView(theme, { ...deps, run: () => undefined }, () => {}, () => 40).render(100).map(plain);
	check("a run that has been retired says that instead of drawing a blank", gone.some((line) => line.includes("no longer held")), gone.join("\n"));
}

// ---------------------------------------------------------------------------
console.log("\nworkflow UI: the wiring");
{
	const workflowSource = readFileSync(`${ROOT}/extensions/workflow.ts`, "utf8");
	const dockSource = readFileSync(`${ROOT}/extensions/agent-dock/index.ts`, "utf8");
	const runtimeSource = readFileSync(`${ROOT}/lib/agent-runtime.ts`, "utf8");

	// Wiring is only ever wrong in one way: it is not there. The events this UI
	// is drawn from were published for two tickets with a test as their only
	// subscriber.
	check("the run's own row carries the run id its view is opened with", /runId,\n/.test(workflowSource) || workflowSource.includes("runId,"));
	check("the engine says on every payload whether an agent belongs to a workflow", runtimeSource.includes("workflowChild: record.workflowChild"));
	check("and puts the call that just started on the progress channel", runtimeSource.includes("toolActivityLine(event.toolName, event.args)"));
	check("the tool folds its own events into the store rather than leaving them to a reader", workflowSource.includes("run.store.apply(run.runId, event)"));
	check("the spawner records the ordinal → task id route", workflowSource.includes("run.store.noteSpawn"));
	check("a finished run is settled in the store, not deleted", workflowSource.includes("run.store.settle(runId"));
	check("the dock opens the run view for a run", dockSource.includes("showWorkflowRunView"));
	check("and repaints on the run's own events", dockSource.includes('pi.events.on("workflow:progress"'));
	check("`/workflows` no longer claims a finished session never ran one", workflowSource.includes("No workflow runs in this session."));
	check("the tool no longer promises a ✓ the dock has never drawn", !workflowSource.includes("the dock shows ✓"));
	check("a run's `toolUses` no longer secretly means agents", workflowSource.includes("toolUses: 0"));

	// Two doc comments said the opposite of the code for two tickets.
	const registrySource = readFileSync(`${ROOT}/extensions/agent-dock/agent-task-registry.ts`, "utf8");
	const readme = readFileSync(`${ROOT}/README.md`, "utf8");
	check("the registry's header no longer claims a workflow's agent never reaches it", !registrySource.includes("a nested child or a workflow's agent reports through"));
	check("nor does the README", !/never appears here/.test(readme) || readme.includes("workflowChild"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
