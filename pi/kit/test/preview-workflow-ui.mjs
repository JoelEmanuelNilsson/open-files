/**
 * Draws the three levels of the workflow UI with a made-up run, so the layout
 * can be looked at instead of reasoned about. Not part of `npm test`.
 *
 *   node test/preview-workflow-ui.mjs [width]
 *   PI_PREVIEW_THEME=dark node test/preview-workflow-ui.mjs
 *
 * Every visual change to these views was previously verified by reading
 * assertion strings, which is how a view can be correct in every test and
 * unreadable on a screen. This is the picture.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme(process.env.PI_PREVIEW_THEME || "dark", false);
const theme = themeModule.theme;

const listView = await jiti.import(`${ROOT}/extensions/agent-dock/background-tasks-view.ts`);
const runView = await jiti.import(`${ROOT}/extensions/agent-dock/workflow-run-view.ts`);
const store = await jiti.import(`${ROOT}/lib/workflow-runs.ts`);

const width = Number(process.argv[2] || 84);
const NOW = 1_000_000;
const rows = 34;

// ---------------------------------------------------------------------------
// A run: one phase, eight agents, three of them done.
// ---------------------------------------------------------------------------
const COUNTRIES = ["Singapore", "Estonia", "United Arab Emirates", "Ireland", "Switzerland", "United States (Delaware)", "Hong Kong", "Netherlands"];
const DONE = new Set([1, 5, 6]);

const runs = new store.WorkflowRunStore();
runs.start({ runId: "wf_1", taskId: "run-1", name: "business-countries-sleep-test", description: "Fan-out test: one free agent per candidate country, each just sleeps 5 minutes", startedAt: NOW - 77_000 });
for (const [at, country] of COUNTRIES.entries()) {
	const ordinal = at + 1;
	runs.apply("wf_1", { type: "agent-start", ordinal, label: `sleep:${country}`, phase: "Sleep" });
	runs.noteSpawn("wf_1", ordinal, {
		taskId: `child-${ordinal}`,
		prompt: "This is a timing test of a workflow fan-out, not\na real research task. Do not look up or reason\nabout the country you are given.\nRun `sleep 300` with Bash.\nWhen it returns, reply with the single word done.\nNothing else.",
	});
	if (DONE.has(ordinal)) runs.apply("wf_1", { type: "agent-done", ordinal });
}
const run = runs.get("wf_1");

const ACTIVITY = ["ToolSearch(select:Monitor)", "Bash(sleep 300)", "Monitor(start=$(date +%s); while true; do now=$(date +%s); if [ $((now-start)) -ge 300 ]; then break; fi; done)"];

/** One of the run's agents as the dock's registry holds it. */
function childTask(taskId) {
	const ordinal = Number(taskId.split("-")[1]);
	const done = DONE.has(ordinal);
	return {
		id: taskId,
		name: `sleep:${COUNTRIES[ordinal - 1]}`,
		type: "worker",
		description: `sleep:${COUNTRIES[ordinal - 1]}`,
		model: "anthropic/claude-sonnet-5",
		workflowChild: true,
		runId: undefined,
		status: done ? "completed" : "running",
		startedAt: NOW - 71_000,
		settledAt: done ? NOW - 55_000 : undefined,
		durationMs: done ? 18_000 : undefined,
		toolUses: done ? 4 : 6,
		lastActivityAt: NOW - 55_000,
		totalTokens: done ? 31_300 : 32_200,
		costUsd: undefined,
		activity: done ? ACTIVITY : ["Monitor(start=$(date +%s); until [ $(( $(date +%s) - start )) -ge 300 ]; do :; done)", "Bash(true)", "Bash(i=0; while [ $i -lt 300 ]; do sleep 1; i=$((i+1)); done)"],
		result: done ? "I'll wait for the monitor to report completion before responding." : undefined,
		error: undefined,
		outcome: done ? "completed" : undefined,
		stopRequested: false,
	};
}

const runTask = { ...childTask("child-1"), id: "run-1", name: "business-countries-sleep-test", type: "workflow", description: run.description, workflowChild: false, runId: "wf_1", status: "running", settledAt: undefined, durationMs: undefined, activity: [], result: undefined, outcome: undefined };
const localAgent = { ...childTask("child-2"), id: "a1", name: "worker-1", type: "worker", description: "Audit the config loader", workflowChild: false, runId: undefined, activity: [] };

function frame(title, lines) {
	console.log(`\n\x1b[2m── ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}\x1b[0m`);
	for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------------------
// Level 0: the list, grouped.
// ---------------------------------------------------------------------------
{
	const view = new listView.BackgroundTasksView(theme, { tasks: () => [localAgent, runTask], runOf: (id) => runs.byTaskId(id), stop: () => {}, now: () => NOW, getTerminalRows: () => 20 }, () => {});
	frame("level 0 — the tasks list, grouped", view.render(width));
}

// ---------------------------------------------------------------------------
// Levels 1 and 2.
// ---------------------------------------------------------------------------
const deps = { run: () => runs.get("wf_1"), agentTask: (id) => childTask(id), stopRun: () => {}, stopAgent: () => {}, now: () => NOW, getTerminalRows: () => rows };

{
	const view = new runView.WorkflowRunView(theme, deps, () => {});
	frame("level 1 — the run", view.render(width));
}
{
	const view = new runView.WorkflowRunView(theme, deps, () => {});
	view.handleInput("\r");
	view.handleInput("\x1b[B");
	frame("level 2 — one agent, running", view.render(width));
}
{
	const view = new runView.WorkflowRunView(theme, deps, () => {});
	view.handleInput("\r");
	for (let at = 0; at < 4; at++) view.handleInput("\x1b[B");
	frame("level 2 — one agent, completed", view.render(width));
}
{
	const view = new runView.WorkflowRunView(theme, deps, () => {});
	view.handleInput("\r");
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	frame("level 2 — the prompt expanded", view.render(width));
}
