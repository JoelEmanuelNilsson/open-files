/**
 * PROTOTYPE — throwaway. The outline smoulders and curling plumes of grey-blue
 * smoke rise off the top rule into the bleed, expanding and fading as they go.
 */

import { css, hex, lerp } from "../core/color.ts";
import { boxRect, cellX } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const ASH = hex("#2a2f38");
const SMOKE = hex("#8f9fb4");
const EMBER = hex("#c46a2e");

interface Puff {
	x: number;
	y: number;
	age: number;
	max: number;
	r: number;
	seed: number;
}

function hash(n: number): number {
	const s = Math.sin(n * 127.1) * 43758.5453;
	return s - Math.floor(s);
}

function noise2(x: number, y: number): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const xf = x - xi;
	const yf = y - yi;
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	const a = hash(xi + yi * 57);
	const b = hash(xi + 1 + yi * 57);
	const c = hash(xi + (yi + 1) * 57);
	const d = hash(xi + 1 + (yi + 1) * 57);
	return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Divergence-free-ish drift: the curl of a scalar noise field. */
function curl(x: number, y: number, t: number): { vx: number; vy: number } {
	const e = 4;
	const n = (px: number, py: number) => noise2(px * 0.012, py * 0.012 + t * 0.25);
	return { vx: (n(x, y + e) - n(x, y - e)) / (2 * e), vy: -(n(x + e, y) - n(x - e, y)) / (2 * e) };
}

const effect: Effect = {
	id: "smoke",
	name: "Smoke",
	group: "fluid",
	blurb: "The outline smoulders; curling plumes of smoke rise off the top rule and dissipate.",
	palette: { hot: SMOKE, peak: hex("#d7e2f0") },
	params: [
		{ key: "rate", label: "puffs/s", min: 0, max: 60, step: 1, value: 18 },
		{ key: "rise", label: "rise px/s", min: 5, max: 90, step: 1, value: 26 },
		{ key: "curl", label: "curl", min: 0, max: 4000, step: 50, value: 1400 },
		{ key: "grow", label: "growth", min: 0, max: 40, step: 1, value: 14 },
	],
	create(): EffectInstance {
		const puffs: Puff[] = [];
		let pending = 0;

		return {
			update(f: Frame) {
				const rect = boxRect(f);
				const rate = f.working ? (f.params.rate ?? 18) * f.intensity : 0;
				pending += rate * f.dt;
				while (pending >= 1 && puffs.length < 160) {
					pending -= 1;
					puffs.push({
						x: rect.x + Math.random() * rect.w,
						y: rect.y + f.metrics.ch * 0.4,
						age: 0,
						max: 2.4 + Math.random() * 2.6,
						r: f.metrics.ch * (0.4 + Math.random() * 0.5),
						seed: Math.random() * 100,
					});
				}
				const rise = f.params.rise ?? 26;
				const swirl = f.params.curl ?? 1400;
				for (let i = puffs.length - 1; i >= 0; i--) {
					const p = puffs[i];
					p.age += f.dt;
					if (p.age >= p.max) {
						puffs.splice(i, 1);
						continue;
					}
					const c = curl(p.x, p.y, f.t + p.seed);
					p.x += c.vx * swirl * f.dt;
					p.y += (c.vy * swirl * 0.4 - rise * (0.6 + p.age * 0.35)) * f.dt;
					p.r += (f.params.grow ?? 14) * f.dt;
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				const smoulder =
					0.5 + 0.5 * Math.sin(cell.x * 0.8 + cell.y * 2.3 + f.t * 1.6 + noise2(cell.x * 0.4, f.t * 0.5) * 6);
				const level = smoulder * f.intensity * (f.working ? 0.55 : 0.15);
				if (level < 0.02) return null;
				const heat = cell.y === 0 ? level : level * 0.5;
				return { color: lerp(lerp(cell.color, ASH, 0.4), EMBER, heat * 0.7), glow: heat * 5 };
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				g.globalCompositeOperation = "lighter";
				for (const p of puffs) {
					const t = p.age / p.max;
					const fade = Math.sin(Math.PI * Math.min(1, t)) ** 1.3 * 0.16 * f.intensity;
					if (fade < 0.003) continue;
					const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
					grad.addColorStop(0, css(SMOKE, fade));
					grad.addColorStop(0.5, css(SMOKE, fade * 0.45));
					grad.addColorStop(1, css(SMOKE, 0));
					g.fillStyle = grad;
					g.beginPath();
					g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
					g.fill();
				}
				// A faint haze hugging the top rule while it smoulders.
				if (!f.working) return;
				const rect = boxRect(f);
				const haze = g.createLinearGradient(0, rect.y - f.metrics.ch * 2, 0, rect.y + f.metrics.ch);
				haze.addColorStop(0, css(SMOKE, 0));
				haze.addColorStop(1, css(SMOKE, 0.07 * f.intensity));
				g.fillStyle = haze;
				g.fillRect(cellX(f, 0) - 20, rect.y - f.metrics.ch * 2, rect.w + 40, f.metrics.ch * 3);
			},
		};
	},
};

export default effect;
