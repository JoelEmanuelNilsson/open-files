/**
 * PROTOTYPE — throwaway. REFERENCE for canvas effects: the bottom rule burns and
 * throws sparks that drift up past the box. Shows cell recolouring, a particle
 * system in `update`, and free painting outside the outline in `drawOver`.
 */

import { css, hex, lerp } from "../core/color.ts";
import { boxRect, cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const COAL = hex("#4a1200");
const FLAME = hex("#ff7a18");
const WHITE_HOT = hex("#ffe6b0");

interface Spark {
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	max: number;
	size: number;
}

/** Cheap value noise: smooth, deterministic, no dependencies. */
function noise(x: number): number {
	const i = Math.floor(x);
	const f = x - i;
	const h = (n: number) => {
		const s = Math.sin(n * 127.1) * 43758.5453;
		return s - Math.floor(s);
	};
	const u = f * f * (3 - 2 * f);
	return h(i) * (1 - u) + h(i + 1) * u;
}

const effect: Effect = {
	id: "embers",
	name: "Embers",
	group: "fire",
	blurb: "The bottom rule burns; sparks lift off and drift up past the box.",
	palette: { hot: FLAME, peak: WHITE_HOT },
	params: [
		{ key: "rate", label: "sparks/s", min: 0, max: 200, step: 5, value: 55 },
		{ key: "rise", label: "rise", min: 10, max: 240, step: 5, value: 90 },
		{ key: "heat", label: "heat", min: 0, max: 1, step: 0.05, value: 0.75 },
	],
	create(): EffectInstance {
		const sparks: Spark[] = [];
		let pending = 0;

		return {
			update(f: Frame) {
				const rect = boxRect(f);
				const rate = f.working ? (f.params.rate ?? 55) * f.intensity : 0;
				pending += rate * f.dt;
				while (pending >= 1) {
					pending -= 1;
					const x = rect.x + Math.random() * rect.w;
					sparks.push({
						x,
						y: rect.y + rect.h - f.metrics.ch * 0.4,
						vx: (Math.random() - 0.5) * 22,
						vy: -(f.params.rise ?? 90) * (0.5 + Math.random()),
						life: 0,
						max: 0.7 + Math.random() * 1.4,
						size: 0.7 + Math.random() * 1.8,
					});
				}
				for (let i = sparks.length - 1; i >= 0; i--) {
					const s = sparks[i] as Spark;
					s.life += f.dt;
					if (s.life >= s.max) {
						sparks.splice(i, 1);
						continue;
					}
					s.vy += 14 * f.dt;
					s.vx += (noise(s.y * 0.02 + f.t * 0.6) - 0.5) * 60 * f.dt;
					s.x += s.vx * f.dt;
					s.y += s.vy * f.dt;
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const last = f.box.rows - 1;
				const heat = f.params.heat ?? 0.75;
				// Heat pools along the bottom rule and licks a little way up the sides.
				const fromBottom = last - cell.y;
				const vertical = Math.exp(-fromBottom * 0.9);
				const flicker = 0.55 + 0.45 * noise(cell.x * 0.35 + f.t * 3.4);
				const level = vertical * flicker * heat * f.intensity;
				if (level < 0.02) return null;
				const colour: Rgb = level > 0.7 ? lerp(FLAME, WHITE_HOT, (level - 0.7) / 0.3) : lerp(COAL, FLAME, level / 0.7);
				return { color: lerp(cell.color, colour, Math.min(1, level * 1.6)), glow: level * 10 };
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				g.globalCompositeOperation = "lighter";
				for (const s of sparks) {
					const t = s.life / s.max;
					const fade = (1 - t) ** 1.6;
					const colour = lerp(WHITE_HOT, FLAME, Math.min(1, t * 1.8));
					g.fillStyle = css(colour, fade);
					g.shadowBlur = 6 * fade;
					g.shadowColor = css(FLAME, fade);
					g.beginPath();
					g.arc(s.x, s.y, s.size * (1 - t * 0.4), 0, Math.PI * 2);
					g.fill();
				}
				g.shadowBlur = 0;
				// A soft heat wash under the box.
				const rect = boxRect(f);
				const { cy } = cellCentre(f, 0, f.box.rows - 1);
				const wash = g.createLinearGradient(0, cy - f.metrics.ch * 2, 0, cy + f.metrics.ch);
				wash.addColorStop(0, css(FLAME, 0));
				wash.addColorStop(1, css(FLAME, 0.12 * f.intensity * (f.working ? 1 : 0)));
				g.fillStyle = wash;
				g.fillRect(rect.x - 20, cy - f.metrics.ch * 2, rect.w + 40, f.metrics.ch * 3);
			},
		};
	},
};

export default effect;
