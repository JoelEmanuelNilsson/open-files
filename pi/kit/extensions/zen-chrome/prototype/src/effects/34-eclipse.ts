/**
 * PROTOTYPE — throwaway. A dark disc transits the box left to right: cells it
 * covers fall to black, cells at its limb flare with corona light.
 */

import { clamp, css, lerp } from "../core/color.ts";
import { boxRect, cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const CORONA: Rgb = { r: 255, g: 236, b: 190 };

const effect: Effect = {
	id: "eclipse",
	name: "Eclipse",
	group: "light",
	blurb: "A dark disc transits the box; its limb burns with corona light as it passes.",
	params: [
		{ key: "period", label: "transit (s)", min: 1.5, max: 12, step: 0.1, value: 5 },
		{ key: "radius", label: "radius (rows)", min: 0.6, max: 4, step: 0.1, value: 1.6 },
		{ key: "corona", label: "corona", min: 0, max: 2, step: 0.05, value: 1 },
	],
	create(): EffectInstance {
		let cx = -9999;
		let cy = 0;
		let radius = 0;

		return {
			update(f: Frame) {
				const rect = boxRect(f);
				radius = (f.params.radius ?? 1.6) * f.metrics.ch;
				if (!f.working) {
					cx = -9999;
					return;
				}
				const span = rect.w + radius * 4;
				cx = rect.x - radius * 2 + ((f.since / (f.params.period ?? 5)) % 1) * span;
				cy = rect.y + rect.h / 2;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working) return null;
				const p = cellCentre(f, cell.x, cell.y);
				const d = Math.hypot(p.cx - cx, p.cy - cy);
				if (d > radius * 2.6) return null;
				if (d <= radius) {
					const shade = clamp(1 - d / radius, 0, 1) ** 0.5;
					return { color: lerp(cell.color, BLACK, shade * f.intensity), alpha: 1 - 0.85 * shade * f.intensity };
				}
				const limb = clamp(1 - (d - radius) / (radius * 1.6), 0, 1) ** 2 * (f.params.corona ?? 1) * f.intensity;
				if (limb < 0.02) return null;
				return { color: lerp(cell.color, CORONA, clamp(limb, 0, 1)), glow: limb * 14 };
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || cx < -9000) return;
				const corona = (f.params.corona ?? 1) * f.intensity;

				g.globalCompositeOperation = "lighter";
				const halo = g.createRadialGradient(cx, cy, radius * 0.92, cx, cy, radius * 2.6);
				halo.addColorStop(0, css(CORONA, 0.5 * corona));
				halo.addColorStop(0.15, css(CORONA, 0.18 * corona));
				halo.addColorStop(1, css(CORONA, 0));
				g.fillStyle = halo;
				g.beginPath();
				g.arc(cx, cy, radius * 2.6, 0, Math.PI * 2);
				g.fill();

				g.globalCompositeOperation = "source-over";
				g.fillStyle = css(f.palette.bg);
				g.beginPath();
				g.arc(cx, cy, radius, 0, Math.PI * 2);
				g.fill();

				g.globalCompositeOperation = "lighter";
				g.strokeStyle = css(CORONA, 0.9 * corona);
				g.lineWidth = 1.4;
				g.shadowBlur = 16 * corona;
				g.shadowColor = css(CORONA, corona);
				g.beginPath();
				g.arc(cx, cy, radius, 0, Math.PI * 2);
				g.stroke();
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
