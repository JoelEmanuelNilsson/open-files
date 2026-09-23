/**
 * PROTOTYPE — throwaway. The band runs the outline as white, splits into
 * wavelength heads that race apart at their own speeds, then re-merges to white.
 */

import { add, clamp, css, hsl, lerp, scale } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
// Red runs fastest, violet slowest: index 0 gets the largest offset.
const WAVES: Rgb[] = [hsl(4, 1, 0.55), hsl(38, 1, 0.55), hsl(70, 1, 0.55), hsl(190, 1, 0.55), hsl(275, 1, 0.55)];
const HEAD_STEPS = 20;

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

const effect: Effect = {
	id: "prism-relay",
	name: "Relay",
	group: "prism-mix",
	blurb: "The white band splits into wavelength heads that spread along the outline and lap back into white.",
	params: [
		{ key: "period", label: "lap (s)", min: 1, max: 10, step: 0.1, value: 4 },
		{ key: "cycle", label: "split every (s)", min: 2, max: 16, step: 0.5, value: 7 },
		{ key: "split", label: "split for (s)", min: 0.6, max: 6, step: 0.1, value: 2.4 },
		{ key: "laps", label: "laps", min: 1, max: 3, step: 1, value: 1 },
		{ key: "width", label: "head (cells)", min: 3, max: 30, step: 1, value: 11 },
		{ key: "dispersion", label: "dispersion", min: 0, max: 1, step: 0.05, value: 1 },
	],
	create(): EffectInstance {
		let path: Array<{ x: number; y: number }> = [];
		const heads = new Float64Array(WAVES.length);
		let spread = 0;

		const ensurePath = (f: Frame) => {
			if (path.length === f.box.ringLength) return;
			const next: Array<{ x: number; y: number }> = new Array(f.box.ringLength);
			for (const c of f.box.cells) if (c.ringIndex >= 0) next[c.ringIndex] = { x: c.x, y: c.y };
			path = next;
		};

		return {
			update(f: Frame) {
				ensurePath(f);
				if (!f.working) {
					heads.fill(0);
					spread = 0;
					return;
				}
				const len = f.box.ringLength;
				const base = ((f.since / (f.params.period ?? 4)) % 1) * len;
				const cycle = Math.max(0.5, f.params.cycle ?? 7);
				const split = Math.min(Math.max(0.2, f.params.split ?? 2.4), cycle);
				const phase = f.since % cycle;
				// Whole laps, so the heads land back on each other exactly when the event ends.
				const laps = Math.max(1, Math.round(f.params.laps ?? 1));
				const p = phase < split ? phase / split : 0;
				const eased = p * p * (3 - 2 * p);
				spread = eased * laps * len;
				for (let i = 0; i < WAVES.length; i++) heads[i] = base + (WAVES.length - 1 - i) * spread;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const half = Math.max(2, f.params.width ?? 11) / 2;
				const tint = f.params.dispersion ?? 1;
				let lit: Rgb = { r: 0, g: 0, b: 0 };
				let peak = 0;
				for (let i = 0; i < WAVES.length; i++) {
					const wave = WAVES[i];
					if (!wave) continue;
					let d = cell.ringIndex - (heads[i] ?? 0);
					d = ((d % len) + len) % len;
					if (d > len / 2) d -= len;
					const u = d / half;
					if (Math.abs(u) >= 1) continue;
					const falloff = (1 - u * u) ** 1.1;
					lit = add(lit, scale(lerp(WHITE, wave, tint), falloff * 0.8 * f.intensity));
					peak = Math.max(peak, falloff);
				}
				if (peak <= 0.01) return null;
				return { color: add(scale(cell.color, 1 - clamp(peak, 0, 1) * 0.8), lit), glow: peak * f.metrics.ch * 0.5 * f.intensity };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || f.intensity <= 0.01 || path.length === 0) return;
				const tint = f.params.dispersion ?? 1;
				g.globalCompositeOperation = "lighter";
				const half = Math.max(2, f.params.width ?? 11) / 2;
				for (let i = 0; i < WAVES.length; i++) {
					const wave = WAVES[i];
					if (!wave) continue;
					const colour = lerp(WHITE, wave, tint);
					const pts: Lit[] = [];
					for (let s = 0; s < HEAD_STEPS; s++) {
						const u = (s / (HEAD_STEPS - 1)) * 2 - 1;
						const index = Math.round((heads[i] ?? 0) + u * half);
						const node = path[((index % path.length) + path.length) % path.length];
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						pts.push({ cx, cy, colour, weight: (1 - u * u) ** 1.1 });
					}
					strokeRun(g, f, pts, f.intensity);
				}
			},
		};
	},
};

export default effect;
