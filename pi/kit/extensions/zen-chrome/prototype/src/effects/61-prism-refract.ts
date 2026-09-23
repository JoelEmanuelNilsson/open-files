/**
 * PROTOTYPE — throwaway. A lens of glass slides along the outline: glyphs bulge
 * outward at its leading edge and sink behind it, fringing blue ahead, red astern.
 */

import { clamp, css, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const BLUE = { r: 90, g: 150, b: 255 };
const RED = { r: 255, g: 80, b: 60 };

/** Outward unit normal for a cell on the box outline, diagonal on the corners. */
function normal(cell: Cell, f: Frame): { nx: number; ny: number } {
	let nx = 0;
	let ny = 0;
	if (cell.y === 0) ny = -1;
	else if (cell.y === f.box.rows - 1) ny = 1;
	if (cell.x === 0) nx = -1;
	else if (cell.x === f.box.cols - 1) nx = 1;
	if (nx !== 0 && ny !== 0) {
		const k = Math.SQRT1_2;
		return { nx: nx * k, ny: ny * k };
	}
	return { nx, ny };
}

const effect: Effect = {
	id: "prism-refract",
	name: "Prism refract",
	group: "prism",
	blurb: "A moving lens bends the glyphs off the outline, with blue fringing ahead and red behind.",
	params: [
		{ key: "period", label: "period (s)", min: 0.8, max: 8, step: 0.1, value: 3.2 },
		{ key: "width", label: "lens (cells)", min: 4, max: 40, step: 1, value: 16 },
		{ key: "bend", label: "bend (px)", min: 0, max: 14, step: 0.5, value: 5 },
		{ key: "fringe", label: "fringe", min: 0, max: 1, step: 0.05, value: 0.7 },
		{ key: "magnify", label: "magnify", min: 0, max: 0.8, step: 0.05, value: 0.25 },
	],
	create(): EffectInstance {
		let ringLength = 0;
		let path: Cell[] = [];
		let head = 0;

		/** How far off the line the lens pushes a cell, and how strongly it is lit there. */
		const lens = (u: number, f: Frame) => {
			const envelope = (1 - u * u) ** 0.6;
			const bend = ((f.params.bend ?? 5) / 14) * f.metrics.ch;
			return { envelope, push: Math.sin(Math.PI * u) * envelope * bend * f.intensity };
		};

		return {
			update(f: Frame) {
				if (ringLength !== f.box.ringLength) {
					ringLength = f.box.ringLength;
					path = new Array(ringLength);
					for (const c of f.box.cells) if (c.ringIndex >= 0) path[c.ringIndex] = c;
					head = 0;
				}
				if (!f.working) {
					head = 0;
					return;
				}
				head = ((f.since / (f.params.period ?? 3.2)) % 1) * ringLength;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0 || ringLength === 0) return null;
				const half = Math.max(2, f.params.width ?? 16) / 2;
				let d = cell.ringIndex - head;
				if (d > ringLength / 2) d -= ringLength;
				if (d < -ringLength / 2) d += ringLength;
				const u = d / half;
				if (Math.abs(u) >= 1) return null;

				const { envelope, push } = lens(u, f);
				const { nx, ny } = normal(cell, f);
				const fringe = (f.params.fringe ?? 0.7) * Math.abs(u) * envelope * f.intensity;
				const tint = u > 0 ? BLUE : RED;
				const core = lerp(cell.color, f.palette.hot, clamp(envelope * 1.2, 0, 1) * f.intensity);

				return {
					dx: nx * push,
					dy: ny * push,
					color: lerp(core, tint, clamp(fringe, 0, 1)),
					scale: 1 + (f.params.magnify ?? 0.25) * envelope * (1 - Math.abs(u)),
					glow: envelope * f.metrics.ch * 0.4 * f.intensity,
				};
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || ringLength === 0 || f.intensity <= 0.01) return;
				const half = Math.max(2, f.params.width ?? 16) / 2;
				const fringe = (f.params.fringe ?? 0.7) * f.intensity;

				// The glyphs step off the line one cell at a time; this stroke follows the
				// same displaced curve continuously, so the bend reads as bent light
				// rather than as a staircase of separately nudged characters.
				const pts: Array<{ cx: number; cy: number; u: number }> = [];
				const steps = 32;
				for (let s = 0; s < steps; s++) {
					const u = (s / (steps - 1)) * 2 - 1;
					const index = Math.round(head + u * half);
					const cell = path[((index % ringLength) + ringLength) % ringLength];
					if (!cell) continue;
					const { cx, cy } = cellCentre(f, cell.x, cell.y);
					const { nx, ny } = normal(cell, f);
					const { push } = lens(u, f);
					pts.push({ cx: cx + nx * push, cy: cy + ny * push, u });
				}
				const first = pts[0];
				const last = pts[pts.length - 1];
				if (!first || !last || pts.length < 2) return;

				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";
				g.lineJoin = "round";
				for (const pass of [
					{ w: f.metrics.ch * 0.7, a: 0.09, blur: f.metrics.ch * 0.5 },
					{ w: f.metrics.lw * 1.8, a: 0.4, blur: 0 },
				]) {
					const grad = g.createLinearGradient(first.cx, first.cy, last.cx, last.cy);
					for (const p of pts) {
						const tint = lerp(f.palette.hot, p.u > 0 ? BLUE : RED, clamp(Math.abs(p.u) * fringe * 1.4, 0, 1));
						const envelope = (1 - p.u * p.u) ** 0.6;
						grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(tint, pass.a * envelope * f.intensity));
					}
					g.strokeStyle = grad;
					g.lineWidth = pass.w;
					g.shadowBlur = pass.blur;
					g.shadowColor = css(f.palette.hot, 0.3 * f.intensity);
					g.beginPath();
					g.moveTo(first.cx, first.cy);
					for (const p of pts) g.lineTo(p.cx, p.cy);
					g.stroke();
				}
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
