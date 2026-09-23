/**
 * The background tasks modal: one row per agent, Enter to open one in its box
 * (`agent-conversation-box.ts`), `x` to stop one, Esc to leave.
 *
 * Opened by one `↓` at an empty prompt (see `open-tasks-on-down-key.ts`), which
 * is the only affordance — there is no hint row anywhere, because the label in
 * the bottom rule already carries the arrow that opens this.
 *
 * **The list is grouped, and the groups are the point.** A workflow run is one
 * row under `Dynamic workflows`; the twenty agents it spawned are not rows at
 * all — they are the run's, and the run's view is where they are
 * (`workflow-run-view.ts`). Before this, a twenty-item workflow put twenty-one
 * rows here, indistinguishable from agents launched by hand, and the count in
 * the bottom rule claimed the seat was waiting on all of them. Headers appear
 * only when there is more than one group: a header exists to separate, and with
 * one group there is nothing to separate from.
 *
 * A row reads `● worker fable Research: prices`: the agent type, then the
 * model in the same word the top rule uses (`zen-chrome/model-label.ts`), then
 * the description. The model is looked up per render, because the lifecycle
 * events never carry it and it is only known once the agent's session exists.
 *
 * **It stands where the prompt box was.** Claude Code's dialog replaces the
 * prompt input in the flow (`PromptInput.tsx:2124`), and pi's `ctx.ui.custom`
 * without `overlay` does the same: the component takes the editor's slot in
 * the dock, the transcript stays above it, and the editor comes back with its
 * text when this closes. Nothing floats and nothing splits. Two overlay
 * placements were tried live before this and both were wrong: centred reads as
 * a block printed **in** the transcript, and bottom-anchored over the editor
 * reads as a pane split. `tasksPanelMaxRows` still caps the height at half the
 * screen so the transcript above is never squeezed out.
 *
 * **`↑` at the top row closes**, mirroring the `↓` that opened it. Without this,
 * `↑` at the top row is the one key that visibly does nothing, on the very
 * screen a user reaches for it. Enter hands the chosen task back to the dock
 * and closes: the box is a different shape, so it is a different overlay, and
 * the dock reopens this one when the box is left.
 *
 * **A running row moves, and says no state word at all.** The chat box's wave
 * (`zen-chrome/animate.ts`) rolls left to right across the row's own text —
 * the tags and the description — and never across the dot or the right-hand
 * column, so the numbers stay readable while the light passes them. Motion is
 * the only property of a terminal cell that cannot be mistaken for content, so
 * it is what "in flight" is said with; a word saying `running` next to a
 * coloured dot was width spent twice on one fact (ticket 53).
 *
 * The right-hand column is then only what the eye cannot infer: the context the
 * child is carrying, and how long it has been quiet once that crosses
 * `IDLE_VISIBLE_MS`. The idle age alone separates a wedged child from a busy
 * one, and it is the number worth the repaint the wave already pays for.
 *
 * A settled row has no motion and says what it cost: `2m 26s · 48k context`. A
 * failure keeps its word in front — `failed · 1m 04s · 12k context` — because
 * that is a fact and not a state. `queued` and `stopping…` keep their words
 * too: one has not started, the other is a request.
 *
 * The chrome (indent, viewport maths, hint row, width fitting) is the kit's
 * existing dialog vocabulary from `context-view/ui/layout.ts`, the same one
 * `/skills` wears, so this is one more dialog rather than a second grammar.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

import { hex, type Rgb, rgbFromPainted, ROW_FRAME_MS } from "../zen-chrome/animate.ts";
import { ROW_LIGHT, shadeLine } from "../zen-chrome/prism.ts";
import { type Piece, rule } from "../zen-chrome/chrome.ts";
import { shortModelId } from "../zen-chrome/model-label.ts";

import {
	BODY_INDENT,
	calculateViewport,
	DEFAULT_TERMINAL_ROWS,
	fitLine,
	fitToTerminalHeight,
	hintRow,
	isPageBackKey,
	isPageForwardKey,
	isStepBackKey,
	isStepForwardKey,
	normalizeTerminalRows,
	spreadLine,
} from "../context-view/ui/layout.ts";
import { formatDuration } from "../../lib/turn-clock.ts";
import type { WorkflowRun } from "../../lib/workflow-runs.ts";
import { type AgentTask, isLiveAgentTask, isWorkflowRunTask } from "./agent-task-registry.ts";

/** Title of the modal. Claude Code's words, and the ones the count promises. */
/** A blocking agent counts too, so the title does not say "background". */
export const BACKGROUND_TASKS_TITLE = "Tasks";

/** Group header for agents this seat launched itself. Render order is nav order. */
export const AGENT_GROUP_TITLE = "Local agents";

/** Group header for workflow runs. Claude Code's own words, from its shipped binary. */
export const WORKFLOW_GROUP_TITLE = "Dynamic workflows";

/** Rows the chrome takes: the rule, a blank, a blank, the hints. Exactly. */
const FIXED_LINE_COUNT = 4;

/** The panel's rule has no corners: it is a divider in the flow, not a box. */
const PANEL_RULE_ENDS = { left: "─", right: "─" } as const;

/** In the editor's slot, not floating over it. See the header. */
export const TASKS_VIEW_OPTIONS = { overlay: false } as const;

/**
 * The tallest the panel may grow: half the screen, so more transcript than
 * panel is always visible and the panel can never be mistaken for the whole
 * screen. Short terminals get the chrome plus one task row, which is the least
 * that still says something.
 */
export function tasksPanelMaxRows(terminalRows: number): number {
	const rows = normalizeTerminalRows(terminalRows);
	return Math.min(rows, Math.max(FIXED_LINE_COUNT + 1, Math.floor(rows / 2)));
}

/** In flight, settled, failed — the transcript's three states, same glyph. */
const TASK_GLYPH = "●";

/**
 * How quiet a running agent has to be before its row says so. Progress goes out
 * on every session event, throttled to a second, so anything past this is an
 * agent that has genuinely done nothing — not a gap between two tool calls.
 */
export const IDLE_VISIBLE_MS = 20_000;

// The dock's clock (`modal-repaint.ts`) runs at this rate, and only while this
// modal is open with something live. It is defined with the other frame rates
// because the row light's speed limit is derived from it, and re-exported here
// because this is the only thing that runs on it.
export { ROW_FRAME_MS };

/** The row's resting colour for a theme that paints `dim` in nothing readable. */
const FALLBACK_REST: Rgb = hex("#5b4a6e");

/**
 * `anthropic/claude-fable-5-1` → `fable`: the provider dropped, the rest
 * shortened the way the top rule shortens it, so the two never disagree.
 */
export function shortTaskModel(modelId: string): string {
	const slash = modelId.lastIndexOf("/");
	return shortModelId(slash === -1 ? modelId : modelId.slice(slash + 1));
}

/** How the modal was left: closed, or closed to open one task's box. */
export type BackgroundTasksExit = { readonly kind: "closed" } | { readonly kind: "open"; readonly id: string };

/** What the modal needs from the session, so the view itself stays testable. */
export interface BackgroundTasksViewDeps {
	/** The session's tasks, live first. Re-read on every render. */
	readonly tasks: () => readonly AgentTask[];
	/** The run behind a workflow row, for its agent count. Absent where there are no runs to draw. */
	readonly runOf?: (taskId: string) => WorkflowRun | undefined;
	/** Ask the engine to stop one agent. Fire and forget; the row waits for the event. */
	readonly stop: (id: string) => void;
	readonly getTerminalRows?: () => number;
	/** The clock the row's age and its wave are read from. Injected so a render is reproducible. */
	readonly now?: () => number;
	/** Task id to put the cursor on when the modal opens; the one whose box was just left. */
	readonly selectedId?: string | undefined;
}

/**
 * Open the modal. Resolves with how it was left.
 *
 * `onRefresh` is handed a function that repaints the open modal, so the caller
 * can push a completion onto the screen the moment its event lands.
 */
export async function showBackgroundTasksView(
	ctx: ExtensionContext,
	deps: BackgroundTasksViewDeps,
	onRefresh?: (refresh: () => void) => void,
): Promise<BackgroundTasksExit> {
	return await ctx.ui.custom<BackgroundTasksExit>(
		(tui, theme, _keybindings, done) => {
			const view = new BackgroundTasksView(theme, deps, done, () => tui.terminal.rows);
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
		},
		TASKS_VIEW_OPTIONS,
	);
}

/** Exported for render and input tests; use `showBackgroundTasksView` from pi code. */
export class BackgroundTasksView {
	private readonly theme: Theme;
	private readonly deps: BackgroundTasksViewDeps;
	private readonly exit: (how: BackgroundTasksExit) => void;
	private readonly getTerminalRows: () => number;
	private readonly now: () => number;
	private cursor = 0;
	private scrollTop = 0;

	public constructor(
		theme: Theme,
		deps: BackgroundTasksViewDeps,
		exit: (how: BackgroundTasksExit) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
	) {
		this.theme = theme;
		this.deps = deps;
		this.exit = exit;
		this.getTerminalRows = deps.getTerminalRows ?? getTerminalRows;
		this.now = deps.now ?? Date.now;
		if (deps.selectedId !== undefined) {
			const at = listEntries(deps.tasks()).findIndex((entry) => entry.kind === "task" && entry.task.id === deps.selectedId);
			if (at >= 0) this.cursor = at;
		}
		this.cursor = this.settleCursor(listEntries(deps.tasks()), this.cursor, 1);
	}

	private close(): void {
		this.exit({ kind: "closed" });
	}

	public invalidate(): void {
		// Nothing cached: every render re-reads the registry, which is the point —
		// an agent that finished while this was open shows up on the next frame.
	}

	public handleInput(data: string): void {
		const entries = listEntries(this.deps.tasks());
		if (matchesKey(data, Key.escape)) return this.close();
		// ↑ at the top row is the way back out, the way `↓` was the way in.
		if (isStepBackKey(data)) return this.atFirstTask(entries) ? this.close() : this.moveCursor(-1, entries);
		if (isStepForwardKey(data)) return this.moveCursor(1, entries);
		if (isPageBackKey(data)) return this.moveCursor(-this.pageSize(entries.length), entries);
		if (isPageForwardKey(data)) return this.moveCursor(this.pageSize(entries.length), entries);
		const entry = entries[this.cursor];
		const selected = entry?.kind === "task" ? entry.task : undefined;
		if (selected === undefined) return;
		if (matchesKey(data, Key.enter)) return this.exit({ kind: "open", id: selected.id });
		// Stopping a settled agent is refused by the bus anyway; not asking keeps
		// the refusal off the screen.
		if (data === "x" && isLiveAgentTask(selected)) this.deps.stop(selected.id);
	}

	public render(width: number): string[] {
		return fitToTerminalHeight(this.renderList(width), this.panelRows(), "");
	}

	/** The row budget this render must live inside; see `tasksPanelMaxRows`. */
	private panelRows(): number {
		return tasksPanelMaxRows(this.getTerminalRows());
	}

	/** The panel's top edge: a full-width rule with a left label and a right one. */
	private ruleRow(left: string, right: string, width: number): string {
		const leftPiece: Piece[] = [{ text: left, paint: (text) => this.theme.fg("accent", this.theme.bold(text)) }];
		const rightPiece: Piece[] = right === "" ? [] : [{ text: right, paint: (text) => this.theme.fg("muted", text) }];
		return rule(width, leftPiece, rightPiece, (text) => this.theme.fg("dim", text), PANEL_RULE_ENDS);
	}

	// ---- list ----

	private renderList(width: number): string[] {
		const tasks = this.deps.tasks();
		const entries = listEntries(tasks);
		this.cursor = this.settleCursor(entries, clamp(this.cursor, 0, Math.max(0, entries.length - 1)), 1);
		const { visibleCount, showScroll } = calculateViewport(entries.length, this.panelRows(), FIXED_LINE_COUNT);
		this.scrollTop = scrollInto(this.cursor, this.scrollTop, visibleCount, entries.length);

		const lines = [this.titleRow(tasks, width), ""];
		if (entries.length === 0) {
			lines.push(fitLine(this.theme.fg("muted", `${BODY_INDENT}No background tasks.`), width));
		}
		for (const [offset, entry] of entries.slice(this.scrollTop, this.scrollTop + visibleCount).entries()) {
			lines.push(fitLine(this.entryRow(entry, this.scrollTop + offset, width), width));
		}
		if (showScroll) {
			const shown = Math.min(this.scrollTop + visibleCount, entries.length);
			lines.push(fitLine(this.theme.fg("dim", `${BODY_INDENT}${shown} of ${entries.length}`), width));
		}
		lines.push("", fitLine(this.listHints(), width));
		return lines;
	}

	private entryRow(entry: ListEntry, position: number, width: number): string {
		if (entry.kind === "blank") return "";
		if (entry.kind === "header") return `${BODY_INDENT}  ${this.theme.fg("text", this.theme.bold(entry.title))} ${this.theme.fg("dim", `(${entry.count})`)}`;
		return this.taskRow(entry.task, position, width);
	}

	private titleRow(tasks: readonly AgentTask[], width: number): string {
		const live = tasks.filter(isLiveAgentTask).length;
		const summary = live > 0 ? `${live} running` : `${tasks.length} finished`;
		return this.ruleRow(BACKGROUND_TASKS_TITLE, summary, width);
	}

	private taskRow(task: AgentTask, position: number, width: number): string {
		const now = this.now();
		const cursor = position === this.cursor ? this.theme.fg("accent", "❯") : " ";
		const glyph = this.theme.fg(taskColor(task), TASK_GLYPH);
		const run = isWorkflowRunTask(task) ? this.deps.runOf?.(task.id) : undefined;
		// A run is addressed by its name; an agent by what it was asked to do.
		const label = isWorkflowRunTask(task) && task.name !== "" ? task.name : task.description === "" ? task.id : task.description;
		const lead = [task.type, task.model === "" ? "" : shortTaskModel(task.model)].filter((part) => part !== "");
		const prefix = lead.length === 0 ? "" : `${this.theme.fg("muted", lead.join(" "))} `;
		return spreadLine(
			`${BODY_INDENT}${cursor} ${glyph} ${this.wave(task, `${prefix}${this.theme.fg("text", label)}`, now)}`,
			`${this.theme.fg("dim", run === undefined ? taskStatusText(task, now) : workflowRowText(task, run, now))}${BODY_INDENT}`,
			width,
		);
	}

	/**
	 * The row's own text, with the light over it while the agent runs.
	 *
	 * A settled row never enters this, so a still row is the bytes it always was.
	 * Each row lights on its own start time: siblings launched seconds apart
	 * de-phase, and one row's motion stays one row's.
	 *
	 * The row is a strip with no second dimension, so the lamps ride it as a
	 * circle — one leaving the right edge arrives at the left. A left-to-right
	 * sweep would have to teleport home at the end of every pass.
	 */
	private wave(task: AgentTask, text: string, now: number): string {
		if (task.status !== "running") return text;
		// Cosmetic: light that throws must not take the list down with it.
		try {
			const t = Math.max(0, now - task.startedAt) / 1000;
			return shadeLine(text, t, this.restColour(), { light: ROW_LIGHT });
		} catch {
			return text;
		}
	}

	/**
	 * What the row sits at between lamps: its own `dim`, so a row away from the
	 * light is the row it always was and the light only ever adds.
	 */
	private restColour(): Rgb {
		try {
			return rgbFromPainted(this.theme.fg("dim", "x")) ?? FALLBACK_REST;
		} catch {
			return FALLBACK_REST;
		}
	}

	private listHints(): string {
		return hintRow(this.theme, [
			["↑↓", "select"],
			["enter", "view"],
			["x", "stop"],
			["esc", "close"],
		]);
	}

	/** Move by rows, then off any header the step landed on: headers render but are never selected. */
	private moveCursor(delta: number, entries: readonly ListEntry[]): void {
		const next = clamp(this.cursor + delta, 0, Math.max(0, entries.length - 1));
		this.cursor = this.settleCursor(entries, next, delta >= 0 ? 1 : -1);
	}

	private settleCursor(entries: readonly ListEntry[], from: number, direction: 1 | -1): number {
		for (let at = from; at >= 0 && at < entries.length; at += direction) {
			if (entries[at]?.kind === "task") return at;
		}
		for (let at = from; at >= 0 && at < entries.length; at -= direction) {
			if (entries[at]?.kind === "task") return at;
		}
		return from;
	}

	/** Whether the cursor is on the first selectable row — where `↑` leaves. */
	private atFirstTask(entries: readonly ListEntry[]): boolean {
		return this.cursor <= entries.findIndex((entry) => entry.kind === "task");
	}

	private pageSize(total: number): number {
		return Math.max(1, calculateViewport(total, this.panelRows(), FIXED_LINE_COUNT).visibleCount);
	}
}

/** One rendered row of the list: a group header, the blank between groups, or a task. */
export type ListEntry =
	| { readonly kind: "header"; readonly title: string; readonly count: number }
	| { readonly kind: "blank" }
	| { readonly kind: "task"; readonly task: AgentTask };

/**
 * The list as rows, grouped: agents this seat launched, then workflow runs.
 *
 * Render order is nav order — one list, deliberately, so `↓` never jumps
 * somewhere the eye did not go. With one group there are no headers: see the
 * file header.
 */
export function listEntries(tasks: readonly AgentTask[]): ListEntry[] {
	const runs = tasks.filter(isWorkflowRunTask);
	const agents = tasks.filter((task) => !isWorkflowRunTask(task));
	if (runs.length === 0 || agents.length === 0) return tasks.map((task) => ({ kind: "task", task }) as const);
	return [
		{ kind: "header", title: AGENT_GROUP_TITLE, count: agents.length },
		...agents.map((task) => ({ kind: "task", task }) as const),
		{ kind: "blank" } as const,
		{ kind: "header", title: WORKFLOW_GROUP_TITLE, count: runs.length },
		...runs.map((task) => ({ kind: "task", task }) as const),
	];
}

/**
 * The right-hand column of a workflow run's row: `3/8 agents` while it runs,
 * and what it cost once it is done.
 *
 * The count is the run store's, read per render. A number copied onto the row
 * at each lifecycle event would be right twice a minute and wrong in between,
 * because agents start and finish without the run's own status moving.
 */
export function workflowRowText(task: AgentTask, run: WorkflowRun, now: number): string {
	if (task.stopRequested) return "stopping…";
	const done = run.agents.filter((agent) => agent.state !== "running").length;
	const agents = `${done}/${run.agents.length} ${run.agents.length === 1 ? "agent" : "agents"}`;
	if (isLiveAgentTask(task)) return agents;
	return [agents, taskStatusText(task, now)].filter((part) => part !== "").join(" · ");
}

/** Theme colour of the state dot: dim in flight, success done, error failed. */
function taskColor(task: AgentTask): "dim" | "success" | "error" {
	if (task.status === "completed") return "success";
	if (task.status === "failed") return "error";
	return "dim";
}

/**
 * The right-hand column of a row: what this agent is carrying, or what it cost.
 *
 * A running row says no state word — the wave says that — so it is the context
 * and, once the child has been quiet past `IDLE_VISIBLE_MS`, the idle age. Both
 * cells may be empty: a child that has produced nothing yet is a moving row and
 * nothing else, which is the whole fact about it.
 *
 * A settled task is its duration and its context — `2m 26s · 48k context` —
 * with `done` only as the fallback for a completion the engine timed nothing
 * for, so the cell is never blank. A task that did not complete keeps its word
 * (`failed`, `stopped`, `aborted`) in front, because that is the fact.
 *
 * **No money on a row.** A row answers "how long is this taking" and "how big
 * did it get"; dollars answer a question Joel asks deliberately, and they live
 * where he asks it: `/stats` (`session-spend.ts`) and `ListAgents` for the
 * model's own diagnosis. A cost column here was added and rejected (map C15).
 */
export function taskStatusText(task: AgentTask, now: number = Date.now()): string {
	if (task.stopRequested) return "stopping…";
	if (task.status === "queued") return "queued";
	if (task.status === "running") return runningText(task, now);
	const duration = task.durationMs === undefined ? undefined : formatDuration(task.durationMs);
	const lead = task.status === "completed" ? (duration ?? "done") : [failedLead(task), duration].filter(present).join(" · ");
	return [lead, contextText(task)].filter(present).join(" · ");
}

/** `32k context · idle 2m`: what it is carrying, and how long since it last did anything. */
function runningText(task: AgentTask, now: number): string {
	const idleMs = task.lastActivityAt === undefined ? 0 : now - task.lastActivityAt;
	const idle = idleMs >= IDLE_VISIBLE_MS ? `idle ${formatDuration(idleMs)}` : undefined;
	return [contextText(task), idle].filter(present).join(" · ");
}

/**
 * `48k context`, spelled out: `ctx` is an abbreviation nobody can pronounce.
 *
 * Rounded to thousands, so a child under half a token-thousand says nothing
 * rather than `0k` — the size of a run is a magnitude, not a reading.
 */
function contextText(task: AgentTask): string | undefined {
	const thousands = task.totalTokens === undefined ? 0 : Math.round(task.totalTokens / 1000);
	return thousands > 0 ? `${thousands}k context` : undefined;
}

function present(part: string | undefined): part is string {
	return part !== undefined && part !== "";
}

/**
 * One word for how a failed task ended, the same word the transcript row
 * uses (`agent-rows/agent-outcome-line.ts`), lower-cased for a table cell: a
 * stop asked for with `x` reads `stopped` here and `Stopped` there.
 */
function failedLead(task: AgentTask): string {
	switch (task.outcome) {
		case "stopped":
			return "stopped";
		case "aborted":
			return "aborted";
		default:
			return "failed";
	}
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(high, value));
}

/** Keep the cursor inside the rendered window without jumping the view. */
function scrollInto(cursor: number, scrollTop: number, visibleCount: number, total: number): number {
	const maxTop = Math.max(0, total - visibleCount);
	if (cursor < scrollTop) return Math.min(cursor, maxTop);
	if (cursor >= scrollTop + visibleCount) return Math.min(cursor - visibleCount + 1, maxTop);
	return Math.min(scrollTop, maxTop);
}
