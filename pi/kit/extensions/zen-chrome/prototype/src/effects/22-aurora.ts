/**
 * PROTOTYPE — throwaway. Soft curtains of colour drift along the top and bottom
 * rules, hue cycling green → teal → violet, with light spilling into the bleed.
 */

import { css, hsl, lerp } from "../core/color.ts";
import { cellX } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

/** Three layered bands at different speeds — no single travelling front. */
function curtain(u: number, t: number, drift: number): number {
	const a = Math.sin(u * 3.1 + t * 0.31 * drift);
	const b = Math.sin(u * 7.7 - t * 0.19 * drift + 1.7);
	const c = Math.sin(u * 1.3 + t * 0.11 * drift + 4.2);
	return (a * 0.5 + b * 0.3 + c * 0.45 + 1.25) / 2.5;
}

function auroraHue(u: number, t: number, spread: number): number {
	return 120 + Math.sin(t * 0.13 + u * 1.9) * 60 * spread + Math.sin(t * 0.07) * 40 * spread;
}

const effect: Effect = {
	id: "aurora",
	name: "Aurora",
	group: "fluid",
	blurb: "Vertical curtains of green-teal-violet light drift slowly along the rules.",
	palette: { hot: hsl(165, 0.7, 0.55), peak: hsl(280, 0.7, 0.75) },
	params: [
		{ key: "drift", label: "drift", min: 0.1, max: 4, step: 0.1, value: 1 },
		{ key: "spread", label: "hue spread", min: 0, max: 1.5, step: 0.05, value: 0.9 },
		{ key: "spill", label: "spill", min: 0, max: 1, step: 0.05, value: 0.6 },
	],
	create(): EffectInstance {
		let phase = 0;

		const band = (u: number, f: Frame): { level: number; colour: Rgb } => {
			const drift = f.params.drift ?? 1;
			const level = curtain(u * 6, phase, drift) ** 1.7;
			const colour = hsl(auroraHue(u * 6, phase, f.params.spread ?? 0.9), 0.75, 0.45 + level * 0.3);
			return { level, colour };
		};

		return {
			update(f: Frame) {
				phase += f.dt * (f.working ? 1 : 0.18);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				const onRule = cell.y === 0 || cell.y === f.box.rows - 1;
				if (!onRule || cell.kind === "label") return null;
				const u = cell.x / f.box.cols;
				const { level, colour } = band(u + (cell.y === 0 ? 0 : 0.37), f);
				const gain = (f.working ? 1 : 0.22) * f.intensity;
				const amount = level * gain;
				if (amount < 0.02) return null;
				return { color: lerp(cell.color, colour, Math.min(1, amount * 1.2)), glow: amount * 10, alpha: 0.7 + amount * 0.3 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				const spill = (f.params.spill ?? 0.6) * f.intensity * (f.working ? 1 : 0.25);
				if (spill <= 0.01) return;
				const { bleed, ch, cw } = f.metrics;
				g.globalCompositeOperation = "lighter";
				g.filter = `blur(${Math.max(6, bleed * 0.5)}px)`;
				for (const row of [0, f.box.rows - 1]) {
					const dir = row === 0 ? -1 : 1;
					const y = bleed + row * ch + ch / 2;
					for (let i = 0; i < 14; i++) {
						const u = (i + 0.5) / 14;
						const { level, colour } = band(u + (row === 0 ? 0 : 0.37), f);
						const h = ch * (1.5 + level * 5) * spill;
						const x = cellX(f, u * f.box.cols);
						const grad = g.createLinearGradient(x, y, x, y + dir * h);
						grad.addColorStop(0, css(colour, 0.3 * level * spill));
						grad.addColorStop(1, css(colour, 0));
						g.fillStyle = grad;
						const w = (f.box.cols * cw) / 10;
						g.fillRect(x - w / 2, dir > 0 ? y : y - h, w, h);
					}
				}
				g.filter = "none";
			},
		};
	},
};

export default effect;
