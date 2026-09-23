/**
 * PROTOTYPE — throwaway. The box fills with liquid from the bottom: the level
 * breathes up and down, the meniscus wobbles, and submerged chrome shifts colour
 * as if seen through water.
 */

import { css, hex, lerp } from "../core/color.ts";
import { boxRect, cellCentre, cellX, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const DEEP = hex("#0d2f45");
const WATER = hex("#2f8fb5");
const SURFACE = hex("#bff0ff");

const effect: Effect = {
	id: "tide",
	name: "Tide",
	group: "fluid",
	blurb: "Liquid rises inside the box, meniscus wobbling; submerged glyphs tint through the water.",
	palette: { hot: WATER, peak: SURFACE },
	params: [
		{ key: "level", label: "mean level", min: 0.05, max: 0.95, step: 0.05, value: 0.45 },
		{ key: "swing", label: "swing", min: 0, max: 0.5, step: 0.02, value: 0.22 },
		{ key: "period", label: "period (s)", min: 2, max: 20, step: 0.5, value: 7 },
		{ key: "wobble", label: "wobble (px)", min: 0, max: 12, step: 0.5, value: 4 },
	],
	create(): EffectInstance {
		let phase = 0;
		let fill = 0;

		/** Water surface in canvas pixels at column position `px`. */
		const surfaceY = (px: number, f: Frame): number => {
			const rect = boxRect(f);
			const mean = f.params.level ?? 0.45;
			const swing = f.params.swing ?? 0.22;
			const h = (mean + swing * Math.sin(phase * ((Math.PI * 2) / (f.params.period ?? 7)))) * fill;
			const wobble = f.params.wobble ?? 4;
			const w =
				Math.sin(px * 0.045 + phase * 1.3) * wobble + Math.sin(px * 0.017 - phase * 0.8 + 2.1) * wobble * 0.7;
			return rect.y + rect.h * (1 - h) + w;
		};

		return {
			update(f: Frame) {
				phase += f.dt;
				const target = f.working ? f.intensity : 0;
				fill += (target - fill) * Math.min(1, f.dt * 1.2);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (fill < 0.02) return null;
				const { cx, cy } = cellCentre(f, cell.x, cell.y);
				const s = surfaceY(cx, f);
				const depth = (cy - s) / f.metrics.ch;
				if (depth < -0.6) return null;
				const near = Math.exp(-(depth * depth) / 0.35);
				if (depth < 0.35) {
					// Right at the meniscus: a bright surface line.
					return { color: lerp(cell.color, SURFACE, near * fill), glow: near * 10 * fill };
				}
				const sink = Math.min(1, depth / Math.max(1, f.box.rows - 1));
				const tint = lerp(WATER, DEEP, sink);
				return {
					color: lerp(cell.color, tint, 0.55 * fill),
					bg: cell.kind === "interior" || cell.kind === "cursor" ? lerp(f.palette.bg, DEEP, 0.5 * fill) : undefined,
					glow: 2 * fill,
				};
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (fill < 0.02) return;
				const rect = boxRect(f);
				const left = cellX(f, 1);
				const right = cellX(f, f.box.cols - 1);
				const top = cellY(f, 1);
				const floor = cellY(f, f.box.rows - 1);
				g.save();
				g.beginPath();
				g.rect(left, top, right - left, floor - top);
				g.clip();
				const body = g.createLinearGradient(0, rect.y, 0, floor);
				body.addColorStop(0, css(WATER, 0.28 * fill));
				body.addColorStop(1, css(DEEP, 0.55 * fill));
				g.beginPath();
				g.moveTo(left, floor);
				for (let x = left; x <= right; x += 3) g.lineTo(x, surfaceY(x, f));
				g.lineTo(right, floor);
				g.closePath();
				g.fillStyle = body;
				g.fill();
				g.strokeStyle = css(SURFACE, 0.5 * fill);
				g.lineWidth = 1.2;
				g.beginPath();
				for (let x = left; x <= right; x += 3) {
					const y = surfaceY(x, f);
					if (x === left) g.moveTo(x, y);
					else g.lineTo(x, y);
				}
				g.stroke();
				g.restore();
			},
		};
	},
};

export default effect;
