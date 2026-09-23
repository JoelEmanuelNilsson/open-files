/**
 * PROTOTYPE — throwaway. A refraction band runs the outline and splits the
 * line into a spectrum, white at its centre, with chromatic haze in the bleed.
 */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };

const effect: Effect = {
	id: "prism",
	name: "Prism",
	group: "light",
	blurb: "A narrow refraction band walks the outline, fanning the line into a spectrum.",
	params: [
		{ key: "period", label: "period (s)", min: 0.8, max: 8, step: 0.1, value: 3 },
		{ key: "width", label: "band (cells)", min: 3, max: 40, step: 1, value: 14 },
		{ key: "spread", label: "spectrum", min: 60, max: 360, step: 10, value: 260 },
		{ key: "hue", label: "hue anchor", min: 0, max: 360, step: 10, value: 340 },
		{ key: "haze", label: "haze", min: 0, max: 1, step: 0.05, value: 0.55 },
		{ key: "bands", label: "bands", min: 1, max: 4, step: 1, value: 1 },
		{ key: "reverse", label: "reverse", min: 0, max: 1, step: 1, value: 0 },
		{ key: "flash", label: "settle flash", min: 0, max: 1, step: 0.05, value: 0.6 },
	],
	create(): EffectInstance {
		let path: Array<{ x: number; y: number }> = [];
		let head = 0;

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
					head = 0;
					return;
				}
				const dir = (f.params.reverse ?? 0) >= 0.5 ? -1 : 1;
				const phase = (((dir * f.since) / (f.params.period ?? 3)) % 1 + 1) % 1;
				head = phase * f.box.ringLength;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;

				// The outro: work finished, so the whole ring flashes white once and drains.
				if (!f.working) {
					const amount = f.params.flash ?? 0.6;
					if (f.settled === null || amount <= 0.01) return null;
					const decay = clamp(1 - f.settled / 0.7, 0, 1) ** 2;
					if (decay <= 0.01) return null;
					const level = decay * amount * f.intensity;
					return { color: lerp(cell.color, WHITE, level), glow: level * 10 };
				}

				const len = f.box.ringLength;
				const width = f.params.width ?? 14;
				const bands = Math.max(1, Math.round(f.params.bands ?? 1));
				const spread = f.params.spread ?? 260;
				const anchor = f.params.hue ?? 340;

				// Bands are evenly spaced around the ring; the nearest one wins the cell.
				let best: { u: number; falloff: number } | null = null;
				for (let b = 0; b < bands; b++) {
					let d = cell.ringIndex - (head + (b * len) / bands);
					d = ((d % len) + len) % len;
					if (d > len / 2) d -= len;
					const u = d / (width / 2);
					if (Math.abs(u) >= 1) continue;
					const falloff = (1 - u * u) ** 0.8;
					if (best === null || falloff > best.falloff) best = { u, falloff };
				}
				if (best === null) return null;

				const colour = hsl(((best.u * 0.5 + 0.5) * spread + anchor) % 360, 1, 0.55);
				const core = clamp(1 - Math.abs(best.u) * 3.2, 0, 1);
				const lit = lerp(colour, WHITE, core ** 1.5);
				const level = best.falloff * f.intensity;
				return { color: lerp(cell.color, lit, clamp(level * 1.5, 0, 1)), glow: level * f.metrics.ch * 0.55 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				const haze = (f.params.haze ?? 0.55) * f.intensity;
				if (!f.working || haze <= 0.01 || path.length === 0) return;
				const width = f.params.width ?? 14;
				const spread = f.params.spread ?? 260;
				const anchor = f.params.hue ?? 340;
				const bands = Math.max(1, Math.round(f.params.bands ?? 1));

				// The bloom is stroked along the outline itself, one short segment per
				// wavelength. A radial gradient at each cell would pool into a round
				// cloud; light coming off a line stays on the line.
				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";
				g.lineJoin = "round";
				const steps = 40;
				for (let b = 0; b < bands; b++) {
					const pts: Array<{ cx: number; cy: number; u: number }> = [];
					for (let i = 0; i < steps; i++) {
						const u = (i / (steps - 1)) * 2 - 1;
						const index = Math.round(head + (b * path.length) / bands + (u * width) / 2);
						const node = path[((index % path.length) + path.length) % path.length];
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						pts.push({ cx, cy, u });
					}
					const first = pts[0];
					const last = pts[pts.length - 1];
					if (!first || !last || pts.length < 2) continue;

					// One continuous stroke carrying the spectrum as a gradient. Drawing
					// each wavelength as its own segment leaves a row of bright beads
					// where the caps overlap under additive blending.
					for (const pass of [
						{ w: f.metrics.ch * 1.4, a: 0.055, blur: f.metrics.ch * 1.1 },
						{ w: f.metrics.ch * 0.55, a: 0.13, blur: f.metrics.ch * 0.5 },
						{ w: f.metrics.lw * 2.2, a: 0.3, blur: 0 },
					]) {
						const grad = g.createLinearGradient(first.cx, first.cy, last.cx, last.cy);
						for (const p of pts) {
							const colour = hsl(((p.u * 0.5 + 0.5) * spread + anchor) % 360, 1, 0.6);
							const falloff = (1 - p.u * p.u) ** 0.7;
							grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(colour, pass.a * haze * falloff));
						}
						g.strokeStyle = grad;
						g.lineWidth = pass.w;
						g.shadowBlur = pass.blur;
						g.shadowColor = css(hsl((spread * 0.5 + anchor) % 360, 1, 0.6), 0.35 * haze);
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
