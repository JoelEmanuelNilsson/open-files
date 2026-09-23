/**
 * PROTOTYPE — throwaway. A white head walks the outline dragging a tail that
 * disperses as it ages: white at the head, then yellow, orange, red, violet.
 */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
// Unwrapped so the ramp runs monotonically down through the spectrum instead of wrapping at 0.
const TAIL_HUES = [58, 40, 16, -8, -70];
const HAZE_STEPS = 28;

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

function tailHue(q: number): number {
	const k = clamp(q, 0, 1) * (TAIL_HUES.length - 1);
	const i = Math.min(TAIL_HUES.length - 2, Math.floor(k));
	const a = TAIL_HUES[i] ?? 0;
	const b = TAIL_HUES[i + 1] ?? a;
	return (((a + (b - a) * (k - i)) % 360) + 360) % 360;
}

const effect: Effect = {
	id: "prism-comet",
	name: "Comet",
	group: "prism-mix",
	blurb: "One white head runs the outline and its tail separates into a spectrum as it falls behind.",
	params: [
		{ key: "period", label: "period (s)", min: 1.5, max: 12, step: 0.1, value: 6 },
		{ key: "tail", label: "tail (cells)", min: 6, max: 90, step: 1, value: 42 },
		{ key: "head", label: "head (cells)", min: 1, max: 12, step: 1, value: 4 },
		{ key: "dispersion", label: "dispersion", min: 0, max: 1, step: 0.05, value: 0.85 },
		{ key: "haze", label: "haze", min: 0, max: 1, step: 0.05, value: 0.45 },
		{ key: "reverse", label: "reverse", min: 0, max: 1, step: 1, value: 0 },
	],
	create(): EffectInstance {
		let path: Array<{ x: number; y: number }> = [];
		let head = 0;

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
					head = 0;
					return;
				}
				const dir = (f.params.reverse ?? 0) >= 0.5 ? -1 : 1;
				const phase = ((((dir * f.since) / (f.params.period ?? 6)) % 1) + 1) % 1;
				head = phase * f.box.ringLength;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const tail = Math.max(2, f.params.tail ?? 42);
				const nose = Math.max(1, f.params.head ?? 4);
				const dir = (f.params.reverse ?? 0) >= 0.5 ? -1 : 1;

				let d = dir * (head - cell.ringIndex);
				d = ((d % len) + len) % len;
				if (d > len - nose) d -= len;
				if (d > tail) return null;

				const q = clamp(d / tail, 0, 1);
				const core = clamp(1 - Math.abs(d) / nose, 0, 1);
				const level = (d < 0 ? core : (1 - q) ** 1.3) * f.intensity;
				if (level <= 0.01) return null;

				const disp = f.params.dispersion ?? 0.85;
				const white = clamp(1 - q * disp * 1.5, 0, 1) ** 1.2;
				const lit = lerp(hsl(tailHue(q), 1, 0.55), WHITE, clamp(white + core * 0.8, 0, 1));
				return { color: lerp(cell.color, lit, clamp(level * 1.6, 0, 1)), glow: level * f.metrics.ch * 0.55 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				const haze = (f.params.haze ?? 0.45) * f.intensity;
				if (!f.working || haze <= 0.01 || path.length === 0) return;
				const tail = Math.max(2, f.params.tail ?? 42);
				const disp = f.params.dispersion ?? 0.85;
				const dir = (f.params.reverse ?? 0) >= 0.5 ? -1 : 1;
				g.globalCompositeOperation = "lighter";
				const pts: Lit[] = [];
				for (let i = 0; i < HAZE_STEPS; i++) {
					const q = i / (HAZE_STEPS - 1);
					const index = Math.round(head - dir * q * tail);
					const node = path[((index % path.length) + path.length) % path.length];
					if (!node) continue;
					const { cx, cy } = cellCentre(f, node.x, node.y);
					const white = clamp(1 - q * disp * 1.5, 0, 1);
					pts.push({ cx, cy, colour: lerp(hsl(tailHue(q), 1, 0.6), WHITE, white), weight: (1 - q) ** 1.5 });
				}
				strokeRun(g, f, pts, haze);
			},
		};
	},
};

export default effect;
