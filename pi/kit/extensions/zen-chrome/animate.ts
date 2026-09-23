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

/**
 * One terminal cell: its glyph and the SGR escapes that style it from a reset.
 * `toCells` writes one escape per attribute in force; a caller may append more,
 * and the last one written for an attribute wins.
 */
export interface Cell {
	ch: string;
	sgr: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const SGR = /\x1b\[([0-9;]*)m/y;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const SGR_ALL = /\x1b\[([0-9;]*)m/g;

const SGR_OFF = {
	intensity: "22",
	italic: "23",
	underline: "24",
	blink: "25",
	inverse: "27",
	hidden: "28",
	strike: "29",
	overline: "55",
	fg: "39",
	bg: "49",
	underlineColor: "59",
} as const;

type SgrSlot = keyof typeof SGR_OFF;

// Parameters are kept as written, so `31` and `38;5;1` stay distinct: a terminal
// may brighten one under bold and not the other. `extras` only a reset clears.
type SgrStyle = Record<SgrSlot, string> & { extras: string };

const SGR_SLOTS = Object.keys(SGR_OFF) as SgrSlot[]; // SAFETY: the keys of a const object literal are exactly its declared keys.
const SLOT_BY_OFF = new Map<string, SgrSlot>(SGR_SLOTS.map((slot) => [SGR_OFF[slot], slot]));
const PLAIN_STYLE: SgrStyle = {
	intensity: "",
	italic: "",
	underline: "",
	blink: "",
	inverse: "",
	hidden: "",
	strike: "",
	overline: "",
	fg: "",
	bg: "",
	underlineColor: "",
	extras: "",
};

const joinParams = (...parts: string[]): string => parts.filter((part) => part !== "").join(";");

// A canonical truecolour foreground, which is what the light appends to every
// lit cell each frame; kept exactly as the general path would write it.
const TRUECOLOR_FG = /^38;2;(?:0|[1-9]\d*);(?:0|[1-9]\d*);(?:0|[1-9]\d*)$/;

function applySgrParams(style: SgrStyle, params: string): void {
	if (TRUECOLOR_FG.test(params)) {
		style.fg = params;
		return;
	}
	const codes = params.split(";").map((code) => String(Number(code)));
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i] ?? "0";
		const n = Number(code);
		const cleared = SLOT_BY_OFF.get(code);
		if (n === 0) Object.assign(style, PLAIN_STYLE);
		else if (cleared !== undefined) style[cleared] = "";
		// Bold and dim are cleared together by 22, and a terminal that treats them
		// as one intensity keeps the last, so the order they were set in is kept.
		else if (n === 1 || n === 2) style.intensity = joinParams(...style.intensity.split(";").filter((c) => c !== code), code);
		else if (n === 3) style.italic = code;
		else if (n === 4 || n === 21) style.underline = code;
		else if (n === 5 || n === 6) style.blink = code;
		else if (n === 7) style.inverse = code;
		else if (n === 8) style.hidden = code;
		else if (n === 9) style.strike = code;
		else if (n === 53) style.overline = code;
		else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) style.fg = code;
		else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) style.bg = code;
		else if (n === 38 || n === 48 || n === 58) {
			const mode = codes[i + 1];
			const args = mode === "5" ? 1 : mode === "2" ? 3 : -1;
			// An extended colour this model cannot read swallows the rest of its
			// sequence, so the rest is kept as written rather than guessed at.
			if (args < 0) {
				style.extras = joinParams(style.extras, codes.slice(i).join(";"));
				return;
			}
			const value = [code, mode, ...Array.from({ length: args }, (_, k) => codes[i + 2 + k] ?? "0")].join(";");
			style[n === 38 ? "fg" : n === 48 ? "bg" : "underlineColor"] = value;
			i += 1 + args;
		} else style.extras = joinParams(style.extras, code);
	}
}

function parseSgr(sgr: string): SgrStyle {
	const style = { ...PLAIN_STYLE };
	for (const match of sgr.matchAll(SGR_ALL)) applySgrParams(style, match[1] ?? "");
	return style;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ONE_SGR = /^\x1b\[([0-9;]*)m$/;

// A lit line's cells are a few base styles with a colour appended to each, so
// the bases are resolved once and every cell applies only its last escape.
// Bounded, because a frame's lit colours arrive as bases of their own when a
// second pass (the wake's grey) appends to them.
const BASE_STYLES = new Map<string, SgrStyle>();
const BASE_STYLES_MAX = 256;

function baseStyle(sgr: string): SgrStyle {
	const known = BASE_STYLES.get(sgr);
	if (known !== undefined) return known;
	if (BASE_STYLES.size >= BASE_STYLES_MAX) BASE_STYLES.clear();
	const style = parseSgr(sgr);
	BASE_STYLES.set(sgr, style);
	return style;
}

/** The style `sgr` leaves in force. Shared objects: read, never written. */
function resolveSgr(sgr: string): SgrStyle {
	const cut = sgr.lastIndexOf("\x1b[");
	const last = cut > 0 ? ONE_SGR.exec(sgr.slice(cut)) : null;
	if (last === null) return baseStyle(sgr);
	const style = { ...baseStyle(sgr.slice(0, cut)) };
	applySgrParams(style, last[1] ?? "");
	return style;
}

const styleParams = (style: SgrStyle): string[] => [...SGR_SLOTS.map((slot) => style[slot]), style.extras].filter((p) => p !== "");

// One escape per attribute rather than one combined escape: readers of painted
// lines match `\x1b[1m` or `\x1b[38;2;` literally, and it costs 3 bytes a rare time.
const sgrEscapes = (params: string[]): string => params.map((p) => `\x1b[${p}m`).join("");

function sgrBetween(from: SgrStyle, to: SgrStyle): string {
	const params = styleParams(to);
	// Measured rather than built: most cells step, and the reset is only written when it wins.
	const resetLength = "\x1b[0m".length + params.reduce((sum, p) => sum + p.length + 3, 0);
	const reset = () => sgrEscapes(["0", ...params]);
	const steps: string[] = [];
	for (const slot of SGR_SLOTS) {
		const was = from[slot];
		const now = to[slot];
		if (was === now) continue;
		if (now === "") steps.push(SGR_OFF[slot]);
		else if (slot === "intensity" && was !== "") steps.push(...(now.startsWith(`${was};`) ? [now.slice(was.length + 1)] : ["22", now]));
		else steps.push(now);
	}
	if (from.extras !== to.extras) {
		if (from.extras === "") steps.push(to.extras);
		else if (to.extras.startsWith(`${from.extras};`)) steps.push(to.extras.slice(from.extras.length + 1));
		else return reset();
	}
	const step = sgrEscapes(steps);
	return step.length <= resetLength ? step : reset();
}

/**
 * Splits a painted line into cells so individual glyphs can be repainted.
 *
 * Each cell carries the style in force as one escape per attribute, not the
 * escapes that built it, so a line's history of resets and overrides costs
 * nothing downstream. Code points are treated as one column each, which holds
 * for every glyph the chrome emits; other escapes pass through as cells.
 */
export function toCells(line: string): Cell[] {
	const cells: Cell[] = [];
	const style = { ...PLAIN_STYLE };
	let active = "";
	let i = 0;
	while (i < line.length) {
		SGR.lastIndex = i;
		const match = SGR.exec(line);
		if (match) {
			applySgrParams(style, match[1] ?? "");
			active = sgrEscapes(styleParams(style));
			i += match[0].length;
			continue;
		}
		const ch = String.fromCodePoint(line.codePointAt(i) ?? 0);
		cells.push({ ch, sgr: active });
		i += ch.length;
	}
	return cells;
}

/**
 * Rebuilds a painted line with the fewest SGR bytes between cells. It opens and
 * ends with a reset, so it styles the same wherever it is spliced in.
 */
export function fromCells(cells: Cell[]): string {
	if (cells.length === 0) return "\x1b[0m";
	let out = "\x1b[0m";
	let shown = PLAIN_STYLE;
	let shownSgr = "";
	for (const cell of cells) {
		if (cell.sgr !== shownSgr) {
			const next = resolveSgr(cell.sgr);
			out += sgrBetween(shown, next);
			shown = next;
			shownSgr = cell.sgr;
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
