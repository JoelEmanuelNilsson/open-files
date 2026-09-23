/**
 * PROTOTYPE — throwaway. An unseen mass orbits the chatbar, dragging nearby
 * cells off the grid on damped springs so the outline bends as it passes.
 */

import { clamp, css, hex, lerp } from "../core/color.ts";
import { boxRect, cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const LENS = hex("#8ab4ff");

interface Spring {
	dx: number;
	dy: number;
	vx: number;
	vy: number;
}

const effect: Effect = {
	id: "gravity",
	name: "Gravity well",
	group: "motion",
	blurb: "A mass orbits the box; cells fall toward it, stretch, and spring back as it passes.",
	palette: { hot: LENS },
	params: [
		{ key: "radius", label: "reach (cells)", min: 2, max: 20, step: 0.5, value: 7 },
		{ key: "pull", label: "pull", min: 0, max: 3000, step: 25, value: 900 },
		{ key: "stiff", label: "stiffness", min: 20, max: 400, step: 5, value: 130 },
		{ key: "orbit", label: "orbit (s)", min: 2, max: 20, step: 0.5, value: 7 },
	],
	create(): EffectInstance {
		const springs = new Map<string, Spring>();
		let angle = 0;
		let ax = 0;
		let ay = 0;

		return {
			update(f: Frame) {
				const rect = boxRect(f);
				const period = f.params.orbit ?? 7;
				if (f.working) angle += (Math.PI * 2 * f.dt) / period;
				const rx = rect.w * 0.56;
				const ry = rect.h * 1.15;
				ax = rect.x + rect.w / 2 + Math.cos(angle) * rx;
				ay = rect.y + rect.h / 2 + Math.sin(angle * 1.37) * ry;

				const reach = (f.params.radius ?? 7) * f.metrics.cw;
				const pull = (f.working ? (f.params.pull ?? 900) : 0) * f.intensity;
				const k = f.params.stiff ?? 130;
				const damp = 2 * Math.sqrt(k) * 0.55;

				for (const cell of f.box.cells) {
					if (cell.ringIndex < 0 && cell.kind === "interior") continue;
					const key = `${cell.x},${cell.y}`;
					let s = springs.get(key);
					if (!s) {
						s = { dx: 0, dy: 0, vx: 0, vy: 0 };
						springs.set(key, s);
					}
					const { cx, cy } = cellCentre(f, cell.x, cell.y);
					const gx = ax - (cx + s.dx);
					const gy = ay - (cy + s.dy);
					const d = Math.hypot(gx, gy) || 1;
					const falloff = Math.exp(-(d * d) / (2 * reach * reach));
					const fx = (gx / d) * pull * falloff - k * s.dx - damp * s.vx;
					const fy = (gy / d) * pull * falloff - k * s.dy - damp * s.vy;
					s.vx += fx * f.dt;
					s.vy += fy * f.dt;
					s.dx += s.vx * f.dt;
					s.dy += s.vy * f.dt;
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				const s = springs.get(`${cell.x},${cell.y}`);
				if (!s) return null;
				const mag = Math.hypot(s.dx, s.dy);
				if (mag < 0.15) return null;
				const heat = clamp(mag / (f.metrics.ch * 1.2), 0, 1);
				return {
					dx: s.dx,
					dy: s.dy,
					color: lerp(cell.color, f.palette.peak, heat * 0.9),
					glow: heat * 12,
					scale: 1 + heat * 0.55,
					alpha: 1,
				};
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working) return;
				const r = (f.params.radius ?? 7) * f.metrics.cw;
				const wash = g.createRadialGradient(ax, ay, 0, ax, ay, r);
				wash.addColorStop(0, css(LENS, 0.16 * f.intensity));
				wash.addColorStop(0.65, css(LENS, 0.05 * f.intensity));
				wash.addColorStop(1, css(LENS, 0));
				g.fillStyle = wash;
				g.beginPath();
				g.arc(ax, ay, r, 0, Math.PI * 2);
				g.fill();
				g.strokeStyle = css(LENS, 0.22 * f.intensity);
				g.lineWidth = 1;
				g.beginPath();
				g.arc(ax, ay, r * 0.62, 0, Math.PI * 2);
				g.stroke();
			},
		};
	},
};

export default effect;
