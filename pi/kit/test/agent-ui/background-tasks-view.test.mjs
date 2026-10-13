/**
 * The Tasks list: its rows, groups, keys and layout, and the wave that says a
 * row is running. **A live row moves, and a settled one is byte for byte the
 * row it would be with no animation at all.**
 *
 *   node test/agent-ui/background-tasks-view.test.mjs
 */

import { check, eq, finish } from "../support/check-harness.mjs";
import { importPi, KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { identityTheme } from "../support/identity-theme.mjs";

const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const jiti = kitJiti();
const view = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/background-tasks-view.ts`);

// An identity theme: every escape on a rendered line then came from the view itself.
const theme = identityTheme;

console.log("background-tasks-view: the modal");
{
	const { BackgroundTasksView, BACKGROUND_TASKS_TITLE, TASKS_VIEW_OPTIONS, taskStatusText, tasksPanelMaxRows, shortTaskModel, IDLE_VISIBLE_MS } = view;
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
	// `↓` from the prompt opens with no selectedId (index.ts `runTasksModal`): a long list starts at its top, cursor on row one.
	const opened = new BackgroundTasksView(theme, { tasks: () => crowd, stop: () => {} }, () => {}, () => 24).render(80).map(plain);
	check("a long list opened with no selection starts at the top, cursor on the first task", /❯.*task 0\b/.test(opened.find((line) => line.includes("task 0")) ?? ""));
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
console.log("\nbackground-tasks-view: motion means running");
{
	const { BackgroundTasksView, ROW_FRAME_MS } = view;
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
	const previousWave = process.env.PI_ZEN_WAVE;
	process.env.PI_ZEN_WAVE = "off";
	const { BackgroundTasksView: WaveOffView } = await kitJiti({ moduleCache: false }).import(`${KIT_ROOT}/extensions/agent-dock/background-tasks-view.ts`);
	if (previousWave === undefined) delete process.env.PI_ZEN_WAVE;
	else process.env.PI_ZEN_WAVE = previousWave;
	const waveOff = new WaveOffView(theme, { tasks: () => [task({ totalTokens: 32_000 })], stop: () => {}, now: () => 1_000 }, () => {}, () => 24)
		.render(80)
		.find((line) => strip(line).includes("audit the wire"));
	check("PI_ZEN_WAVE=off leaves a running row still", !waveOff.includes("\x1b"), JSON.stringify(waveOff));

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

// Joel: "show subagents each task/subagent has launched like in the '⎿' symbol".
// Fed through the dock's real registry, so the order is the one the dock hands over.
console.log("\nbackground-tasks-view: each task's agents nest under it");
{
	const { BackgroundTasksView, listEntries } = view;
	const { AgentTaskRegistry } = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/agent-task-registry.ts`);
	const registry = new AgentTaskRegistry();
	const start = (at, id, type, description, parentId) =>
		registry.applyLifecycleEvent("started", { id, type, description, model: "anthropic/claude-opus-4-1", ...(parentId === undefined ? {} : { parentId }) }, at);
	start(1, "lead", "lead", "Engine v0: build and measure");
	start(2, "w1", "worker", "build the engine", "lead");
	start(3, "solo", "worker", "a task of its own");
	start(4, "w2", "worker", "measure it", "lead");
	start(5, "g1", "worker", "probe the cache", "w1");
	start(6, "orphan", "worker", "whose lead is gone", "trimmed-away");
	const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const make = (exit = () => {}) => new BackgroundTasksView(theme, { tasks: () => registry.list(), stop: () => {}, now: () => 10 }, exit, () => 40);
	const frame = make().render(80).map(strip);
	const body = frame.filter((line) => /●/.test(line)).map((line) => line.trimEnd());
	eq("each child sits under its parent, one level deeper per generation", body, [
		"  ❯ ● lead opus Engine v0: build and measure",
		"    ⎿ ● worker opus build the engine",
		"      ⎿ ● worker opus probe the cache",
		"    ⎿ ● worker opus measure it",
		"    ● worker opus a task of its own",
		"    ● worker opus whose lead is gone",
	]);
	eq("the list hands its rows over in the order they are drawn", listEntries(registry.list()).map((entry) => entry.task.id), ["lead", "w1", "g1", "w2", "solo", "orphan"]);
	const opened = [];
	const nav = make((how) => opened.push(how.id));
	nav.render(80);
	for (let i = 0; i < 2; i++) nav.handleInput("\x1b[B");
	check("↓ walks the rows in the order they are drawn", nav.render(80).map(strip).find((line) => line.includes("probe the cache")).includes("❯"));
	nav.handleInput("\r");
	eq("and enter opens the row the cursor is on", opened, ["g1"]);

	const withMain = new BackgroundTasksView(theme, { tasks: () => registry.list(), stop: () => {}, now: () => 10, mainRow: () => "idle", selectedId: "g1" }, () => {}, () => 40);
	const rows = withMain.render(80).map(strip).filter((line) => /●/.test(line)).map((line) => line.trimEnd());
	check("with an agent focused, main is first and the nesting under it is unchanged", /^\s+● main\s+idle$/.test(rows[0]) && rows.slice(1).map((line) => line.replace("❯", " ")).join("\n") === body.map((line) => line.replace("❯", " ")).join("\n"), JSON.stringify(rows));
	check("and the cursor opens on the nested agent it was given", rows.find((line) => line.includes("probe the cache")).includes("❯"));
	eq("the entries are main, then the tree", listEntries(registry.list(), "idle").map((entry) => (entry.kind === "task" ? `${entry.task.id}:${entry.depth}` : entry.kind)), ["main", "lead:0", "w1:1", "g1:2", "w2:1", "solo:0", "orphan:0"]);
}

// While an agent view replaces main's transcript, the list's first row goes back to main.
console.log("\nbackground-tasks-view: the main row");
{
	const { BackgroundTasksView, listEntries } = view;
	const task = (over) => ({ id: "a1", name: "worker-1", type: "worker", description: "audit the wire", model: "", status: "completed", startedAt: 0, durationMs: 1_000, stopRequested: false, ...over });
	const tasks = [task(), task({ id: "a2", name: "worker-2", description: "map the kit" })];
	const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const exits = [];
	const make = (main, selectedId) => new BackgroundTasksView(theme, { tasks: () => tasks, stop: () => {}, mainRow: () => main, selectedId }, (how) => exits.push(how), () => 24);
	const rowOf = (lines, text) => lines.find((line) => line.includes(text)) ?? "";

	check("with main on screen there is no main row", !make(undefined).render(80).map(plain).some((line) => /● main\b/.test(line)));
	const rows = make("working", "a2").render(80).map(plain);
	const mainAt = rows.findIndex((line) => /● main\b/.test(line));
	check("with an agent focused the first row is main", mainAt === 2 && rows.findIndex((line) => line.includes("audit the wire")) > mainAt, JSON.stringify(rows));
	check("shaped like the other rows, with main's status on the right", /^\s+ ● main\s+working\s*$/.test(rows[mainAt]), JSON.stringify(rows[mainAt]));
	check("the cursor opens on the focused agent's row, not on main", rowOf(rows, "map the kit").includes("❯") && !rows[mainAt].includes("❯"));
	check("idle says idle", /main\s+idle/.test(rowOf(make("idle").render(80).map(plain), "● main")));

	const toMain = make("idle", "a1");
	toMain.render(80);
	toMain.handleInput("\x1b[A");
	check("↑ from the first agent reaches main", rowOf(toMain.render(80).map(plain), "● main").includes("❯"));
	toMain.handleInput("x");
	check("x on main stops nothing and does not leave", exits.length === 0);
	toMain.handleInput("\r");
	eq("Enter on main leaves the agent view", exits, [{ kind: "main" }]);
	exits.length = 0;
	toMain.handleInput("\x1b[A");
	eq("↑ on main, the top row, closes the list", exits, [{ kind: "closed" }]);

	const grouped = listEntries([task(), task({ id: "r1", runId: "run-1" })], "idle").map((entry) => entry.kind);
	eq("with group headers the main row is set off by a blank", grouped, ["main", "blank", "header", "task", "blank", "header", "task"]);
	eq("without them it is simply first", listEntries(tasks, "idle").map((entry) => entry.kind), ["main", "task", "task"]);
}

await finish();
