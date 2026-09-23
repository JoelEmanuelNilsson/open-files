/**
 * PROTOTYPE — throwaway. Drops land on the cursor; concentric rings expand across
 * the grid, bounce off the box edges as mirrored sources, and interfere.
 */

import { css, hex, lerp } from "../core/color.ts";
import { boxRect, cellCentre, cellX, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const TROUGH = hex("#12303c");
const WATER = hex("#3fb7c9");
const CREST = hex("#e8fbff");

const MAX_DROPS = 6;

interface Drop {
	x: number;
	y: number;
	age: number;
}

const effect: Effect = {
	id: "ripple",
	name: "Ripple",
	group: "fluid",
	blurb: "Drops land at the cursor; rings expand, reflect off the edges and interfere.",
	palette: { hot: WATER, peak: CREST },
	params: [
		{ key: "every", label: "drop every (s)", min: 0.3, max: 3, step: 0.1, value: 1.2 },
		{ key: "speed", label: "px/s", min: 40, max: 400, step: 10, value: 150 },
		{ key: "wavelength", label: "wavelength (px)", min: 8, max: 80, step: 2, value: 26 },
		{ key: "decay", label: "decay", min: 0.2, max: 3, step: 0.1, value: 0.9 },
	],
	create(): EffectInstance {
		const drops: Drop[] = [];
		let next = 0;

		/** Summed wave height at a point, including four edge mirrors. */
		const height = (px: number, py: number, f: Frame): number => {
			const rect = boxRect(f);
			const k = (Math.PI * 2) / (f.params.wavelength ?? 26);
			const c = f.params.speed ?? 150;
			const decay = f.params.decay ?? 0.9;
			let sum = 0;
			for (const d of drops) {
				const sources: Array<[number, number, number]> = [
					[d.x, d.y, 1],
					[2 * rect.x - d.x, d.y, 0.6],
					[2 * (rect.x + rect.w) - d.x, d.y, 0.6],
					[d.x, 2 * rect.y - d.y, 0.6],
					[d.x, 2 * (rect.y + rect.h) - d.y, 0.6],
				];
				const front = c * d.age;
				for (const [sx, sy, gain] of sources) {
					const dist = Math.hypot(px - sx, py - sy);
					if (dist > front) continue;
					const behind = front - dist;
					const env = Math.exp(-behind / (c * 0.55)) * Math.exp(-d.age * decay) / (1 + dist * 0.012);
					sum += gain * env * Math.sin(k * (dist - front));
				}
			}
			return sum;
		};

		return {
			update(f: Frame) {
				for (let i = drops.length - 1; i >= 0; i--) {
					const d = drops[i];
					d.age += f.dt;
					if (d.age > 4.5) drops.splice(i, 1);
				}
				if (!f.working) return;
				next -= f.dt;
				if (next > 0) return;
				next = f.params.every ?? 1.2;
				const cursor = f.box.cells.find((c) => c.kind === "cursor");
				if (!cursor) return;
				const { cx, cy } = cellCentre(f, cursor.x, cursor.y);
				drops.push({ x: cx, y: cy, age: 0 });
				if (drops.length > MAX_DROPS) drops.shift();
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (drops.length === 0) return null;
				const { cx, cy } = cellCentre(f, cell.x, cell.y);
				const h = height(cx, cy, f) * f.intensity;
				const level = Math.abs(h);
				if (level < 0.02) return null;
				const colour =
					h > 0
						? level > 0.55
							? lerp(WATER, CREST, Math.min(1, (level - 0.55) / 0.45))
							: lerp(cell.color, WATER, level / 0.55)
						: lerp(cell.color, TROUGH, Math.min(1, level * 1.4));
				return {
					color: colour,
					glow: h > 0 ? level * 12 : 0,
					dy: -h * f.metrics.ch * 0.25,
					scale: 1 + Math.max(0, h) * 0.25,
				};
			},

			// Blank interior cells are never drawn, so the water itself is painted here.
			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (drops.length === 0) return;
				for (const cell of f.box.cells) {
					if (cell.kind !== "interior") continue;
					const { cx, cy } = cellCentre(f, cell.x, cell.y);
					const h = height(cx, cy, f) * f.intensity;
					if (Math.abs(h) < 0.03) continue;
					g.fillStyle = css(h > 0 ? WATER : TROUGH, Math.min(0.5, Math.abs(h) * 0.55));
					g.fillRect(cellX(f, cell.x), cellY(f, cell.y), f.metrics.cw + 0.5, f.metrics.ch + 0.5);
				}
			},
		};
	},
};

export default effect;
