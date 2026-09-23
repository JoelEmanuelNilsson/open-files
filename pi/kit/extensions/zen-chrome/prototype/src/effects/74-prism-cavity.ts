/**
 * PROTOTYPE — throwaway. A beam bounces inside the box at a shallow angle and
 * sheds one wavelength at each wall, scattering it onto the outline.
 */

import { add, clamp, css, hsl, lerp, scale } from "../core/color.ts";
import { cellCentre, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
// Shed in refraction order — red leaves first, so the beam cools as it travels.
const WAVES: Rgb[] = [
	hsl(2, 1, 0.55),
	hsl(28, 1, 0.55),
	hsl(52, 1, 0.55),
	hsl(140, 1, 0.55),
	hsl(210, 1, 0.55),
	hsl(280, 1, 0.55),
];
const MAX_MARKS = 8;
const BEAM_STEPS = 10;
const MARK_STEPS = 20;

interface Lit {
	cx: number;
	cy: number;
	colour: Rgb;
	weight: number;
}

// Light off a line stays on the line: one stroke along the run of cells, three
// widths of it, rather than a radial gradient per cell pooling into a blob.
function strokeRun(g: CanvasRenderingContext2D, f: Frame, pts: Lit[], amount: number): void {
	if (pts.length < 2 || amount <= 0.005) return;
	const first = pts[0];
	const last = pts[pts.length - 1];
	const mid = pts[Math.floor(pts.length / 2)];
	g.lineCap = "butt";
	g.lineJoin = "round";
	for (const pass of [
		{ w: f.metrics.ch * 0.85, a: 0.05, blur: 0 },
		{ w: f.metrics.ch * 0.32, a: 0.12, blur: 0 },
		{ w: f.metrics.lw * 1.8, a: 0.5, blur: f.metrics.ch * 0.3 },
	]) {
		const grad = g.createLinearGradient(first.cx, first.cy, last.cx, last.cy);
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i];
			// Fade the ends: a wide stroke stopped square reads as a grey rectangle.
			const edge = Math.min(1, Math.min(i, pts.length - 1 - i) / 3);
			grad.addColorStop(clamp(i / (pts.length - 1), 0, 1), css(p.colour, pass.a * amount * p.weight * edge));
		}
		g.strokeStyle = grad;
		g.lineWidth = pass.w;
		g.shadowBlur = pass.blur;
		g.shadowColor = css(mid.colour, 0.5 * amount);
		g.beginPath();
		g.moveTo(first.cx, first.cy);
		for (const p of pts) g.lineTo(p.cx, p.cy);
		g.stroke();
	}
	g.shadowBlur = 0;
}

interface Mark {
	ring: number;
	colour: Rgb;
	age: number;
}

const effect: Effect = {
	id: "prism-cavity",
	name: "Cavity",
	group: "prism-mix",
	blurb: "A beam ricochets inside the box, dropping one colour of the spectrum at every wall it hits.",
	params: [
		{ key: "period", label: "period (s)", min: 1, max: 10, step: 0.1, value: 4.5 },
		{ key: "width", label: "band (cells)", min: 3, max: 30, step: 1, value: 12 },
		{ key: "speed", label: "beam (cells/s)", min: 8, max: 90, step: 1, value: 34 },
		{ key: "dispersion", label: "dispersion", min: 0, max: 1, step: 0.05, value: 0.8 },
		{ key: "decay", label: "decay (s)", min: 0.5, max: 6, step: 0.1, value: 2.6 },
		{ key: "beamAlpha", label: "beam alpha", min: 0.05, max: 0.6, step: 0.05, value: 0.22 },
	],
	create(): EffectInstance {
		let path: Array<{ x: number; y: number }> = [];
		let ringAt: Int32Array = new Int32Array(0);
		let cols = 0;
		const marks: Mark[] = [];
		let bx = 1;
		let by = 1;
		let vx = 1;
		let vy = 0.3;
		let shed = 0;
		let head = 0;

		const ensurePath = (f: Frame) => {
			if (path.length === f.box.ringLength && cols === f.box.cols) return;
			const next: Array<{ x: number; y: number }> = new Array(f.box.ringLength);
			const lookup = new Int32Array(f.box.cols * f.box.rows).fill(-1);
			for (const c of f.box.cells) {
				if (c.ringIndex < 0) continue;
				next[c.ringIndex] = { x: c.x, y: c.y };
				lookup[c.y * f.box.cols + c.x] = c.ringIndex;
			}
			path = next;
			ringAt = lookup;
			cols = f.box.cols;
			bx = 1;
			by = (f.box.rows - 1) / 2;
		};

		const ringOf = (f: Frame, x: number, y: number): number => {
			const cx = clamp(Math.round(x), 0, f.box.cols - 1);
			const cy = clamp(Math.round(y), 0, f.box.rows - 1);
			return ringAt[cy * f.box.cols + cx] ?? -1;
		};

		const drop = (f: Frame, x: number, y: number) => {
			const ring = ringOf(f, x, y);
			const colour = WAVES[shed];
			if (ring >= 0 && colour) {
				if (marks.length >= MAX_MARKS) marks.shift();
				marks.push({ ring, colour, age: 0 });
			}
			shed = (shed + 1) % WAVES.length;
		};

		/** Remaining wavelengths averaged: white at the start of a cycle, cooler after each shed. */
		const beamColour = (): Rgb => {
			let sum: Rgb = { r: 0, g: 0, b: 0 };
			let n = 0;
			for (let i = shed; i < WAVES.length; i++) {
				const w = WAVES[i];
				if (!w) continue;
				sum = add(sum, w);
				n++;
			}
			if (n === 0) return WHITE;
			return lerp(scale(sum, 1 / n), WHITE, 0.4);
		};

		return {
			update(f: Frame) {
				ensurePath(f);
				if (!f.working) {
					marks.length = 0;
					shed = 0;
					head = 0;
					bx = 1;
					by = (f.box.rows - 1) / 2;
					vx = 1;
					vy = 0.3;
					return;
				}
				head = ((f.since / (f.params.period ?? 4.5)) % 1) * f.box.ringLength;

				const loX = 1;
				const hiX = f.box.cols - 2;
				const loY = 1;
				const hiY = f.box.rows - 2;
				const speed = f.params.speed ?? 34;
				const step = speed * Math.min(f.dt, 0.05);
				bx += vx * step;
				by += vy * step * 0.34;
				for (let guard = 0; guard < 4; guard++) {
					if (bx < loX) {
						bx = loX + (loX - bx);
						vx = -vx;
						drop(f, 0, by);
					} else if (bx > hiX) {
						bx = hiX - (bx - hiX);
						vx = -vx;
						drop(f, f.box.cols - 1, by);
					} else if (by < loY) {
						by = loY + (loY - by);
						vy = -vy;
						drop(f, bx, 0);
					} else if (by > hiY) {
						by = hiY - (by - hiY);
						vy = -vy;
						drop(f, bx, f.box.rows - 1);
					} else break;
				}

				const decay = f.params.decay ?? 2.6;
				for (let i = marks.length - 1; i >= 0; i--) {
					const mark = marks[i];
					if (!mark) continue;
					mark.age += f.dt;
					if (mark.age > decay) marks.splice(i, 1);
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const ringDist = (target: number) => {
					let d = cell.ringIndex - target;
					d = ((d % len) + len) % len;
					if (d > len / 2) d -= len;
					return d;
				};

				let lit: Rgb = { r: 0, g: 0, b: 0 };
				let peak = 0;

				const half = Math.max(2, f.params.width ?? 12) / 2;
				const u = ringDist(head) / half;
				if (Math.abs(u) < 1) {
					const falloff = (1 - u * u) ** 0.8;
					lit = add(lit, scale(WHITE, falloff * f.intensity));
					peak = Math.max(peak, falloff);
				}

				const disp = (f.params.dispersion ?? 0.8) * f.intensity;
				const decay = f.params.decay ?? 2.6;
				if (disp > 0.01) {
					for (const mark of marks) {
						const d = ringDist(mark.ring) / half;
						if (Math.abs(d) >= 1) continue;
						const life = clamp(1 - mark.age / decay, 0, 1) ** 1.5;
						const falloff = (1 - d * d) ** 1.2 * life * disp;
						if (falloff <= 0.01) continue;
						lit = add(lit, scale(mark.colour, falloff * 1.2));
						peak = Math.max(peak, falloff);
					}
				}

				if (peak <= 0.01) return null;
				return { color: add(scale(cell.color, 1 - clamp(peak, 0, 1) * 0.8), lit), glow: peak * f.metrics.ch * 0.5 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || f.intensity <= 0.01 || path.length === 0) return;
				g.globalCompositeOperation = "lighter";

				const alpha = (f.params.beamAlpha ?? 0.22) * f.intensity;
				const trail = 5;
				const from = cellCentre(f, bx - vx * trail, by - vy * trail * 0.34);
				const to = cellCentre(f, bx, by);
				// The input row carries typed text, so the beam is dimmed where it crosses it.
				const rowTop = cellY(f, 1);
				const rowBottom = cellY(f, f.box.rows - 1);
				g.lineWidth = f.metrics.lw * 1.2;
				g.lineCap = "butt";
				const colour = beamColour();
				for (let s = 0; s < BEAM_STEPS; s++) {
					const k0 = s / BEAM_STEPS;
					const k1 = (s + 1) / BEAM_STEPS;
					const y0 = from.cy + (to.cy - from.cy) * k0;
					const y1 = from.cy + (to.cy - from.cy) * k1;
					const mid = (y0 + y1) / 2;
					const over = mid >= rowTop && mid <= rowBottom ? 0.3 : 1;
					g.strokeStyle = css(colour, alpha * k1 * over);
					g.beginPath();
					g.moveTo(from.cx + (to.cx - from.cx) * k0, y0);
					g.lineTo(from.cx + (to.cx - from.cx) * k1, y1);
					g.stroke();
				}

				const disp = (f.params.dispersion ?? 0.8) * f.intensity;
				const decay = f.params.decay ?? 2.6;
				if (disp <= 0.01) return;
				// A scatter mark is a short lit run of the outline centred on the wall it hit.
				const half = Math.max(2, f.params.width ?? 12) / 2;
				for (const mark of marks) {
					const life = clamp(1 - mark.age / decay, 0, 1) ** 1.5;
					if (life <= 0.05) continue;
					const pts: Lit[] = [];
					for (let i = 0; i < MARK_STEPS; i++) {
						const u = (i / (MARK_STEPS - 1)) * 2 - 1;
						const index = Math.round(mark.ring + u * half);
						const node = path[((index % path.length) + path.length) % path.length];
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						pts.push({ cx, cy, colour: mark.colour, weight: (1 - u * u) ** 1.1 });
					}
					strokeRun(g, f, pts, life * disp);
				}
			},
		};
	},
};

export default effect;
