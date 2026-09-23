/**
 * PROTOTYPE — throwaway. Overexposure: the outline keeps a hairline white
 * highlight while huge soft spectral lobes wash the whole bleed area.
 */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };

const effect: Effect = {
	id: "prism-bloom",
	name: "Bloom",
	group: "prism",
	blurb: "A hairline white crest on the line, blown out into vast drifting spectral haze.",
	params: [
		{ key: "period", label: "period (s)", min: 1, max: 12, step: 0.1, value: 5 },
		{ key: "crest", label: "crest (cells)", min: 1, max: 12, step: 1, value: 4 },
		{ key: "lobes", label: "lobes", min: 2, max: 10, step: 1, value: 6 },
		{ key: "size", label: "lobe size", min: 0.5, max: 3, step: 0.1, value: 1.8 },
		{ key: "wash", label: "wash", min: 0, max: 1, step: 0.05, value: 0.6 },
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
				head = ((f.since / (f.params.period ?? 5)) % 1) * f.box.ringLength;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const crest = f.params.crest ?? 4;
				let d = cell.ringIndex - head;
				if (d > len / 2) d -= len;
				if (d < -len / 2) d += len;
				const u = d / (crest / 2);
				if (Math.abs(u) >= 1) return null;
				const level = (1 - u * u) ** 1.6 * f.intensity;
				return { color: lerp(cell.color, WHITE, clamp(level * 1.2, 0, 1)), glow: level * f.metrics.ch * 0.6 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				const wash = (f.params.wash ?? 0.6) * f.intensity;
				if (!f.working || wash <= 0.01 || path.length === 0) return;
				const len = path.length;
				const lobes = Math.round(f.params.lobes ?? 6);
				const size = f.params.size ?? 1.8;
				const at = (index: number) => path[((Math.round(index) % len) + len) % len];
				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";
				g.lineJoin = "round";

				// The overexposure is carried by the line itself: each lobe is a wide,
				// very dim stroke over its own arc of the outline. Round lobes floating
				// in the bleed only ever read as a grey cloud.
				const span = len / lobes;
				for (let i = 0; i < lobes; i++) {
					const hue = ((i / lobes) * 300 + f.t * 22 + 330) % 360;
					const breathe = 0.6 + 0.4 * Math.sin(f.t * 0.7 + i * 1.9);
					const colour = hsl(hue, 1, 0.62);
					const steps = 16;
					const pts: Array<{ cx: number; cy: number; u: number }> = [];
					for (let s = 0; s < steps; s++) {
						const u = (s / (steps - 1)) * 2 - 1;
						const node = at(head + (i + 0.5) * span + (u * span) / 2);
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						pts.push({ cx, cy, u });
					}
					const first = pts[0];
					const last = pts[pts.length - 1];
					if (!first || !last || pts.length < 2) continue;
					for (const pass of [
						{ w: f.metrics.ch * 0.5 * size, a: 0.1, blur: 0 },
						{ w: f.metrics.ch * 0.18 * size, a: 0.22, blur: 0 },
						{ w: f.metrics.lw * 1.6, a: 0.3, blur: 0 },
					]) {
						const grad = g.createLinearGradient(first.cx, first.cy, last.cx, last.cy);
						for (const p of pts) {
							const falloff = (1 - p.u * p.u) ** 0.8 * breathe;
							grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(colour, pass.a * wash * falloff));
						}
						g.strokeStyle = grad;
						g.lineWidth = pass.w;
						g.shadowBlur = pass.blur;
						g.shadowColor = css(colour, 0.25 * wash);
						g.beginPath();
						g.moveTo(first.cx, first.cy);
						for (const p of pts) g.lineTo(p.cx, p.cy);
						g.stroke();
					}
				}

				const crest = Math.max(2, f.params.crest ?? 4);
				const crestPts: Array<{ cx: number; cy: number; u: number }> = [];
				for (let s = 0; s < 12; s++) {
					const u = (s / 11) * 2 - 1;
					const node = at(head + (u * crest) / 2);
					if (!node) continue;
					const { cx, cy } = cellCentre(f, node.x, node.y);
					crestPts.push({ cx, cy, u });
				}
				const cFirst = crestPts[0];
				const cLast = crestPts[crestPts.length - 1];
				if (!cFirst || !cLast || crestPts.length < 2) return;
				for (const pass of [
					{ w: f.metrics.ch * 0.9, a: 0.12, blur: f.metrics.ch * 0.6 },
					{ w: f.metrics.lw * 2, a: 0.5, blur: 0 },
				]) {
					const grad = g.createLinearGradient(cFirst.cx, cFirst.cy, cLast.cx, cLast.cy);
					for (const p of crestPts) {
						grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(WHITE, pass.a * wash * (1 - p.u * p.u) ** 0.6));
					}
					g.strokeStyle = grad;
					g.lineWidth = pass.w;
					g.shadowBlur = pass.blur;
					g.shadowColor = css(WHITE, 0.3 * wash);
					g.beginPath();
					g.moveTo(cFirst.cx, cFirst.cy);
					for (const p of crestPts) g.lineTo(p.cx, p.cy);
					g.stroke();
				}
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
