import { type Cell, fromCells, toCells } from "../../lib/ui/sgr-cells.ts";
import { fg, lerp, luminance } from "../../lib/ui/rgb-color.ts";
import { restOf } from "../../lib/ui/prism-light.ts";

export const DARK_MS = 750;

/** How long the light takes to arrive and settle into the resting palette. */
export const LIT_MS = 1600;

/** The whole wake, end to end. */
export const WAKE_MS = DARK_MS + LIT_MS;

const CLEAR = 0.4;
const HOLD = 0.35;

function smoothstep(x: number): number {
	const c = Math.max(0, Math.min(1, x));
	return c * c * (3 - 2 * c);
}

/** Where the wake is now: how grey the bar is, and how strongly the light is on it, both 0..1. */
export interface Wake {
	readonly grey: number;
	readonly light: number;
}

export function wakeAt(since: number, now: number): Wake | null {
	const elapsed = now - since;
	if (elapsed < 0) return null;
	if (elapsed < DARK_MS) return { grey: 1, light: 1 };
	const p = (elapsed - DARK_MS) / LIT_MS;
	if (p >= 1) return null;
	return {
		grey: 1 - smoothstep(p / CLEAR),
		light: 1 - smoothstep((p - HOLD) / (1 - HOLD)),
	};
}

export function greyOut(lines: string[], amount: number): string[] {
	const k = Math.max(0, Math.min(1, amount));
	if (k <= 0) return lines;
	return lines.map((line) => fromCells(toCells(line).map((cell) => grey(cell, k))));
}

function grey(cell: Cell, k: number): Cell {
	const rest = restOf(cell.sgr);
	if (rest === null) return cell;
	const luma = Math.round(luminance(rest));
	return { ch: cell.ch, sgr: cell.sgr + fg(lerp(rest, { r: luma, g: luma, b: luma }, k)) };
}
