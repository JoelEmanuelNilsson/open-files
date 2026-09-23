/**
 * PROTOTYPE — throwaway. One white head launches and disperses in time: red,
 * green and blue run the outline at different speeds, adding where they overlap.
 */

import { add, clamp, css, scale } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const CHANNELS: Array<{ colour: Rgb; drift: number }> = [
	{ colour: { r: 255, g: 40, b: 30 }, drift: 1 },
	{ colour: { r: 40, g: 255, b: 70 }, drift: 0 },
	{ colour: { r: 40, g: 90, b: 255 }, drift: -1 },
];

const effect: Effect = {
	id: "prism-split",
	name: "Prism split",
	group: "prism",
	blurb: "Chromatic dispersion in time: R, G and B heads race the outline, going white where they lap.",
	params: [
		{ key: "period", label: "lap (s)", min: 0.8, max: 8, step: 0.1, value: 2.6 },
		{ key: "dispersion", label: "dispersion", min: 0, max: 0.3, step: 0.005, value: 0.06 },
		{ key: "width", label: "head (cells)", min: 2, max: 30, step: 1, value: 9 },
		{ key: "gain", label: "gain", min: 0.3, max: 2.5, step: 0.05, value: 1.3 },
		{ key: "haze", label: "haze", min: 0, max: 1, step: 0.05, value: 0.5 },
	],
	create(): EffectInstance {
		let path: Array<{ x: number; y: number }> = [];
		const heads = [0, 0, 0];

		const ensurePath = (f: Frame) => {
			if (path.length === f.box.ringLength) return;
			const next: Array<{ x: number; y: number }> = new Array(f.box.ringLength);
			for (const c of f.box.cells) if (c.ringIndex >= 0) next[c.ringIndex] = { x: c.x, y: c.y };
			path = next;
		};

		return {
			update(f: Frame) {
				ensurePath(f);
				if (!f.working) {
					heads.fill(0);
					return;
				}
				const period = f.params.period ?? 2.6;
				const dispersion = f.params.dispersion ?? 0.06;
				const len = f.box.ringLength;
				for (let i = 0; i < CHANNELS.length; i++) {
					const speed = 1 + dispersion * (CHANNELS[i]?.drift ?? 0);
					heads[i] = (((f.since * speed) / period) % 1) * len;
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const half = Math.max(1, f.params.width ?? 9) / 2;
				const gain = (f.params.gain ?? 1.3) * f.intensity;
				let lit: Rgb = { r: 0, g: 0, b: 0 };
				let peak = 0;
				for (let i = 0; i < CHANNELS.length; i++) {
					const channel = CHANNELS[i];
					if (!channel) continue;
					let d = cell.ringIndex - (heads[i] ?? 0);
					if (d > len / 2) d -= len;
					if (d < -len / 2) d += len;
					const u = d / half;
					if (Math.abs(u) >= 1) continue;
					const falloff = (1 - u * u) ** 1.4;
					lit = add(lit, scale(channel.colour, falloff * gain));
					peak = Math.max(peak, falloff);
				}
				if (peak <= 0.004) return null;
				return {
					color: add(scale(cell.color, 1 - clamp(peak, 0, 1) * 0.8), lit),
					glow: peak * f.metrics.ch * 0.5 * f.intensity,
				};
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				const haze = (f.params.haze ?? 0.5) * f.intensity;
				if (!f.working || haze <= 0.01 || path.length === 0) return;
				const half = Math.max(1, f.params.width ?? 9) / 2;

				// Each head's glow is stroked along the outline it is travelling, not
				// stamped at its cell: a radial gradient there pools into a round cloud
				// sitting off the box instead of light running the line.
				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";
				g.lineJoin = "round";
				const steps = 24;
				for (let i = 0; i < CHANNELS.length; i++) {
					const channel = CHANNELS[i];
					if (!channel) continue;
					const pts: Array<{ cx: number; cy: number; u: number }> = [];
					for (let s = 0; s < steps; s++) {
						const u = (s / (steps - 1)) * 2 - 1;
						const index = Math.round((heads[i] ?? 0) + u * half);
						const node = path[((index % path.length) + path.length) % path.length];
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						pts.push({ cx, cy, u });
					}
					const first = pts[0];
					const last = pts[pts.length - 1];
					if (!first || !last || pts.length < 2) continue;

					for (const pass of [
						{ w: f.metrics.ch * 1.2, a: 0.07, blur: f.metrics.ch * 0.8 },
						{ w: f.metrics.ch * 0.45, a: 0.16, blur: 0 },
						{ w: f.metrics.lw * 2, a: 0.35, blur: 0 },
					]) {
						const grad = g.createLinearGradient(first.cx, first.cy, last.cx, last.cy);
						for (const p of pts) {
							const falloff = (1 - p.u * p.u) ** 1.2;
							grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(channel.colour, pass.a * haze * falloff));
						}
						g.strokeStyle = grad;
						g.lineWidth = pass.w;
						g.shadowBlur = pass.blur;
						g.shadowColor = css(channel.colour, 0.3 * haze);
						g.beginPath();
						g.moveTo(first.cx, first.cy);
						for (const p of pts) g.lineTo(p.cx, p.cy);
						g.stroke();
					}
				}
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
