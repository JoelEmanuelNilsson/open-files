/** PROTOTYPE — throwaway. The prism band walks the outline; each corner is a vertex that fans it into wavelength chords. */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre, cellX, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
const WAVES = 9;
const CHORD_STEPS = 8;
const BAND_STEPS = 32;

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

interface Ray {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	hue: number;
	level: number;
}

interface Corner {
	x: number;
	y: number;
	ringIndex: number;
	dx: number;
	dy: number;
}

const effect: Effect = {
	id: "prism-vertex",
	name: "Vertex",
	group: "prism-mix",
	blurb: "The band walks the outline and refracts at every corner into a fan of wavelength chords.",
	params: [
		{ key: "period", label: "period (s)", min: 0.8, max: 8, step: 0.1, value: 3 },
		{ key: "width", label: "band (cells)", min: 3, max: 40, step: 1, value: 14 },
		{ key: "spread", label: "spectrum", min: 60, max: 360, step: 10, value: 260 },
		{ key: "burst", label: "vertex burst", min: 0, max: 1, step: 0.05, value: 0.5 },
		{ key: "dispersion", label: "dispersion (deg)", min: 5, max: 70, step: 1, value: 38 },
		{ key: "haze", label: "haze", min: 0, max: 1, step: 0.05, value: 0.5 },
	],
	create(): EffectInstance {
		let path: Array<{ x: number; y: number }> = [];
		let corners: Corner[] = [];
		let head = 0;
		const rays: Ray[] = [];
		const landings = new Map<number, { hue: number; level: number }>();

		const ensurePath = (f: Frame) => {
			if (path.length === f.box.ringLength) return;
			const next: Array<{ x: number; y: number }> = new Array(f.box.ringLength);
			for (const c of f.box.cells) if (c.ringIndex >= 0) next[c.ringIndex] = { x: c.x, y: c.y };
			path = next;
			const last = { x: f.box.cols - 1, y: f.box.rows - 1 };
			// Clockwise outgoing edge direction at each corner; rotating it inward gives the refracted fan.
			const wanted: Array<{ x: number; y: number; dx: number; dy: number }> = [
				{ x: 0, y: 0, dx: 1, dy: 0 },
				{ x: last.x, y: 0, dx: 0, dy: 1 },
				{ x: last.x, y: last.y, dx: -1, dy: 0 },
				{ x: 0, y: last.y, dx: 0, dy: -1 },
			];
			const built: Corner[] = [];
			for (const w of wanted) {
				const cell = f.box.cells.find((c) => c.x === w.x && c.y === w.y && c.ringIndex >= 0);
				if (cell) built.push({ x: w.x, y: w.y, ringIndex: cell.ringIndex, dx: w.dx, dy: w.dy });
			}
			corners = built;
		};

		const key = (x: number, y: number) => y * 4096 + x;

		return {
			update(f: Frame) {
				ensurePath(f);
				rays.length = 0;
				landings.clear();
				if (!f.working) {
					head = 0;
					return;
				}
				const len = f.box.ringLength;
				head = ((f.since / (f.params.period ?? 3)) % 1) * len;

				const burst = (f.params.burst ?? 0.5) * f.intensity;
				if (burst <= 0.01 || corners.length === 0) return;
				const spread = f.params.spread ?? 260;
				const deviation = ((f.params.dispersion ?? 38) * Math.PI) / 180;
				const trail = Math.max(4, (f.params.width ?? 14) * 1.6);

				const x0 = cellX(f, 0) + f.metrics.cw / 2;
				const x1 = cellX(f, f.box.cols - 1) + f.metrics.cw / 2;
				const y0 = cellY(f, 0) + f.metrics.ch / 2;
				const y1 = cellY(f, f.box.rows - 1) + f.metrics.ch / 2;

				for (const corner of corners) {
					const age = (((head - corner.ringIndex) % len) + len) % len;
					const level = Math.exp(-age / trail) * burst;
					if (level <= 0.02) continue;
					const origin = cellCentre(f, corner.x, corner.y);
					for (let w = 0; w < WAVES; w++) {
						const u = w / (WAVES - 1);
						// Red bends least, violet most: the deviation angle rises with u.
						const angle = 0.18 + deviation * (0.25 + 0.75 * u);
						const dx = corner.dx * Math.cos(angle) - corner.dy * Math.sin(angle);
						const dy = corner.dx * Math.sin(angle) + corner.dy * Math.cos(angle);

						let t = Number.POSITIVE_INFINITY;
						let axis: "x" | "y" = "x";
						if (Math.abs(dx) > 1e-6) {
							const tx = ((dx > 0 ? x1 : x0) - origin.cx) / dx;
							if (tx > 0 && tx < t) {
								t = tx;
								axis = "x";
							}
						}
						if (Math.abs(dy) > 1e-6) {
							const ty = ((dy > 0 ? y1 : y0) - origin.cy) / dy;
							if (ty > 0 && ty < t) {
								t = ty;
								axis = "y";
							}
						}
						if (!Number.isFinite(t)) continue;

						const ex = origin.cx + dx * t;
						const ey = origin.cy + dy * t;
						const hue = ((1 - u) * spread + 340) % 360;
						rays.push({ x0: origin.cx, y0: origin.cy, x1: ex, y1: ey, hue, level });

						let lx = clamp(Math.round((ex - f.metrics.bleed - f.metrics.cw / 2) / f.metrics.cw), 0, f.box.cols - 1);
						let ly = clamp(Math.round((ey - f.metrics.bleed - f.metrics.ch / 2) / f.metrics.ch), 0, f.box.rows - 1);
						if (axis === "x") lx = dx > 0 ? f.box.cols - 1 : 0;
						else ly = dy > 0 ? f.box.rows - 1 : 0;
						const prior = landings.get(key(lx, ly));
						if (!prior || prior.level < level) landings.set(key(lx, ly), { hue, level });
					}
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const width = f.params.width ?? 14;
				const spread = f.params.spread ?? 260;

				let d = cell.ringIndex - head;
				d = ((d % len) + len) % len;
				if (d > len / 2) d -= len;
				const u = d / (width / 2);

				if (Math.abs(u) < 1) {
					const falloff = (1 - u * u) ** 0.8;
					const colour = hsl(((u * 0.5 + 0.5) * spread + 340) % 360, 1, 0.55);
					const core = clamp(1 - Math.abs(u) * 3.2, 0, 1);
					const lit = lerp(colour, WHITE, core ** 1.5);
					const level = falloff * f.intensity;
					return { color: lerp(cell.color, lit, clamp(level * 1.5, 0, 1)), glow: level * f.metrics.ch * 0.5 };
				}

				const hit = landings.get(key(cell.x, cell.y));
				if (!hit) return null;
				const level = clamp(hit.level, 0, 1);
				return { color: lerp(cell.color, hsl(hit.hue, 1, 0.62), level), glow: level * f.metrics.ch * 0.4 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || f.intensity <= 0.01) return;
				g.globalCompositeOperation = "lighter";

				const haze = (f.params.haze ?? 0.5) * f.intensity;
				if (haze > 0.01 && path.length > 0) {
					const width = f.params.width ?? 14;
					const spread = f.params.spread ?? 260;
					const pts: Lit[] = [];
					for (let i = 0; i < BAND_STEPS; i++) {
						const u = (i / (BAND_STEPS - 1)) * 2 - 1;
						const index = Math.round(head + (u * width) / 2);
						const node = path[((index % path.length) + path.length) % path.length];
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						const colour = hsl(((u * 0.5 + 0.5) * spread + 340) % 360, 1, 0.6);
						pts.push({ cx, cy, colour, weight: (1 - u * u) ** 0.7 });
					}
					strokeRun(g, f, pts, haze);
				}

				if (rays.length === 0) return;
				// The input row carries typed text, so chords are dimmed where they cross it.
				const rowTop = cellY(f, 1);
				const rowBottom = cellY(f, 2);
				g.lineCap = "butt";
				g.lineWidth = f.metrics.lw;
				for (const ray of rays) {
					const colour = hsl(ray.hue, 1, 0.6);
					for (let s = 0; s < CHORD_STEPS; s++) {
						const k0 = s / CHORD_STEPS;
						const k1 = (s + 1) / CHORD_STEPS;
						const ya = ray.y0 + (ray.y1 - ray.y0) * k0;
						const yb = ray.y0 + (ray.y1 - ray.y0) * k1;
						const mid = (ya + yb) / 2;
						const over = mid >= rowTop && mid <= rowBottom ? 0.25 : 1;
						const fade = 1 - k0 * 0.35;
						g.strokeStyle = css(colour, ray.level * 0.34 * over * fade * f.intensity);
						g.beginPath();
						g.moveTo(ray.x0 + (ray.x1 - ray.x0) * k0, ya);
						g.lineTo(ray.x0 + (ray.x1 - ray.x0) * k1, yb);
						g.stroke();
					}
				}
			},
		};
	},
};

export default effect;
