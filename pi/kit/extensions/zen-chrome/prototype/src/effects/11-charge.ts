/**
 * PROTOTYPE — throwaway. A super meter: energy creeps inward from the four
 * corners along the outline, brightness and glow building, then releases as an
 * expanding shockwave that washes over the box before the cycle restarts.
 */

import { clamp, css, hex, lerp } from "../core/color.ts";
import { boxRect } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const CHARGE = hex("#4ea8ff");
const CORE = hex("#eaf6ff");
const SPARK = hex("#a2f0ff");

const effect: Effect = {
	id: "charge",
	name: "Charge & release",
	group: "energy",
	blurb: "Energy accumulates from the corners inward, then releases as a shockwave over the box.",
	palette: { hot: CHARGE, peak: CORE },
	params: [
		{ key: "build", label: "build (s)", min: 0.6, max: 6, step: 0.1, value: 2 },
		{ key: "release", label: "release (s)", min: 0.2, max: 1.6, step: 0.05, value: 0.55 },
		{ key: "wave", label: "wave reach", min: 0.6, max: 3, step: 0.1, value: 1.6 },
	],
	create(): EffectInstance {
		let phase = 0;
		let releasing = false;
		let releaseT = 0;

		return {
			update(f: Frame) {
				if (!f.working) {
					phase = 0;
					releasing = false;
					releaseT = 0;
					return;
				}
				const build = f.params.build ?? 2;
				const release = f.params.release ?? 0.55;
				if (releasing) {
					releaseT += f.dt;
					if (releaseT >= release) {
						releasing = false;
						releaseT = 0;
						phase = 0;
					}
				} else {
					phase += f.dt / build;
					if (phase >= 1) {
						phase = 1;
						releasing = true;
						releaseT = 0;
					}
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const { cols, rows, ringLength } = f.box;
				const corners = [0, cols - 1, cols + rows - 2, 2 * cols + rows - 3];
				let nearest = ringLength;
				for (const c of corners) {
					const raw = Math.abs(cell.ringIndex - c) % ringLength;
					nearest = Math.min(nearest, Math.min(raw, ringLength - raw));
				}
				const reach = Math.max(cols, rows) / 2 + 2;

				if (releasing) {
					const release = f.params.release ?? 0.55;
					const k = 1 - releaseT / release;
					const level = clamp(k * k * f.intensity, 0, 1);
					return { color: lerp(f.palette.hot, CORE, level), glow: level * 26, scale: 1 + level * 0.12 };
				}

				const front = phase * reach;
				const filled = clamp((front - nearest) / 2 + 0.5, 0, 1);
				const crest = Math.exp(-((nearest - front) ** 2) / 6);
				const level = clamp((filled * (0.25 + 0.75 * phase) + crest * 0.7) * f.intensity, 0, 1);
				if (level < 0.02) return null;
				const hum = 0.9 + 0.1 * Math.sin(f.t * 26 + cell.ringIndex * 0.7) * phase;
				const colour = level > 0.7 ? lerp(CHARGE, CORE, (level - 0.7) / 0.3) : lerp(cell.color, CHARGE, level / 0.7);
				return { color: lerp(cell.color, colour, hum), glow: level * 14 * (0.4 + phase) };
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working) return;
				const rect = boxRect(f);
				const cx = rect.x + rect.w / 2;
				const cy = rect.y + rect.h / 2;

				if (!releasing) {
					// Pre-release swell: the interior brightens as the meter fills.
					const glow = g.createRadialGradient(cx, cy, 0, cx, cy, rect.w * 0.5);
					const a = 0.14 * phase * phase * f.intensity;
					glow.addColorStop(0, css(CHARGE, a));
					glow.addColorStop(1, css(CHARGE, 0));
					g.globalCompositeOperation = "lighter";
					g.fillStyle = glow;
					g.fillRect(0, 0, f.metrics.width, f.metrics.height);
					return;
				}

				const release = f.params.release ?? 0.55;
				const t = releaseT / release;
				const fade = (1 - t) ** 1.5;
				const maxR = (rect.w / 2) * (f.params.wave ?? 1.6);
				const r = maxR * (1 - (1 - t) ** 2);
				const squash = rect.h / rect.w;

				g.globalCompositeOperation = "lighter";
				g.save();
				g.translate(cx, cy);
				g.scale(1, Math.max(squash * 2.2, 0.18));
				for (let i = 0; i < 3; i++) {
					const rr = r - i * f.metrics.cw * 2.2;
					if (rr <= 0) continue;
					g.beginPath();
					g.arc(0, 0, rr, 0, Math.PI * 2);
					g.strokeStyle = css(i === 0 ? CORE : SPARK, fade * (i === 0 ? 0.9 : 0.35) * f.intensity);
					g.lineWidth = (i === 0 ? 3.5 : 1.6) / Math.max(squash * 2.2, 0.18);
					g.stroke();
				}
				g.restore();

				g.fillStyle = css(SPARK, 0.2 * fade * f.intensity);
				g.fillRect(rect.x - f.metrics.bleed, rect.y - f.metrics.bleed, rect.w + f.metrics.bleed * 2, rect.h + f.metrics.bleed * 2);
			},
		};
	},
};

export default effect;
