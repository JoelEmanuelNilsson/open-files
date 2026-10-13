import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

import { hex, type Rgb, rgbFromPainted } from "../../lib/ui/rgb-color.ts";
import { ROW_FRAME_MS, ROW_LIGHT, shadeLine, waveEnabled } from "../../lib/ui/prism-light.ts";
import { type Piece, rule } from "../../lib/ui/labelled-rule.ts";
import { shortModelId } from "../../lib/models/model-label.ts";

import {
	BODY_INDENT,
	calculateViewport,
	DEFAULT_TERMINAL_ROWS,
	fitLine,
	clamp,
	fitToTerminalHeight,
	hintRow,
	isNonEmptyPart,
	isPageBackKey,
	isPageForwardKey,
	isStepBackKey,
	isStepForwardKey,
	normalizeTerminalRows,
	spreadLine,
} from "../../lib/ui/dialog-layout.ts";
import { formatDuration } from "../../lib/ui/duration-label.ts";
import type { WorkflowRun } from "../../lib/workflow/workflow-run-store.ts";
import { type AgentTask, isLiveAgentTask, isWorkflowRunTask } from "./agent-task-registry.ts";
import { showViewOverlay } from "../../lib/ui/view-overlay.ts";

const WAVE = waveEnabled();

/** Title of the modal: Claude Code's word, and the one the count promises. A blocking agent counts too, so it does not say "background". */
export const BACKGROUND_TASKS_TITLE = "Tasks";

/** Group header for agents this seat launched itself. Render order is nav order. */
export const AGENT_GROUP_TITLE = "Local agents";

/** Group header for workflow runs. Claude Code's own words, from its shipped binary. */
export const WORKFLOW_GROUP_TITLE = "Dynamic workflows";

const FIXED_LINE_COUNT = 4;

const PANEL_RULE_ENDS = { left: "─", right: "─" } as const;

/** In the editor's slot, not floating over it. See the header. */
export const TASKS_VIEW_OPTIONS = { overlay: false } as const;

export function tasksPanelMaxRows(terminalRows: number): number {
	const rows = normalizeTerminalRows(terminalRows);
	return Math.min(rows, Math.max(FIXED_LINE_COUNT + 1, Math.floor(rows / 2)));
}

const TASK_GLYPH = "●";

export const IDLE_VISIBLE_MS = 20_000;

export { ROW_FRAME_MS };

const FALLBACK_REST: Rgb = hex("#5b4a6e");

export function shortTaskModel(modelId: string): string {
	const slash = modelId.lastIndexOf("/");
	return shortModelId(slash === -1 ? modelId : modelId.slice(slash + 1));
}

/** How the modal was left: closed, closed to open one task's box, or closed to go back to main from an agent view. */
export type BackgroundTasksExit = { readonly kind: "closed" } | { readonly kind: "open"; readonly id: string } | { readonly kind: "main" };

/** What the `main` row says about the main session: running a turn, or waiting for the prompt. */
export type MainRowStatus = "working" | "idle";

/** What the modal needs from the session, so the view itself stays testable. */
export interface BackgroundTasksViewDeps {
	readonly tasks: () => readonly AgentTask[];
	readonly runOf?: (taskId: string) => WorkflowRun | undefined;
	readonly stop: (id: string) => void;
	readonly getTerminalRows?: () => number;
	readonly now?: () => number;
	readonly selectedId?: string | undefined;
	readonly mainRow?: () => MainRowStatus | undefined;
}

export async function showBackgroundTasksView(
	ctx: ExtensionContext,
	deps: BackgroundTasksViewDeps,
	onRefresh?: (refresh: () => void) => void,
): Promise<BackgroundTasksExit> {
	return await showViewOverlay<BackgroundTasksExit>(ctx, (tui, theme, done) => new BackgroundTasksView(theme, deps, done, () => tui.terminal.rows), TASKS_VIEW_OPTIONS, onRefresh);
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
		const entries = this.entries();
		if (deps.selectedId !== undefined) {
			const at = entries.findIndex((entry) => entry.kind === "task" && entry.task.id === deps.selectedId);
			if (at >= 0) this.cursor = at;
		}
		this.cursor = this.settleCursor(entries, this.cursor, 1);
	}

	private entries(): ListEntry[] {
		return listEntries(this.deps.tasks(), this.deps.mainRow?.());
	}

	private close(): void {
		this.exit({ kind: "closed" });
	}

	public invalidate(): void {
	}

	public handleInput(data: string): void {
		const entries = this.entries();
		if (matchesKey(data, Key.escape)) return this.close();
		if (isStepBackKey(data)) return this.atFirstTask(entries) ? this.close() : this.moveCursor(-1, entries);
		if (isStepForwardKey(data)) return this.moveCursor(1, entries);
		if (isPageBackKey(data)) return this.moveCursor(-this.pageSize(entries.length), entries);
		if (isPageForwardKey(data)) return this.moveCursor(this.pageSize(entries.length), entries);
		const entry = entries[this.cursor];
		if (entry?.kind === "main") {
			if (matchesKey(data, Key.enter)) this.exit({ kind: "main" });
			return;
		}
		const selected = entry?.kind === "task" ? entry.task : undefined;
		if (selected === undefined) return;
		if (matchesKey(data, Key.enter)) return this.exit({ kind: "open", id: selected.id });
		if (data === "x" && isLiveAgentTask(selected)) this.deps.stop(selected.id);
	}

	public render(width: number): string[] {
		return fitToTerminalHeight(this.renderList(width), this.panelRows(), "");
	}

	private panelRows(): number {
		return tasksPanelMaxRows(this.getTerminalRows());
	}

	private ruleRow(left: string, right: string, width: number): string {
		const leftPiece: Piece[] = [{ text: left, paint: (text) => this.theme.fg("accent", this.theme.bold(text)) }];
		const rightPiece: Piece[] = right === "" ? [] : [{ text: right, paint: (text) => this.theme.fg("muted", text) }];
		return rule(width, leftPiece, rightPiece, (text) => this.theme.fg("dim", text), PANEL_RULE_ENDS);
	}

	private renderList(width: number): string[] {
		const tasks = this.deps.tasks();
		const entries = listEntries(tasks, this.deps.mainRow?.());
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
		if (entry.kind === "main") return this.mainRow(entry.status, position, width);
		return this.taskRow(entry.task, entry.depth, position, width);
	}

	private mainRow(status: MainRowStatus, position: number, width: number): string {
		const cursor = position === this.cursor ? this.theme.fg("accent", "❯") : " ";
		return spreadLine(
			`${BODY_INDENT}${cursor} ${this.theme.fg("dim", TASK_GLYPH)} ${this.theme.fg("text", "main")}`,
			`${this.theme.fg("dim", status)}${BODY_INDENT}`,
			width,
		);
	}

	private titleRow(tasks: readonly AgentTask[], width: number): string {
		const live = tasks.filter(isLiveAgentTask).length;
		const summary = live > 0 ? `${live} running` : `${tasks.length} finished`;
		return this.ruleRow(BACKGROUND_TASKS_TITLE, summary, width);
	}

	private taskRow(task: AgentTask, depth: number, position: number, width: number): string {
		const now = this.now();
		const cursor = position === this.cursor ? this.theme.fg("accent", "❯") : " ";
		const glyph = this.theme.fg(taskColor(task), TASK_GLYPH);
		const run = isWorkflowRunTask(task) ? this.deps.runOf?.(task.id) : undefined;
		const label = isWorkflowRunTask(task) && task.name !== "" ? task.name : task.description === "" ? task.id : task.description;
		const lead = [task.type, task.model === "" ? "" : shortTaskModel(task.model)].filter((part) => part !== "");
		const prefix = lead.length === 0 ? "" : `${this.theme.fg("muted", lead.join(" "))} `;
		return spreadLine(
			`${BODY_INDENT}${cursor} ${depth === 0 ? "" : `${"  ".repeat(depth - 1)}⎿ `}${glyph} ${this.wave(task, `${prefix}${this.theme.fg("text", label)}`, now)}`,
			`${this.theme.fg("dim", run === undefined ? taskStatusText(task, now) : workflowRowText(task, run, now))}${BODY_INDENT}`,
			width,
		);
	}

	private wave(task: AgentTask, text: string, now: number): string {
		if (task.status !== "running" || !WAVE) return text;
		try {
			const t = Math.max(0, now - task.startedAt) / 1000;
			return shadeLine(text, t, this.restColour(), { light: ROW_LIGHT });
		} catch {
			return text;
		}
	}

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

	private moveCursor(delta: number, entries: readonly ListEntry[]): void {
		const next = clamp(this.cursor + delta, 0, Math.max(0, entries.length - 1));
		this.cursor = this.settleCursor(entries, next, delta >= 0 ? 1 : -1);
	}

	private settleCursor(entries: readonly ListEntry[], from: number, direction: 1 | -1): number {
		for (let at = from; at >= 0 && at < entries.length; at += direction) {
			if (isSelectableEntry(entries[at])) return at;
		}
		for (let at = from; at >= 0 && at < entries.length; at -= direction) {
			if (isSelectableEntry(entries[at])) return at;
		}
		return from;
	}

	private atFirstTask(entries: readonly ListEntry[]): boolean {
		return this.cursor <= entries.findIndex(isSelectableEntry);
	}

	private pageSize(total: number): number {
		return Math.max(1, calculateViewport(total, this.panelRows(), FIXED_LINE_COUNT).visibleCount);
	}
}

/** One rendered row of the list: a group header, the blank between groups, the `main` row, or a task. */
export type ListEntry =
	| { readonly kind: "header"; readonly title: string; readonly count: number }
	| { readonly kind: "blank" }
	| { readonly kind: "main"; readonly status: MainRowStatus }
	| { readonly kind: "task"; readonly task: AgentTask; readonly depth: number };

function isSelectableEntry(entry: ListEntry | undefined): boolean {
	return entry?.kind === "task" || entry?.kind === "main";
}

export function listEntries(tasks: readonly AgentTask[], main?: MainRowStatus): ListEntry[] {
	const listed = new Set(tasks.map((task) => task.id));
	const roots = tasks.filter((task) => task.parentId === undefined || !listed.has(task.parentId));
	const withChildren = (task: AgentTask, depth: number): ListEntry[] => [
		{ kind: "task", task, depth },
		...tasks.filter((child) => child.parentId === task.id).flatMap((child) => withChildren(child, depth + 1)),
	];
	const runs = roots.filter(isWorkflowRunTask).flatMap((task) => withChildren(task, 0));
	const agents = roots.filter((task) => !isWorkflowRunTask(task)).flatMap((task) => withChildren(task, 0));
	const grouped = runs.length > 0 && agents.length > 0;
	const lead: ListEntry[] = main === undefined ? [] : grouped ? [{ kind: "main", status: main }, { kind: "blank" }] : [{ kind: "main", status: main }];
	if (!grouped) return [...lead, ...agents, ...runs];
	return [
		...lead,
		{ kind: "header", title: AGENT_GROUP_TITLE, count: agents.length },
		...agents,
		{ kind: "blank" } as const,
		{ kind: "header", title: WORKFLOW_GROUP_TITLE, count: runs.length },
		...runs,
	];
}

export function workflowRowText(task: AgentTask, run: WorkflowRun, now: number): string {
	if (task.stopRequested) return "stopping…";
	const done = run.agents.filter((agent) => agent.state !== "running").length;
	const agents = `${done}/${run.agents.length} ${run.agents.length === 1 ? "agent" : "agents"}`;
	if (isLiveAgentTask(task)) return agents;
	return [agents, taskStatusText(task, now)].filter((part) => part !== "").join(" · ");
}

function taskColor(task: AgentTask): "dim" | "success" | "error" {
	if (task.status === "completed") return "success";
	if (task.status === "failed") return "error";
	return "dim";
}

export function taskStatusText(task: AgentTask, now: number = Date.now()): string {
	if (task.stopRequested) return "stopping…";
	if (task.status === "queued") return "queued";
	if (task.status === "running") return runningText(task, now);
	const duration = task.durationMs === undefined ? undefined : formatDuration(task.durationMs);
	const lead = task.status === "completed" ? (duration ?? "done") : [failedLead(task), duration].filter(isNonEmptyPart).join(" · ");
	return [lead, contextText(task)].filter(isNonEmptyPart).join(" · ");
}

function runningText(task: AgentTask, now: number): string {
	const idleMs = task.lastActivityAt === undefined ? 0 : now - task.lastActivityAt;
	const idle = idleMs >= IDLE_VISIBLE_MS ? `idle ${formatDuration(idleMs)}` : undefined;
	return [contextText(task), idle].filter(isNonEmptyPart).join(" · ");
}

function contextText(task: AgentTask): string | undefined {
	const thousands = task.totalTokens === undefined ? 0 : Math.round(task.totalTokens / 1000);
	return thousands > 0 ? `${thousands}k context` : undefined;
}

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

function scrollInto(cursor: number, scrollTop: number, visibleCount: number, total: number): number {
	const maxTop = Math.max(0, total - visibleCount);
	if (cursor < scrollTop) return Math.min(cursor, maxTop);
	if (cursor >= scrollTop + visibleCount) return Math.min(cursor - visibleCount + 1, maxTop);
	return Math.min(scrollTop, maxTop);
}
