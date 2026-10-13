/** A colour in 24-bit terminal space. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** `#7dd3fc` → `{ r: 125, g: 211, b: 252 }`. Defects on malformed input are fine: palettes are hardcoded. */
export function hex(color: string): Rgb {
	return {
		r: parseInt(color.slice(1, 3), 16),
		g: parseInt(color.slice(3, 5), 16),
		b: parseInt(color.slice(5, 7), 16),
	};
}

export function lerp(a: Rgb, b: Rgb, t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	return {
		r: Math.round(a.r + (b.r - a.r) * clamped),
		g: Math.round(a.g + (b.g - a.g) * clamped),
		b: Math.round(a.b + (b.b - a.b) * clamped),
	};
}

/** Rec. 601 luma, which is what "how light is this" means to an eye on a terminal. */
export function luminance(color: Rgb): number {
	return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

/** The truecolor foreground escape for a colour. */
export function fg(color: Rgb): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}

/** The truecolor background escape for a colour. */
export function bg(color: Rgb): string {
	return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}

/** The SGR reset escape, which ends every colour and attribute in force. */
export const SGR_RESET = "\x1b[0m";

export function rgbFromPainted(painted: string): Rgb | null {
	const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(painted);
	if (!match) return null;
	return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/** The first indexed foreground in a painted string, or null when the theme emitted something else. */
export function indexFromPainted(painted: string): number | null {
	const match = /\x1b\[38;5;(\d+)m/.exec(painted);
	return match ? Number(match[1]) : null;
}

/** What a run of escapes leaves the foreground set to: a colour, a palette slot, or the terminal's own. */
export type Foreground = { kind: "rgb"; color: Rgb } | { kind: "index"; index: number } | { kind: "default" };

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const SGR_PARAMS = /\x1b\[([0-9;]*)m/g;

export function activeForeground(sgr: string): Foreground {
	let front: Foreground = { kind: "default" };
	for (const match of sgr.matchAll(SGR_PARAMS)) {
		const params = (match[1] ?? "").split(";").map((param) => (param === "" ? 0 : Number(param)));
		for (let i = 0; i < params.length; i++) {
			const param = params[i] ?? 0;
			if (param === 0 || param === 39) front = { kind: "default" };
			else if (param >= 30 && param <= 37) front = { kind: "index", index: param - 30 };
			else if (param >= 90 && param <= 97) front = { kind: "index", index: param - 90 + 8 };
			else if (param === 38 || param === 48) {
				const mode = params[i + 1] ?? 0;
				if (mode === 2) {
					if (param === 38) {
						front = { kind: "rgb", color: { r: params[i + 2] ?? 0, g: params[i + 3] ?? 0, b: params[i + 4] ?? 0 } };
					}
					i += 4;
				} else if (mode === 5) {
					if (param === 38) front = { kind: "index", index: params[i + 2] ?? 0 };
					i += 2;
				}
			}
		}
	}
	return front;
}
