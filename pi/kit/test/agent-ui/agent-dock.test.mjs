/**
 * The dock's entry: the count that goes in the bottom rule, published from the
 * lifecycle events to pi's own footer data, and the `↓` rule that opens the list.
 *
 * **`↓` must never be stolen from editing**, so the rule is exercised against
 * every editor state, not just the happy one. The bottom rule's own layout, with
 * and without the count, is measured in `test/chrome/prompt-box-rules.test.mjs`; the
 * registry, the list, the repaint clock and `/stats` have their own files here.
 */

import { check, eq, finish } from "../support/check-harness.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { importPi, KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { readFileSync } from "node:fs";

const jiti = kitJiti();

const count = await jiti.import(`${KIT_ROOT}/lib/agents/agent-task-count.ts`);
const keyRule = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/open-tasks-on-down-key.ts`);
const chrome = await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/prompt-box-rules.ts`);

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
	const dockSource = readFileSync(`${KIT_ROOT}/extensions/agent-dock/index.ts`, "utf8");
	check("agent-dock publishes under that key", dockSource.includes("setStatus(AGENT_TASK_STATUS_KEY"));

	// Steps 1 and 2 of the fix live in the wiring, and wiring is only ever wrong
	// in one way: it is not there. The view was written against a live session
	// from the start and sat unplugged for two tickets because nobody passed one.
	const focusSource = readFileSync(`${KIT_ROOT}/extensions/agent-dock/agent-focus-target.ts`, "utf8");
	check("the dock takes the child's live session off the runtime seam", dockSource.includes("agentRuntimeOf(sessionId)") && focusSource.includes("runtime.liveRun(taskId)"));
	check("and hands typed text to the engine, which picks prompt, steer or resume", /runtime\.send\(taskId, text, false, "Joel"\)/.test(focusSource));
	check("the note claiming nobody publishes live child sessions is gone", !dockSource.includes("nothing publishes live child sessions"));
	check("the agent view holds no session method it could send the wrong one with", !/\.steer\(|\.prompt\(/.test(focusSource));
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
	const { FooterDataProvider } = await importPi("dist/core/footer-data-provider.js");
	const provider = new FooterDataProvider(KIT_ROOT);
	let repaints = 0;
	const tui = { requestRender: () => { repaints++; } };
	const pi = fakeExtensionApi();
	const emit = (channel, payload) => pi.api.events.emit(channel, payload);
	const ctx = {
		mode: "tui",
		cwd: KIT_ROOT,
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
	await (await jiti.import(`${KIT_ROOT}/extensions/agent-dock/index.ts`, { default: true }))(pi.api);
	await pi.fire("session_start", {}, ctx);

	const label = () => provider.getExtensionStatuses().get(count.AGENT_TASK_STATUS_KEY);
	eq("a session with no agents claims nothing", label(), undefined);

	emit("subagents:created", { id: "a1", type: "worker", description: "audit the wire" });
	eq("a queued agent is already a task in the rule", label(), "1 task ↓");
	repaints = 0;
	emit("subagents:started", { id: "a1", type: "worker", description: "audit the wire" });
	check("the dock has a TUI to repaint with, so the bar is asked to redraw", repaints > 0);
	emit("subagents:started", { id: "a2", type: "explore", description: "map the kit" });
	eq("two running agents are two tasks", label(), "2 tasks ↓");

	// Live counts: the running row's tool count and idle age come off
	// `subagents:progress`, which never touches the count in the rule.
	repaints = 0;
	emit("subagents:progress", { id: "a1", name: "worker-1", toolUses: 7, lastActivityAt: 1_000 });
	check("a progress event repaints the open dock", repaints > 0);
	eq("and leaves the count alone, because no task changed state", label(), "2 tasks ↓");

	const piece = (text) => [{ text, paint: (part) => part, atomic: true }];
	const drawn = chrome.bottomRule(
		80,
		{ branch: piece("main"), tasks: piece(label()), timer: piece("1m 12s "), cache: [], context: piece("31.4%") },
		(part) => part,
	);
	check("and the rule pi draws carries it", drawn.includes("2 tasks ↓"), drawn);

	emit("subagents:completed", { id: "a1", result: "all clear" });
	eq("one settling leaves the other counted", label(), "1 task ↓");
	emit("subagents:failed", { id: "a2", error: "boom" });
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
	eq("no live tasks, but the prompt is focused on an agent: the list opens to switch", opens({ liveTaskCount: 0, agentFocused: true }), true);
	eq("focused on an agent, text in the editor still keeps its arrow", opens({ agentFocused: true, editor: { empty: false, browsingHistory: false } }), false);
	eq("text in the editor keeps its arrow", opens({ editor: { empty: false, browsingHistory: false } }), false);
	eq("history browsing keeps its arrow", opens({ editor: { empty: true, browsingHistory: true } }), false);
	eq("a dialog keeps its arrow", opens({ editor: undefined }), false);
	eq("an open list owns its own keys", opens({ modalOpen: true }), false);
	eq("any other key is the editor's", opens({ key: "other" }), false);
}

// ---------------------------------------------------------------------------
console.log("\nagent-dock: the main row leaves the agent view");
{
	const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t, inverse: (t) => t, strikethrough: (t) => t };
	const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const rowOf = (lines, text) => lines.find((line) => line.includes(text)) ?? "";
	// Through the dock itself: ↓, Enter on an agent, ↓ again, Enter on main.
	const { publishPromptFocus, forgetPromptFocus } = await jiti.import(`${KIT_ROOT}/lib/session/prompt-focus.ts`);
	const { promptTargetOf, setPromptTarget } = await jiti.import(`${KIT_ROOT}/lib/session/prompt-target.ts`);
	const { publishAgentRuntime, forgetAgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const SEAT = "seat-main-row";
	const channels = new Map();
	const hooks = new Map();
	const lists = [];
	let keyListener;
	let focusedTarget;
	let exitCalls = 0;
	const tui = { requestRender: () => {}, terminal: { rows: 24 }, focusedComponent: { isEditorEmpty: () => true, historyIndex: -1 } };
	const pi = {
		on: (event, handler) => hooks.set(event, handler),
		registerCommand: () => {},
		events: { on: (channel, handler) => { channels.set(channel, handler); return () => {}; }, emit: () => {} },
	};
	let mainIdle = false;
	const ctx = {
		mode: "tui",
		cwd: KIT_ROOT,
		sessionManager: { getSessionId: () => SEAT },
		isIdle: () => mainIdle,
		ui: {
			setStatus: () => {},
			setWidget: (_key, factory) => factory(tui),
			onTerminalInput: (listener) => { keyListener = listener; return () => {}; },
			notify: () => {},
			theme,
			custom: (factory) => new Promise((resolve) => lists.push(factory(tui, theme, {}, resolve))),
		},
	};
	publishPromptFocus(SEAT, {
		focus: (target) => { focusedTarget = target; setPromptTarget(SEAT, target.target); return true; },
		exit: () => { exitCalls++; setPromptTarget(SEAT, undefined); },
	});
	publishAgentRuntime(SEAT, { registry: { byName: () => undefined }, liveRun: () => undefined });
	await (await jiti.import(`${KIT_ROOT}/extensions/agent-dock/index.ts`, { default: true }))(pi);
	hooks.get("session_start")({}, ctx);
	channels.get("subagents:started")({ id: "a1", name: "worker-1", type: "worker", description: "audit the wire" });
	channels.get("subagents:started")({ id: "a2", name: "worker-2", type: "worker", description: "map the kit" });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const open = async () => { check("(↓ opens the list)", keyListener("\x1b[B")?.consume === true); await settle(); return lists.at(-1); };

	let list = await open();
	check("opened from main, the list has no main row", !list.render(80).map(plain).some((line) => /● main\b/.test(line)));
	list.handleInput("\x1b[B");
	list.handleInput("\r");
	await settle();
	check("Enter on an agent focuses it", focusedTarget?.target.name === "worker-2" && focusedTarget.placement === "replace");

	list = await open();
	let drawn = list.render(80).map(plain);
	check("opened from the agent view, main is the first row, with main's status", /● main\s+working/.test(drawn[2] ?? ""), JSON.stringify(drawn));
	check("and the list opens at the top: the cursor is on main", rowOf(drawn, "main").includes("❯"));
	mainIdle = true;
	check("main's status is read per render", /● main\s+idle/.test(list.render(80).map(plain)[2] ?? ""));
	list.handleInput("\r");
	await settle();
	check("Enter on main leaves the agent view through the prompt focus, as Esc does", exitCalls === 1 && promptTargetOf(SEAT) === undefined);

	list = await open();
	drawn = list.render(80).map(plain);
	check("back on main, the main row is gone again", !drawn.some((line) => /● main\b/.test(line)), JSON.stringify(drawn));
	list.handleInput("\x1b");
	await settle();
	hooks.get("session_shutdown")?.({}, ctx);
	forgetPromptFocus(SEAT);
	forgetAgentRuntime(SEAT);
}

// A nested agent is owned by the child that started it, not by main's runtime,
// and its name can be one of main's: Enter must never open main's namesake.
console.log("\nagent-dock: Enter on a nested agent's row");
{
	const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t, inverse: (t) => t, strikethrough: (t) => t };
	const { publishPromptFocus, forgetPromptFocus } = await jiti.import(`${KIT_ROOT}/lib/session/prompt-focus.ts`);
	const { publishAgentRuntime, forgetAgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const SEAT = "seat-nested-row";
	const channels = new Map();
	const hooks = new Map();
	const lists = [];
	const notices = [];
	const emitted = [];
	let keyListener;
	let focusedTarget;
	const tui = { requestRender: () => {}, terminal: { rows: 24 }, focusedComponent: { isEditorEmpty: () => true, historyIndex: -1 } };
	const pi = {
		on: (event, handler) => hooks.set(event, handler),
		registerCommand: () => {},
		events: { on: (channel, handler) => { channels.set(channel, handler); return () => {}; }, emit: (channel, payload) => emitted.push([channel, payload]) },
	};
	const ctx = {
		mode: "tui",
		cwd: KIT_ROOT,
		sessionManager: { getSessionId: () => SEAT },
		isIdle: () => true,
		ui: {
			setStatus: () => {},
			setWidget: (_key, factory) => factory(tui),
			onTerminalInput: (listener) => { keyListener = listener; return () => {}; },
			notify: (message, level) => notices.push({ message, level }),
			theme,
			custom: (factory) => new Promise((resolve) => lists.push(factory(tui, theme, {}, resolve))),
		},
	};
	publishPromptFocus(SEAT, { focus: (target) => { focusedTarget = target; return true; }, exit: () => {} });
	const mains = { name: "worker-2", taskId: "a2", description: "main's own worker-2" };
	publishAgentRuntime(SEAT, { registry: { byName: (name) => (name === mains.name ? mains : undefined), byTaskId: (id) => (id === mains.taskId ? mains : undefined) }, liveRun: () => undefined });
	await (await jiti.import(`${KIT_ROOT}/extensions/agent-dock/index.ts`, { default: true }))(pi);
	hooks.get("session_start")({}, ctx);
	channels.get("subagents:started")({ id: "a1", name: "lead-1", type: "lead", description: "run the chunk" });
	channels.get("subagents:started")({ id: "n1", name: "worker-2", type: "worker", description: "nested namesake", parentId: "a1" });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const nestedRow = (view) => view.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).find((line) => line.includes("nested namesake")) ?? "";
	keyListener("\x1b[B");
	await settle();
	const list = lists.at(-1);
	list.handleInput("\x1b[B");
	check("(the cursor is on the nested row)", nestedRow(list).includes("❯"));
	list.handleInput("x");
	check("x on a nested row still stops it", emitted.some(([channel, payload]) => channel === "subagents:rpc:stop" && payload.agentId === "n1"), JSON.stringify(emitted));
	list.handleInput("\r");
	await settle();
	check("Enter on a nested row opens no agent view, least of all main's namesake", focusedTarget === undefined, JSON.stringify(focusedTarget?.target));
	check("and says in one line that it cannot be opened", notices.length === 1 && /can't be opened/.test(notices[0].message) && !notices[0].message.includes("\n"), JSON.stringify(notices));
	check("the list stays open on it", lists.length === 2 && nestedRow(lists.at(-1)).includes("❯"));
	lists.at(-1).handleInput("\x1b");
	await settle();
	hooks.get("session_shutdown")?.({}, ctx);
	forgetPromptFocus(SEAT);
	forgetAgentRuntime(SEAT);
}

await finish();
