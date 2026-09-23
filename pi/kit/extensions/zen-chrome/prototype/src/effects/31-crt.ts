/**
 * PROTOTYPE — throwaway. A CRT beam band sweeps down the box: chromatic
 * fringes, fine scanlines, rolling-sync shear and a vignette.
 */

import { clamp, css, lerp } from "../core/color.ts";
import { boxRect } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const RED = { r: 255, g: 40, b: 60 };
const BLUE = { r: 60, g: 90, b: 255 };
const WHITE = { r: 255, g: 250, b: 235 };

const effect: Effect = {
	id: "crt",
	name: "CRT sweep",
	group: "light",
	blurb: "A beam band rolls down the tube with RGB fringing, scanlines and sync tears.",
	params: [
		{ key: "period", label: "sweep (s)", min: 0.6, max: 6, step: 0.1, value: 2.2 },
		{ key: "band", label: "band (rows)", min: 0.4, max: 4, step: 0.1, value: 1.3 },
		{ key: "split", label: "aberration", min: 0, max: 14, step: 0.5, value: 5 },
		{ key: "lines", label: "scanlines", min: 0, max: 1, step: 0.05, value: 0.45 },
	],
	create(): EffectInstance {
		let bandY = -999;
		let tearTimer = 1.5;
		let tearRow = 0;
		let tearRows = 0;
		let tearAmount = 0;
		let tearLeft = 0;

		return {
			update(f: Frame) {
				const rect = boxRect(f);
				if (!f.working) {
					bandY = -999;
					tearLeft = 0;
					return;
				}
				const period = f.params.period ?? 2.2;
				const span = rect.h + f.metrics.ch * 6;
				bandY = rect.y - f.metrics.ch * 3 + ((f.since / period) % 1) * span;

				tearTimer -= f.dt;
				if (tearTimer <= 0) {
					tearTimer = 1.2 + Math.random() * 3;
					tearRow = Math.floor(Math.random() * f.box.rows);
					tearRows = 1 + Math.floor(Math.random() * 3);
					tearAmount = (Math.random() - 0.5) * f.metrics.cw * 3.5;
					tearLeft = 0.08 + Math.random() * 0.14;
				}
				if (tearLeft > 0) tearLeft = Math.max(0, tearLeft - f.dt);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working) return null;
				const ch = f.metrics.ch;
				const cy = f.metrics.bleed + cell.y * ch + ch / 2;
				const half = Math.max(0.3, f.params.band ?? 1.3) * ch;
				const d = Math.abs(cy - bandY) / half;
				const gain = d >= 1 ? 0 : (1 - d * d) ** 1.5 * f.intensity;
				const sheared = tearLeft > 0 && cell.y >= tearRow && cell.y < tearRow + tearRows;
				if (gain <= 0.01 && !sheared) return null;
				const style: CellStyle = {};
				if (gain > 0.01) {
					style.color = lerp(cell.color, WHITE, clamp(gain * 1.3, 0, 1));
					style.glow = gain * 9;
					style.alpha = 1;
				}
				if (sheared) {
					style.dx = tearAmount;
					style.alpha = 0.75;
				}
				return style;
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				const rect = boxRect(f);
				const lines = f.params.lines ?? 0.45;

				if (f.working) {
					const half = Math.max(0.3, f.params.band ?? 1.3) * f.metrics.ch;
					const split = (f.params.split ?? 5) * f.intensity;
					g.globalCompositeOperation = "lighter";
					const bar = (colour: { r: number; g: number; b: number }, offset: number, alpha: number) => {
						const grad = g.createLinearGradient(0, bandY - half + offset, 0, bandY + half + offset);
						grad.addColorStop(0, css(colour, 0));
						grad.addColorStop(0.5, css(colour, alpha * f.intensity));
						grad.addColorStop(1, css(colour, 0));
						g.fillStyle = grad;
						g.fillRect(rect.x - f.metrics.bleed, bandY - half + offset, rect.w + f.metrics.bleed * 2, half * 2);
					};
					bar(RED, -split, 0.2);
					bar(BLUE, split, 0.2);
					bar(WHITE, 0, 0.12);
					g.globalCompositeOperation = "source-over";
				}

				if (lines > 0.01) {
					g.fillStyle = css(f.palette.bg, 0.5 * lines);
					for (let y = rect.y; y < rect.y + rect.h; y += 3) g.fillRect(rect.x, y, rect.w, 1);
				}

				// Vignette: the tube's glass falls off toward the corners.
				const cx = rect.x + rect.w / 2;
				const cy = rect.y + rect.h / 2;
				const r = Math.hypot(rect.w, rect.h) / 2;
				const vig = g.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
				vig.addColorStop(0, css(f.palette.bg, 0));
				vig.addColorStop(1, css(f.palette.bg, 0.75));
				g.fillStyle = vig;
				g.fillRect(0, 0, f.metrics.width, f.metrics.height);
			},
		};
	},
};

export default effect;
