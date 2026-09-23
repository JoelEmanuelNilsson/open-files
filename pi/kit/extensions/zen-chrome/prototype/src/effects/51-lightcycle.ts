/**
 * PROTOTYPE — throwaway. Two Tron cycles run the outline at different speeds,
 * burning trails that decay behind them and dropping bright markers at corners.
 */

import { clamp, css, hex, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const CYAN = hex("#3ff2ff");
const AMBER = hex("#ff9d29");
const WHITE = hex("#ffffff");

interface Cycle {
	colour: Rgb;
	pos: number;
	speed: number;
	base: number;
	offset: number;
	burst: number;
	cooldown: number;
	trail: number[];
	marks: number[];
}

function makeCycle(colour: Rgb, base: number, offset: number): Cycle {
	return { colour, pos: 0, speed: base, base, offset, burst: 0, cooldown: 1 + Math.random() * 3, trail: [], marks: [] };
}

const effect: Effect = {
	id: "lightcycle",
	name: "Light cycle",
	group: "motion",
	blurb: "Two light cycles race the outline, trails decaying behind them and corner markers lingering.",
	palette: { hot: CYAN, peak: WHITE },
	params: [
		{ key: "speed", label: "cells/s", min: 5, max: 140, step: 1, value: 42 },
		{ key: "decay", label: "trail decay", min: 0.3, max: 6, step: 0.1, value: 1.5 },
		{ key: "boost", label: "burst ×", min: 1, max: 8, step: 0.25, value: 4 },
	],
	create(): EffectInstance {
		const cycles = [makeCycle(CYAN, 1, 0), makeCycle(AMBER, 0.62, 0.4)];
		let len = 0;
		let corners: number[] = [];

		const fit = (f: Frame) => {
			if (len === f.box.ringLength) return;
			len = f.box.ringLength;
			corners = f.box.cells.filter((c) => c.kind === "corner").map((c) => c.ringIndex);
			for (const c of cycles) {
				c.trail = new Array<number>(len).fill(0);
				c.marks = new Array<number>(len).fill(0);
				c.pos = c.offset * len;
			}
		};

		return {
			update(f: Frame) {
				fit(f);
				const decay = f.params.decay ?? 1.5;
				const gain = f.working ? f.intensity : 0;
				const speed = (f.params.speed ?? 42) * (0.35 + 0.65 * f.intensity);

				for (const c of cycles) {
					const fade = Math.exp(-decay * f.dt);
					for (let i = 0; i < len; i++) {
						c.trail[i] = (c.trail[i] ?? 0) * fade;
						c.marks[i] = (c.marks[i] ?? 0) * Math.exp(-decay * 0.28 * f.dt);
					}
					if (gain <= 0) continue;

					c.cooldown -= f.dt;
					if (c.cooldown <= 0) {
						c.burst = 0.35 + Math.random() * 0.5;
						c.cooldown = 2 + Math.random() * 4;
					}
					// A burst is a hard kick that bleeds off, leaving the cycle coasting.
					const kick = c.burst > 0 ? 1 + ((f.params.boost ?? 4) - 1) * clamp(c.burst * 2.2, 0, 1) : 1;
					if (c.burst > 0) c.burst -= f.dt;
					c.speed = c.base * kick;

					const from = c.pos;
					c.pos = (c.pos + speed * c.speed * f.dt) % len;
					const steps = Math.max(1, Math.ceil((c.pos < from ? c.pos + len : c.pos) - from));
					for (let s = 0; s <= steps; s++) {
						const idx = Math.floor(from + ((c.pos < from ? c.pos + len : c.pos) - from) * (s / steps)) % len;
						c.trail[idx] = 1;
						if (corners.includes(idx)) c.marks[idx] = 1;
					}
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				let level = 0;
				let colour = cell.color;
				for (const c of cycles) {
					const v = Math.max(c.trail[cell.ringIndex] ?? 0, (c.marks[cell.ringIndex] ?? 0) * 0.85);
					if (v > level) {
						level = v;
						colour = c.colour;
					}
				}
				level *= f.intensity;
				if (level < 0.015) return null;
				const hot = level > 0.9 ? lerp(colour, WHITE, (level - 0.9) / 0.1) : colour;
				return {
					color: lerp(cell.color, hot, clamp(level * 1.5, 0, 1)),
					glow: level * 14,
					scale: 1 + level * 0.12,
				};
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working) return;
				g.globalCompositeOperation = "lighter";
				for (const c of cycles) {
					const idx = Math.floor(c.pos) % len;
					const cellAt = f.box.cells.find((k) => k.ringIndex === idx);
					if (!cellAt) continue;
					const { cx, cy } = cellCentre(f, cellAt.x, cellAt.y);
					const r = f.metrics.ch * (0.9 + 0.5 * clamp(c.speed / 4, 0, 1)) * f.intensity;
					const halo = g.createRadialGradient(cx, cy, 0, cx, cy, r);
					halo.addColorStop(0, css(WHITE, 0.75 * f.intensity));
					halo.addColorStop(0.4, css(c.colour, 0.35 * f.intensity));
					halo.addColorStop(1, css(c.colour, 0));
					g.fillStyle = halo;
					g.beginPath();
					g.arc(cx, cy, r, 0, Math.PI * 2);
					g.fill();
				}
			},
		};
	},
};

export default effect;
