/**
 * The dock: the count that goes in the bottom rule, the registry behind it, the
 * `↓` rule, and the modal.
 *
 * Three of these are the ones worth having. **The count is a lie the moment a
 * settled agent still counts**, so the registry is driven with the real event
 * order — including the two orders the engine actually produces, `created →
 * started → completed` for a background `Agent` call and `started → completed`
 * for an RPC spawn, which emits no `created` at all. **`↓` must never be stolen
 * from editing**, so the rule is exercised against every editor state, not just
 * the happy one. And **the rule layout must survive an 80-column pane**, so the
 * bottom rule is measured at widths with and without every label.
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

const count = await jiti.import(`${ROOT}/lib/agent-task-count.ts`);
const registryModule = await jiti.import(`${ROOT}/extensions/agent-dock/agent-task-registry.ts`);
const keyRule = await jiti.import(`${ROOT}/extensions/agent-dock/open-tasks-on-down-key.ts`);
const view = await jiti.import(`${ROOT}/extensions/agent-dock/background-tasks-view.ts`);
const repaintModule = await jiti.import(`${ROOT}/extensions/agent-dock/modal-repaint.ts`);
const spend = await jiti.import(`${ROOT}/extensions/agent-dock/session-spend.ts`);
const chrome = await jiti.import(`${ROOT}/extensions/zen-chrome/chrome.ts`);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
};
const eq = (label, actual, expected) =>
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------------------
console.log("agent-dock: the label in the rule");
{
	const { formatAgentTaskCount, AGENT_TASK_STATUS_KEY } = count;
	eq("no tasks draws nothing", formatAgentTaskCount(0), undefined);
	eq("one task is singular", formatAgentTaskCount(1), "1 task ↓");
	eq("more than one is plural", formatAgentTaskCount(3), "3 tasks ↓");
	eq("a negative count is nothing, not a minus sign", formatAgentTaskCount(-2), undefined);
	eq("NaN is nothing", formatAgentTaskCount(Number.NaN), undefined);
	eq("the arrow has no dot before it", formatAgentTaskCount(2).includes("·"), false);
	check("the status key is one shared string", AGENT_TASK_STATUS_KEY === "agents");

	// The count is published by agent-dock and rendered by zen-chrome. Two files,
	// one key — a rename that reaches only one of them puts the count nowhere.
	const chromeSource = readFileSync(`${ROOT}/extensions/zen-chrome/index.ts`, "utf8");
	check("zen-chrome imports the shared key rather than spelling it again", chromeSource.includes("AGENT_TASK_STATUS_KEY"));
	check("zen-chrome keeps the claimed key out of the footer row", /RULE_STATUSES\.has\(key\)/.test(chromeSource));
	// The count only exists while an agent is working, so it is lit for as long as
	// it is drawn — and the frames that light it have to go when it does, or an
	// idle seat repaints 25 times a second forever.
	check("zen-chrome lights the count it draws", /taskGlow\(Boolean\(text\)\)/.test(chromeSource) && /light: LABEL_LIGHT/.test(chromeSource));
	check("and takes the frames down with the label and with the session", (chromeSource.match(/stopTaskFrames\(\)/g) ?? []).length >= 3);
	const dockSource = readFileSync(`${ROOT}/extensions/agent-dock/index.ts`, "utf8");
	check("agent-dock publishes under that key", dockSource.includes("setStatus(AGENT_TASK_STATUS_KEY"));

	// Steps 1 and 2 of the fix live in the wiring, and wiring is only ever wrong
	// in one way: it is not there. The box was written against a live session
	// from the start and sat unplugged for two tickets because nobody passed one.
	check("the dock takes the child's live session off the runtime seam", dockSource.includes("agentRuntimeOf(sessionId)") && dockSource.includes("liveRun(exit.id)"));
	check("and hands typed text to the engine, which picks prompt or steer", /runtime\.send\(name, text, false\)/.test(dockSource));
	check("the note claiming nobody publishes live child sessions is gone", !dockSource.includes("nothing publishes live child sessions"));
	const boxSource = readFileSync(`${ROOT}/extensions/agent-dock/agent-conversation-box.ts`, "utf8");
	check("the box holds no session method it could send the wrong one with", !/\.steer\(|\.prompt\(/.test(boxSource));
}

// ---------------------------------------------------------------------------
console.log("\nagent-dock: the registry behind the count");
{
	const { AgentTaskRegistry, parseAgentLifecyclePayload, parseAgentProgressPayload, AGENT_LIFECYCLE_CHANNELS, AGENT_PROGRESS_CHANNEL, SETTLED_TASK_LIMIT, SETTLED_TASK_GRACE_MS } = registryModule;

	eq("the five channels are the vendor's, plus the resume", AGENT_LIFECYCLE_CHANNELS.map(([channel]) => channel), [
		"subagents:created",
		"subagents:started",
		"subagents:completed",
		"subagents:failed",
		"subagents:resumed",
	]);

	eq("progress rides its own channel, because it carries no status", AGENT_PROGRESS_CHANNEL, "subagents:progress");
	eq("a payload with no id is not an agent", parseAgentLifecyclePayload({ type: "explore" }), undefined);
	eq("a non-object payload is not an agent", parseAgentLifecyclePayload("a1"), undefined);
	eq("an empty id is not an id", parseAgentLifecyclePayload({ id: "" }), undefined);
	eq("a number field arriving as a string is dropped, not coerced",
		parseAgentLifecyclePayload({ id: "a1", toolUses: "12" }).toolUses, undefined);

	const registry = new AgentTaskRegistry();
	// The `Agent` tool's background branch: created, then started, then done.
	registry.applyLifecycleEvent("created", { id: "a1", type: "worker", description: "audit the wire" }, 1_000);
	eq("a created agent is queued and counted", [registry.liveCount(), registry.get("a1").status], [1, "queued"]);
	registry.applyLifecycleEvent("started", { id: "a1", type: "worker", description: "audit the wire" }, 2_000);
	eq("a started agent is running and still counted", [registry.liveCount(), registry.get("a1").status], [1, "running"]);

	// An RPC spawn emits no `subagents:created` — its first event is `started`.
	registry.applyLifecycleEvent("started", { id: "a2", type: "explore", description: "map the kit" }, 2_500);
	eq("an agent first seen at started is a task all the same", registry.liveCount(), 2);

	registry.applyLifecycleEvent(
		"completed",
		{ id: "a1", type: "worker", description: "audit the wire", result: "all clear", toolUses: 45, durationMs: 681_000 },
		9_000,
	);
	eq("a settled agent leaves the count", registry.liveCount(), 1);
	eq("its answer is kept for the modal", registry.get("a1").result, "all clear");
	eq("so is what it cost", [registry.get("a1").toolUses, registry.get("a1").durationMs], [45, 681_000]);

	registry.applyLifecycleEvent("started", { id: "a1" }, 10_000);
	eq("a late started never resurrects a settled agent", [registry.liveCount(), registry.get("a1").status], [1, "completed"]);

	// A `SendMessage` resume, on its own channel: one agent, one row, for the
	// agent's whole life. The old row asserting `completed` while it ran is the
	// fault this replaces.
	registry.applyLifecycleEvent("resumed", { id: "a1" }, 10_500);
	eq("a resume revives the agent's own row rather than adding a second", [registry.liveCount(), registry.get("a1").status, registry.list().length], [2, "running", 2]);
	eq("and the previous run's answer goes: a running agent has none", [registry.get("a1").result, registry.get("a1").settledAt], [undefined, undefined]);
	registry.applyLifecycleEvent("completed", { id: "a1", result: "clear again" }, 10_800);
	eq("the resumed run settles into the same row", [registry.liveCount(), registry.get("a1").result], [1, "clear again"]);

	registry.applyLifecycleEvent("failed", { id: "a2", status: "stopped", error: "watchdog: aborted after 15m" }, 11_000);
	eq("a failure settles too", [registry.liveCount(), registry.get("a2").status], [0, "failed"]);
	eq("the vendor's outcome word is kept", registry.get("a2").outcome, "stopped");
	eq("the reason is kept", registry.get("a2").error, "watchdog: aborted after 15m");
	eq("a description already seen survives a payload that omits it", registry.get("a2").description, "map the kit");

	eq("live first, then the most recently settled", registry.list().map((task) => task.id), ["a2", "a1"]);

	// Stopping.
	registry.applyLifecycleEvent("started", { id: "a3", description: "long one" }, 12_000);
	check("a stop is noted", registry.markStopRequested("a3") === true);
	check("asking twice changes nothing", registry.markStopRequested("a3") === false);
	check("a settled agent cannot be stopped", registry.markStopRequested("a1") === false);
	registry.applyLifecycleEvent("failed", { id: "a3", error: "aborted" }, 13_000);
	eq("a stop that landed is no longer pending", registry.get("a3").stopRequested, false);

	// The settled list is bounded; the live count never is.
	const many = new AgentTaskRegistry();
	for (let i = 0; i < SETTLED_TASK_LIMIT + 5; i++) {
		many.applyLifecycleEvent("started", { id: `b${i}`, description: `task ${i}` }, 1_000 + i);
		many.applyLifecycleEvent("completed", { id: `b${i}`, result: "done" }, 2_000 + i);
	}
	// Twenty-five landing together: nothing is trimmed yet, because a row nobody
	// has had a chance to see must not vanish while `ListAgents` still lists it.
	eq("a row inside the grace is never trimmed, whatever the limit says", many.list().length, SETTLED_TASK_LIMIT + 5);
	many.applyLifecycleEvent("started", { id: "late" }, 2_000 + SETTLED_TASK_GRACE_MS + 1_000);
	many.applyLifecycleEvent("completed", { id: "late", result: "done" }, 2_000 + SETTLED_TASK_GRACE_MS + 1_000);
	eq("settled tasks are capped once the grace has passed", many.list().length, SETTLED_TASK_LIMIT);
	eq("the newest survive", many.list()[0].id, "late");
	many.clear();
	eq("a new conversation owns no earlier agents", [many.list().length, many.liveCount()], [0, 0]);

	// C15's per-agent dollars. The engine reports the whole run as a pi `Usage`
	// on the settling event, so `usage.cost.total` is the one number to read and
	// the flat `tokens` view beside it is a different question (display tokens,
	// cacheRead excluded).
	eq("an agent's dollars come off usage.cost.total",
		parseAgentLifecyclePayload({ id: "c1", usage: { input: 1, cost: { total: 0.4213 } } }).costUsd, 0.4213);
	eq("a run that spent nothing reports no usage, and no cost", parseAgentLifecyclePayload({ id: "c1" }).costUsd, undefined);
	eq("an unpriced model is not a free one", parseAgentLifecyclePayload({ id: "c1", usage: { cost: {} } }).costUsd, undefined);
	eq("a cost arriving as a string is dropped, not coerced",
		parseAgentLifecyclePayload({ id: "c1", usage: { cost: { total: "0.42" } } }).costUsd, undefined);

	const priced = new AgentTaskRegistry();
	priced.applyLifecycleEvent("started", { id: "c1", type: "worker", description: "price the fork", model: "anthropic/claude-fable-5-1" }, 1_000);
	eq("a running agent has spent nothing it can report", priced.get("c1").costUsd, undefined);
	priced.applyLifecycleEvent("completed", { id: "c1", usage: { cost: { total: 0.42 } }, durationMs: 2_400 }, 5_000);
	eq("and keeps it once settled — a settled row is never blank", priced.get("c1").model, "anthropic/claude-fable-5-1");
	eq("the settled agent carries its dollars", priced.get("c1").costUsd, 0.42);
	// The model is on every payload (`lifecyclePayload`), so the dock's model
	// column is filled from `subagents:created` on and stays filled once settled.
	eq("the model is read off the payload", parseAgentLifecyclePayload({ id: "c1", model: "anthropic/claude-fable-5-1" }).model, "anthropic/claude-fable-5-1");
	eq("a payload with no model leaves it unset", parseAgentLifecyclePayload({ id: "c1" }).model, undefined);
	eq("a live agent already names its model", priced.get("c1").model, "anthropic/claude-fable-5-1");
	priced.applyLifecycleEvent("failed", { id: "c2", usage: { cost: { total: 0.03 } }, error: "boom" }, 6_000);
	eq("a failed agent spent money too", priced.get("c2").costUsd, 0.03);

	// The name rides every payload (`lifecyclePayload`) and is what `SendMessage`
	// addresses, so the box can only talk to a child if the dock kept it.
	eq("the engine's name for the agent is read off the payload", parseAgentLifecyclePayload({ id: "d1", name: "worker-2" }).name, "worker-2");
	const named = new AgentTaskRegistry();
	named.applyLifecycleEvent("started", { id: "d1", name: "worker-2", type: "worker" }, 1_000);
	eq("a task carries the name the box sends to", named.get("d1").name, "worker-2");
	named.applyLifecycleEvent("completed", { id: "d1" }, 2_000);
	eq("a payload that omits the name never loses it", named.get("d1").name, "worker-2");
	eq("a payload with no name leaves it empty rather than absent", new AgentTaskRegistry().applyLifecycleEvent("started", { id: "d2" }, 1) && undefined, undefined);

	// Live counts: `toolUses` lives in the run's memory and reaches the record
	// only at settle, so without progress a running row's count is always zero.
	eq("progress with no id is not progress", parseAgentProgressPayload({ toolUses: 3 }), undefined);
	eq("a progress count arriving as a string is dropped, not coerced", parseAgentProgressPayload({ id: "e1", toolUses: "3" }).toolUses, undefined);
	const live = new AgentTaskRegistry();
	live.applyLifecycleEvent("started", { id: "e1", name: "worker-3", toolUses: 0 }, 1_000);
	eq("a running agent starts with nothing to show", [live.get("e1").toolUses, live.get("e1").lastActivityAt], [0, undefined]);
	check("progress moves the row", live.applyProgressEvent({ id: "e1", toolUses: 4, lastActivityAt: 5_000 }, 5_000) === true);
	eq("the count and the moment of the last step are the row's", [live.get("e1").toolUses, live.get("e1").lastActivityAt], [4, 5_000]);
	eq("progress never moves a task between states", [live.get("e1").status, live.liveCount()], ["running", 1]);
	check("the same progress twice is not a repaint", live.applyProgressEvent({ id: "e1", toolUses: 4, lastActivityAt: 5_000 }, 5_000) === false);
	check("progress for an agent this dock never saw is dropped", live.applyProgressEvent({ id: "zz", toolUses: 9 }, 6_000) === false);
	live.applyLifecycleEvent("completed", { id: "e1", toolUses: 5, durationMs: 9_000 }, 9_000);
	check("progress still in flight cannot walk a settled agent's counts back", live.applyProgressEvent({ id: "e1", toolUses: 2, lastActivityAt: 10_000 }, 10_000) === false);
	eq("a settled agent keeps the count the engine recorded", live.get("e1").toolUses, 5);
}

// ---------------------------------------------------------------------------
// C15: per-agent dollars on the dock row, a tree rollup in `/stats`, and
// nothing model-facing. The dollars are a proxy for quota, useful as a ratio
// between choices — the allowance itself is only ever the server's, and only
// `lib/quota-meter.ts` can see it.
console.log("\nagent-dock: what the session spent");
{
	const { assistantCostUsd, agentSpendTreeOf, SPEND_LABEL_LIMIT } = spend;

	eq("an assistant message reports what pi charged for it",
		assistantCostUsd({ role: "assistant", usage: { cost: { total: 0.0123 } } }), 0.0123);
	eq("a user message costs the seat nothing", assistantCostUsd({ role: "user", usage: { cost: { total: 9 } } }), 0);
	eq("a message with no usage costs nothing", assistantCostUsd({ role: "assistant" }), 0);
	eq("an unpriced model costs nothing rather than NaN", assistantCostUsd({ role: "assistant", usage: { cost: {} } }), 0);
	eq("a non-message is not a charge", assistantCostUsd(undefined), 0);

	const tasks = [
		{ id: "a1", type: "worker", description: "price the fork", status: "completed", costUsd: 0.42 },
		{ id: "a2", type: "explore", description: "find the defect", status: "running", costUsd: undefined },
		{ id: "a3", type: "", description: "", status: "failed", costUsd: 0.08 },
	];
	const tree = agentSpendTreeOf(tasks, 2.41);
	eq("the seat's own spend is the root", tree.ownDollars, 2.41);
	eq("one branch per agent, in the order given", tree.agents.map((agent) => agent.label),
		["worker price the fork", "explore find the defect", "a3"]);
	eq("a running agent is live, and contributes nothing yet", [tree.agents[1].live, tree.agents[1].dollars], [true, 0]);
	eq("a settled agent is not live", tree.agents[0].live, false);
	eq("a failed agent still reports what it spent", tree.agents[2].dollars, 0.08);

	const long = agentSpendTreeOf([{ id: "a4", type: "worker", description: "x".repeat(80), status: "completed", costUsd: 1 }], 0);
	check("a long description is clipped so the amounts stay a column",
		long.agents[0].label.length <= SPEND_LABEL_LIMIT && long.agents[0].label.endsWith("…"), long.agents[0].label);

	const { renderAgentSpendTree } = await jiti.import(`${ROOT}/lib/agent-spend.ts`);
	const lines = renderAgentSpendTree(tree);
	check("the rollup reads as a table", lines[0] === "main                      $2.41" && lines.at(-1) === "total                     $2.91", JSON.stringify(lines));
}

// ---------------------------------------------------------------------------
console.log("\nagent-dock: /stats, driven through a stand-in ExtensionAPI");
{
	const channels = new Map();
	const hooks = new Map();
	const commands = new Map();
	const pi = {
		on: (event, handler) => hooks.set(event, handler),
		registerCommand: (name, options) => commands.set(name, options),
		events: { on: (channel, handler) => { channels.set(channel, handler); return () => {}; }, emit: () => {} },
	};
	const notices = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "session-stats" },
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			notify: (message) => notices.push(message),
			theme: { fg: (_c, t) => t },
		},
	};
	await (await jiti.import(`${ROOT}/extensions/agent-dock/index.ts`, { default: true }))(pi);
	hooks.get("session_start")({}, ctx);

	check("/stats is registered — pi has no such command of its own", commands.has("stats"));

	await commands.get("stats").handler("", ctx);
	eq("a session that has spent nothing says so", notices.at(-1).includes("nothing"), true);

	hooks.get("message_end")({ message: { role: "assistant", usage: { cost: { total: 0.2 } } } }, ctx);
	hooks.get("message_end")({ message: { role: "assistant", usage: { cost: { total: 0.05 } } } }, ctx);
	hooks.get("message_end")({ message: { role: "user", usage: { cost: { total: 99 } } } }, ctx);
	channels.get("subagents:started")({ id: "a1", type: "worker", description: "price the fork" });
	channels.get("subagents:completed")({ id: "a1", usage: { cost: { total: 0.42 } }, durationMs: 2_400 });
	channels.get("subagents:started")({ id: "a2", type: "explore", description: "still going" });

	await commands.get("stats").handler("", ctx);
	const report = notices.at(-1);
	check("the seat's own turns are summed", report.includes("main") && report.includes("$0.25"), report);
	check("a settled agent is a branch with its dollars", report.includes("worker price the fork") && report.includes("$0.42"), report);
	check("a running agent says running, not $0.00", /still going\s+running/.test(report), report);
	check("the total is the seat plus its agents", report.includes("$0.67"), report);
	// C15: cost visibility only. The quota line is ticket 18's open question and
	// is not ruled, so `/stats` says nothing about the allowance.
	check("nothing here claims to know the quota", !report.includes("5h ") && !report.includes("7d "), report);

	hooks.get("session_start")({}, ctx);
	await commands.get("stats").handler("", ctx);
	check("a new conversation starts from zero", notices.at(-1).includes("nothing"), notices.at(-1));
}

// ---------------------------------------------------------------------------
// The whole chain ticket 31 (c) blamed, driven end to end against pi's own
// footer data provider. Both suspects in that ticket are dead in the vendor:
// `setExtensionStatus` deletes the key on `undefined` and always re-renders
// (`core/footer-data-provider.js:127`, `modes/interactive/interactive-mode.js:1661`),
// and a widget factory runs the moment the widget is set
// (`interactive-mode.js:1748`), so a zero-line widget still hands the dock its
// TUI. This drives the real provider rather than a stub, so a future stub that
// lies about either cannot make the count look published when it is not.
console.log("\nagent-dock: from an agent starting to the label in the rule");
{
	const { FooterDataProvider } = await import(`${PI}/dist/core/footer-data-provider.js`);
	const provider = new FooterDataProvider(ROOT);
	const channels = new Map();
	const hooks = new Map();
	let repaints = 0;
	const tui = { requestRender: () => { repaints++; } };
	const pi = {
		on: (event, handler) => hooks.set(event, handler),
		registerCommand: () => {},
		events: { on: (channel, handler) => { channels.set(channel, handler); return () => {}; }, emit: () => {} },
	};
	const ctx = {
		mode: "tui",
		cwd: ROOT,
		// The seat's own id: the key its `AgentRuntime` is published under, which
		// is how the dock finds a live child session to hand the box.
		sessionManager: { getSessionId: () => "seat-1" },
		ui: {
			setStatus: (key, text) => provider.setExtensionStatus(key, text),
			setWidget: (_key, factory) => factory(tui),
			onTerminalInput: () => () => {},
			notify: () => {},
			theme: { fg: (_c, text) => text },
		},
	};
	await (await jiti.import(`${ROOT}/extensions/agent-dock/index.ts`, { default: true }))(pi);
	hooks.get("session_start")({}, ctx);

	const label = () => provider.getExtensionStatuses().get(count.AGENT_TASK_STATUS_KEY);
	eq("a session with no agents claims nothing", label(), undefined);

	channels.get("subagents:created")({ id: "a1", type: "worker", description: "audit the wire" });
	eq("a queued agent is already a task in the rule", label(), "1 task ↓");
	repaints = 0;
	channels.get("subagents:started")({ id: "a1", type: "worker", description: "audit the wire" });
	check("the dock has a TUI to repaint with, so the bar is asked to redraw", repaints > 0);
	channels.get("subagents:started")({ id: "a2", type: "explore", description: "map the kit" });
	eq("two running agents are two tasks", label(), "2 tasks ↓");

	// Live counts: the running row's tool count and idle age come off
	// `subagents:progress`, which never touches the count in the rule.
	repaints = 0;
	channels.get("subagents:progress")({ id: "a1", name: "worker-1", toolUses: 7, lastActivityAt: 1_000 });
	check("a progress event repaints the open dock", repaints > 0);
	eq("and leaves the count alone, because no task changed state", label(), "2 tasks ↓");

	const piece = (text) => [{ text, paint: (part) => part, atomic: true }];
	const drawn = chrome.bottomRule(
		80,
		{ branch: piece("main"), tasks: piece(label()), timer: piece("1m 12s "), cache: [], context: piece("31.4%") },
		(part) => part,
	);
	check("and the rule pi draws carries it", drawn.includes("2 tasks ↓"), drawn);

	channels.get("subagents:completed")({ id: "a1", result: "all clear" });
	eq("one settling leaves the other counted", label(), "1 task ↓");
	channels.get("subagents:failed")({ id: "a2", error: "boom" });
	eq("the last one settling clears the key rather than leaving a stale count", label(), undefined);
	check("and clearing it really removes the key", !provider.getExtensionStatuses().has(count.AGENT_TASK_STATUS_KEY));
	provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\nagent-dock: one ↓ opens the list, and nothing steals a keystroke");
{
	const { tasksLabelKey, readPromptEditorKeyState, shouldOpenTasksList } = keyRule;

	eq("the down arrow is down", tasksLabelKey("\x1b[B"), "down");
	eq("the up arrow is other", tasksLabelKey("\x1b[A"), "other");
	eq("return is other", tasksLabelKey("\r"), "other");
	eq("a printable character is other", tasksLabelKey("j"), "other");
	// A kitty terminal reports press and release, and `matchesKey` matches both,
	// so a release would open the list a second time on one physical press.
	eq("a kitty key release is other", tasksLabelKey("\x1b[1;1:3B"), "other");

	const editor = (empty, historyIndex) => ({ isEditorEmpty: () => empty, historyIndex });
	eq("an empty prompt reads as empty and not browsing", readPromptEditorKeyState(editor(true, -1)), { empty: true, browsingHistory: false });
	eq("a recalled prompt reads as browsing", readPromptEditorKeyState(editor(false, 2)), { empty: false, browsingHistory: true });
	eq("a dialog is not a prompt editor", readPromptEditorKeyState({ render: () => [] }), undefined);
	eq("nothing focused is not a prompt editor", readPromptEditorKeyState(undefined), undefined);
	eq("an editor that throws is not read", readPromptEditorKeyState({ isEditorEmpty: () => { throw new Error("gone"); }, historyIndex: -1 }), undefined);

	const opens = (over = {}) =>
		shouldOpenTasksList({ key: "down", editor: { empty: true, browsingHistory: false }, liveTaskCount: 2, modalOpen: false, ...over });
	// The failure this pins: a first `↓` that only selected the label read as a
	// key that had to be held down. One press opens, or the editor gets it.
	eq("one ↓ at an empty prompt opens the list", opens(), true);
	eq("no tasks, nothing to open", opens({ liveTaskCount: 0 }), false);
	eq("text in the editor keeps its arrow", opens({ editor: { empty: false, browsingHistory: false } }), false);
	eq("history browsing keeps its arrow", opens({ editor: { empty: true, browsingHistory: true } }), false);
	eq("a dialog keeps its arrow", opens({ editor: undefined }), false);
	eq("an open list owns its own keys", opens({ modalOpen: true }), false);
	eq("any other key is the editor's", opens({ key: "other" }), false);
}

// ---------------------------------------------------------------------------
console.log("\nagent-dock: the modal");
{
	const { BackgroundTasksView, BACKGROUND_TASKS_TITLE, TASKS_VIEW_OPTIONS, taskStatusText, tasksPanelMaxRows, shortTaskModel, IDLE_VISIBLE_MS } = view;
	const theme = {
		fg: (_c, t) => t,
		bg: (_c, t) => t,
		bold: (t) => t,
		italic: (t) => t,
		dim: (t) => t,
		inverse: (t) => t,
		strikethrough: (t) => t,
	};
	const task = (over) => ({
		id: "a1",
		type: "worker",
		description: "audit the wire",
		model: "anthropic/claude-fable-5-1",
		status: "running",
		startedAt: 0,
		settledAt: undefined,
		durationMs: undefined,
		toolUses: undefined,
		result: undefined,
		error: undefined,
		stopRequested: false,
		...over,
	});

	// Ticket 53, Joel at the dock: "if they are running, it should not say
	// running". Motion says it, so the words a running row keeps are only the
	// ones the eye cannot infer — and `4 tools` and `ctx` are not among them.
	eq("a running row with nothing to report says nothing at all", taskStatusText(task()), "");
	eq("a running row never says the word", taskStatusText(task({ toolUses: 4, totalTokens: 32_000, lastActivityAt: 1_000 }), 1_500).includes("running"), false);
	eq("a running row says what it is carrying, spelled out", taskStatusText(task({ toolUses: 4, totalTokens: 32_000, lastActivityAt: 1_000 }), 1_500), "32k context");
	eq("no abbreviation nobody can pronounce", taskStatusText(task({ totalTokens: 32_000 })).includes("ctx"), false);
	eq("the tool count is gone: the idle age is the wedge detector now", taskStatusText(task({ toolUses: 4 })), "");
	eq("a child under half a thousand tokens says nothing rather than 0k", taskStatusText(task({ totalTokens: 400 })), "");
	eq("a child that has just acted is not called idle", taskStatusText(task({ totalTokens: 32_000, lastActivityAt: 1_000 }), 1_000 + IDLE_VISIBLE_MS - 1), "32k context");
	eq("a wedged child says how long it has been quiet", taskStatusText(task({ totalTokens: 32_000, lastActivityAt: 1_000 }), 241_000), "32k context · idle 4m 00s");
	eq("a child that has done nothing at all can still be wedged", taskStatusText(task({ lastActivityAt: 1_000 }), 61_000), "idle 1m 00s");
	eq("no activity yet is never called idle", taskStatusText(task({ totalTokens: 3_000 }), 999_000), "3k context");
	// One has not started and one is a request, so neither is said with motion.
	eq("a queued row is not a running one, whatever progress says", taskStatusText(task({ status: "queued", totalTokens: 32_000, lastActivityAt: 1_000 }), 999_000), "queued");
	eq("a stop in flight still says only that", taskStatusText(task({ stopRequested: true, totalTokens: 32_000, lastActivityAt: 1 }), 999_000), "stopping…");
	eq("a queued row says queued", taskStatusText(task({ status: "queued" })), "queued");
	eq("a stop in flight says so", taskStatusText(task({ stopRequested: true })), "stopping…");
	// A settled row says what it cost: how long it worked, and how big it got.
	eq("a settled row is its duration and its size", taskStatusText(task({ status: "completed", toolUses: 27, totalTokens: 48_000, lastActivityAt: 1_000, durationMs: 146_000 }), 999_000), "2m 26s · 48k context");
	eq("and a failed one keeps its word in front", taskStatusText(task({ status: "failed", outcome: "stopped", totalTokens: 12_000, durationMs: 64_000 }), 999_000), "stopped · 1m 04s · 12k context");
	eq("a settled row is never idle and never counts tools", taskStatusText(task({ status: "completed", toolUses: 27, lastActivityAt: 1_000, durationMs: 146_000 }), 999_000), "2m 26s");
	eq("a completion with no duration still says something", taskStatusText(task({ status: "completed" })), "done");
	eq("and says its size beside that", taskStatusText(task({ status: "completed", totalTokens: 48_000 })), "done · 48k context");
	// A row answers "how long is this taking" and "how big did it get". Money
	// lives in `/stats` and on a `ListAgents` row: a `· $0.42` here was rejected (C15).
	eq("a completed row says the time, never the money",
		taskStatusText(task({ status: "completed", durationMs: 146_000, costUsd: 0.42 })), "2m 26s");
	eq("a sub-cent agent is still just its duration",
		taskStatusText(task({ status: "completed", durationMs: 2_400, costUsd: 0.001 })), "2s");
	eq("a running row has nothing to add", taskStatusText(task({ costUsd: 0.42 })), "");
	eq("a failed row keeps its word and its duration, and no bill",
		taskStatusText(task({ status: "failed", outcome: "error", durationMs: 2_400, costUsd: 0.03 })), "failed · 2s");
	check("no row anywhere prints a dollar sign",
		![task(), task({ status: "queued" }), task({ status: "completed", durationMs: 146_000, costUsd: 0.42 }), task({ status: "failed", outcome: "stopped", costUsd: 9 })]
			.some((one) => taskStatusText(one).includes("$")));
	eq("a failure keeps its word in front of the duration",
		taskStatusText(task({ status: "failed", outcome: "error", toolUses: 3, durationMs: 2_400 })), "failed · 2s");
	eq("a failure says failed", taskStatusText(task({ status: "failed" })), "failed");
	eq("a stop says stopped, the transcript row's word", taskStatusText(task({ status: "failed", outcome: "stopped", toolUses: 27 })), "stopped");
	eq("an abort says aborted", taskStatusText(task({ status: "failed", outcome: "aborted" })), "aborted");

	// The same word as the top rule: `fable`, not `anthropic/claude-fable-5-1`.
	eq("the model drops its provider and reads like the top rule", shortTaskModel("anthropic/claude-fable-5-1"), "fable");
	eq("opus and luna likewise", [shortTaskModel("anthropic/claude-opus-4-1"), shortTaskModel("openai-codex/gpt-6-luna")], ["opus", "luna"]);
	eq("a model with no family keeps its id", shortTaskModel("openai/gpt-5"), "gpt-5");

	const stopped = [];
	const tasks = [task(), task({ id: "a2", description: "map the kit", status: "completed", durationMs: 146_000, result: "line one\nline two\nline three" })];
	const exit = (how) => stopped.push(how.kind === "open" ? `open:${how.id}` : "closed");
	const make = (selectedId) =>
		new BackgroundTasksView(theme, { tasks: () => tasks, stop: (id) => stopped.push(id), selectedId }, exit, () => 24);

	// A running row wears the wave, so its text arrives interleaved with colour
	// escapes: content is asserted on the stripped line, motion on the raw one.
	const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const list = make().render(80).map(plain);
	check("the title is Claude Code's words", list[0].includes(BACKGROUND_TASKS_TITLE));
	check("the list stands in the prompt box's place, not in an overlay", TASKS_VIEW_OPTIONS.overlay === false);
	check("the first row is a full-width rule, the divider Claude Code's dialog draws",
		/^─+ /.test(list[0]) && /─$/.test(list[0]) && visibleWidth(list[0]) === 80);
	eq("half the screen is the cap", tasksPanelMaxRows(48), 24);
	eq("a short terminal still gets the chrome plus a task row", tasksPanelMaxRows(8), 5);
	eq("and a terminal shorter than that floor never overflows it", tasksPanelMaxRows(3), 3);
	check("a panel of two tasks costs only the rows it needs", list.length <= 8);

	// The failure this pins: pi anchors the panel by the height it renders, so a
	// view that budgets from the terminal instead of from the panel either
	// overflows the screen (and pi slices the hints off the bottom) or fills it
	// (and the transcript vanishes). Both were seen live before this rule existed.
	const crowd = Array.from({ length: 40 }, (_, i) => task({ id: `c${i}`, description: `task ${i}` }));
	for (const rows of [10, 24, 40, 60]) {
		const packed = new BackgroundTasksView(theme, { tasks: () => crowd, stop: () => {} }, () => {}, () => rows);
		const drawn = packed.render(80);
		eq(`at ${rows} rows the panel is exactly its budget`, drawn.length, tasksPanelMaxRows(rows));
		check(`at ${rows} rows the transcript above it survives`, drawn.length < rows);
		check(`at ${rows} rows the hints are still on screen`, /esc close/.test(drawn[drawn.length - 1]));
		// The stated limit: the `N of 40` counter needs a row of its own, and a panel
		// of five rows has none to spare. Below 12 terminal rows it is the first
		// thing given up, after which a task row and the way out are all that is left.
		eq(`at ${rows} rows the overflow is counted`, drawn.some((line) => /of 40/.test(line)), rows >= 12);
	}
	check("the title counts what is running", list[0].includes("1 running"));
	check("every agent gets a row", list.some((l) => l.includes("audit the wire")) && list.some((l) => l.includes("map the kit")));
	check("the first row is selected", list.find((l) => l.includes("audit the wire")).includes("❯"));
	{
		// The model rides the lifecycle payload, so it is on the task itself:
		// a running row and a settled row both name it, and neither is blank.
		const rows = new BackgroundTasksView(theme, { tasks: () => tasks, stop: () => {} }, exit, () => 24).render(80).map(plain);
		check("a running row leads with its type and the model", rows.some((l) => /worker fable audit the wire/.test(l)));
		check("a settled row names its model too", rows.some((l) => /worker fable map the kit/.test(l)));
		check("no row's model column is blank", rows.filter((l) => /audit the wire|map the kit/.test(l)).every((l) => /worker fable /.test(l)));
		const unknown = new BackgroundTasksView(theme, { tasks: () => [task({ model: "" })], stop: () => {} }, exit, () => 24).render(80).map(plain);
		check("a model not yet named leaves no gap", unknown.some((l) => /worker audit the wire/.test(l)));
	}
	check("the hints name every key", /↑↓ select · enter view · x stop · esc close/.test(list.join("\n")));
	check("no line is wider than the width it was handed", list.every((line) => visibleWidth(line) <= 80));
	check("it renders at 40 columns too", make().render(40).every((line) => visibleWidth(line) <= 40));

	const navigated = make();
	navigated.render(80);
	navigated.handleInput("\x1b[B");
	check("↓ moves the selection", navigated.render(80).map(plain).find((l) => l.includes("map the kit")).includes("❯"));
	navigated.handleInput("\x1b[B");
	check("the selection stops at the end", navigated.render(80).map(plain).find((l) => l.includes("map the kit")).includes("❯"));

	navigated.handleInput("\r");
	eq("enter hands that agent back to the dock, to open its box", stopped, ["open:a2"]);
	stopped.length = 0;
	const reopened = make("a2");
	check("reopened on the row whose box was left", reopened.render(80).map(plain).find((l) => l.includes("map the kit")).includes("❯"));
	const unknown = make("gone");
	check("an id that is no longer listed lands on the first row", unknown.render(80).map(plain).find((l) => l.includes("audit the wire")).includes("❯"));

	// ↑ at the top goes back one level, mirroring the ↓ that opened the modal.
	const backOut = make();
	backOut.render(80);
	backOut.handleInput("\x1b[B");
	backOut.handleInput("\x1b[A");
	check("↑ below the top row just moves the selection",
		backOut.render(80).map(plain).find((l) => l.includes("audit the wire")).includes("❯") && stopped.length === 0);
	backOut.handleInput("\x1b[A");
	eq("↑ at the top row closes the modal, the way ↓ opened it", stopped, ["closed"]);
	stopped.length = 0;

	const stopper = make();
	stopper.render(80);
	stopper.handleInput("x");
	eq("x stops the selected agent", stopped, ["a1"]);
	stopper.handleInput("\x1b[B");
	stopper.render(80);
	stopper.handleInput("x");
	eq("a settled agent is not asked to stop", stopped, ["a1"]);
	stopper.handleInput("\x1b");
	eq("esc closes the modal", stopped, ["a1", "closed"]);

	const empty = new BackgroundTasksView(theme, { tasks: () => [], stop: () => {} }, () => {}, () => 24);
	check("an empty list says so instead of drawing nothing", empty.render(60).join("\n").includes("No background tasks."));
	empty.handleInput("\r");
	empty.handleInput("x");
	check("keys on an empty list do nothing at all", empty.render(60).join("\n").includes("No background tasks."));
}

// ---------------------------------------------------------------------------
// Ticket 53: the row says "this is running" with motion, because motion is the
// one property of a terminal cell that cannot be mistaken for content. So the
// two facts worth pinning are that a live row moves and that a settled one is
// bytes for bytes the row it would be with no animation at all.
console.log("\nagent-dock: motion means running");
{
	const { BackgroundTasksView, ROW_FRAME_MS } = view;
	const theme = {
		fg: (_c, t) => t,
		bg: (_c, t) => t,
		bold: (t) => t,
		italic: (t) => t,
		dim: (t) => t,
		inverse: (t) => t,
		strikethrough: (t) => t,
	};
	const task = (over) => ({
		id: "a1", type: "worker", description: "audit the wire", model: "anthropic/claude-fable-5-1",
		status: "running", startedAt: 0, settledAt: undefined, durationMs: undefined, toolUses: undefined,
		totalTokens: undefined, lastActivityAt: undefined, result: undefined, error: undefined,
		outcome: undefined, stopRequested: false, ...over,
	});
	const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const row = (over, now = 1_000) =>
		new BackgroundTasksView(theme, { tasks: () => [task(over)], stop: () => {}, now: () => now }, () => {}, () => 24)
			.render(80)
			.find((line) => strip(line).includes("audit the wire"));

	eq("the wave runs at about ten frames a second", ROW_FRAME_MS, 100);

	const running = row({ totalTokens: 32_000 });
	check("a running row is painted in truecolor, which is the wave", /\x1b\[38;2;\d+;\d+;\d+m/.test(running), JSON.stringify(running));
	check("and it moves: the same row a moment later is different bytes", running !== row({ totalTokens: 32_000 }, 1_400));
	check("the row reads as it should once the colour is taken off",
		/❯ ● worker fable audit the wire +32k context {2}$/.test(strip(running)), JSON.stringify(strip(running)));
	check("no running row anywhere says the word", !strip(running).includes("running"));
	check("the wave never reaches the dot", running.indexOf("\x1b") > running.indexOf("●"), JSON.stringify(running));
	// Numbers have to stay readable while the light goes past them, so the wave
	// stops at the end of the description: everything after its last reset is plain.
	const tail = running.split("\x1b[0m").pop();
	check("and never reaches the right-hand column", /^ +32k context {2}$/.test(tail), JSON.stringify(tail));
	const wedged = row({ totalTokens: 32_000, lastActivityAt: 1_000 }, 241_000);
	check("a wedged child's idle age rides that column too, unpainted",
		/^ +32k context · idle 4m 00s {2}$/.test(wedged.split("\x1b[0m").pop()), JSON.stringify(wedged));

	// With an identity theme every escape on a line came from the wave, so "no
	// escapes" is exactly "this row is what it would be with the animation off".
	// A stop asked for is a request, not a state: the child is still running, so
	// the row still moves — and still says the word, because the request is a fact
	// the motion cannot carry.
	const stopping = row({ stopRequested: true });
	check("a stop in flight keeps moving, because the child is still running", /\x1b\[38;2;/.test(stopping));
	check("and keeps its word", strip(stopping).trimEnd().endsWith("stopping…"));

	const still = {
		queued: { status: "queued" },
		completed: { status: "completed", durationMs: 146_000, totalTokens: 48_000 },
		failed: { status: "failed", outcome: "error", durationMs: 64_000, totalTokens: 12_000 },
	};
	for (const [name, over] of Object.entries(still)) {
		const line = row(over);
		check(`a ${name} row has no motion in it at all`, !line.includes("\x1b"), JSON.stringify(line));
		eq(`a ${name} row is byte-identical five seconds later`, line, row(over, 6_000));
	}
	eq("a settled row says what it cost", strip(row(still.completed)).trimEnd().endsWith("2m 26s · 48k context"), true);
	eq("a failed row keeps its word in front", strip(row(still.failed)).trimEnd().endsWith("failed · 1m 04s · 12k context"), true);
	eq("a queued row keeps its word, because it has not started", strip(row(still.queued)).trimEnd().endsWith("queued"), true);
}

// ---------------------------------------------------------------------------
// The cadence. 10fps is expensive, so the only way to reach it is an open
// overlay that claims frames while something is live — there is no flag to
// leave on, and the clock re-derives itself on every frame it fires.
console.log("\nagent-dock: the repaint clock");
{
	const { ModalRepaint } = repaintModule;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	let live = false;
	let paints = 0;
	const clock = new ModalRepaint(5);

	check("a closed dock animates nothing", clock.animating === false);
	clock.paint();
	check("and painting a closed dock starts nothing", clock.animating === false && paints === 0);

	clock.attach(() => paints++, () => live);
	check("an open list with nothing live is still", clock.animating === false);
	live = true;
	clock.paint();
	check("the first live child starts the frames", clock.animating === true);
	await sleep(40);
	check("which repaint the list", paints > 2, `paints=${paints}`);

	live = false;
	await sleep(20);
	check("the last child settling stops the clock, without anyone saying so", clock.animating === false);
	const settled = paints;
	await sleep(20);
	eq("after which nothing repaints at all", paints, settled);

	live = true;
	clock.paint();
	check("a new child starts it again", clock.animating === true);
	clock.detach();
	check("and closing the overlay stops it, whatever is still running", clock.animating === false);
	const closed = paints;
	await sleep(20);
	eq("a closed dock repaints nothing", paints, closed);

	clock.attach(() => paints++);
	clock.paint();
	check("an overlay that claims no frames never gets any", clock.animating === false);
	clock.detach();
}

// ---------------------------------------------------------------------------
console.log("\nagent-dock: the count in the bottom rule");
{
	const { bottomRule } = chrome;
	const plain = (text) => text;
	const piece = (text, atomic = false) => (text ? [{ text, paint: plain, atomic }] : []);
	const rule = (width, { branch = "main", tasks = "", timer = "", context = "31.4%" } = {}) =>
		bottomRule(
			width,
			{ branch: piece(branch), tasks: piece(tasks, true), timer: piece(timer ? `${timer} ` : "", true), cache: [], context: piece(context, true), scroll: [] },
			plain,
		);

	for (const width of [40, 60, 80, 100, 120, 160]) {
		const line = rule(width, { tasks: "2 tasks ↓", timer: "1m 12s" });
		check(`the rule is exactly ${width} columns wide`, visibleWidth(line) === width, JSON.stringify(line));
	}

	const at80 = rule(80, { tasks: "2 tasks ↓", timer: "1m 12s" });
	check("80 columns holds branch, tasks and clock", /main/.test(at80) && /2 tasks ↓/.test(at80) && /1m 12s/.test(at80), at80);
	check("the tasks label sits between the branch and the clock", at80.indexOf("2 tasks") > at80.indexOf("main") && at80.indexOf("2 tasks") < at80.indexOf("1m 12s"));
	check("dashes separate it from both", / ─+ 2 tasks ↓ ─+ /.test(at80), at80);
	check("no tasks, no label", !rule(80, { timer: "1m 12s" }).includes("task"));

	// The drop order, stated: timer, then tasks, then the branch is squeezed.
	const narrow = rule(30, { tasks: "2 tasks ↓", timer: "1m 12s" });
	check("the timer goes first", !narrow.includes("1m 12s") && narrow.includes("2 tasks ↓"), narrow);
	const narrower = rule(21, { tasks: "2 tasks ↓", timer: "1m 12s" });
	check("then the tasks go", !narrower.includes("task"), narrower);
	check("the branch outlives them both", narrower.includes(" main "), narrower);
	check("nothing is ever clipped on the way down", !narrower.includes("…"), narrower);
	for (const width of [4, 8, 12, 20, 26, 34, 46]) {
		check(`a ${width}-column rule is still exactly that wide`, visibleWidth(rule(width, { tasks: "12 tasks ↓", timer: "10m 04s" })) === width);
	}
	check("a long branch is squeezed rather than dropped",
		rule(30, { branch: "a-very-long-feature-branch-name", tasks: "2 tasks ↓" }).includes("…"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
