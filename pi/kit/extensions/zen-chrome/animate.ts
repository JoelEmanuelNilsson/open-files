/**
 * The colour primitives the chrome's light is built out of: the shared RGB
 * arithmetic, the split of a painted line into repaintable cells, and the frame
 * rates the animations run at. The animation itself lives in `prism.ts`.
 *
 * Everything here is pure. Preview the light with `./test.sh`.
 */

// Colour arithmetic is shared with the diff rows; see lib/rgb.ts. Re-exported
// so the chrome's own consumers keep asking this module for it.
import { fg, hex, type Rgb, rgbFromPainted } from "../../lib/rgb.ts";

export { fg, hex, type Rgb, rgbFromPainted };

/** One terminal cell: its glyph and the SGR sequence active when it was drawn. */
export interface Cell {
	ch: string;
	sgr: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const SGR = /\x1b\[[0-9;]*m/y;

/**
 * Splits a painted line into cells so individual glyphs can be repainted.
 *
 * SGR codes accumulate until a reset clears them, so the active style is the
 * concatenation of everything seen since the last reset — compound styles like
 * bold-plus-colour survive the round trip. Code points are treated as one
 * column each, which holds for every glyph the chrome emits.
 */
export function toCells(line: string): Cell[] {
	const cells: Cell[] = [];
	let active = "";
	let i = 0;
	while (i < line.length) {
		SGR.lastIndex = i;
		const match = SGR.exec(line);
		if (match) {
			const reset = match[0] === "\x1b[0m" || match[0] === "\x1b[m";
			active = reset ? "" : active + match[0];
			i += match[0].length;
			continue;
		}
		const ch = String.fromCodePoint(line.codePointAt(i) ?? 0);
		cells.push({ ch, sgr: active });
		i += ch.length;
	}
	return cells;
}

/** Rebuilds a painted line, emitting escapes only where the style changes. */
export function fromCells(cells: Cell[]): string {
	let out = "";
	let active: string | null = null;
	for (const cell of cells) {
		if (cell.sgr !== active) {
			out += "\x1b[0m" + cell.sgr;
			active = cell.sgr;
		}
		out += cell.ch;
	}
	return out + "\x1b[0m";
}

/** Which glyphs an animation repaints. The box outline is the default; a text row asks for all of them. */
export type Paints = (glyph: string) => boolean;

/** Every glyph, for callers whose whole line is the light's surface. */
export const EVERY_GLYPH: Paints = () => true;

/** Milliseconds between frames while a request is in flight (~30fps). */
export const FRAME_MS = 33;

/** Milliseconds between frames while a warm label idles (~25fps). */
export const SHIMMER_FRAME_MS = 40;

/**
 * Milliseconds between frames of the dock's repaint clock, which runs while a
 * child agent is live (~10fps).
 *
 * It lives here with the other frame rates because a light's speed limit is
 * derived from the rate its surface is repainted at; see `travelPeriod` in
 * `prism.ts`.
 */
export const ROW_FRAME_MS = 100;

/**
 * How long light takes to leave a surface it is done with: the border once a
 * turn settles, the model label once a level change has been seen.
 *
 * One number for both, because it is one idea — a light that stops dead reads
 * as a glitch, and two surfaces letting go at different rates read as two
 * unrelated animations.
 */
export const FADE_MS = 900;
