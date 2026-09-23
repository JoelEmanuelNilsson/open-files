/**
 * PROTOTYPE — throwaway. The outline is a channel of liquid metal: a bead runs
 * clockwise, bulging the line with surface tension, dragging at the corners and
 * snapping round them.
 */

import { css, hex, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const MERCURY = hex("#9fb4c8");
const SHEEN = hex("#f2f8ff");
const SHADOW = hex("#2b3440");

interface Ring {
	cells: Cell[];
	corners: number[];
}

function ringOf(f: Frame): Ring {
	const cells: Cell[] = [];
	for (const cell of f.box.cells) if (cell.ringIndex >= 0) cells[cell.ringIndex] = cell;
	const corners: number[] = [];
	cells.forEach((cell, i) => {
		if (cell.kind === "corner") corners.push(i);
	});
	return { cells, corners };
}

/** 0 in open runs, 1 at a corner — how much the bead is dragging. */
function drag(index: number, ring: Ring, len: number, reach: number): number {
	let best = len;
	for (const c of ring.corners) {
		const d = Math.abs(index - c);
		best = Math.min(best, Math.min(d, len - d));
	}
	return Math.max(0, 1 - best / reach);
}

/** Unit vector pointing out of the box at a cell. */
function outward(cell: Cell, f: Frame): { ox: number; oy: number } {
	const ox = cell.x === 0 ? -1 : cell.x === f.box.cols - 1 ? 1 : 0;
	const oy = cell.y === 0 ? -1 : cell.y === f.box.rows - 1 ? 1 : 0;
	const m = Math.hypot(ox, oy) || 1;
	return { ox: ox / m, oy: oy / m };
}

const effect: Effect = {
	id: "mercury",
	name: "Mercury",
	group: "fluid",
	blurb: "A bead of liquid metal circulates the outline, swelling the line and snapping round corners.",
	palette: { hot: MERCURY, peak: SHEEN },
	params: [
		{ key: "speed", label: "cells/s", min: 4, max: 90, step: 1, value: 30 },
		{ key: "swell", label: "swell", min: 0, max: 1, step: 0.05, value: 0.6 },
		{ key: "length", label: "bead (cells)", min: 1, max: 14, step: 0.5, value: 4.5 },
	],
	create(): EffectInstance {
		let pos = 0;
		let fat = 0;

		return {
			update(f: Frame) {
				const ring = ringOf(f);
				const len = f.box.ringLength;
				const d = drag(Math.round(pos) % len, ring, len, 4);
				// Slow into the corner, then release faster than cruise on the way out.
				const gain = 1 - d * 0.78;
				const snapping = fat > d ? 1.55 : 1;
				fat += (d - fat) * Math.min(1, f.dt * 9);
				if (f.working) pos = (pos + (f.params.speed ?? 30) * gain * snapping * f.dt) % len;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const width = (f.params.length ?? 4.5) * (1 + fat * 0.9);
				let ahead = cell.ringIndex - pos;
				if (ahead > len / 2) ahead -= len;
				if (ahead < -len / 2) ahead += len;
				const head = Math.exp(-(ahead * ahead) / (2 * width * width));
				const film = 0.1 + 0.1 * Math.sin(cell.ringIndex * 0.7 - f.t * 1.2);
				const level = f.working ? head * f.intensity : film * 0.5;
				if (level < 0.02) return null;
				const colour = level > 0.6 ? lerp(MERCURY, SHEEN, (level - 0.6) / 0.4) : lerp(SHADOW, MERCURY, level / 0.6);
				const swell = (f.params.swell ?? 0.6) * head * f.intensity;
				const { ox, oy } = outward(cell, f);
				return {
					color: lerp(cell.color, colour, Math.min(1, level * 1.5)),
					scale: 1 + swell * 0.55,
					dx: ox * swell * f.metrics.cw * 0.35,
					dy: oy * swell * f.metrics.ch * 0.35,
					glow: level * 9,
				};
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working) return;
				const ring = ringOf(f);
				const len = f.box.ringLength;
				const a = ring.cells[Math.floor(pos) % len];
				const b = ring.cells[(Math.floor(pos) + 1) % len];
				if (!a || !b) return;
				const k = pos - Math.floor(pos);
				const pa = cellCentre(f, a.x, a.y);
				const pb = cellCentre(f, b.x, b.y);
				const cx = pa.cx + (pb.cx - pa.cx) * k;
				const cy = pa.cy + (pb.cy - pa.cy) * k;
				const r = f.metrics.ch * (0.9 + fat * 0.8) * (0.5 + f.intensity * 0.7);
				g.globalCompositeOperation = "lighter";
				const blob = g.createRadialGradient(cx - r * 0.25, cy - r * 0.3, 0, cx, cy, r);
				blob.addColorStop(0, css(SHEEN, 0.85 * f.intensity));
				blob.addColorStop(0.35, css(MERCURY, 0.4 * f.intensity));
				blob.addColorStop(1, css(MERCURY, 0));
				g.fillStyle = blob;
				g.beginPath();
				g.arc(cx, cy, r, 0, Math.PI * 2);
				g.fill();
			},
		};
	},
};

export default effect;
