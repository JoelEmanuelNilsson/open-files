/** PROTOTYPE — throwaway. The prism band sheds a continuous fan of wavelength chords across the interior as it travels. */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
const WAVES = 9;
const TRAILS = 3;
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
	id: "prism-fan",
	name: "Fan",
	group: "prism-mix",
	blurb: "The travelling band continuously sheds thin wavelength chords, filling the box with a sweeping moiré.",
	params: [
		{ key: "period", label: "period (s)", min: 0.8, max: 8, step: 0.1, value: 3.4 },
		{ key: "width", label: "band (cells)", min: 3, max: 40, step: 1, value: 14 },
		{ key: "spread", label: "spectrum", min: 60, max: 360, step: 10, value: 260 },
		{ key: "fan", label: "fan alpha", min: 0, max: 0.6, step: 0.02, value: 0.18 },
		{ key: "splay", label: "splay", min: 0.02, max: 0.5, step: 0.01, value: 0.22 },
		{ key: "haze", label: "haze", min: 0, max: 1, step: 0.05, value: 0.5 },
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
				head = ((f.since / (f.params.period ?? 3.4)) % 1) * f.box.ringLength;
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
				const width = f.params.width ?? 14;
				const spread = f.params.spread ?? 260;
				g.globalCompositeOperation = "lighter";

				const haze = (f.params.haze ?? 0.5) * f.intensity;
				if (haze > 0.01) {
					const pts: Lit[] = [];
					for (let i = 0; i < BAND_STEPS; i++) {
						const u = (i / (BAND_STEPS - 1)) * 2 - 1;
						const node = nodeAt(head + (u * width) / 2);
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						const colour = hsl(((u * 0.5 + 0.5) * spread + 340) % 360, 1, 0.6);
						pts.push({ cx, cy, colour, weight: (1 - u * u) ** 0.7 });
					}
					strokeRun(g, f, pts, haze);
				}

				const alpha = (f.params.fan ?? 0.18) * f.intensity;
				if (alpha <= 0.005) return;
				const splay = f.params.splay ?? 0.22;
				const len = path.length;
				// The input row carries typed text, so chords are dimmed where they cross it.
				const rowTop = cellY(f, 1);
				const rowBottom = cellY(f, 2);
				g.lineCap = "butt";
				g.lineWidth = f.metrics.lw * 0.8;

				for (let s = 0; s < TRAILS; s++) {
					const source = head - s * width * 0.5;
					const node = nodeAt(source);
					if (!node) continue;
					const from = cellCentre(f, node.x, node.y);
					const dim = 1 - s / (TRAILS + 1);
					for (let w = 0; w < WAVES; w++) {
						const u = w / (WAVES - 1);
						// Red deviates least, so it lands nearest the straight-across point.
						const target = nodeAt(source + len * (0.5 + splay * (u - 0.15)));
						if (!target) continue;
						const to = cellCentre(f, target.x, target.y);
						const colour = hsl(((1 - u) * spread + 340) % 360, 1, 0.6);
						for (let k = 0; k < CHORD_STEPS; k++) {
							const k0 = k / CHORD_STEPS;
							const k1 = (k + 1) / CHORD_STEPS;
							const ya = from.cy + (to.cy - from.cy) * k0;
							const yb = from.cy + (to.cy - from.cy) * k1;
							const mid = (ya + yb) / 2;
							const over = mid >= rowTop && mid <= rowBottom ? 0.25 : 1;
							g.strokeStyle = css(colour, alpha * dim * over);
							g.beginPath();
							g.moveTo(from.cx + (to.cx - from.cx) * k0, ya);
							g.lineTo(from.cx + (to.cx - from.cx) * k1, yb);
							g.stroke();
						}
					}
				}
			},
		};
	},
};

export default effect;
