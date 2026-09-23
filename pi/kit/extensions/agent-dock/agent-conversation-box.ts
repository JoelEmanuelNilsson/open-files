/**
 * One agent's conversation in a box: the transcript as the main screen draws
 * it, live, with a prompt line to talk to the agent.
 *
 *     ╭─ Agent(audit the wire) ──────────────────── 32k context ─╮
 *     │                                                          │
 *     │  ● Read(lib/wire.ts)                                     │
 *     │    ⎿  Read 212 lines                                     │
 *     │                                                          │
 *     │  Looking at the header block next.                       │
 *     ├──────────────────────────────────────────────────────────┤
 *     │ ❯ tell it what to do                                     │
 *     ╰─ ↑↓ scroll · enter send · esc back ──────────────────────╯
 *
 * **Centred, bordered, most of the screen.** The Tasks list is a picker and
 * sits along the bottom under a rule; this is for reading, and a bordered box
 * floating over the transcript reads as a window on something else. The bare
 * panel that read as a crash last time had no frame: the frame is the whole
 * difference, so every row of this view wears one.
 *
 * **It follows the agent until you scroll.** A running agent appends; the view
 * sticks to the bottom so the newest row is always on screen. `↑` or a wheel
 * notch breaks off and reads back; `↓` past the end, or `end`, re-attaches.
 * That is pi's own transcript behaviour and the one a reader expects. The
 * wheel is read here because pi hands it to a focused overlay untouched
 * (`lib/wheel.ts`); one notch is `WHEEL_LINES`, pi's default for its own view.
 *
 * **The prompt line sends; it never picks how.** Enter on typed text hands it
 * to `deps.send`, which is the engine's `AgentRuntime.send` — the one place
 * that reads the child's state and chooses a prompt or a steer. The box is
 * given no session method at all, so it cannot send the wrong one. A settled
 * agent shows no prompt line rather than a prompt that would go nowhere. `j`
 * and `k` are typing here, so only the arrow and page keys move the view.
 *
 * **With no session, the answer stands in.** A settled agent's session is gone
 * and a run outside this seat's runtime never had one here, so the record's
 * final text is what the box shows, as prose. A running agent has no final
 * text yet, and the box says exactly that rather than claiming the agent has
 * not started (see `nothingToShow`).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, type OverlayOptions, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { type Piece, rule } from "../zen-chrome/chrome.ts";
import { fitLine, hintRow, isPageBackKey, isPageForwardKey, normalizeTerminalRows } from "../context-view/ui/layout.ts";
import { AgentConversationFeed, type ConversationSource } from "./agent-conversation-feed.ts";
import { wheelDirection } from "../../lib/wheel.ts";
import { type AgentTask, isLiveAgentTask } from "./agent-task-registry.ts";
import { taskStatusText } from "./background-tasks-view.ts";

/** What the box needs from the session, so the view stays testable. */
export interface AgentConversationBoxDeps {
	/** The task as the registry sees it now. Re-read on every render. */
	readonly task: () => AgentTask | undefined;
	/**
	 * The agent's live session, re-read on every render: `undefined` once the run
	 * is over, which is what puts the record's final text on screen instead.
	 */
	readonly session?: () => ConversationSource | undefined;
	/**
	 * Deliver text to the agent. Absent when there is nothing to deliver it
	 * through, and then the box draws no prompt line — reading and talking are
	 * two capabilities, and a box may have the first without the second.
	 */
	readonly send?: (text: string) => Promise<void>;
	readonly cwd: string;
	readonly getTerminalRows?: () => number;
}

/** Share of the screen the box takes. Enough to read; enough transcript left to say it floats. */
const BOX_HEIGHT_PCT = 80;

/** Where pi puts the box: centred, most of the width, a margin of transcript on every side. */
export const AGENT_BOX_OVERLAY_OPTIONS: { readonly overlay: true; readonly overlayOptions: OverlayOptions } = {
	overlay: true,
	overlayOptions: { anchor: "center", width: "90%", maxHeight: `${BOX_HEIGHT_PCT}%` },
};

/** The most rows the box may draw, from the terminal's height. Mirrors the overlay cap, read live. */
export function agentBoxMaxRows(terminalRows: number): number {
	const rows = normalizeTerminalRows(terminalRows);
	return Math.max(FIXED_ROWS_LIVE + 1, Math.floor((rows * BOX_HEIGHT_PCT) / 100));
}

/** Corners of the box: it is a window, not an edge of the screen. */
const TOP_ENDS = { left: "╭", right: "╮" } as const;
const MID_ENDS = { left: "├", right: "┤" } as const;
const BOTTOM_ENDS = { left: "╰", right: "╯" } as const;
const SIDE = "│";
/** The two side columns and the space inside each. */
const FRAME_COLUMNS = 4;

/** Rows the chrome takes when there is a prompt line: top, divider, prompt, bottom. */
const FIXED_ROWS_LIVE = 4;
/** Rows the chrome takes without one: top, bottom. */
const FIXED_ROWS_SETTLED = 2;

/** Rows one wheel notch moves. Three is what a terminal gives a plain scrollback. */
export const WHEEL_LINES = 3;

const PROMPT_MARK = "❯ ";
const PROMPT_PLACEHOLDER = "tell it what to do";
/** pi-tui's `Input` draws this before the text; the box draws its own mark instead. */
const INPUT_PREFIX = "> ";

/**
 * Open the box. Resolves when the user leaves it.
 *
 * `onRefresh` receives a function that repaints the open box, for the dock to
 * call when the task's status changes under it.
 */
export async function showAgentConversationBox(
	ctx: ExtensionContext,
	deps: AgentConversationBoxDeps,
	onRefresh?: (refresh: () => void) => void,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const view = new AgentConversationBox(theme, deps, tui, () => done(undefined), () => tui.terminal.rows);
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
				dispose: () => view.dispose(),
			};
		},
		AGENT_BOX_OVERLAY_OPTIONS,
	);
}

/** Exported for render and input tests; use `showAgentConversationBox` from pi code. */
export class AgentConversationBox {
	private readonly theme: Theme;
	private readonly deps: AgentConversationBoxDeps;
	private readonly close: () => void;
	private readonly getTerminalRows: () => number;
	private readonly input = new Input();
	private feed: AgentConversationFeed | undefined;
	/** The session the feed was built on, so a dropped session is noticed. */
	private feedSource: ConversationSource | undefined;
	/** Lines hidden above the viewport; undefined while following the newest row. */
	private scrollTop: number | undefined;
	/** The furthest `scrollTop` the last render allowed, so `↑` from follow mode lands one row up. */
	private maxTop = 0;

	public constructor(
		theme: Theme,
		deps: AgentConversationBoxDeps,
		ui: { requestRender: () => void },
		close: () => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? 24,
	) {
		this.theme = theme;
		this.deps = deps;
		this.close = close;
		this.getTerminalRows = deps.getTerminalRows ?? getTerminalRows;
		this.input.onSubmit = (value) => this.submit(value);
		const source = deps.session?.();
		if (source !== undefined) {
			this.feedSource = source;
			this.feed = new AgentConversationFeed(source, ui, deps.cwd);
		}
	}

	public invalidate(): void {
		this.feed?.invalidate();
	}

	public dispose(): void {
		this.feed?.dispose();
		this.feed = undefined;
	}

	/** Whether the view is pinned to the newest row. */
	public get following(): boolean {
		return this.scrollTop === undefined;
	}

	public handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) return this.close();
		const wheel = wheelDirection(data);
		if (wheel !== undefined) return this.scrollBy(wheel * WHEEL_LINES);
		if (matchesKey(data, Key.up)) return this.scrollBy(-1);
		if (matchesKey(data, Key.down)) return this.scrollBy(1);
		if (isPageBackKey(data)) return this.scrollBy(-this.pageSize());
		if (isPageForwardKey(data)) return this.scrollBy(this.pageSize());
		if (matchesKey(data, Key.end)) {
			this.scrollTop = undefined;
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.scrollTop = 0;
			return;
		}
		if (this.canSteer()) this.input.handleInput(data);
	}

	public render(width: number): string[] {
		const task = this.deps.task();
		const live = this.canSteer();
		const inner = Math.max(1, width - FRAME_COLUMNS);
		const budget = agentBoxMaxRows(this.getTerminalRows());
		const bodyRows = Math.max(1, budget - (live ? FIXED_ROWS_LIVE : FIXED_ROWS_SETTLED));
		const body = this.bodyLines(task, inner);
		const maxTop = Math.max(0, body.length - bodyRows);
		this.maxTop = maxTop;
		const top = this.scrollTop === undefined ? maxTop : Math.min(this.scrollTop, maxTop);
		// Scrolled to the newest row is the same thing as following it.
		if (this.scrollTop !== undefined && this.scrollTop >= maxTop) this.scrollTop = undefined;

		const lines = [this.topRule(task, width)];
		const window = body.slice(top, top + bodyRows);
		for (let row = 0; row < bodyRows; row++) lines.push(this.framed(window[row] ?? "", inner));
		if (live) {
			lines.push(this.divider(width));
			lines.push(this.framed(this.promptLine(inner), inner));
		}
		lines.push(this.bottomRule(live, width));
		return lines;
	}

	// ---- body ----

	private bodyLines(task: AgentTask | undefined, width: number): string[] {
		// The session can go away while the box is open; a feed on a dead session
		// would draw its last frame forever, so the answer stands in from then on.
		if (this.feed !== undefined && this.deps.session?.() !== this.feedSource) this.dispose();
		if (this.feed !== undefined) return this.feed.render(width);
		return wrapAnswer(task, width);
	}

	/** One body row between the two sides, padded so the right side lines up. */
	private framed(line: string, inner: number): string {
		const side = this.theme.fg("dim", SIDE);
		const fitted = fitLine(line, inner);
		return `${side} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${side}`;
	}

	private topRule(task: AgentTask | undefined, width: number): string {
		const title: Piece[] = [{ text: headline(task), paint: (text) => this.theme.fg("accent", this.theme.bold(text)) }];
		const status: Piece[] = task === undefined ? [] : [{ text: taskStatusText(task), paint: (text) => this.theme.fg("muted", text) }];
		return rule(width, title, status, (text) => this.theme.fg("dim", text), TOP_ENDS);
	}

	private divider(width: number): string {
		return rule(width, [], [], (text) => this.theme.fg("dim", text), MID_ENDS);
	}

	private bottomRule(live: boolean, width: number): string {
		const hints: Array<readonly [string, string]> = [["↑↓", "scroll"]];
		if (live) hints.push(["enter", "send"]);
		hints.push(["esc", "back"]);
		const hint: Piece[] = [{ text: hintRow(this.theme, hints).trimStart() }];
		return rule(width, hint, [], (text) => this.theme.fg("dim", text), BOTTOM_ENDS);
	}

	private promptLine(inner: number): string {
		const text = this.input.getValue();
		const mark = this.theme.fg("accent", PROMPT_MARK);
		if (text === "") return `${mark}${this.theme.fg("dim", PROMPT_PLACEHOLDER)}`;
		const [line = ""] = this.input.render(Math.max(1, inner - PROMPT_MARK.length + INPUT_PREFIX.length));
		return `${mark}${line.startsWith(INPUT_PREFIX) ? line.slice(INPUT_PREFIX.length) : line}`;
	}

	// ---- keys ----

	private canSteer(): boolean {
		const task = this.deps.task();
		if (task === undefined || !isLiveAgentTask(task) || this.deps.send === undefined) return false;
		return this.feedSource !== undefined && this.deps.session?.() === this.feedSource;
	}

	private scrollBy(delta: number): void {
		// Scrolling down while following stays following; scrolling up breaks off
		// from where the bottom was. The next render clamps either way.
		if (this.scrollTop === undefined && delta > 0) return;
		const next = Math.max(0, (this.scrollTop ?? this.maxTop) + delta);
		this.scrollTop = next >= this.maxTop ? undefined : next;
	}

	private pageSize(): number {
		return Math.max(1, agentBoxMaxRows(this.getTerminalRows()) - FIXED_ROWS_LIVE);
	}

	private submit(value: string): void {
		const text = value.trim();
		this.input.setValue("");
		const send = this.deps.send;
		if (text === "" || send === undefined || !this.canSteer()) return;
		// The agent answers on its own stream; a refused delivery is not the box's to
		// report beyond leaving the prompt as it was.
		send(text).catch(() => {
			this.input.setValue(text);
		});
	}
}

/** `Agent(fix the flaky test)` — the transcript's header shape, so both name the same thing. */
function headline(task: AgentTask | undefined): string {
	if (task === undefined) return "Agent";
	return `Agent(${task.description === "" ? task.id : task.description})`;
}

/** The body when there is no session left to draw: the answer, the error, or why there is neither. */
export function wrapAnswer(task: AgentTask | undefined, width: number): string[] {
	const text = task?.error ?? task?.result ?? "";
	if (text === "") return wrapTextWithAnsi(nothingToShow(task), width);
	return text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
}

/**
 * Why the box is empty.
 *
 * A running agent is not "still starting" — it has been working and producing
 * output all along. Reaching this line means no live session was handed over
 * for it, so the true statement is that its output is not on this screen.
 */
function nothingToShow(task: AgentTask | undefined): string {
	if (task === undefined || !isLiveAgentTask(task)) return "No output.";
	if (task.status === "queued") return "Queued. It has not started yet.";
	return "Running, with no live session to follow here; the answer lands when it finishes.";
}
