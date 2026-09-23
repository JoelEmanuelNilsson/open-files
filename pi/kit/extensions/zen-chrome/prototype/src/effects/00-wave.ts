/**
 * PROTOTYPE — throwaway. BASELINE: the effect currently shipping in zen-chrome.
 * A single gaussian crest rolls clockwise round the outline — steep in front,
 * long drain behind. Every other variant is judged against this one.
 */

import { ramp } from "../core/color.ts";
import type { Cell, CellStyle, Effect, Frame } from "../core/types.ts";

const FRONT = 6;
const TAIL = 26;
const LIFT = 0.6;

function gaussian(distance: number, sigma: number): number {
	return Math.exp(-(distance * distance) / (2 * sigma * sigma));
}

/** Intensity at a cell `ahead` cells in front of the crest (negative = behind). */
function profile(ahead: number): number {
	const raw = ahead > 0 ? gaussian(ahead, FRONT) : gaussian(ahead, TAIL);
	return raw ** (1 - LIFT);
}

const effect: Effect = {
	id: "wave",
	name: "Wave (current)",
	group: "baseline",
	blurb: "Today's effect: one gaussian crest rolling the outline, steep front, long drain.",
	params: [{ key: "period", label: "period (s)", min: 0.6, max: 6, step: 0.1, value: 2.4 }],
	create() {
		return {
			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0 || !f.working) return null;
				const len = f.box.ringLength;
				const period = f.params.period ?? 2.4;
				const crest = ((f.since / period) % 1) * len;
				let ahead = cell.ringIndex - crest;
				if (ahead > len / 2) ahead -= len;
				if (ahead < -len / 2) ahead += len;
				const level = profile(ahead) * f.intensity;
				if (level < 0.01) return null;
				const colour = ramp(cell.color, f.palette.hot, f.palette.peak, level);
				return { color: colour, glow: level * 6 };
			},
		};
	},
};

export default effect;
