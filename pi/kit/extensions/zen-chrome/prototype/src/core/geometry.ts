/** PROTOTYPE — throwaway. Builds the chatbar's character grid, matching zen-chrome's chrome.ts. */

import type { Box, Cell, CellKind, Palette } from "./types.ts";

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const SIDE = "│";
const DASH = "─";

export interface Labels {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	/** What the user has typed; empty means just a cursor. */
	input: string;
}

export const DEFAULT_LABELS: Labels = {
	topLeft: "⚡/2",
	topRight: "fable high",
	bottomLeft: "main",
	bottomRight: "57s ❄ 27m 8.0%",
	input: "",
};

/** A rule row: corner, `─ label `, dashes, ` label ─`, corner. Returns glyphs plus which are label cells. */
function ruleRow(cols: number, left: string, right: string): { glyphs: string[]; label: boolean[] } {
	const glyphs: string[] = [];
	const label: boolean[] = [];
	const push = (text: string, isLabel: boolean) => {
		for (const ch of text) {
			glyphs.push(ch);
			label.push(isLabel);
		}
	};
	push(DASH + " ", false);
	push(left, true);
	push(" ", false);
	const tail = ` ${right} ${DASH}`;
	const fill = Math.max(1, cols - 2 - glyphs.length - tail.length);
	push(DASH.repeat(fill), false);
	push(" ", false);
	push(right, true);
	push(` ${DASH}`, false);
	return { glyphs, label };
}

/**
 * The chatbar as a grid of cells, plus the outline path every effect travels
 * along. Row 0 is the top rule, the last row is the bottom rule, and the rows
 * between are the input area.
 */
export function buildBox(cols: number, rows: number, labels: Labels, palette: Palette): Box {
	const cells: Cell[] = [];
	const at = new Map<string, Cell>();
	const add = (x: number, y: number, glyph: string, kind: CellKind) => {
		const cell: Cell = {
			x,
			y,
			glyph,
			kind,
			ring: -1,
			ringIndex: -1,
			color: kind === "label" ? palette.label : kind === "cursor" ? palette.dim : palette.base,
		};
		cells.push(cell);
		at.set(`${x},${y}`, cell);
	};

	const top = ruleRow(cols, labels.topLeft, labels.topRight);
	const bottom = ruleRow(cols, labels.bottomLeft, labels.bottomRight);
	const last = rows - 1;

	add(0, 0, TOP_LEFT, "corner");
	for (let i = 0; i < cols - 2; i++) add(i + 1, 0, top.glyphs[i] ?? DASH, top.label[i] ? "label" : "rule");
	add(cols - 1, 0, TOP_RIGHT, "corner");

	for (let y = 1; y < last; y++) {
		add(0, y, SIDE, "side");
		for (let x = 1; x < cols - 1; x++) add(x, y, " ", "interior");
		add(cols - 1, y, SIDE, "side");
	}

	add(0, last, BOTTOM_LEFT, "corner");
	for (let i = 0; i < cols - 2; i++) add(i + 1, last, bottom.glyphs[i] ?? DASH, bottom.label[i] ? "label" : "rule");
	add(cols - 1, last, BOTTOM_RIGHT, "corner");

	// The input line: typed text, then the block cursor.
	const inputRow = 1;
	let x = 2;
	for (const ch of labels.input) {
		const cell = at.get(`${x},${inputRow}`);
		if (cell) {
			cell.glyph = ch;
			cell.kind = "label";
			cell.color = palette.label;
		}
		x++;
	}
	const cursor = at.get(`${x},${inputRow}`);
	if (cursor) {
		cursor.glyph = "▌";
		cursor.kind = "cursor";
		cursor.color = palette.dim;
	}

	// The outline path, clockwise from the top-left corner.
	const path: Array<[number, number]> = [];
	for (let i = 0; i < cols; i++) path.push([i, 0]);
	for (let y = 1; y < last; y++) path.push([cols - 1, y]);
	for (let i = cols - 1; i >= 0; i--) path.push([i, last]);
	for (let y = last - 1; y >= 1; y--) path.push([0, y]);

	path.forEach(([px, py], index) => {
		const cell = at.get(`${px},${py}`);
		if (!cell) return;
		cell.ringIndex = index;
		cell.ring = index / path.length;
	});

	return { cols, rows, cells, ringLength: path.length };
}

/** Shortest distance between two positions on the ring, in cells. */
export function ringDistance(a: number, b: number, ringLength: number): number {
	const d = Math.abs(a - b) % ringLength;
	return Math.min(d, ringLength - d);
}
