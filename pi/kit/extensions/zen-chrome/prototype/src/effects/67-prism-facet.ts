/**
 * PROTOTYPE — throwaway. The box read as a cut gem head-on: hue is the angle
 * from its centre, and the spectrum rotates slowly around the whole outline.
 */

import { clamp, hsl, lerp, ramp } from "../core/color.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const effect: Effect = {
	id: "prism-facet",
	name: "Facet",
	group: "prism",
	blurb: "Hue is the angle from the box centre, aspect-normalised so each of the four sides gets its own band rather than bunching at the ends, and the spectrum rotates slowly.",
	params: [
		{ key: "sat", label: "saturation", min: 0, max: 1, step: 0.05, value: 0.4 },
		{ key: "depth", label: "tint", min: 0, max: 1, step: 0.05, value: 0.5 },
		{ key: "spin", label: "rotation (s)", min: 6, max: 90, step: 1, value: 28 },
		{ key: "spread", label: "spectrum", min: 60, max: 360, step: 10, value: 300 },
		{ key: "shade", label: "facet shading", min: 0, max: 1, step: 0.05, value: 0.35 },
	],
	create(): EffectInstance {
		// Lags the working flag so the gem lights and dims instead of snapping.
		let gate = 0;

		return {
			update(f: Frame) {
				if (!f.working && gate < 0.002) {
					gate = 0;
					return;
				}
				const target = f.working ? 1 : 0;
				gate += (target - gate) * clamp((f.working ? 0.8 : 0.45) * f.dt * 2, 0, 1);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0 || gate < 0.01) return null;
				const cols = Math.max(1, f.box.cols);
				const rows = Math.max(1, f.box.rows);
				// Normalised to the unit square, so the wide short box still spends
				// a quarter of the spectrum on each side.
				const nx = (cell.x + 0.5) / cols - 0.5;
				const ny = (cell.y + 0.5) / rows - 0.5;
				const angle = Math.atan2(ny, nx) / (Math.PI * 2) + 0.5;

				const spin = f.params.spin ?? 28;
				const phase = (angle + f.t / spin) % 1;
				const spread = f.params.spread ?? 300;
				const level = gate * f.intensity;

				// A slow highlight axis so opposite sides never read at the same weight.
				const shade = f.params.shade ?? 0.35;
				const facet = 0.5 + 0.5 * Math.cos((angle - f.t / (spin * 1.7)) * Math.PI * 4);
				const weight = 1 - shade + shade * facet;

				const ground = ramp(f.palette.base, f.palette.hot, f.palette.peak, level * 0.35 * weight);
				const lit = hsl((phase * spread + 210) % 360, clamp((f.params.sat ?? 0.4) * 1.5, 0, 1), 0.46 + weight * 0.22);
				const depth = (f.params.depth ?? 0.5) * level * (0.8 + weight * 0.75);
				// Kept low: a wide shadow on every outline cell turns the line into a band.
				return { color: lerp(ground, lit, clamp(depth, 0, 1)), glow: level * weight * f.metrics.ch * 0.18 };
			},
		};
	},
};

export default effect;
