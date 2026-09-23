/**
 * One workflow run, live: its phases, the agents in the selected phase, and
 * then one agent on its own.
 *
 *     ──────────────────────────────────────────────────────────────
 *       spec-sweep
 *       One agent per spec file            3/8 agents · 1m 17s
 *
 *     ❯ 1 Sleep            3/8
 *
 *      ┌──────────────────────────────────────────────────────────┐
 *      │  Sleep                                                   │
 *      │  8 agents                                                │
 *      │                                                          │
 *      │  ✓ sleep:Singapore      fable · 31.5k              14s   │
 *      │  ● sleep:Estonia        fable · 32.2k           1m 11s   │
 *      └──────────────────────────────────────────────────────────┘
 *
 *       ↑↓ select · enter agents · x stop workflow · esc back
 *
 * **Three levels, not two.** The list is level 0 and it holds one row per run
 * (`background-tasks-view.ts`); this is level 1, the run; enter again and it is
 * level 2, one agent. `↑↓` means a different thing at each, which is why the
 * hint row is rebuilt per level rather than being one string.
 *
 * **It is not a transcript.** Level 2 shows the prompt's first two lines, the
 * last three tool calls as one line each (`Name(args)`, no result, no receipt),
 * and the agent's last words. A workflow puts five agents on a screen and each
 * of them gets a handful of rows: the receipt feed a single agent's box draws
 * (`agent-conversation-feed.ts`) is the right thing for one agent and the wrong
 * thing for eight. Both survive; neither replaces the other.
 *
 * **Two sources, joined on the task id.** The tree — phases, ordinals, labels,
 * prompts — is the run store's (`lib/workflow-runs.ts`). The per-agent numbers
 * — model, tokens, tool calls, duration, activity, final answer — are the
 * dock's rows, which is where every agent's facts already live. Neither is
 * copied into the other.
 *
 * **A finished run still draws.** Everything here comes from two records that
 * outlive the run, so the view a user opened to watch a run finish is still
 * there when it does — the one thing Claude Code deliberately keeps open
 * through completion.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { BODY_INDENT, DEFAULT_TERMINAL_ROWS, fitLine, fitToTerminalHeight, hintRow, isStepBackKey, isStepForwardKey, normalizeTerminalRows, spreadLine } from "../context-view/ui/layout.ts";
import { rule } from "../zen-chrome/chrome.ts";
import { formatDuration } from "../../lib/turn-clock.ts";
import { type WorkflowRun, type WorkflowRunAgent, workflowRunOutcomeCounts, type WorkflowRunPhase, workflowRunPhases } from "../../lib/workflow-runs.ts";
import { type AgentTask, isLiveAgentTask } from "./agent-task-registry.ts";
import { shortTaskModel } from "./background-tasks-view.ts";

/** The panel replaces the prompt editor, like the list it is opened from. */
export const WORKFLOW_VIEW_OPTIONS = { overlay: false } as const;

/** The panel's top edge: a divider in the flow, not a box. */
const PANEL_RULE_ENDS = { left: "─", right: "─" } as const;

/** Box corners. The box is a window on the phase, so it is closed on all four sides. */
const BOX = { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" } as const;

/** Spaces between the border and the content, on each side. */
const BOX_PADDING = 2;

/** Activity lines one agent shows. Claude Code shows three under a heading that says how many are hidden. */
export const ACTIVITY_LINES_SHOWN = 3;

/** Prompt lines shown before `… N more lines`. */
export const PROMPT_LINES_SHOWN = 2;

/**
 * Share of the screen the run view takes.
 *
 * Wider than the task list's half, because this draws a box of agent rows and
 * a box that has to scroll at eight agents is not a picture of the run. The
 * conversation box already takes the same share for the same reason.
 */
const VIEW_HEIGHT_PCT = 80;

/** Tallest the panel may grow, from the terminal's height. */
export function workflowViewMaxRows(terminalRows: number): number {
	const rows = normalizeTerminalRows(terminalRows);
	return Math.min(rows, Math.max(12, Math.floor((rows * VIEW_HEIGHT_PCT) / 100)));
}

/** One glyph per agent state: done and cached are answers, running is not. */
const AGENT_GLYPH: Record<WorkflowRunAgent["state"], string> = { running: "●", cached: "≡", done: "✓", failed: "✗", skipped: "⊘" };

type AgentColor = "dim" | "success" | "error" | "muted";

function agentColor(state: WorkflowRunAgent["state"]): AgentColor {
	if (state === "failed") return "error";
	// A skip is a choice, not a fault: it must not read as red on the row beside
	// an agent that actually broke.
	if (state === "skipped") return "muted";
	if (state === "running") return "dim";
	return "success";
}

/** `31.5k`, one decimal: the size of a run is a magnitude. Claude Code truncates the number itself, which is a defect, not a style. */
export function formatTokens(total: number | undefined): string | undefined {
	if (total === undefined || total <= 0) return undefined;
	if (total < 1000) return String(total);
	return `${(total / 1000).toFixed(1)}k`;
}

/** How the run view was left. */
export type WorkflowRunViewExit = { readonly kind: "closed" };

/** What the view needs; everything is re-read per render, so a run that moves is drawn as it is. */
export interface WorkflowRunViewDeps {
	/** The run, or undefined once it has been retired — which closes the view. */
	readonly run: () => WorkflowRun | undefined;
	/** The dock's row for one of the run's agents. Undefined for an agent that never ran, or one long retired. */
	readonly agentTask: (taskId: string) => AgentTask | undefined;
	/** Stop the whole run. */
	readonly stopRun: () => void;
	/** Stop one agent — the skip affordance (`x` on an agent, ticket 46 §8.3). */
	readonly stopAgent: (taskId: string) => void;
	readonly getTerminalRows?: () => number;
	readonly now?: () => number;
}

/** Open the run view. Resolves when it is left. `onRefresh` repaints it as events land. */
export async function showWorkflowRunView(ctx: ExtensionContext, deps: WorkflowRunViewDeps, onRefresh?: (refresh: () => void) => void): Promise<WorkflowRunViewExit> {
	return await ctx.ui.custom<WorkflowRunViewExit>((tui, theme, _keybindings, done) => {
		const view = new WorkflowRunView(theme, deps, done, () => tui.terminal.rows);
		onRefresh?.(() => {
			view.invalidate();
			tui.requestRender();
		});
		return {
			render: (width: number) => view.render(width),
			invalidate: () => view.invalidate(),
			handleInput: (data: string) => {
				view.handleInput(data);
				tui.requestRender();
			},
		};
	}, WORKFLOW_VIEW_OPTIONS);
}

/** Exported for render and input tests; use `showWorkflowRunView` from pi code. */
export class WorkflowRunView {
	private readonly theme: Theme;
	private readonly deps: WorkflowRunViewDeps;
	private readonly exit: (how: WorkflowRunViewExit) => void;
	private readonly getTerminalRows: () => number;
	private readonly now: () => number;
	private level: "run" | "agent" = "run";
	private phaseCursor = 0;
	private agentCursor = 0;
	private promptExpanded = false;

	public constructor(theme: Theme, deps: WorkflowRunViewDeps, exit: (how: WorkflowRunViewExit) => void, getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS) {
		this.theme = theme;
		this.deps = deps;
		this.exit = exit;
		this.getTerminalRows = deps.getTerminalRows ?? getTerminalRows;
		this.now = deps.now ?? Date.now;
	}

	public invalidate(): void {
		// Nothing cached: every render re-reads the run and the rows, which is what
		// puts an agent that just finished on the next frame.
	}

	public handleInput(data: string): void {
		const run = this.deps.run();
		if (run === undefined) return this.exit({ kind: "closed" });
		const phases = workflowRunPhases(run);
		// Esc at level 2 is one step back, not the way out: the levels are a path.
		if (matchesKey(data, Key.escape)) return this.level === "agent" ? this.leaveAgent() : this.exit({ kind: "closed" });
		if (this.level === "run") return this.handleRunInput(data, phases);
		return this.handleAgentInput(data, phases);
	}

	private handleRunInput(data: string, phases: readonly WorkflowRunPhase[]): void {
		if (isStepBackKey(data)) {
			// ↑ at the top row leaves, the way ↑ leaves the list it was opened from.
			if (this.phaseCursor === 0) return this.exit({ kind: "closed" });
			this.phaseCursor--;
			return;
		}
		if (isStepForwardKey(data)) {
			this.phaseCursor = Math.min(this.phaseCursor + 1, Math.max(0, phases.length - 1));
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if ((phases[this.phaseCursor]?.agents.length ?? 0) === 0) return;
			this.level = "agent";
			this.agentCursor = 0;
			this.promptExpanded = false;
			return;
		}
		if (data === "x") this.deps.stopRun();
	}

	private handleAgentInput(data: string, phases: readonly WorkflowRunPhase[]): void {
		const agents = phases[this.phaseCursor]?.agents ?? [];
		if (isStepBackKey(data)) {
			if (this.agentCursor === 0) return this.leaveAgent();
			this.agentCursor--;
			this.promptExpanded = false;
			return;
		}
		if (isStepForwardKey(data)) {
			this.agentCursor = Math.min(this.agentCursor + 1, Math.max(0, agents.length - 1));
			this.promptExpanded = false;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.promptExpanded = !this.promptExpanded;
			return;
		}
		const agent = agents[this.agentCursor];
		if (data === "x" && agent?.taskId !== undefined && agent.state === "running") this.deps.stopAgent(agent.taskId);
	}

	private leaveAgent(): void {
		this.level = "run";
		this.promptExpanded = false;
	}

	public render(width: number): string[] {
		const rows = workflowViewMaxRows(this.getTerminalRows());
		const run = this.deps.run();
		if (run === undefined) return fitToTerminalHeight([this.ruleRow(width), fitLine(this.theme.fg("muted", `${BODY_INDENT}This run is no longer held.`), width)], rows, "");
		const phases = workflowRunPhases(run);
		this.phaseCursor = clamp(this.phaseCursor, 0, Math.max(0, phases.length - 1));
		const lines = this.level === "agent" ? this.renderAgentLevel(run, phases, width, rows) : this.renderRunLevel(run, phases, width, rows);
		return fitToTerminalHeight(lines, rows, "");
	}

	// ---- level 1: the run ----

	private renderRunLevel(run: WorkflowRun, phases: readonly WorkflowRunPhase[], width: number, rows: number): string[] {
		const head = [this.ruleRow(width), ...this.headerBlock(run, width), ""];
		const phaseRows = phases.map((phase, at) => fitLine(this.phaseRow(phase, at, phases), width));
		const hints = fitLine(this.runHints(run), width);
		const selected = phases[this.phaseCursor];
		const spare = rows - head.length - phaseRows.length - 3;
		const box = selected === undefined ? [] : this.phaseBox(selected, width, Math.max(1, spare - 5));
		return [...head, ...phaseRows, "", ...box, "", hints];
	}

	private headerBlock(run: WorkflowRun, width: number): string[] {
		const done = run.agents.filter((agent) => agent.state !== "running").length;
		const elapsed = formatDuration((run.settledAt ?? this.now()) - run.startedAt);
		const counts = workflowRunOutcomeCounts(run);
		const stats = `${done}/${run.agents.length} agents · ${elapsed}${counts === "" ? "" : ` · ${counts}`}${runStatusSuffix(run)}`;
		return [
			fitLine(`${BODY_INDENT}${this.theme.fg("accent", this.theme.bold(run.name))}`, width),
			spreadLine(`${BODY_INDENT}${this.theme.fg("dim", run.description)}`, `${this.theme.fg("dim", stats)}${BODY_INDENT}`, width),
		];
	}

	private phaseRow(phase: WorkflowRunPhase, at: number, phases: readonly WorkflowRunPhase[]): string {
		const cursor = at === this.phaseCursor ? this.theme.fg("accent", "❯") : " ";
		const titleWidth = Math.max(...phases.map((one) => visibleWidth(one.title))) + 2;
		const title = `${phase.title}`.padEnd(titleWidth);
		const paint = at === this.phaseCursor ? "text" : "muted";
		return `${cursor} ${this.theme.fg(paint, `${phase.index} ${title}`)}${this.theme.fg("dim", `${phase.done}/${phase.total}`)}`;
	}

	private phaseBox(phase: WorkflowRunPhase, width: number, agentRows: number): string[] {
		const inner = Math.max(20, width - 4);
		const shown = phase.agents.slice(0, Math.max(1, agentRows));
		const body = [
			this.theme.fg("text", this.theme.bold(phase.title)),
			this.theme.fg("dim", `${phase.total} ${phase.total === 1 ? "agent" : "agents"}`),
			"",
			...shown.map((agent) => this.agentRow(agent, inner - BOX_PADDING * 2)),
			...(phase.agents.length > shown.length ? [this.theme.fg("dim", `… ${phase.agents.length - shown.length} more`)] : []),
		];
		const pad = Math.max(0, agentRows - shown.length);
		return this.box([...body, ...Array.from({ length: pad }, () => "")], width, inner);
	}

	/** `✓ sleep:Singapore    fable · 31.5k    14s` — glyph, label, model, tokens, duration. A running row is dim throughout. */
	private agentRow(agent: WorkflowRunAgent, inner: number): string {
		const task = agent.taskId === undefined ? undefined : this.deps.agentTask(agent.taskId);
		const color = agentColor(agent.state);
		const labelWidth = Math.max(12, Math.floor(inner * 0.42));
		const label = pad(truncateToWidth(agent.label, labelWidth - 2, "…"), labelWidth - 2);
		const meta = [task?.model === undefined || task.model === "" ? undefined : shortTaskModel(task.model), formatTokens(task?.totalTokens)].filter(present).join(" · ");
		const duration = this.agentDuration(agent, task);
		const bright = agent.state === "running" ? "dim" : "text";
		const left = `${this.theme.fg(color, AGENT_GLYPH[agent.state])} ${this.theme.fg(bright, label)}  ${this.theme.fg("dim", meta)}`;
		return spreadLine(left, this.theme.fg("dim", duration), inner);
	}

	private agentDuration(agent: WorkflowRunAgent, task: AgentTask | undefined): string {
		if (task === undefined) return agent.state === "cached" ? "cached" : "";
		if (task.durationMs !== undefined && !isLiveAgentTask(task)) return formatDuration(task.durationMs);
		return formatDuration(this.now() - task.startedAt);
	}

	// ---- level 2: one agent ----

	private renderAgentLevel(run: WorkflowRun, phases: readonly WorkflowRunPhase[], width: number, rows: number): string[] {
		const agents = phases[this.phaseCursor]?.agents ?? [];
		this.agentCursor = clamp(this.agentCursor, 0, Math.max(0, agents.length - 1));
		const agent = agents[this.agentCursor];
		const head = [this.ruleRow(width), ...this.headerBlock(run, width), ""];
		const hints = fitLine(this.agentHints(agent), width);
		if (agent === undefined) return [...head, fitLine(this.theme.fg("muted", `${BODY_INDENT}No agent in this phase yet.`), width), "", hints];
		const inner = Math.max(20, width - 4);
		const body = this.agentBody(run, agent, inner - BOX_PADDING * 2, Math.max(4, rows - head.length - 5));
		return [...head, ...this.box(body, width, inner), "", hints];
	}

	private agentBody(run: WorkflowRun, agent: WorkflowRunAgent, inner: number, budget: number): string[] {
		const task = agent.taskId === undefined ? undefined : this.deps.agentTask(agent.taskId);
		const lines = [this.agentTitle(run, agent, inner), this.agentStatusLine(agent, task), this.theme.fg("dim", this.agentStats(agent, task)), ""];
		lines.push(...this.promptBlock(agent, inner));
		lines.push("", ...this.activityBlock(task, inner));
		lines.push("", ...this.outcomeBlock(agent, task, inner));
		const pad = Math.max(0, budget - lines.length);
		return [...lines, ...Array.from({ length: pad }, () => "")];
	}

	private agentTitle(run: WorkflowRun, agent: WorkflowRunAgent, inner: number): string {
		const label = truncateToWidth(agent.label, Math.max(8, inner - 10), "…");
		return `${this.theme.fg("accent", this.theme.bold(label))}${this.theme.fg("dim", ` · ${agent.ordinal}/${run.agents.length}`)}`;
	}

	private agentStatusLine(agent: WorkflowRunAgent, task: AgentTask | undefined): string {
		const word = { running: "Running", cached: "Cached", done: "Completed", failed: "Failed", skipped: "Skipped" }[agent.state];
		const color = agentColor(agent.state);
		const model = task?.model === undefined || task.model === "" ? undefined : shortTaskModel(task.model);
		return `${this.theme.fg(color, `${AGENT_GLYPH[agent.state]} ${word}`)}${model === undefined ? "" : this.theme.fg("dim", ` · ${model}`)}`;
	}

	/** `32.2k tok · 6 tool calls · idle 55s`; once settled the idle age gives way to the duration. */
	private agentStats(agent: WorkflowRunAgent, task: AgentTask | undefined): string {
		if (task === undefined) return agent.state === "cached" ? "replayed from the journal" : "not started";
		const tokens = formatTokens(task.totalTokens);
		const calls = task.toolUses === undefined || task.toolUses === 0 ? undefined : `${task.toolUses} tool ${task.toolUses === 1 ? "call" : "calls"}`;
		const live = isLiveAgentTask(task);
		const age = live ? (task.lastActivityAt === undefined ? undefined : `idle ${formatDuration(this.now() - task.lastActivityAt)}`) : task.durationMs === undefined ? undefined : formatDuration(task.durationMs);
		return [tokens === undefined ? undefined : `${tokens} tok`, calls, age].filter(present).join(" · ") || "nothing yet";
	}

	private promptBlock(agent: WorkflowRunAgent, inner: number): string[] {
		const all = agent.prompt.split("\n").filter((line) => line.trim() !== "");
		if (all.length === 0) return [this.theme.fg("text", this.theme.bold("Prompt")), this.theme.fg("dim", "  (none recorded)")];
		const shown = this.promptExpanded ? all : all.slice(0, PROMPT_LINES_SHOWN);
		const hidden = all.length - shown.length;
		const heading = [this.theme.fg("text", this.theme.bold("Prompt")), this.theme.fg("dim", ` · ${all.length} ${all.length === 1 ? "line" : "lines"}`), all.length > PROMPT_LINES_SHOWN ? this.theme.fg("dim", ` · ⏎ ${this.promptExpanded ? "collapse" : "expand"}`) : ""].join("");
		return [heading, ...shown.map((line) => this.theme.fg("muted", `  ${truncateToWidth(line, Math.max(8, inner - 2), "…")}`)), ...(hidden > 0 ? [this.theme.fg("dim", `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`)] : [])];
	}

	/** `Activity · last 3 of 6 tool calls`, then one line per call. No results, no receipts — see the header. */
	private activityBlock(task: AgentTask | undefined, inner: number): string[] {
		const calls = task?.toolUses ?? 0;
		const tail = (task?.activity ?? []).slice(-ACTIVITY_LINES_SHOWN);
		if (tail.length === 0) return [this.theme.fg("text", this.theme.bold("Activity")), this.theme.fg("dim", "  no tool calls yet")];
		const heading = `${this.theme.fg("text", this.theme.bold("Activity"))}${this.theme.fg("dim", ` · last ${tail.length} of ${Math.max(calls, tail.length)} tool ${calls === 1 ? "call" : "calls"}`)}`;
		return [heading, ...tail.map((line) => this.theme.fg("muted", `  ${truncateToWidth(line, Math.max(8, inner - 2), "…")}`))];
	}

	private outcomeBlock(agent: WorkflowRunAgent, task: AgentTask | undefined, inner: number): string[] {
		const heading = this.theme.fg("text", this.theme.bold("Outcome"));
		const text = agent.reason ?? task?.error ?? task?.result ?? (agent.state === "running" ? "Still running…" : undefined);
		if (text === undefined) return [heading, this.theme.fg("dim", "  nothing yet")];
		const color = agent.state === "failed" ? "error" : "muted";
		const wrapped = wrapPlain(text, Math.max(8, inner - 2)).slice(0, 3);
		return [heading, ...wrapped.map((line) => this.theme.fg(color, `  ${line}`))];
	}

	// ---- chrome ----

	private ruleRow(width: number): string {
		return rule(width, [], [], (text) => this.theme.fg("dim", text), PANEL_RULE_ENDS);
	}

	/** One box, its content already painted and one cell narrower than the inside. */
	private box(body: readonly string[], width: number, inner: number): string[] {
		const side = this.theme.fg("dim", BOX.vertical);
		const top = this.theme.fg("dim", `${BOX.topLeft}${BOX.horizontal.repeat(inner)}${BOX.topRight}`);
		const bottom = this.theme.fg("dim", `${BOX.bottomLeft}${BOX.horizontal.repeat(inner)}${BOX.bottomRight}`);
		const rows = body.map((line) => `${side}  ${padPainted(line, inner - BOX_PADDING * 2)}  ${side}`);
		return [` ${top}`, ...rows.map((line) => ` ${line}`), ` ${bottom}`].map((line) => fitLine(line, width));
	}

	private runHints(run: WorkflowRun): string {
		const hints: Array<readonly [string, string]> = [["↑↓", "select"], ["enter", "agents"]];
		if (run.status === "running") hints.push(["x", "stop workflow"]);
		hints.push(["esc", "back"]);
		return hintRow(this.theme, hints);
	}

	private agentHints(agent: WorkflowRunAgent | undefined): string {
		const hints: Array<readonly [string, string]> = [["↑↓", "agent"], ["⏎", "expand"]];
		if (agent?.state === "running" && agent.taskId !== undefined) hints.push(["x", "skip"]);
		hints.push(["esc", "back"]);
		return hintRow(this.theme, hints);
	}
}

/** ` · stopped` and the rest: the run's own word, only when it has one. */
function runStatusSuffix(run: WorkflowRun): string {
	return run.status === "running" ? "" : ` · ${run.status === "completed" ? "done" : run.status}`;
}

function present(part: string | undefined): part is string {
	return part !== undefined && part !== "";
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Pad a painted line to a visible width, so a box's right edge stays put. */
function padPainted(line: string, width: number): string {
	const shown = truncateToWidth(line, width, "…");
	const gap = width - visibleWidth(shown);
	return gap > 0 ? shown + " ".repeat(gap) : shown;
}

/** Wrap unpainted text at a width, on spaces where there are any. */
function wrapPlain(text: string, width: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current === "") current = word;
		else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current !== "") lines.push(current);
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(high, value));
}
