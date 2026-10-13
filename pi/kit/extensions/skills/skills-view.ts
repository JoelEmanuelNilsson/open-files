import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

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
	wrapDescriptionLines,
} from "../../lib/ui/dialog-layout.ts";
import { FULLSCREEN_OVERLAY_OPTIONS, showViewOverlay } from "../../lib/ui/view-overlay.ts";
import { DEFAULT_WHEEL_SCROLL_LINES, parseWheelDirection, readWheelScrollLines } from "../../lib/ui/wheel-scroll.ts";
import { type SkillChange, SkillDraft, type SkillRow } from "./skill-draft.ts";

const FIXED_LINE_COUNT = 9;
const MUTED_GLYPH = "○";
const ACTIVE_GLYPH = "●";
const CHANGED_MARKER = "•";

export async function showSkillsView(
	context: ExtensionCommandContext,
	rows: readonly SkillRow[],
): Promise<SkillChange[] | undefined> {
	return showViewOverlay<SkillChange[] | undefined>(
		context,
		(tui, theme, done) => new SkillsView(theme, rows, done, () => tui.terminal.rows, readWheelScrollLines(tui)),
		FULLSCREEN_OVERLAY_OPTIONS,
	);
}

/** Exported for direct render/input tests; use showSkillsView from pi code. */
export class SkillsView {
	private readonly theme: Theme;
	private readonly draft: SkillDraft;
	private readonly done: (result: SkillChange[] | undefined) => void;
	private readonly getTerminalRows: () => number;
	private readonly wheelScrollLines: number;
	private scrollTop = 0;

	public constructor(
		theme: Theme,
		rows: readonly SkillRow[],
		done: (result: SkillChange[] | undefined) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
		wheelScrollLines: number = DEFAULT_WHEEL_SCROLL_LINES,
	) {
		this.theme = theme;
		this.draft = new SkillDraft(rows);
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.wheelScrollLines = wheelScrollLines;
	}

	public invalidate(): void {
	}

	public handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.done(this.draft.changes());
			return;
		}
		if (data === " ") {
			this.draft.toggleAtCursor();
			return;
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			this.draft.reset();
			return;
		}
		const wheel = parseWheelDirection(data);
		if (wheel !== undefined) return this.draft.moveCursor(wheel * this.wheelScrollLines);
		if (isStepBackKey(data)) return this.draft.moveCursor(-1);
		if (isStepForwardKey(data)) return this.draft.moveCursor(1);
		if (isPageBackKey(data)) return this.draft.moveCursor(-this.pageSize());
		if (isPageForwardKey(data)) return this.draft.moveCursor(this.pageSize());
		if (matchesKey(data, Key.home)) return this.draft.setCursor(0);
		if (matchesKey(data, Key.end)) return this.draft.setCursor(this.draft.visible().length - 1);
		if (matchesKey(data, Key.backspace)) {
			this.draft.setQuery(this.draft.getQuery().slice(0, -1));
			return;
		}
		if (isPrintable(data)) this.draft.setQuery(this.draft.getQuery() + data);
	}

	public render(width: number): string[] {
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		const visible = this.draft.visible();
		const { visibleCount, showScroll } = calculateViewport(visible.length, terminalRows, FIXED_LINE_COUNT);
		this.scrollTop = scrollInto(this.draft.getCursor(), this.scrollTop, visibleCount, visible.length);

		const lines = [
			fitLine(this.titleRow(width), width),
			"",
			fitLine(this.filterRow(), width),
			"",
		];

		if (visible.length === 0) {
			lines.push(fitLine(this.theme.fg("muted", `${BODY_INDENT}No skill matches that filter.`), width));
		}
		for (const [offset, entry] of visible.slice(this.scrollTop, this.scrollTop + visibleCount).entries()) {
			lines.push(fitLine(this.skillRow(entry.row, entry.index, this.scrollTop + offset, width), width));
		}
		if (showScroll) {
			const shown = Math.min(this.scrollTop + visibleCount, visible.length);
			lines.push(fitLine(this.theme.fg("dim", `${BODY_INDENT}${shown} of ${visible.length}`), width));
		}

		lines.push("", ...this.descriptionRows(width), "", fitLine(this.hints(), width));
		return fitToTerminalHeight(lines, terminalRows, "");
	}

	private pageSize(): number {
		const rows = normalizeTerminalRows(this.getTerminalRows());
		return Math.max(1, calculateViewport(this.draft.visible().length, rows, FIXED_LINE_COUNT).visibleCount);
	}

	private titleRow(width: number): string {
		const active = this.draft.activeCount();
		const pending = this.draft.changes().length;
		const left = this.theme.fg("accent", this.theme.bold("Skills"));
		const counts = this.theme.fg("muted", `${active} of ${this.draft.total()} reachable by the model`);
		const dirty = pending === 0 ? "" : this.theme.fg("warning", ` · ${pending} unsaved`);
		return spreadLine(`${BODY_INDENT}${left}`, `${counts}${dirty}${BODY_INDENT}`, width);
	}

	private filterRow(): string {
		const query = this.draft.getQuery();
		const shown = query.length === 0 ? this.theme.fg("dim", "type to filter") : query;
		return `${BODY_INDENT}${this.theme.fg("dim", "/")} ${shown}`;
	}

	private skillRow(row: SkillRow, index: number, position: number, width: number): string {
		const selected = position === this.draft.getCursor();
		const muted = this.draft.isMuted(index);
		const cursor = selected ? this.theme.fg("accent", "❯") : " ";
		const glyph = muted ? this.theme.fg("dim", MUTED_GLYPH) : this.theme.fg("success", ACTIVE_GLYPH);
		const name = muted ? this.theme.fg("muted", row.name) : this.theme.fg("text", row.name);
		const marker = this.draft.isChanged(index) ? this.theme.fg("warning", ` ${CHANGED_MARKER}`) : "";
		return spreadLine(
			`${BODY_INDENT}${cursor} ${glyph} ${name}${marker}`,
			`${this.theme.fg("dim", row.scope)}${BODY_INDENT}`,
			width,
		);
	}

	private descriptionRows(width: number): string[] {
		const entry = this.draft.visible()[this.draft.getCursor()];
		if (entry === undefined) return ["", ""];
		const wrapped = wrapDescriptionLines(this.theme, entry.row.description, "muted", width);
		return [wrapped[0] ?? "", wrapped[1] ?? ""];
	}

	private hints(): string {
		return hintRow(this.theme, [
			["↑↓", "move"],
			["space", "toggle"],
			["ctrl+s", "apply"],
			["ctrl+r", "reset"],
			["esc", "cancel"],
		]);
	}
}

function scrollInto(cursor: number, scrollTop: number, visibleCount: number, total: number): number {
	const maxTop = Math.max(0, total - visibleCount);
	if (cursor < scrollTop) return Math.min(cursor, maxTop);
	if (cursor >= scrollTop + visibleCount) return Math.min(cursor - visibleCount + 1, maxTop);
	return Math.min(scrollTop, maxTop);
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= "!" && data <= "~";
}
