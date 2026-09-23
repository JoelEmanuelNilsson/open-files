/**
 * The chrome's light: lamps riding a closed rail, each owning the colour of the
 * cells nearest it.
 *
 * Every animated surface in the chrome is one of these — the box outline while
 * a request is in flight, the model label while a fresh session's first request
 * would read its prefix from cache, and a background task, both on its own row
 * in the dock and in the `1 task ↓` count in the bottom rule, while its agent
 * works. They differ only in the rail the lamps ride and in whether the light
 * replaces the surface's colour or tints it.
 *
 * The rail is always closed. A lamp that runs along a segment and wraps at the
 * end teleports, and one discontinuity per lap is enough to read as the whole
 * animation hopping; a loop has no ends to wrap at. That is why a box uses its
 * perimeter and a row of text uses a circle rather than a left-to-right sweep.
 *
 * The colour is pigment, not summed light. Adding two hues in RGB lands greyer
 * and paler than either, which is where pastels come from; averaging the lamps'
 * hues as positions on the arc keeps every mix at full chroma. Distance is
 * measured along the rail, so a lamp on the top edge of a box does not light the
 * bottom edge and the outline shows lamps rather than an even band. Brightness
 * is one ramp of *value* from the dim end to the lamp's core — the ramp is
 * depth, never chroma — and the two ends of that ramp are the only thing the
 * terminal's background changes.
 *
 * Preview with `./test.sh`.
 */

import {
	type Cell,
	EVERY_GLYPH,
	fg,
	FRAME_MS,
	fromCells,
	type Paints,
	type Rgb,
	ROW_FRAME_MS,
	SHIMMER_FRAME_MS,
	toCells,
} from "./animate.ts";
import { HOME_GLYPH } from "../../lib/home-glyph.ts";
import { activeForeground, lerp, luminance } from "../../lib/rgb.ts";
import { glowName } from "./choice.ts";
import { slotColors } from "../../lib/slot-colors.ts";

export { EVERY_GLYPH, type Paints };

/**
 * `PI_ZEN_WAVE=off` stops every surface animating.
 *
 * The light costs a render every 33ms for as long as a turn lasts. On a terminal
 * compositing a blurred translucent background that is not free, and it is the
 * only thing in this config asking for a steady frame rate, so it is the first
 * thing to turn off when the transcript is not streaming smoothly.
 */
export function waveEnabled(): boolean {
	return (process.env.PI_ZEN_WAVE ?? "").toLowerCase() !== "off";
}

/** A colour in linear 0..1 floats. */
interface Vec3 {
	x: number;
	y: number;
	z: number;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A row is about this many columns tall; folded into any distance meant to look round. */
const ASPECT = 2.1;

/** How fast a lamp travels, in cells per second.
 *
 *  Fixed as a speed rather than as a lap time: a lap time would fling the lamps
 *  around a wide terminal and crawl them around a narrow one. Calibrated so the
 *  box Joel tuned on — 78 columns, 5 rows, a lap of ~171 cells — takes just
 *  over six seconds. */
const SPEED = 28;

/** Floor on seconds per lap, so a short strip of text does not strobe. */
const MIN_PERIOD = 2.6;

/**
 * How far a lamp may travel between two frames, as a fraction of its own
 * falloff radius.
 *
 * Past roughly a quarter of it the pool of light arrives somewhere it never
 * travelled through, and what the eye reads is a lamp stepping rather than one
 * sliding.
 */
const STEP_RATIO = 0.25;

/** The range of lamps a rail is allowed to hold, however its light is spaced. */
const MIN_LAMPS = 2;
const MAX_LAMPS = 8;

/**
 * A lamp's falloff radius as a fraction of the spacing between lamps:
 * `1/(1 + d²/reach²)`.
 *
 * A ratio and not a length, so a light is tuned by saying how far apart its
 * lamps sit and nothing else. Lamps twice as far apart with the same reach are
 * not the same picture at half scale — they are the same pools of light with
 * twice as much unlit rail between them — and every time the two were set
 * independently the second one had to be re-derived from the first anyway.
 */
const REACH_RATIO = 0.31;

/**
 * The arc of the wheel the colour lives on: blue, indigo, violet, magenta, pink,
 * coral, red, gold, yellow, green. Stated as a range running past 360 because it
 * is the long way round — the only thing outside it is the wedge from green to
 * blue: teal, cyan, sky, the whole pale-blue stretch, which is the one thing a
 * holographic foil never shows.
 *
 * The hue is *folded* at both ends rather than wrapped: a lamp arriving at green
 * turns round and walks back toward blue. That makes the wedge unreachable
 * rather than merely unlikely, and no lamp ever snaps from one end of the arc
 * to the other in a single frame.
 */
const HUE_MIN = 225;
const HUE_MAX = 360 + 140;

/** Seconds for a lamp to cross the arc and come back. */
const HUE_PERIOD = 13;

/**
 * Where along the arc a lamp lingers: below 1 at the two ends, above 1 in the
 * middle. Below 1, because the middle needs no help: it is also where a mix of
 * two neighbouring lamps lands, so it dominates the palette whatever this is.
 */
const HUE_DWELL = 0.7;

/**
 * How much of a fold the lamps are spread over, on a strip of text.
 *
 * All of it. A fold is there-and-back, so lamps spread across the whole of it
 * pair up — six lamps hold four distinct hues, and the pairs sit at opposite
 * ends of the strip. Spread across less than a fold, neighbouring lamps land
 * within a few degrees of each other and the whole rail reads as one long
 * string of a single colour slowly changing.
 *
 * Which is what the box outline wants and text does not. A row of text is read
 * word by word, so a hue that changes along it is a property of the row; a
 * border is seen whole, and a hue that changes along *it* is a rainbow lying
 * across the screen. The box lights set their own spread; see `ONE_HUE`.
 */
const HUE_SPREAD = 1;

/** Saturation, the same at both ends of the ramp: the ramp is depth, never chroma. */
const SATURATION = 0.62;

/**
 * Contrast on the depth ramp for a strip of text: above 1 collapses the
 * falloff's long tail toward the floor. The box lights take twice this, which
 * is what turns a lamp from a bright stretch into a pool with a dim rail either
 * side of it.
 */
const CONTRAST = 1.6;

/**
 * How far a lit glyph travels from its resting colour under a lamp. Text is
 * read, so the light tints it and never replaces it.
 */
const TINT = 0.9;

/**
 * The two ends of the value ramp, in sRGB HSV terms, and the value of the ink
 * that tints text — the only quantities the terminal's background changes.
 *
 * The hue arc is deliberately not one of them: which colours belong together is
 * not a property of the paper.
 */
interface Surface {
	/** HSV value under a lamp's core. */
	readonly value: number;
	/** HSV value where no lamp reaches. */
	readonly floor: number;
	/** HSV value of the hue mixed into text. */
	readonly ink: number;
}

/**
 * Ink-blue background, pale text: a bright core and a floor well under it.
 *
 * The floor used to be the value, on the reading that a dip between lamps looks
 * like a gap in the line. It does not: what reads as a gap is a dip on a line
 * that is otherwise evenly bright, and what reads as light is a line that is
 * dim everywhere except where a lamp is. The floor is as low as the outline can
 * go while still drawing a box when no lamp is near it (2026-09-12).
 */
const ON_DARK: Surface = { value: 1, floor: 0.75, ink: 0.95 };

/** Parchment: full-bright cores, a floor that is still colour, mid-bright ink on text. */
const ON_LIGHT: Surface = { value: 1, floor: 0.8, ink: 0.8 };

/** Rec. 601 luma above this reads as paper rather than ink. */
const PAPER = 128;

/**
 * The surface this process's terminal is. `slot-colors` holds the OSC 11 answer
 * per process and re-reads it, so an appearance flip mid-session repaints
 * within a second; `PI_ZEN_SURFACE=light|dark` overrides it for previewing one
 * on the other.
 */
function surface(): Surface {
	const forced = (process.env.PI_ZEN_SURFACE ?? "").toLowerCase();
	if (forced === "light") return ON_LIGHT;
	if (forced === "dark") return ON_DARK;
	const bg = slotColors().background();
	return bg !== undefined && luminance(bg) > PAPER ? ON_LIGHT : ON_DARK;
}

/**
 * The hue at `u` along the fold, `u` counted in whole there-and-back cycles.
 *
 * The fold is a triangle — out along the arc and back at a constant rate — bent
 * by `HUE_DWELL` toward either its middle or its ends.
 */
function foldHue(u: number): number {
	const f = ((u % 1) + 1) % 1;
	const out = 2 * (1 - Math.abs(2 * f - 1)) - 1;
	const eased = 0.5 + 0.5 * Math.sign(out) * Math.abs(out) ** HUE_DWELL;
	return HUE_MIN + eased * (HUE_MAX - HUE_MIN);
}

/**
 * The resting colour of a fixed position `f` (0..1) along the hue arc: cold
 * blue at 0, the warm end at 1.
 *
 * The arc walked straight rather than folded, because this is a scale and not a
 * lamp: the effort slider spends the whole arc on the model's range, so the
 * level has a temperature that does not move. Painted at the ink value, like
 * every other piece of text the prism touches.
 */
export function arcColor(f: number): Rgb {
	return toRgb(hsv(HUE_MIN + clamp(f, 0, 1) * (HUE_MAX - HUE_MIN), SATURATION, surface().ink));
}

/**
 * How far an unreached notch sits from its hue toward the paper.
 *
 * Far, because the arc is a hue ramp and hue is nearly worthless for ordering:
 * a 62%-saturated blue and the border's grey are within 30 of each other in
 * luma, so a strip painted hue-against-grey reads as one block of similar
 * brightness — which is exactly how the first slider failed (2026-09-12).
 * Sunk this far, the gap is over 100 and the reading is carried by brightness.
 */
const UNLIT = 0.78;

/**
 * The colour of a notch on the scale that the level has not reached: its own
 * hue, sunk most of the way into the background.
 *
 * The background, not a fixed grey: on paper the unreached end has to go paler
 * than the ink and on ink it has to go darker, and the terminal is the only
 * thing that knows which it is. A terminal that will not say falls back to the
 * surface the prism picked.
 */
export function arcTrack(f: number): Rgb {
	const here = surface();
	const paper = here === ON_LIGHT ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	return lerp(arcColor(f), slotColors().background() ?? paper, UNLIT);
}

/**
 * How long the drift mark takes to walk the arc once, one way.
 *
 * Slow on purpose. The mark is the only thing on this chrome that moves while
 * nothing is happening, and it has earned that by being temporary — it is gone
 * the moment the next request goes out. Moving it fast would make it an alarm;
 * at this rate it reads as something quietly alive, which is what an unspent
 * cost is.
 */
const DRIFT_WALK_MS = 2500;

/**
 * The drift mark's colour now: the hue arc walked end to end and back, without
 * a seam.
 *
 * Back rather than round, because the arc is a line and not a wheel — looping
 * it would snap from the warm end to the cold one once a cycle, and a jump is
 * the one thing a slow drift must not have.
 */
export function driftColor(now: number): Rgb {
	const phase = (now % (2 * DRIFT_WALK_MS)) / DRIFT_WALK_MS;
	return arcColor(phase <= 1 ? phase : 2 - phase);
}

/** A closed loop the lamps ride. */
interface Rail {
	/** Circumference in aspect-corrected cells. */
	readonly lap: number;
	/** Arc length of a cell that sits on the rail. */
	arc(px: number, py: number): number;
}

/**
 * The outline of a `w × h` box: right along the top, down the right side, back
 * along the bottom, up the left.
 */
function boxRail(w: number, h: number): Rail {
	const side = (h - 1) * ASPECT;
	const run = Math.max(0, w - 1);
	return {
		lap: 2 * run + 2 * side,
		arc(px, py) {
			if (py <= 0) return px;
			if (px >= run) return run + py;
			if (py >= side) return run + side + (run - px);
			return 2 * run + side + (side - py);
		},
	};
}

/**
 * A run of `total` columns treated as a circle: a lamp leaving the right edge
 * arrives at the left. A row of text has no second dimension to route light
 * through, so the loop has to be the text itself.
 */
function stripRail(total: number): Rail {
	return { lap: Math.max(1, total), arc: (px) => px };
}

/**
 * HSV stated in sRGB terms, decoded to linear for `toRgb` to encode again.
 *
 * Stated in sRGB terms on purpose: a triple built in linear light and encoded
 * afterwards turns (0, 0.3, 1) into `#0094ff`, a sky blue, which is the one
 * colour the arc is built to exclude. Built here, blue is blue.
 */
function hsv(h: number, s: number, v: number): Vec3 {
	const hp = (((h % 360) + 360) % 360) / 60;
	const c = v * s;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r, g, b] =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = v - c;
	return v3((r + m) ** 2.2, (g + m) ** 2.2, (b + m) ** 2.2);
}

/** Linear 0..1 to an sRGB byte triple. */
function toRgb(c: Vec3): Rgb {
	const enc = (v: number) => Math.round(clamp(v, 0, 1) ** (1 / 2.2) * 255);
	return { r: enc(c.x), g: enc(c.y), b: enc(c.z) };
}

/** Lamps enough to space them out, within what a rail that short can hold. */
function lampCount(lap: number, spacing: number): number {
	return clamp(Math.round(lap / spacing), MIN_LAMPS, MAX_LAMPS);
}

/**
 * Per-surface tuning of the light.
 *
 * The constants above are calibrated on the box outline, a rail of about 160
 * cells. A model label is nine cells long, and on a rail that short the same
 * spacing yields the minimum two lamps while the same reach has both of them
 * covering the whole word — so the label pulses as one block instead of showing
 * colour travelling along it.
 */
export interface Light {
	/** Multiplier on how fast the lamps travel. */
	readonly tempo: number;
	/** Cells between lamps; the rail's length decides how many that is. */
	readonly spacing: number;
	/** Falloff radius squared along the rail, or null to take it from the spacing. */
	readonly reach2: number | null;
	/** How many lamps ride the rail, or null to space them out by `spacing`. */
	readonly lamps: number | null;
	/** How much of a hue fold the lamps are spread over. */
	readonly spread: number;
	/** Contrast on the depth ramp: higher is a tighter pool with more unlit rail around it. */
	readonly focus: number;
	/**
	 * The interval the surface carrying this light is repainted at. The light's
	 * speed is capped so its lamps stay sample-able at that rate.
	 */
	readonly frameMs: number;
}

/**
 * The box outline, in the two lights it can carry. `/glow` picks; `choice.ts`
 * remembers.
 *
 * Both are the same idea — a few lamps far apart on a dim rail, so the outline
 * is mostly its floor colour with pools of light moving over it — and they
 * differ in how much of the hue arc is on screen at once. `one` puts every lamp
 * on the same hue, which then drifts along the arc, so the whole frame is one
 * colour at any instant. `two` spreads the lamps over a third of a fold, so two
 * neighbouring hues meet somewhere on the frame and the gradient between them
 * runs the whole way round.
 *
 * Neither is the rainbow this started as. A hue that crosses the whole arc in
 * one rule changes by tens of degrees per cell, and a cell is a flat colour a
 * ninth of an inch wide: what that draws is not a gradient but a row of
 * differently coloured dashes, worst at the corners, where the arc turns a
 * quarter of the lap into two cells (2026-09-12).
 *
 * The spacings are twice and nearly three times a text row's, and the focus is
 * twice its contrast: few lamps, far apart, each a tight pool. That is the
 * other half of why this reads as light — the glow is as much the dim rail
 * between the lamps as the lamps.
 */
export const ONE_HUE: Light = {
	tempo: 1,
	spacing: 51,
	reach2: null,
	lamps: null,
	spread: 0,
	focus: CONTRAST * 2,
	frameMs: FRAME_MS,
};
export const TWO_HUES: Light = {
	tempo: 1,
	spacing: 69,
	reach2: null,
	lamps: null,
	spread: 0.3,
	focus: CONTRAST * 2,
	frameMs: FRAME_MS,
};

/** The light the box outline is carrying this session. */
export function boxLight(): Light {
	return glowName() === "two" ? TWO_HUES : ONE_HUE;
}

/**
 * A label let into a rule: the model and its slider, the background task count.
 * Three times the box's speed, and short enough that it needs its own lamp
 * count and a reach to match: nine cells hold three lamps three cells apart,
 * and a reach anywhere near the box's leaves all three covering the whole word
 * at once, so the label changes colour as a block. Pulled in to about one cell,
 * each glyph is carried by its nearest lamp and the colour visibly travels
 * along the word.
 */
export const LABEL_LIGHT: Light = {
	tempo: 3,
	spacing: 3,
	reach2: 1.6,
	lamps: 3,
	spread: HUE_SPREAD,
	focus: CONTRAST,
	frameMs: SHIMMER_FRAME_MS,
};

/** A background task's row: text, lit at the tempo and spacing the light was first tuned at. */
export const ROW_LIGHT: Light = {
	tempo: 3,
	spacing: 25,
	reach2: null,
	lamps: null,
	spread: HUE_SPREAD,
	focus: CONTRAST,
	frameMs: ROW_FRAME_MS,
};

/**
 * The row standing for tool calls in flight: the group's rollup line, or an
 * expanded call's header. 40% slower than a task row: it is read, not glanced
 * at, and at the row's tempo the words were hard to hold.
 */
export const CALL_LIGHT: Light = { ...ROW_LIGHT, tempo: 1.8, frameMs: FRAME_MS };

/**
 * Seconds per lap: what the tuning asks for, or slower if that would outrun the
 * rate the surface is repainted at.
 *
 * A lamp sampled once per frame has to be seen somewhere inside its own pool of
 * light every time, or the pool arrives where it was never drawn and the light
 * strobes — so the travel between two frames is capped at `STEP_RATIO` of the
 * falloff radius, and never at less than one cell, because a cell is discrete
 * and motion under one cell per frame cannot step in position however tight the
 * lamp is.
 *
 * The floor is on the speed and not on the lap time. Where it binds, the lamps
 * travel at a fixed cells-per-second whatever the rail's length — the invariant
 * `SPEED` states and `MIN_PERIOD`, which floors the lap, does not.
 */
function travelPeriod(lap: number, reach2: number, light: Light): number {
	const asked = Math.max(MIN_PERIOD, lap / SPEED) / light.tempo;
	const step = Math.max(1, STEP_RATIO * Math.sqrt(reach2));
	return Math.max(asked, (lap * (light.frameMs / 1000)) / step);
}

/**
 * The pigment at arc length `s`: the lamps' hues averaged as positions on the
 * arc, weighted by the square of each lamp's reach so the nearest lamp owns the
 * cell, and a depth 0..1 from how strongly the nearest lamp reaches it.
 */
function pigmentAt(s: number, t: number, rail: Rail, light: Light): { hue: number; depth: number } {
	const count = light.lamps ?? lampCount(rail.lap, light.spacing);
	const reach2 = light.reach2 ?? (REACH_RATIO * light.spacing) ** 2;
	const period = travelPeriod(rail.lap, reach2, light);
	let hueSum = 0;
	let weight = 0;
	let nearest = 0;
	for (let i = 0; i < count; i++) {
		const phase = i / count;
		const ls = ((((phase + t / period) * rail.lap) % rail.lap) + rail.lap) % rail.lap;
		const gap = Math.abs(s - ls);
		const d = Math.min(gap, rail.lap - gap);
		const falloff = 1 / (1 + (d * d) / reach2);
		const w = falloff * falloff;
		hueSum += foldHue(phase * light.spread + t / HUE_PERIOD) * w;
		weight += w;
		nearest = Math.max(nearest, falloff);
	}
	return { hue: hueSum / weight, depth: nearest ** light.focus };
}

/**
 * The colour a painted cell rests at: truecolour as written, indexed via the
 * terminal's palette, null for a glyph left in the terminal's own foreground.
 * The one reading for every lit surface — border, label, rows — because the
 * theme paints in ANSI slots, and a path that parsed only truecolour lit
 * nothing on it (the model label sat still in accent, 2026-09-09).
 *
 * The argument is a cell's accumulated escapes, so the *active* foreground is
 * the answer; see `activeForeground`.
 */
export function restOf(sgr: string): Rgb | null {
	const front = activeForeground(sgr);
	if (front.kind === "rgb") return front.color;
	if (front.kind === "index") return slotColors().get(front.index) ?? null;
	return null;
}

/**
 * The first colour a painted string actually puts on screen, for callers
 * holding a sample of the theme rather than a cell — `theme.fg("muted",
 * "opus")` ends in a reset, which says what the colour stops being, not what
 * it was.
 *
 * The first *painted* glyph, not the first glyph: the effort slider opens with
 * an unpainted space, and reading that one cell said the whole label resolved
 * to nothing, which dropped it to flat accent whenever it was lit.
 */
export function inkOf(painted: string): Rgb | null {
	for (const cell of toCells(painted)) {
		const rest = restOf(cell.sgr);
		if (rest !== null) return rest;
	}
	return null;
}

/** Which glyphs the light takes, and how far it has left them. */
export interface BoxOptions {
	/** Which glyphs the light replaces outright. Defaults to the frame. */
	readonly paints?: Paints;
	/**
	 * Which glyphs the light tints instead, each keeping its own colour under it
	 * — the treatment a text row gets, applied to the text inside a box.
	 */
	readonly tint?: Paints;
	/** How far the light has left the surface, 0..1. */
	readonly fade?: number;
}

/**
 * Repaints a rendered box with the light at `t` seconds.
 *
 * The outline's colour is replaced rather than tinted: unlike a label, nobody
 * reads a border, so it can be carried entirely by the light. Anything named
 * by `tint` is tinted instead, on the same field: one light crossing the whole
 * box, replacing the outline and passing over the words.
 *
 * `fade` 0..1 mixes the result back toward each cell's own painted colour — 0
 * is the light, 1 is the border as it was — so a finished turn can let the
 * light go rather than switch it off. A cell painted with an indexed colour is
 * resolved through the terminal's palette, which is what the border actually
 * is: the theme paints it as ANSI 8. A cell whose colour cannot be resolved is
 * left as it was once the fade begins.
 */
export function shadeBox(lines: string[], t: number, opts: BoxOptions = {}): string[] {
	const { paints = isFrame, tint, fade = 0 } = opts;
	const grid = lines.map(toCells);
	const height = grid.length;
	const width = grid[0]?.length ?? 0;
	if (width < 2 || height < 2) return lines;
	const rail = boxRail(width, height);
	const light = boxLight();
	const here = surface();
	return grid.map((cells, y) =>
		fromCells(
			cells.map((cell, x) => {
				const replaces = paints(cell.ch);
				const tints = !replaces && tint !== undefined && tint(cell.ch);
				if (!replaces && !tints) return cell;
				const { hue, depth } = pigmentAt(rail.arc(x, y * ASPECT), t, rail, light);
				if (tints) return tinted(cell, restOf(cell.sgr), hue, depth, 1 - clamp(fade, 0, 1), here);
				const value = here.floor + (here.value - here.floor) * depth;
				const lit = toRgb(hsv(hue, SATURATION, value));
				if (fade <= 0) return { ch: cell.ch, sgr: fg(lit) };
				const rest = restOf(cell.sgr);
				if (rest === null) return cell;
				const k = clamp(fade, 0, 1);
				return {
					ch: cell.ch,
					sgr: fg({
						r: Math.round(lit.r + (rest.r - lit.r) * k),
						g: Math.round(lit.g + (rest.g - lit.g) * k),
						b: Math.round(lit.b + (rest.b - lit.b) * k),
					}),
				};
			}),
		),
	);
}

/**
 * One line of text with the light crossing it, painted glyph by glyph.
 *
 * `offset` and `total` place this piece inside a longer strip, so a label made
 * of several pieces — `fable` in one colour, `high` in another — carries one
 * continuous field across both while each keeps its own resting colour.
 *
 * The light tints rather than replaces: a glyph away from every lamp is exactly
 * its resting colour, so a lit label reads the same at a glance as an unlit one.
 */
export interface LineOptions {
	/** Where this piece starts in a longer strip, and the strip's full width. */
	readonly offset?: number;
	readonly total?: number;
	readonly paints?: Paints;
	/** Which surface's tuning to light it with. Defaults to a text row's. */
	readonly light?: Light;
	/**
	 * How far the light has left the line, 0..1 — 0 is fully lit, 1 is the text
	 * in its own colours. The same quantity `shadeBox` fades the border by, so a
	 * light that flashes and decays is one idea on both surfaces.
	 */
	readonly fade?: number;
}

export function shadeLine(line: string, t: number, rest: Rgb | "self", opts: LineOptions = {}): string {
	const { offset = 0, total = 0, paints = EVERY_GLYPH, light = ROW_LIGHT, fade = 0 } = opts;
	const strength = 1 - clamp(fade, 0, 1);
	const cells = toCells(line);
	const span = total > 0 ? total : cells.length;
	if (span < 1) return line;
	const rail = stripRail(span);
	const here = surface();
	let col = offset;
	return fromCells(
		cells.map((cell) => {
			const px = col++;
			if (!paints(cell.ch)) return cell;
			// `"self"`: every glyph's own colour is its resting state, so a line painted
			// in several colours — a tool header's dot, name and argument — can be lit
			// without the caller knowing the palette. A glyph the theme painted with
			// anything but a truecolour foreground is left exactly as it was.
			const base = rest === "self" ? restOf(cell.sgr) : rest;
			if (base === null) return cell;
			const { hue, depth } = pigmentAt(rail.arc(px, 0), t, rail, light);
			return tinted(cell, base, hue, depth, strength, here);
		}),
	);
}

/**
 * One cell with the light mixed into its own colour, so the reading survives
 * and only the hue travels over it. A cell whose colour could not be resolved
 * is left exactly as it was.
 *
 * The one tinting path: a text row, a multi-piece label and the words inside a
 * lit box all land here, so they cannot pick up three slightly different ideas
 * of what a tint is.
 */
function tinted(cell: Cell, base: Rgb | null, hue: number, depth: number, strength: number, here: Surface): Cell {
	if (base === null) return cell;
	const ink = toRgb(hsv(hue, SATURATION, here.ink));
	// Appended, not substituted: the glyph keeps its bold and whatever else the
	// theme set, and the later foreground wins.
	return { ch: cell.ch, sgr: cell.sgr + fg(lerp(base, ink, clamp(depth * TINT * strength, 0, 1))) };
}

/**
 * The frame itself: the outline, and the ghost.
 *
 * The ghost is in here because it is a mark and not a letter — nobody reads
 * it, the same reason the outline can be carried entirely by the light. Left
 * out, it sat dead in the one place the frame is most alive, which is the
 * corner the eye starts at.
 */
const FRAME_GLYPHS = new Set(["─", "╭", "╮", "╰", "╯", "│", "╶", "╴", HOME_GLYPH]);

/** Which glyphs `shadeBox` repaints by default: the frame, not the labels on it. */
export const isFrame: Paints = (glyph) => FRAME_GLYPHS.has(glyph);

/** Everything the frame is not: the labels let into the rules, and the text in the box. */
export const isNotFrame: Paints = (glyph) => !FRAME_GLYPHS.has(glyph);
