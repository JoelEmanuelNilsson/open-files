/**
 * PROTOTYPE — throwaway. The refraction band throws caustic streaks off the
 * outline: thin spectral rays wander out into the bleed like light through
 * rippled glass falling on a wall.
 */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
const SEGMENTS = 5;

interface Node {
	x: number;
	y: number;
	/** Outward unit normal, so a ray knows which way is "off the box". */
	nx: number;
	ny: number;
}

const effect: Effect = {
	id: "prism-caustics",
	name: "Caustics",
	group: "prism",
	blurb: "Refracted rays fan off the travelling band and wander across the surrounding air.",
	params: [
		{ key: "period", label: "period (s)", min: 0.8, max: 8, step: 0.1, value: 3.4 },
		{ key: "width", label: "band (cells)", min: 3, max: 40, step: 1, value: 12 },
		{ key: "rays", label: "rays", min: 6, max: 40, step: 1, value: 24 },
		{ key: "reach", label: "reach", min: 0.2, max: 1.6, step: 0.05, value: 1 },
		{ key: "wobble", label: "wobble", min: 0, max: 2, step: 0.05, value: 0.8 },
	],
	create(): EffectInstance {
		let path: Node[] = [];
		let head = 0;

		const ensurePath = (f: Frame) => {
			if (path.length === f.box.ringLength) return;
			const next: Node[] = new Array(f.box.ringLength);
			for (const c of f.box.cells) {
				if (c.ringIndex < 0) continue;
				let nx = c.x === 0 ? -1 : c.x === f.box.cols - 1 ? 1 : 0;
				let ny = c.y === 0 ? -1 : c.y === f.box.rows - 1 ? 1 : 0;
				if (nx !== 0 && ny !== 0) {
					nx *= Math.SQRT1_2;
					ny *= Math.SQRT1_2;
				}
				if (nx === 0 && ny === 0) ny = -1;
				next[c.ringIndex] = { x: c.x, y: c.y, nx, ny };
			}
			path = next;
		};

		return {
			update(f: Frame) {
				ensurePath(f);
				if (!f.working) {
					head = 0;
					return;
				}
				head = ((f.since / (f.params.period ?? 3.4)) % 1) * f.box.ringLength;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const width = f.params.width ?? 12;
				let d = cell.ringIndex - head;
				if (d > len / 2) d -= len;
				if (d < -len / 2) d += len;
				const u = d / (width / 2);
				if (Math.abs(u) >= 1) return null;
				const level = (1 - u * u) ** 1.2 * f.intensity;
				const lit = lerp(hsl(((u * 0.5 + 0.5) * 180 + 340) % 360, 0.7, 0.7), WHITE, 0.5);
				return { color: lerp(cell.color, lit, clamp(level, 0, 1)), glow: level * f.metrics.ch * 0.4 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || path.length === 0 || f.intensity <= 0.01) return;
				const count = Math.round(f.params.rays ?? 24);
				const width = f.params.width ?? 12;
				const wobble = f.params.wobble ?? 0.8;
				const reachScale = (f.params.reach ?? 1) * f.metrics.bleed * 1.5;
				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";
				g.lineJoin = "round";

				// The lit stretch of outline the rays leave from, stroked along the line:
				// without it the rays look like hair growing out of nothing.
				const band: Array<{ cx: number; cy: number; u: number }> = [];
				for (let s = 0; s < 24; s++) {
					const u = (s / 23) * 2 - 1;
					const index = Math.round(head + (u * width) / 2);
					const node = path[((index % path.length) + path.length) % path.length];
					if (!node) continue;
					const p = cellCentre(f, node.x, node.y);
					band.push({ cx: p.cx, cy: p.cy, u });
				}
				const bFirst = band[0];
				const bLast = band[band.length - 1];
				if (bFirst && bLast && band.length > 1) {
					for (const pass of [
						{ w: f.metrics.ch * 0.9, a: 0.1, blur: f.metrics.ch * 0.6 },
						{ w: f.metrics.lw * 2, a: 0.4, blur: 0 },
					]) {
						const grad = g.createLinearGradient(bFirst.cx, bFirst.cy, bLast.cx, bLast.cy);
						for (const p of band) {
							const colour = hsl(((p.u * 0.5 + 0.5) * 280 + 335) % 360, 1, 0.7);
							grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(colour, pass.a * f.intensity * (1 - p.u * p.u) ** 0.7));
						}
						g.strokeStyle = grad;
						g.lineWidth = pass.w;
						g.shadowBlur = pass.blur;
						g.shadowColor = css(WHITE, 0.25 * f.intensity);
						g.beginPath();
						g.moveTo(bFirst.cx, bFirst.cy);
						for (const p of band) g.lineTo(p.cx, p.cy);
						g.stroke();
					}
				}
				g.shadowBlur = 0;

				for (let i = 0; i < count; i++) {
					const u = ((i + 0.5) / count) * 2 - 1;
					const index = Math.round(head + (u * width) / 2);
					const node = path[((index % path.length) + path.length) % path.length];
					if (!node) continue;
					const { cx, cy } = cellCentre(f, node.x, node.y);
					const phase = f.t * 1.9 + i * 2.399;
					const swing = Math.sin(phase) * wobble * 0.22;
					const a = Math.atan2(node.ny, node.nx) + swing;
					const ca = Math.cos(a);
					const sa = Math.sin(a);
					const reach = reachScale * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 0.7 + 1.1))) * (1 - Math.abs(u) * 0.45);
					const colour = hsl(((u * 0.5 + 0.5) * 280 + 335) % 360, 1, 0.62);
					const alpha = 0.6 * f.intensity * (1 - u * u) ** 1.1;
					const ray: Array<{ x: number; y: number }> = [{ x: cx, y: cy }];
					for (let s = 1; s <= SEGMENTS; s++) {
						const k = s / SEGMENTS;
						const dist = reach * k;
						const lateral = Math.sin(phase * 1.3 + k * 4.7) * wobble * f.metrics.ch * 0.18 * k * k;
						ray.push({ x: cx + ca * dist - sa * lateral, y: cy + sa * dist + ca * lateral });
					}
					const tip = ray[ray.length - 1];
					if (!tip) continue;
					// Two passes per ray: a soft sheath and a hairline core. One pass at a
					// single width reads as loose hair rather than a shaft of light.
					for (const pass of [
						{ w: f.metrics.lw * 3, a: 0.28 },
						{ w: f.metrics.lw, a: 1 },
					]) {
						const grad = g.createLinearGradient(cx, cy, tip.x, tip.y);
						grad.addColorStop(0, css(WHITE, alpha * pass.a * 0.9));
						grad.addColorStop(0.25, css(colour, alpha * pass.a));
						grad.addColorStop(1, css(colour, 0));
						g.strokeStyle = grad;
						g.lineWidth = pass.w;
						g.beginPath();
						g.moveTo(cx, cy);
						for (const p of ray) g.lineTo(p.x, p.y);
						g.stroke();
					}
				}
			},
		};
	},
};

export default effect;
