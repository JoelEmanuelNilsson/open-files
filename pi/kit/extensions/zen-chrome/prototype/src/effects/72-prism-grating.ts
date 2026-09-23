/** PROTOTYPE — throwaway. The prism band walks the outline; crossing the bottom rule it diffracts into discrete orders. */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre, cellX, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
const WAVES = 6;
const CHORD_STEPS = 6;
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

const effect: Effect = {
	id: "prism-grating",
	name: "Grating",
	group: "prism-mix",
	blurb: "The bottom rule acts as a diffraction grating, throwing discrete spectral orders up into the box.",
	params: [
		{ key: "period", label: "period (s)", min: 0.8, max: 8, step: 0.1, value: 3.2 },
		{ key: "width", label: "band (cells)", min: 3, max: 40, step: 1, value: 14 },
		{ key: "spread", label: "spectrum", min: 60, max: 360, step: 10, value: 260 },
		{ key: "orders", label: "order alpha", min: 0, max: 1, step: 0.05, value: 0.45 },
		{ key: "angle", label: "order angle", min: 5, max: 45, step: 1, value: 22 },
		{ key: "count", label: "orders", min: 1, max: 3, step: 1, value: 2 },
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

		const nodeAt = (index: number) => {
			if (path.length === 0) return undefined;
			const i = Math.round(index);
			return path[((i % path.length) + path.length) % path.length];
		};

		return {
			update(f: Frame) {
				ensurePath(f);
				if (!f.working) {
					head = 0;
					return;
				}
				head = ((f.since / (f.params.period ?? 3.2)) % 1) * f.box.ringLength;
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
				if (Math.abs(u) >= 1) return null;
				const falloff = (1 - u * u) ** 0.8;
				const colour = hsl(((u * 0.5 + 0.5) * spread + 340) % 360, 1, 0.55);
				const core = clamp(1 - Math.abs(u) * 3.2, 0, 1);
				const lit = lerp(colour, WHITE, core ** 1.5);
				const level = falloff * f.intensity;
				return { color: lerp(cell.color, lit, clamp(level * 1.5, 0, 1)), glow: level * f.metrics.ch * 0.5 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || f.intensity <= 0.01 || path.length === 0) return;
				const node = nodeAt(head);
				if (!node) return;
				const spectrum = f.params.spread ?? 260;
				const band = f.params.width ?? 14;

				g.globalCompositeOperation = "lighter";
				const pts: Lit[] = [];
				for (let i = 0; i < BAND_STEPS; i++) {
					const u = (i / (BAND_STEPS - 1)) * 2 - 1;
					const n = nodeAt(head + (u * band) / 2);
					if (!n) continue;
					const { cx, cy } = cellCentre(f, n.x, n.y);
					pts.push({ cx, cy, colour: hsl(((u * 0.5 + 0.5) * spectrum + 340) % 360, 1, 0.6), weight: (1 - u * u) ** 0.7 });
				}
				strokeRun(g, f, pts, 0.5 * f.intensity);

				const alpha = (f.params.orders ?? 0.45) * f.intensity;
				if (alpha <= 0.005 || node.y !== f.box.rows - 1) return;

				const source = cellCentre(f, node.x, node.y);
				const left = cellX(f, 0) + f.metrics.cw / 2;
				const right = cellX(f, f.box.cols - 1) + f.metrics.cw / 2;
				const top = cellY(f, 0) + f.metrics.ch / 2;
				// The input row carries typed text, so the orders are dimmed where they cross it.
				const rowTop = cellY(f, 1);
				const rowBottom = cellY(f, 2);

				const base = ((f.params.angle ?? 22) * Math.PI) / 180;
				const count = Math.max(1, Math.round(f.params.count ?? 2));
				const spread = f.params.spread ?? 260;

				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";

				const beam = (angle: number, colour: { r: number; g: number; b: number }, a: number, wide: number) => {
					const dx = Math.sin(angle);
					const dy = -Math.cos(angle);
					let t = (top - source.cy) / dy;
					if (Math.abs(dx) > 1e-6) {
						const tx = ((dx > 0 ? right : left) - source.cx) / dx;
						if (tx > 0 && tx < t) t = tx;
					}
					if (!(t > 0) || !Number.isFinite(t)) return;
					g.lineWidth = wide;
					for (let k = 0; k < CHORD_STEPS; k++) {
						const k0 = k / CHORD_STEPS;
						const k1 = (k + 1) / CHORD_STEPS;
						const ya = source.cy + dy * t * k0;
						const yb = source.cy + dy * t * k1;
						const mid = (ya + yb) / 2;
						const over = mid >= rowTop && mid <= rowBottom ? 0.25 : 1;
						g.strokeStyle = css(colour, a * over * (1 - k0 * 0.55));
						g.beginPath();
						g.moveTo(source.cx + dx * t * k0, ya);
						g.lineTo(source.cx + dx * t * k1, yb);
						g.stroke();
					}
				};

				beam(0, WHITE, alpha * 0.9, f.metrics.lw * 1.5);
				for (let m = 1; m <= count; m++) {
					for (const sign of [-1, 1]) {
						for (let w = 0; w < WAVES; w++) {
							const u = w / (WAVES - 1);
							// sinθ ∝ mλ: red, the longest wavelength, sits at the wide end of each order.
							const factor = 1.35 - 0.55 * u;
							const angle = sign * base * m * factor;
							const colour = hsl(((1 - u) * spread + 340) % 360, 1, 0.6);
							beam(angle, colour, (alpha * 0.7) / m, f.metrics.lw);
						}
					}
				}
			},
		};
	},
};

export default effect;
