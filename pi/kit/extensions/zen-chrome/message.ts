/**
 * Pure layout for a transcript message closed into the prompt's box.
 *
 *     ╭─ User ──────────────────────────────────╮
 *     │ what should we do about the flaky test? │
 *     ╰─────────────────────────────────────────╯
 *
 * A sent message keeps the shape it had while it was being typed, so the
 * transcript reads as a column of the same box rather than two vocabularies.
 *
 * Nothing here touches pi state, so `preview.ts` can exercise it without a TUI.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOTTOM_ENDS, type Paint, type Piece, rule, SIDE, stripAnsi, TOP_ENDS } from "./chrome.ts";

/** Columns taken by the left and right edges. */
export const FRAME = 2;

/**
 * Columns a body must be narrower than the box: the two edges plus a space of
 * air inside each. The frame owns that air — pi's `outputPad` is 0 here, so a
 * render arrives flush against its own margin and would otherwise sit hard
 * against the border.
 */
export const INSET = FRAME + 2;

/**
 * Under this the frame costs more than it explains: `╭─ User ─╮` alone is nine
 * columns, and what is left would wrap mid-word.
 */
export const MIN_WIDTH = 16;

const RESET = "\x1b[0m";

function isBlank(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

/** Drops the blank rows a padded message box leaves above and below its text. */
function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start] ?? "")) start++;
	while (end > start && isBlank(lines[end - 1] ?? "")) end--;
	return lines.slice(start, end);
}

/**
 * Forces a rendered row to exactly `width` visible columns, so the right edge
 * lands in the same column on every line.
 */
function exactly(line: string, width: number): string {
	const overflow = visibleWidth(line) - width;
	// Cutting a row can drop the escape that closed its colour, which would then
	// bleed into the border, so close it here.
	if (overflow > 0) return truncateToWidth(line, width, "") + RESET;
	return line + " ".repeat(-overflow);
}

/**
 * Closes `body` into a labelled box.
 *
 * `body` must already have been rendered `INSET` columns narrower than `width`.
 * Returns `[]` when there is nothing worth framing, so callers can fall back to
 * the plain render rather than inspect the same conditions twice.
 */
export function frame(body: string[], width: number, label: Piece[], border: Paint): string[] {
	if (width < MIN_WIDTH) return [];
	const rows = trimBlank(body);
	if (rows.length === 0) return [];

	const side = border(SIDE);
	const inner = width - INSET;
	return [
		rule(width, label, [], border, TOP_ENDS),
		...rows.map((row) => side + " " + exactly(row, inner) + " " + side),
		rule(width, [], [], border, BOTTOM_ENDS),
	];
}
