import { SGR_RESET } from "./rgb-color.ts";

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

type SgrStyle = Record<SgrSlot, string> & { extras: string };

// SAFETY: Object.keys of SGR_OFF yields exactly the SgrSlot keys
const SGR_SLOTS = Object.keys(SGR_OFF) as SgrSlot[];
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

// shared-state: a bounded memo of parseSgr, a pure function of its key; a second copy recomputes the same styles
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

function resolveSgr(sgr: string): SgrStyle {
	const cut = sgr.lastIndexOf("\x1b[");
	const last = cut > 0 ? ONE_SGR.exec(sgr.slice(cut)) : null;
	if (last === null) return baseStyle(sgr);
	const style = { ...baseStyle(sgr.slice(0, cut)) };
	applySgrParams(style, last[1] ?? "");
	return style;
}

const styleParams = (style: SgrStyle): string[] => [...SGR_SLOTS.map((slot) => style[slot]), style.extras].filter((p) => p !== "");

const sgrEscapes = (params: string[]): string => params.map((p) => `\x1b[${p}m`).join("");

function sgrBetween(from: SgrStyle, to: SgrStyle): string {
	const params = styleParams(to);
	const resetLength = SGR_RESET.length + params.reduce((sum, p) => sum + p.length + 3, 0);
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

export function fromCells(cells: Cell[]): string {
	if (cells.length === 0) return SGR_RESET;
	let out = SGR_RESET;
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
	return out + SGR_RESET;
}
