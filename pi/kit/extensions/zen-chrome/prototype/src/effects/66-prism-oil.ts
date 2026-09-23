/**
 * PROTOTYPE — throwaway. Thin-film interference: the whole outline is
 * iridescent at once, hue set by a slow drifting noise field, no travelling head.
 */

import { clamp, hsl, lerp, ramp } from "../core/color.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

function hash(n: number): number {
	const s = Math.sin(n * 127.1) * 43758.5453;
	return s - Math.floor(s);
}

function noise2(x: number, y: number): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const xf = x - xi;
	const yf = y - yi;
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	const a = hash(xi + yi * 57);
	const b = hash(xi + 1 + yi * 57);
	const c = hash(xi + (yi + 1) * 57);
	const d = hash(xi + 1 + (yi + 1) * 57);
	return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const effect: Effect = {
	id: "prism-oil",
	name: "Oil film",
	group: "prism",
	blurb: "Thin-film interference — film thickness is a drifting noise field, so the outline is pearlescent everywhere at once.",
	params: [
		{ key: "sat", label: "saturation", min: 0, max: 1, step: 0.05, value: 0.35 },
		{ key: "depth", label: "tint", min: 0, max: 1, step: 0.05, value: 0.45 },
		{ key: "grain", label: "film grain", min: 0.02, max: 0.4, step: 0.01, value: 0.11 },
		{ key: "drift", label: "drift (s⁻¹)", min: 0.01, max: 0.5, step: 0.01, value: 0.07 },
		{ key: "spread", label: "spectrum", min: 40, max: 360, step: 10, value: 180 },
	],
	create(): EffectInstance {
		// Lags the working flag so the film fades in and out instead of snapping.
		let gate = 0;

		return {
			update(f: Frame) {
				if (!f.working && gate < 0.002) {
					gate = 0;
					return;
				}
				const target = f.working ? 1 : 0;
				gate += (target - gate) * clamp((f.working ? 0.9 : 0.5) * f.dt * 2, 0, 1);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0 || gate < 0.01) return null;
				const grain = f.params.grain ?? 0.11;
				const drift = f.params.drift ?? 0.07;
				const spread = f.params.spread ?? 180;

				// Two octaves drifting in different directions: the pattern never sweeps one way.
				const a = noise2(cell.x * grain + f.t * drift, cell.y * grain * 3 - f.t * drift * 0.6);
				const b = noise2(cell.x * grain * 2.3 - f.t * drift * 0.4, cell.y * grain * 5 + f.t * drift * 0.9);
				// Stretched about its midpoint: two smooth octaves alone only span a
				// narrow slice of the spectrum, which reads as one flat colour.
				const film = clamp((a * 0.65 + b * 0.35 - 0.5) * 1.9 + 0.5, 0, 1);
				const breathe = 0.5 + 0.5 * Math.sin(f.t * drift * 2.4);

				const level = gate * f.intensity;
				const ground = ramp(f.palette.base, f.palette.hot, f.palette.peak, level * 0.35);
				const hue = (film * spread + breathe * 40 + 200) % 360;
				const sat = (f.params.sat ?? 0.35) * (0.95 + film * 0.8);
				const lit = hsl(hue, clamp(sat, 0, 1), 0.52 + film * 0.22);
				const depth = (f.params.depth ?? 0.45) * level * (0.85 + film * 0.7);
				// Kept low: a wide shadow on every outline cell turns the line into a band.
				return { color: lerp(ground, lit, clamp(depth, 0, 1)), glow: level * film * f.metrics.ch * 0.18 };
			},
		};
	},
};

export default effect;
