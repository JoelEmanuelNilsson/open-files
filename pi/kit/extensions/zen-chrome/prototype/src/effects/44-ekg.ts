/**
 * PROTOTYPE — throwaway. A heartbeat trace runs the bottom rule: the QRS complex
 * travels left to right, displacing cells and drawn crisply as a polyline.
 */

import { css, hex, lerp } from "../core/color.ts";
import { cellX, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const TRACE = hex("#5cff9d");
const PEAK = hex("#dcffe9");

function bump(u: number, centre: number, sigma: number, amp: number): number {
	const d = u - centre;
	return amp * Math.exp(-(d * d) / (2 * sigma * sigma));
}

/** One cardiac cycle over u in 0..1: P, Q dip, R spike, S undershoot, T, then rest. */
function beat(u: number): number {
	return (
		bump(u, 0.1, 0.026, 0.14) +
		bump(u, 0.2, 0.009, -0.16) +
		bump(u, 0.228, 0.0085, 1) +
		bump(u, 0.258, 0.013, -0.4) +
		bump(u, 0.38, 0.042, 0.24)
	);
}

const effect: Effect = {
	id: "ekg",
	name: "EKG",
	group: "signal",
	blurb: "A cardiac trace crosses the bottom rule — spike, undershoot, recovery, then the pause.",
	palette: { hot: TRACE, peak: PEAK },
	params: [
		{ key: "bpm", label: "bpm", min: 20, max: 200, step: 5, value: 72 },
		{ key: "amp", label: "amplitude", min: 0.2, max: 3, step: 0.1, value: 1.4 },
		{ key: "beats", label: "beats across", min: 0.5, max: 4, step: 0.25, value: 1.5 },
	],
	create(): EffectInstance {
		let head = 0;

		const wave = (f: Frame, x: number): number => {
			const period = f.box.cols / Math.max(0.5, f.params.beats ?? 1.5);
			const u = (((x - head) / period) % 1 + 1) % 1;
			return beat(u);
		};

		return {
			update(f: Frame) {
				if (!f.working) return;
				const period = f.box.cols / Math.max(0.5, f.params.beats ?? 1.5);
				head += period * ((f.params.bpm ?? 72) / 60) * f.dt;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working) return null;
				if (cell.y !== f.box.rows - 1 || cell.kind === "label") return null;
				const v = wave(f, cell.x + 0.5);
				const level = Math.min(1, Math.abs(v) * 1.3) * f.intensity;
				if (level < 0.02) return null;
				const amp = (f.params.amp ?? 1.4) * f.intensity;
				return {
					dy: -v * amp * f.metrics.ch,
					color: level > 0.6 ? lerp(TRACE, PEAK, (level - 0.6) / 0.4) : lerp(cell.color, TRACE, level * 1.5),
					glow: level * 12,
					scale: 1 + level * 0.25,
				};
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working) return;
				const y0 = cellY(f, f.box.rows - 1) + f.metrics.ch / 2;
				const amp = (f.params.amp ?? 1.4) * f.intensity * f.metrics.ch;
				const left = cellX(f, 0);
				const right = cellX(f, f.box.cols);
				const steps = f.box.cols * 6;

				g.globalCompositeOperation = "lighter";
				g.lineJoin = "round";
				g.lineCap = "round";
				for (const pass of [
					{ w: 3.5, a: 0.16, c: TRACE },
					{ w: 1.2, a: 0.9, c: PEAK },
				]) {
					g.beginPath();
					for (let i = 0; i <= steps; i++) {
						const px = left + ((right - left) * i) / steps;
						const cx = (px - f.metrics.bleed) / f.metrics.cw;
						const y = y0 - wave(f, cx) * amp;
						if (i === 0) g.moveTo(px, y);
						else g.lineTo(px, y);
					}
					g.strokeStyle = css(pass.c, pass.a * f.intensity);
					g.lineWidth = pass.w;
					g.shadowBlur = pass.w * 4;
					g.shadowColor = css(TRACE, 0.8);
					g.stroke();
				}
				g.shadowBlur = 0;

				// A marker riding the R spike itself, so the eye has something to track.
				const period = f.box.cols / Math.max(0.5, f.params.beats ?? 1.5);
				const spike = (((head + 0.228 * period) % period) + period) % period;
				for (let x = spike; x < f.box.cols; x += period) {
					g.fillStyle = css(PEAK, 0.8 * f.intensity);
					g.beginPath();
					g.arc(cellX(f, x), y0 - beat(0.228) * amp, 2.2, 0, Math.PI * 2);
					g.fill();
				}
			},
		};
	},
};

export default effect;
