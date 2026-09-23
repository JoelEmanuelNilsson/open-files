/**
 * The one way a diff is painted in this harness: Claude Code's look.
 *
 * Added and removed lines carry a background across the whole row, the changed
 * span inside a replaced line carries a stronger one, and context lines are
 * plain. Both colours come from the theme's `toolDiffAdded` / `toolDiffRemoved`
 * (pi only has foreground slots, so the escape is turned into a background
 * here); the span is the same colour taken further from the background —
 * brighter on a dark row, deeper on a light one, the ratio Claude Code uses.
 *
 * A theme that paints in ANSI slots names an accent at full strength rather
 * than a tint, and a row of that would be a block of colour with unreadable
 * text on it. Such a theme's rows are mixed here instead, from what the
 * terminal reports for that slot and its background (`lib/slot-colors.ts`), to
 * the same distance from the background the hex tints sit at.
 *
 * Shared by the edit tool and the write tool's overwrite view, so a diff looks
 * the same whichever tool produced it.
 */

import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, sliceByColumn, truncateToWidth } from "@earendil-works/pi-tui";
import { bg, indexFromPainted, lerp, luminance, type Rgb, rgbFromPainted } from "./rgb.ts";
import { slotColors } from "./slot-colors.ts";
import { type DiffMode, type DiffPalette, layoutDiff, type Paint } from "./split-diff.ts";

/** Lines a collapsed diff shows before it counts the rest. */
export const DIFF_PREVIEW_LINES = 24;

const RESET_BG = "\x1b[49m";
const RESET_FG = "\x1b[39m";

/**
 * How far a diff row and the changed span inside it sit from the background, in
 * Rec. 601 luma.
 *
 * Claude Code's dark palette puts its rows ~65 above a near-black background
 * and the span at ~1.8× that; these are those two distances, stated as
 * distances so a light background gets the same reading downward and any
 * palette — pastel slots, saturated ones — lands in the same place.
 */
const ROW_LUMA = 65;
const SPAN_LUMA = 120;

/** A foreground escape (`38;…`) becomes the same colour as a background. */
function backgroundOf(fgAnsi: string): string {
	return fgAnsi.replace("[38;", "[48;");
}

/**
 * The span colour for a truecolor row colour: ×1.8 on a dark row, ×0.6 on a
 * light one — the ratio Claude Code's palette uses.
 */
function scaledEmphasis(rgb: Rgb): string {
	const scale = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b < 128 ? 1.8 : 0.6;
	const channel = (value: number) => Math.min(255, Math.round(value * scale));
	return `\x1b[48;2;${channel(rgb.r)};${channel(rgb.g)};${channel(rgb.b)}m`;
}

/**
 * `surface` moved `delta` of luma toward `color`, or as far as `color` goes when
 * that is not far enough. A slot the terminal draws close to its own background
 * has no more to give, and half a tint is better than none.
 */
function tint(surface: Rgb, color: Rgb, delta: number): Rgb {
	const reach = Math.abs(luminance(color) - luminance(surface));
	return lerp(surface, color, reach < 1 ? 1 : Math.min(1, delta / reach));
}

/**
 * The background escapes for one diff colour — row first, span second — or null
 * when there is nothing to paint with yet.
 *
 * A theme naming a hex has already chosen its tint (`#225c2b` on a dark
 * background), so that colour is the row and the span is scaled off it. A theme
 * painting in ANSI slots has named a full-strength accent instead: the tint is
 * mixed here, from what the terminal says that slot and its background actually
 * are, which is also what keeps a light palette's rows light.
 */
function backgrounds(fgAnsi: string): [row: string, span: string] | null {
	const hex = rgbFromPainted(fgAnsi);
	if (hex !== null) return [backgroundOf(fgAnsi), scaledEmphasis(hex)];
	const slot = indexFromPainted(fgAnsi);
	if (slot === null) return null;
	const colors = slotColors();
	const color = colors.get(slot);
	const surface = colors.background();
	if (color === undefined || surface === undefined) return null;
	return [bg(tint(surface, color, ROW_LUMA)), bg(tint(surface, color, SPAN_LUMA))];
}

/**
 * A paint for one part of a diff line, resolved at paint time rather than when
 * the palette is built: the terminal answers about its colours asynchronously
 * and repaints them on an appearance flip, and a row already on screen has to
 * follow. `DiffView` re-renders on the same signal (`SlotColors.version`).
 *
 * Until the terminal has answered — or on a terminal that never will — the line
 * is painted in the diff colour itself, as foreground. No background is better
 * than a wrong one: a full-strength accent across the row is a block of colour
 * with unreadable text on it.
 */
function paintOf(fgAnsi: string, which: 0 | 1): Paint {
	if (fgAnsi === "") return (text) => text;
	return (text) => {
		const pair = backgrounds(fgAnsi);
		if (pair === null) return `${fgAnsi}${text}${RESET_FG}`;
		return `${pair[which]}${text}${RESET_BG}`;
	};
}

/**
 * The escape a theme opens `color` with. A theme that paints nothing (the render
 * tests' identity theme) or does not know the token yields "", and then the diff
 * is painted with nothing too — a render must never die for a colour.
 */
function escapeOf(theme: Theme, color: "toolDiffAdded" | "toolDiffRemoved"): string {
	try {
		return theme.getFgAnsi(color);
	} catch {
		return "";
	}
}

export function diffPalette(theme: Theme): DiffPalette {
	const added = escapeOf(theme, "toolDiffAdded");
	const removed = escapeOf(theme, "toolDiffRemoved");
	return {
		removed: paintOf(removed, 0),
		added: paintOf(added, 0),
		context: (text) => theme.fg("toolDiffContext", text),
		note: (text) => theme.fg("accent", text),
		separator: (text) => theme.fg("dim", text),
		removedEmphasis: paintOf(removed, 1),
		addedEmphasis: paintOf(added, 1),
	};
}

/** keyHint needs an initialized TUI theme; a render must never die for a hint. */
function safeHint(id: string, description: string): string {
	try {
		return keyHint(id, description);
	} catch {
		return description;
	}
}

/** `PI_DIFF_MODE=split|unified` pins the layout; anything else decides per hunk. */
export function configuredMode(): DiffMode {
	const setting = process.env.PI_DIFF_MODE;
	return setting === "split" || setting === "unified" ? setting : "auto";
}

/**
 * Lays the diff out against the width it is actually given.
 *
 * `renderResult` runs when the row changes, but `render` runs on every frame
 * and every resize, so the layout decision has to live here rather than in the
 * renderer. Caching mirrors `Text`: keyed on width, dropped by `invalidate` —
 * and keyed on the terminal's colour answers too, so a row painted before they
 * arrived, or before a light/dark flip, repaints itself instead of holding a
 * palette that is no longer true.
 */
export class DiffView implements Component {
	private cachedWidth?: number;
	private cachedColors?: number;
	private cachedLines?: string[];

	constructor(
		private readonly diff: string,
		private readonly palette: DiffPalette,
		private readonly mode: DiffMode,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		const colors = slotColors().version;
		if (this.cachedLines && this.cachedWidth === width && this.cachedColors === colors) return this.cachedLines;

		let lines: string[];
		try {
			lines = layoutDiff(this.diff, width, { palette: this.palette, mode: this.mode });
		} catch {
			// A broken layout must still show the edit. Clipping the raw diff is
			// ugly and always correct.
			lines = this.diff.split("\n").map((line) => this.palette.context(sliceByColumn(line, 0, width, true)));
		}

		if (!this.expanded && lines.length > DIFF_PREVIEW_LINES) {
			const hidden = lines.length - DIFF_PREVIEW_LINES;
			const note = `${this.palette.context(`… ${hidden} more lines`)} (${safeHint("app.tools.expand", "expand to see")})`;
			lines = [...lines.slice(0, DIFF_PREVIEW_LINES), truncateToWidth(note, width)];
		}

		this.cachedWidth = width;
		this.cachedColors = colors;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedColors = undefined;
		this.cachedLines = undefined;
	}
}
