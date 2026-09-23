/**
 * The chrome waking: the frame opens grey and switches on a moment later, lit
 * by the same light the running surfaces use.
 *
 * Every colour on this chrome means something — the accent on the cwd, the
 * temperature of the effort strip, the lamps on a border with a request in
 * flight. A surface that is simply born coloured never shows that its colour
 * is a state. Opening grey and turning on says it once per session, in under
 * two seconds, and then the bar sits at rest for the rest of the session.
 *
 * Grey means desaturated, not dimmed: every glyph keeps its brightness and
 * loses its hue, so the bar is fully readable the whole way through and the
 * only thing the wake changes is colour.
 *
 * No state lives here. `wakeAt` is a pure function of the instant the session
 * opened and the clock, so the timeline is testable on its own and the
 * renderer holds nothing but that instant. Preview it with `./test.sh`.
 */

import { type Cell, fg, fromCells, toCells } from "./animate.ts";
import { lerp, luminance } from "../../lib/rgb.ts";
import { restOf } from "./prism.ts";

/**
 * How long the bar stays grey before it lights.
 *
 * Long enough to be read as a state the eye arrives at rather than a flicker
 * on the way to the real thing, short enough that nobody waits for the bar to
 * finish before typing — and typing during it changes nothing, since the wake
 * only ever repaints.
 */
export const DARK_MS = 750;

/** How long the light takes to arrive and settle into the resting palette. */
export const LIT_MS = 1600;

/** The whole wake, end to end. */
export const WAKE_MS = DARK_MS + LIT_MS;

/**
 * The fraction of the lit phase the grey takes to clear, and the fraction the
 * light holds at full before it starts leaving.
 *
 * The grey goes first and the light leaves second, deliberately: the colour has
 * to be at full while the grey lifts, or the bar fades up into its resting
 * colours and the turning-on never happens.
 */
const CLEAR = 0.4;
const HOLD = 0.35;

/** `0` below the ramp, `1` above it, eased at both ends in between. */
function smoothstep(x: number): number {
	const c = Math.max(0, Math.min(1, x));
	return c * c * (3 - 2 * c);
}

/** Where the wake is now: how grey the bar is, and how strongly the light is on it, both 0..1. */
export interface Wake {
	readonly grey: number;
	readonly light: number;
}

/**
 * The wake at `now` for a session that opened at `since`, or null once the bar
 * is awake — which is also the caller's signal to stop asking for frames.
 */
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

/**
 * The same lines with `amount` of their colour taken out, 0 leaving them as
 * they were and 1 leaving every glyph at its own brightness in grey.
 *
 * Rec. 601 luma, not a fixed grey: a bar flattened to one grey would lose the
 * difference between its dim border and its bright text, and the wake is about
 * colour arriving, not about the layout appearing. A glyph whose colour cannot
 * be resolved — plain text the theme never painted — is left alone, since
 * there is nothing to take out of it.
 */
export function greyOut(lines: string[], amount: number): string[] {
	const k = Math.max(0, Math.min(1, amount));
	if (k <= 0) return lines;
	return lines.map((line) => fromCells(toCells(line).map((cell) => grey(cell, k))));
}

function grey(cell: Cell, k: number): Cell {
	const rest = restOf(cell.sgr);
	if (rest === null) return cell;
	const luma = Math.round(luminance(rest));
	// Appended, not substituted: the glyph keeps its bold and whatever else the
	// theme set, and the later foreground wins.
	return { ch: cell.ch, sgr: cell.sgr + fg(lerp(rest, { r: luma, g: luma, b: luma }, k)) };
}
