import { type Cell, fromCells, toCells } from "./sgr-cells.ts";
import { HOME_GLYPH } from "./home-glyph.ts";
import { activeForeground, fg, type Foreground, lerp, luminance, type Rgb } from "./rgb-color.ts";
import { slotColors } from "./terminal-slot-colors.ts";

/** Which glyphs an animation repaints. The box outline is the default; a text row asks for all of them. */
export type Paints = (glyph: string) => boolean;

/** Every glyph, for callers whose whole line is the light's surface. */
export const EVERY_GLYPH: Paints = () => true;

/** Milliseconds between frames while a request is in flight (~30fps). */
export const FRAME_MS = 33;

/** Milliseconds between frames while a warm label idles (~25fps). */
export const SHIMMER_FRAME_MS = 40;

export const ROW_FRAME_MS = 100;

export const FADE_MS = 900;

export function waveEnabled(): boolean {
	return (process.env.PI_ZEN_WAVE ?? "").toLowerCase() !== "off";
}

interface Vec3 {
	x: number;
	y: number;
	z: number;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const ASPECT = 2.1;

const SPEED = 28;

const MIN_PERIOD = 2.6;

const STEP_RATIO = 0.25;

const MIN_LAMPS = 2;
const MAX_LAMPS = 8;

const REACH_RATIO = 0.31;

const HUE_MIN = 225;
const HUE_MAX = 360 + 140;

const HUE_PERIOD = 13;

const HUE_DWELL = 0.7;

const HUE_SPREAD = 1;

const SATURATION = 0.62;

const CONTRAST = 1.6;

const TINT = 0.9;

interface Surface {
	readonly value: number;
	readonly floor: number;
	readonly ink: number;
}

const ON_DARK: Surface = { value: 1, floor: 0.75, ink: 0.95 };

const ON_LIGHT: Surface = { value: 1, floor: 0.8, ink: 0.8 };

const PAPER = 128;

function surface(): Surface {
	const forced = (process.env.PI_ZEN_SURFACE ?? "").toLowerCase();
	if (forced === "light") return ON_LIGHT;
	if (forced === "dark") return ON_DARK;
	const bg = slotColors().background();
	return bg !== undefined && luminance(bg) > PAPER ? ON_LIGHT : ON_DARK;
}

function foldHue(u: number): number {
	const f = ((u % 1) + 1) % 1;
	const out = 2 * (1 - Math.abs(2 * f - 1)) - 1;
	const eased = 0.5 + 0.5 * Math.sign(out) * Math.abs(out) ** HUE_DWELL;
	return HUE_MIN + eased * (HUE_MAX - HUE_MIN);
}

export function arcColor(f: number): Rgb {
	return toRgb(hsv(HUE_MIN + clamp(f, 0, 1) * (HUE_MAX - HUE_MIN), SATURATION, surface().ink));
}

const UNLIT = 0.78;

export function arcTrack(f: number): Rgb {
	const here = surface();
	const paper = here === ON_LIGHT ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	return lerp(arcColor(f), slotColors().background() ?? paper, UNLIT);
}

const DRIFT_WALK_MS = 2500;

export function driftColor(now: number): Rgb {
	const phase = (now % (2 * DRIFT_WALK_MS)) / DRIFT_WALK_MS;
	return arcColor(phase <= 1 ? phase : 2 - phase);
}

interface Rail {
	readonly lap: number;
	arc(px: number, py: number): number;
}

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

function stripRail(total: number): Rail {
	return { lap: Math.max(1, total), arc: (px) => px };
}

function hsv(h: number, s: number, v: number): Vec3 {
	const hp = (((h % 360) + 360) % 360) / 60;
	const c = v * s;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r, g, b] =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = v - c;
	return v3((r + m) ** 2.2, (g + m) ** 2.2, (b + m) ** 2.2);
}

function toRgb(c: Vec3): Rgb {
	const enc = (v: number) => Math.round(clamp(v, 0, 1) ** (1 / 2.2) * 255);
	return { r: enc(c.x), g: enc(c.y), b: enc(c.z) };
}

const EVEN_HUE = 320;

function evenInk(hue: number, s: number, v: number): Rgb {
	return toRgb(atLightness(hsv(hue, s, v), oklab(hsv(EVEN_HUE, s, v)).x));
}

function oklab(c: Vec3): Vec3 {
	const l = Math.cbrt(0.4122214708 * c.x + 0.5363325363 * c.y + 0.0514459929 * c.z);
	const m = Math.cbrt(0.2119034982 * c.x + 0.6806995451 * c.y + 0.1073969566 * c.z);
	const s = Math.cbrt(0.0883024619 * c.x + 0.2817188376 * c.y + 0.6299787005 * c.z);
	return v3(
		0.2104542553 * l + 0.793617785 * m - 0.0040720718 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	);
}

function fromOklab(c: Vec3): Vec3 {
	const l = (c.x + 0.3963377774 * c.y + 0.2158037573 * c.z) ** 3;
	const m = (c.x - 0.1055613458 * c.y - 0.0638541728 * c.z) ** 3;
	const s = (c.x - 0.0894841775 * c.y - 1.291485548 * c.z) ** 3;
	return v3(
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	);
}

function atLightness(c: Vec3, lightness: number): Vec3 {
	const { y: a, z: b } = oklab(c);
	const at = (k: number) => fromOklab(v3(lightness, a * k, b * k));
	const shows = (k: number) => {
		const out = at(k);
		return [out.x, out.y, out.z].every((u) => u >= 0 && u <= 1);
	};
	if (shows(1)) return at(1);
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 12; i++) {
		const mid = (lo + hi) / 2;
		if (shows(mid)) lo = mid;
		else hi = mid;
	}
	return at(lo);
}

function lampCount(lap: number, spacing: number): number {
	return clamp(Math.round(lap / spacing), MIN_LAMPS, MAX_LAMPS);
}

export interface Light {
	readonly tempo: number;
	readonly spacing: number;
	readonly reach2: number | null;
	readonly lamps: number | null;
	readonly spread: number;
	readonly focus: number;
	readonly frameMs: number;
	readonly pastel?: number;
}

const PASTEL = 0.42;

export const ONE_HUE: Light = {
	tempo: 1,
	spacing: 51,
	reach2: null,
	lamps: null,
	spread: 0,
	focus: CONTRAST * 2,
	frameMs: FRAME_MS,
};

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

export const CALL_LIGHT: Light = { ...ROW_LIGHT, tempo: 1.8, frameMs: FRAME_MS, pastel: PASTEL };

export const FOLDED_BAR_LIGHT: Light = { ...ROW_LIGHT, pastel: PASTEL };

function travelPeriod(lap: number, reach2: number, light: Light): number {
	const asked = Math.max(MIN_PERIOD, lap / SPEED) / light.tempo;
	const step = Math.max(1, STEP_RATIO * Math.sqrt(reach2));
	return Math.max(asked, (lap * (light.frameMs / 1000)) / step);
}

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

// shared-state: a bounded memo of activeForeground, a pure function of its key; a second copy recomputes the same readings
const FOREGROUNDS = new Map<string, Foreground>();
const FOREGROUNDS_MAX = 256;

function foregroundOf(sgr: string): Foreground {
	const known = FOREGROUNDS.get(sgr);
	if (known !== undefined) return known;
	if (FOREGROUNDS.size >= FOREGROUNDS_MAX) FOREGROUNDS.clear();
	const front = activeForeground(sgr);
	FOREGROUNDS.set(sgr, front);
	return front;
}

export function restOf(sgr: string): Rgb | null {
	const front = foregroundOf(sgr);
	if (front.kind === "rgb") return front.color;
	if (front.kind === "index") return slotColors().get(front.index) ?? null;
	return null;
}

export function inkOf(painted: string): Rgb | null {
	for (const cell of toCells(painted)) {
		const rest = restOf(cell.sgr);
		if (rest !== null) return rest;
	}
	return null;
}

/** Which glyphs the light takes, and how far it has left them. */
export interface BoxOptions {
	readonly paints?: Paints;
	readonly tint?: Paints;
	readonly fade?: number;
	readonly light?: Light;
}

export function shadeBox(lines: string[], t: number, opts: BoxOptions = {}): string[] {
	const { paints = isFrame, tint, fade = 0, light = ONE_HUE } = opts;
	const grid = lines.map(toCells);
	const height = grid.length;
	const width = grid[0]?.length ?? 0;
	if (width < 2 || height < 2) return lines;
	const rail = boxRail(width, height);
	const here = surface();
	return grid.map((cells, y) =>
		fromCells(
			cells.map((cell, x) => {
				const replaces = paints(cell.ch);
				const tints = !replaces && tint !== undefined && tint(cell.ch);
				if (!replaces && !tints) return cell;
				const { hue, depth } = pigmentAt(rail.arc(x, y * ASPECT), t, rail, light);
				if (tints) return tinted(cell, restOf(cell.sgr), hue, depth, 1 - clamp(fade, 0, 1), here, light.pastel);
				const value = here.floor + (here.value - here.floor) * depth;
				const lit = toRgb(hsv(hue, SATURATION, value));
				if (fade <= 0) return { ch: cell.ch, sgr: fg(lit) };
				const rest = restOf(cell.sgr);
				if (rest === null) return cell;
				return { ch: cell.ch, sgr: fg(lerp(lit, rest, fade)) };
			}),
		),
	);
}

export interface LineOptions {
	readonly offset?: number;
	readonly total?: number;
	readonly paints?: Paints;
	readonly light?: Light;
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
			const base = rest === "self" ? restOf(cell.sgr) : rest;
			if (base === null) return cell;
			const { hue, depth } = pigmentAt(rail.arc(px, 0), t, rail, light);
			return tinted(cell, base, hue, depth, strength, here, light.pastel);
		}),
	);
}

function tinted(cell: Cell, base: Rgb | null, hue: number, depth: number, strength: number, here: Surface, pastel?: number): Cell {
	if (base === null) return cell;
	const lit =
		pastel === undefined
			? lerp(base, evenInk(hue, SATURATION, here.ink), clamp(depth * TINT * strength, 0, 1))
			: lerp(base, evenInk(hue, pastel + (SATURATION - pastel) * clamp(depth, 0, 1), here.ink), clamp(TINT * strength, 0, 1));
	return { ch: cell.ch, sgr: cell.sgr + fg(lit) };
}

const FRAME_GLYPHS = new Set(["─", "╭", "╮", "╰", "╯", "│", "╶", "╴", HOME_GLYPH]);

/** Which glyphs `shadeBox` repaints by default: the frame, not the labels on it. */
export const isFrame: Paints = (glyph) => FRAME_GLYPHS.has(glyph);

/** Everything the frame is not: the labels let into the rules, and the text in the box. */
export const isNotFrame: Paints = (glyph) => !FRAME_GLYPHS.has(glyph);
