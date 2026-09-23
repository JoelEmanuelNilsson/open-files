/**
 * PROTOTYPE — throwaway. The outline is a neon tube: coloured bloom spills
 * outside the glass, the tube stutters on when work begins, and one bad
 * segment buzzes and drops out.
 */

import { clamp, css, lerp, ramp } from "../core/color.ts";
import { boxRect } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

/** On-windows of the starter, in seconds since work began. */
const STARTUP: Array<[number, number]> = [
	[0.02, 0.06],
	[0.12, 0.15],
	[0.24, 0.36],
	[0.42, 0.46],
];

function starter(since: number): number {
	if (since >= 0.54) return 1;
	for (const [a, b] of STARTUP) if (since >= a && since < b) return 0.85;
	return 0.06;
}

function hash(n: number): number {
	const s = Math.sin(n * 127.1) * 43758.5453;
	return s - Math.floor(s);
}

const effect: Effect = {
	id: "neon",
	name: "Neon tube",
	group: "light",
	blurb: "Glass tube with heavy bloom: it stutters alight, hums, and one segment buzzes out.",
	params: [
		{ key: "bloom", label: "bloom", min: 0, max: 3, step: 0.1, value: 1.4 },
		{ key: "hum", label: "hum", min: 0, max: 0.5, step: 0.02, value: 0.14 },
		{ key: "buzz", label: "buzz", min: 0, max: 1, step: 0.05, value: 0.7 },
	],
	create(): EffectInstance {
		let lit = 0;
		let segStart = 0;
		let segLength = 8;
		let badness = 1;
		let reseed = 0;

		return {
			update(f: Frame) {
				const target = f.working ? starter(f.since) : 0.08;
				// The tube's own inertia: gas takes a moment to strike and to die.
				const k = 1 - Math.exp(-f.dt * (target > lit ? 40 : 9));
				lit += (target - lit) * k;

				reseed -= f.dt;
				if (reseed <= 0) {
					reseed = 2.2 + Math.random() * 3.4;
					segStart = Math.floor(Math.random() * Math.max(1, f.box.ringLength));
					segLength = 5 + Math.floor(Math.random() * 10);
				}
				const rate = 9 + (f.params.buzz ?? 0.7) * 26;
				const n = hash(Math.floor(f.t * rate));
				badness = f.working && n < (f.params.buzz ?? 0.7) * 0.45 ? 0.05 + n : 1;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				const hum = 1 - (f.params.hum ?? 0.14) * (0.5 + 0.5 * Math.sin(f.t * 37.7));
				const len = f.box.ringLength;
				let d = cell.ringIndex - segStart;
				if (d < 0) d += len;
				const inSegment = d < segLength;
				const level = clamp(lit * hum * (inSegment ? badness : 1), 0, 1) * f.intensity;
				const colour = ramp(f.palette.base, f.palette.hot, f.palette.peak, level * 0.9 + 0.1);
				return {
					color: lerp(f.palette.bg, colour, 0.15 + level * 0.85),
					glow: level * 14,
					alpha: 0.35 + level * 0.65,
				};
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				const rect = boxRect(f);
				const bloom = (f.params.bloom ?? 1.4) * lit * f.intensity;
				if (bloom <= 0.01) return;
				g.globalCompositeOperation = "lighter";
				const x = rect.x + f.metrics.cw / 2;
				const y = rect.y + f.metrics.ch / 2;
				const w = rect.w - f.metrics.cw;
				const h = rect.h - f.metrics.ch;
				const layers: Array<[number, number]> = [
					[f.metrics.bleed * 1.5, 0.05],
					[f.metrics.bleed * 0.8, 0.09],
					[f.metrics.ch * 0.9, 0.16],
					[3, 0.3],
				];
				for (const [width, alpha] of layers) {
					g.strokeStyle = css(f.palette.hot, alpha * bloom);
					g.lineWidth = width;
					g.shadowBlur = width * 1.4;
					g.shadowColor = css(f.palette.hot, alpha * bloom);
					g.strokeRect(x, y, w, h);
				}
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
