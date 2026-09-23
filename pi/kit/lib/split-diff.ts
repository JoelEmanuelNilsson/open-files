/**
 * Side-by-side layout for pi's display diffs.
 *
 * pi renders edits as a flat string of `-12 old` / `+12 new` / ` 12 context`
 * lines and hands it to a `Text`, which word-wraps it. Word wrap is wrong for
 * code: it reflows at spaces, drops the gutter on continuations, and destroys
 * indentation. And stacking every removal above its addition spends a screen
 * row on each half of a one-character change.
 *
 * This module lays the same diff out in columns instead, and decides per hunk
 * whether columns are affordable at the width it was handed:
 *
 *   - Context lines span the full width once. Printing them twice, as a
 *     graphical diff viewer does, is the single most expensive thing you can do
 *     to a 60-column pane, and it shows nothing.
 *   - A run of changes goes side by side only when every one of its lines fits
 *     its column. A long line split across two half-columns wraps into ragged
 *     fragments on *both* sides, which is harder to read than not splitting.
 *   - Below `MIN_CODE_WIDTH` usable columns per side there is no layout worth
 *     having, so the whole diff falls back to stacked.
 *
 * Everything here is pure: text in, painted lines out. `preview.ts`-style
 * harnesses can exercise the entire visual language without booting a TUI.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Paints a run of text. Widths are always measured before painting. */
export type Paint = (text: string) => string;

/**
 * The six colours a diff needs. Kept structural so tests can pass identity
 * functions and read the geometry.
 */
export interface DiffPalette {
	removed: Paint;
	added: Paint;
	context: Paint;
	/** `File: path` headers and anything else that is not a diff line. */
	note: Paint;
	/** The rule between the two columns. */
	separator: Paint;
	/** Applied to the changed span *within* a removed line. */
	removedEmphasis: Paint;
	/** Applied to the changed span *within* an added line. */
	addedEmphasis: Paint;
}

export type DiffMode = "auto" | "split" | "unified";

export interface DiffLayoutOptions {
	palette: DiffPalette;
	/** `auto` decides per hunk. `split` and `unified` still respect hard limits. */
	mode?: DiffMode;
}

/**
 * Floor on usable columns per side. This is only a guard against degenerate
 * widths where the gutter would outweigh the code; whether a given hunk is
 * *actually* narrow enough is decided by `hunkSuitsColumns`, which checks the
 * lines themselves rather than the space they were offered.
 */
const MIN_CODE_WIDTH = 12;
/** Columns spent on the rule between the two halves. */
const SEPARATOR = " │ ";
/** Marks a fragment continued from the line above. */
const CONTINUATION = "↳";
/**
 * An intra-line highlight covering most of the line is noise: the eye wants to
 * be pointed at the token that moved, not told the line changed.
 */
const MAX_EMPHASIS_RATIO = 0.8;
/** Characters a wrapped code line prefers to break after. */
const BREAK_CHARS = new Set([" ", "\t", ",", "(", ")", "{", "}", "[", "]", ";", ".", ":", "=", "<", ">", "/"]);
/** How far back from the wrap column to look for a break character. */
const BREAK_SEARCH_RATIO = 0.3;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One side of one line: the number pi printed, and the code. */
interface Cell {
	num: string;
	text: string;
}

type Row =
	/** Unchanged, or the ` ... ` elision marker. Rendered once, full width. */
	| { kind: "context"; cell: Cell }
	/** A removal, an addition, or a removal paired with its addition. */
	| { kind: "change"; removed?: Cell; added?: Cell }
	/** `File: path` headers, blank separators, anything that is not a diff line. */
	| { kind: "note"; text: string };

const DIFF_LINE = /^([+-\s])(\s*\d*)\s(.*)$/;

function parseLine(line: string): { sign: "+" | "-" | " "; cell: Cell } | undefined {
	const match = DIFF_LINE.exec(line);
	if (!match) return undefined;
	const sign = match[1] === "+" ? "+" : match[1] === "-" ? "-" : " ";
	return { sign, cell: { num: match[2].trim(), text: match[3].replace(/\t/g, "   ") } };
}

/**
 * Fold the diff into rows, pairing each run of removals with the run of
 * additions that follows it. Pairing is positional, which is what
 * `Diff.diffLines` gives us: it reports a changed block as "these N lines left,
 * these M lines arrived" without saying which became which.
 */
export function parseRows(diff: string): Row[] {
	const lines = diff.split("\n");
	const rows: Row[] = [];
	let index = 0;

	while (index < lines.length) {
		const parsed = parseLine(lines[index]);

		if (!parsed) {
			rows.push({ kind: "note", text: lines[index] });
			index++;
			continue;
		}

		if (parsed.sign === " ") {
			rows.push({ kind: "context", cell: parsed.cell });
			index++;
			continue;
		}

		const removed: Cell[] = [];
		while (index < lines.length) {
			const next = parseLine(lines[index]);
			if (!next || next.sign !== "-") break;
			removed.push(next.cell);
			index++;
		}

		const added: Cell[] = [];
		while (index < lines.length) {
			const next = parseLine(lines[index]);
			if (!next || next.sign !== "+") break;
			added.push(next.cell);
			index++;
		}

		const height = Math.max(removed.length, added.length);
		for (let offset = 0; offset < height; offset++) {
			rows.push({ kind: "change", removed: removed[offset], added: added[offset] });
		}
	}

	return rows;
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/**
 * Hard-wrap a line of code to `width` columns, breaking after a delimiter when
 * one is near the wrap column. Continuations carry the original indentation and
 * a `↳`, so a fragment never reads as a statement of its own.
 */
export function wrapCode(text: string, width: number): string[] {
	if (width < 2) return [sliceByColumn(text, 0, Math.max(1, width))];
	if (visibleWidth(text) <= width) return [text];

	const indent = /^\s*/.exec(text)?.[0] ?? "";
	let marker = indent + CONTINUATION;
	if (width - visibleWidth(marker) < MIN_CODE_WIDTH / 2) marker = CONTINUATION;
	if (width - visibleWidth(marker) < 2) marker = "";

	const fragments: string[] = [];
	let rest = text;
	let first = true;

	while (rest.length > 0) {
		const prefix = first ? "" : marker;
		const available = width - visibleWidth(prefix);

		if (visibleWidth(rest) <= available) {
			fragments.push(prefix + rest);
			break;
		}

		const head = sliceByColumn(rest, 0, available, true);
		let cut = head.length > 0 ? head.length : 1;

		const searchFrom = Math.floor(cut * (1 - BREAK_SEARCH_RATIO));
		for (let at = cut - 1; at >= searchFrom; at--) {
			if (BREAK_CHARS.has(head[at])) {
				cut = at + 1;
				break;
			}
		}

		fragments.push(prefix + rest.slice(0, cut));
		rest = rest.slice(cut);
		first = false;
	}

	return fragments;
}

// ---------------------------------------------------------------------------
// Intra-line emphasis
// ---------------------------------------------------------------------------

/**
 * The span that actually changed, as `[start, end)` character indices into each
 * side. Returns `undefined` when the whole line moved, which is when pointing
 * at a span tells you nothing.
 */
function changedSpan(before: string, after: string): { removed: [number, number]; added: [number, number] } | undefined {
	const beforeChars = [...before];
	const afterChars = [...after];
	const shortest = Math.min(beforeChars.length, afterChars.length);

	let head = 0;
	while (head < shortest && beforeChars[head] === afterChars[head]) head++;

	let tail = 0;
	while (
		tail < shortest - head &&
		beforeChars[beforeChars.length - 1 - tail] === afterChars[afterChars.length - 1 - tail]
	) {
		tail++;
	}

	const removedLength = beforeChars.length - head - tail;
	const addedLength = afterChars.length - head - tail;
	if (removedLength === 0 && addedLength === 0) return undefined;

	const longest = Math.max(beforeChars.length, afterChars.length);
	if (longest > 0 && Math.max(removedLength, addedLength) / longest > MAX_EMPHASIS_RATIO) return undefined;

	const removedStart = beforeChars.slice(0, head).join("").length;
	const addedStart = afterChars.slice(0, head).join("").length;
	return {
		removed: [removedStart, removedStart + beforeChars.slice(head, head + removedLength).join("").length],
		added: [addedStart, addedStart + afterChars.slice(head, head + addedLength).join("").length],
	};
}

/** Paint `text`, with `[start, end)` picked out in `emphasis`. */
function paintSpan(text: string, span: [number, number] | undefined, base: Paint, emphasis: Paint): string {
	if (!span || span[0] >= span[1]) return base(text);
	const [start, end] = span;
	return base(text.slice(0, start)) + emphasis(text.slice(start, end)) + base(text.slice(end));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function gutterWidth(rows: Row[]): number {
	let widest = 1;
	for (const row of rows) {
		if (row.kind === "context") widest = Math.max(widest, row.cell.num.length);
		if (row.kind === "change") {
			widest = Math.max(widest, row.removed?.num.length ?? 0, row.added?.num.length ?? 0);
		}
	}
	return widest;
}

/**
 * The left margin of a diff line. Degrades as the width runs out: `279- `, then
 * `- `, then `-`. The sign outlives the number, because a diff that cannot say
 * which side a line came from is not a diff.
 */
interface Gutter {
	width: number;
	render(num: string, sign: string): string;
}

/** Code columns a gutter style must leave behind to justify itself. */
const GUTTER_KEEPS_CODE = 8;

function chooseGutter(numWidth: number, available: number): Gutter {
	if (numWidth + 2 + GUTTER_KEEPS_CODE <= available) {
		return { width: numWidth + 2, render: (num, sign) => `${num.padStart(numWidth)}${sign} ` };
	}
	if (2 + 2 <= available) return { width: 2, render: (_num, sign) => `${sign} ` };
	return { width: 1, render: (_num, sign) => sign };
}

/** A run of consecutive change rows, decided on as one visual unit. */
function hunkAt(rows: Row[], start: number): number {
	let end = start;
	while (end < rows.length && rows[end].kind === "change") end++;
	return end;
}

/**
 * Columns are worth their cost only when something was actually replaced. A run
 * of pure insertions or pure deletions has no counterpart to put opposite it,
 * so splitting it just blanks half the width.
 */
function hunkSuitsColumns(rows: Row[], from: number, to: number, codeWidth: number): boolean {
	let paired = false;
	for (let at = from; at < to; at++) {
		const row = rows[at];
		if (row.kind !== "change") continue;
		if (row.removed && row.added) paired = true;
		if (row.removed && visibleWidth(row.removed.text) > codeWidth) return false;
		if (row.added && visibleWidth(row.added.text) > codeWidth) return false;
	}
	return paired;
}

function padTo(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function renderContext(cell: Cell, width: number, gutter: Gutter, palette: DiffPalette): string[] {
	const head = gutter.render(cell.num, " ");
	const body = wrapCode(cell.text, Math.max(1, width - gutter.width));
	return body.map((fragment, at) => palette.context((at === 0 ? head : " ".repeat(gutter.width)) + fragment));
}

function renderStacked(row: Row, width: number, gutter: Gutter, palette: DiffPalette): string[] {
	if (row.kind !== "change") return [];
	const lines: string[] = [];
	const span = row.removed && row.added ? changedSpan(row.removed.text, row.added.text) : undefined;

	const emit = (cell: Cell, sign: "-" | "+", base: Paint, emphasis: Paint, range: [number, number] | undefined) => {
		const head = gutter.render(cell.num, sign);
		const room = Math.max(1, width - gutter.width);
		const body = wrapCode(cell.text, room);
		// Changed lines are padded to the full width: the palette paints them as
		// a background, and a background that stops at the last character reads
		// as ragged blocks instead of a row.
		// A wrapped cell loses its character offsets, so emphasis is dropped
		// rather than painted in the wrong place.
		if (body.length === 1) {
			lines.push(base(head) + paintSpan(padTo(body[0], room), range, base, emphasis));
			return;
		}
		for (const [at, fragment] of body.entries()) {
			lines.push(base((at === 0 ? head : " ".repeat(gutter.width)) + padTo(fragment, room)));
		}
	};

	if (row.removed) emit(row.removed, "-", palette.removed, palette.removedEmphasis, span?.removed);
	if (row.added) emit(row.added, "+", palette.added, palette.addedEmphasis, span?.added);
	return lines;
}

function renderColumns(row: Row, sideWidth: number, rightWidth: number, gutter: Gutter, palette: DiffPalette): string {
	if (row.kind !== "change") return "";
	const span = row.removed && row.added ? changedSpan(row.removed.text, row.added.text) : undefined;

	const half = (
		cell: Cell | undefined,
		sign: "-" | "+",
		base: Paint,
		emphasis: Paint,
		range: [number, number] | undefined,
		side: number,
	) => {
		if (!cell) return " ".repeat(side);
		const head = gutter.render(cell.num, sign);
		const room = Math.max(1, side - gutter.width);
		// `mode: "split"` can force columns onto a hunk that does not fit. Clip
		// rather than overflow: a line wider than `width` corrupts the frame.
		const body = visibleWidth(cell.text) > room ? sliceByColumn(cell.text, 0, room, true) : cell.text;
		return base(head) + paintSpan(padTo(body, room), range, base, emphasis);
	};

	// The odd column goes to the right side, so both halves together fill the row.
	const left = half(row.removed, "-", palette.removed, palette.removedEmphasis, span?.removed, sideWidth);
	const right = half(row.added, "+", palette.added, palette.addedEmphasis, span?.added, rightWidth);
	return left + palette.separator(SEPARATOR) + right;
}

/**
 * Lay a pi display diff out for `width` columns.
 *
 * Never returns a line wider than `width`; the TUI composites on that promise.
 */
export function layoutDiff(diff: string, width: number, options: DiffLayoutOptions): string[] {
	const { palette, mode = "auto" } = options;
	const rows = parseRows(diff);
	const numWidth = gutterWidth(rows);
	const usable = Math.max(1, width);

	const sideWidth = Math.floor((usable - SEPARATOR.length) / 2);
	const rightWidth = usable - SEPARATOR.length - sideWidth;
	// Each half is laid out on its own, so the split view picks its gutter from
	// the column width rather than the row width.
	const splitGutter = chooseGutter(numWidth, sideWidth);
	const stackedGutter = chooseGutter(numWidth, usable);
	const codeWidth = sideWidth - splitGutter.width;
	const columnsPossible = mode !== "unified" && codeWidth >= MIN_CODE_WIDTH;

	const lines: string[] = [];
	let at = 0;

	while (at < rows.length) {
		const row = rows[at];

		if (row.kind === "note") {
			if (row.text === "") lines.push("");
			else lines.push(...wrapCode(row.text, usable).map(palette.note));
			at++;
			continue;
		}

		if (row.kind === "context") {
			lines.push(...renderContext(row.cell, usable, stackedGutter, palette));
			at++;
			continue;
		}

		const end = hunkAt(rows, at);
		const columns = columnsPossible && (mode === "split" || hunkSuitsColumns(rows, at, end, codeWidth));

		for (let cursor = at; cursor < end; cursor++) {
			if (columns) lines.push(renderColumns(rows[cursor], sideWidth, rightWidth, splitGutter, palette));
			else lines.push(...renderStacked(rows[cursor], usable, stackedGutter, palette));
		}
		at = end;
	}

	return lines;
}
