/**
 * PROTOTYPE — throwaway. The outline holds the theme colour; a few scattered
 * cells at a time flare into a spectral colour and fade back, like dust in light.
 */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
const FLARE_STEPS = 16;

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

interface Flare {
	index: number;
	age: number;
	life: number;
	hue: number;
}

const MAX_FLARES = 6;

/** Flare brightness over its life: a fast strike, then a long fade. */
function envelopeOf(flare: Flare): number {
	const q = clamp(flare.age / flare.life, 0, 1);
	return q < 0.12 ? 0.35 + (q / 0.12) * 0.65 : ((1 - q) / 0.88) ** 1.4;
}

const effect: Effect = {
	id: "prism-shimmer",
	name: "Shimmer",
	group: "prism",
	blurb: "Scattered single cells briefly refract — a short spectral flare rises and fades, a handful at a time, with no travelling head.",
	params: [
		{ key: "rate", label: "flares/s", min: 0.2, max: 8, step: 0.1, value: 1.8 },
		{ key: "life", label: "flare (s)", min: 0.15, max: 1.5, step: 0.05, value: 0.55 },
		{ key: "sat", label: "saturation", min: 0, max: 1, step: 0.05, value: 0.55 },
		{ key: "depth", label: "tint", min: 0, max: 1, step: 0.05, value: 0.45 },
		{ key: "reach", label: "softness (cells)", min: 0.5, max: 4, step: 0.25, value: 1.5 },
	],
	create(): EffectInstance {
		let flares: Flare[] = [];
		// Starts full so the first working frame flares at once, with no dead opening.
		let pending = 1;
		let ringLength = 0;
		let path: Array<{ x: number; y: number }> = [];

		return {
			update(f: Frame) {
				// Ring length changes on resize: indices from the old ring no longer mean anything.
				if (f.box.ringLength !== ringLength) {
					ringLength = f.box.ringLength;
					flares = [];
					pending = 1;
					const next: Array<{ x: number; y: number }> = new Array(ringLength);
					for (const c of f.box.cells) if (c.ringIndex >= 0) next[c.ringIndex] = { x: c.x, y: c.y };
					path = next;
				}
				if (!f.working) {
					flares = [];
					pending = 1;
					return;
				}
				for (let i = flares.length - 1; i >= 0; i--) {
					const flare = flares[i];
					flare.age += f.dt;
					if (flare.age >= flare.life) flares.splice(i, 1);
				}
				if (ringLength <= 0) return;
				const life = f.params.life ?? 0.55;
				pending += (f.params.rate ?? 1.8) * f.intensity * f.dt;
				while (pending >= 1) {
					pending -= 1;
					if (flares.length >= MAX_FLARES) continue;
					flares.push({
						index: Math.floor(Math.random() * ringLength),
						age: 0,
						life: life * (0.7 + Math.random() * 0.6),
						hue: Math.random() * 360,
					});
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0 || flares.length === 0) return null;
				const reach = f.params.reach ?? 1.5;
				const half = ringLength / 2;

				let best = 0;
				let hue = 0;
				for (const flare of flares) {
					let d = cell.ringIndex - flare.index;
					if (d > half) d -= ringLength;
					if (d < -half) d += ringLength;
					const near = 1 - Math.abs(d) / reach;
					if (near <= 0) continue;
					const level = near ** 1.4 * envelopeOf(flare);
					if (level > best) {
						best = level;
						hue = flare.hue;
					}
				}
				if (best < 0.01) return null;

				const level = best * f.intensity * (f.params.depth ?? 0.45) * 1.7;
				// The theme colour is the ground; the flare is a deviation from it, white at its core.
				const tint = lerp(f.palette.hot, hsl(hue, clamp(f.params.sat ?? 0.55, 0, 1), 0.62), 0.85);
				const lit = lerp(tint, WHITE, best ** 2 * 0.55);
				return { color: lerp(cell.color, lit, clamp(level, 0, 1)), glow: best * f.intensity * f.metrics.ch * 0.4 };
			},

			// A single recoloured cell is too small to notice; each flare also lights a
			// short run of the line it sits on.
			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (flares.length === 0 || path.length === 0 || f.intensity <= 0.01) return;
				const reach = (f.params.reach ?? 1.5) + 1;
				g.globalCompositeOperation = "lighter";
				for (const flare of flares) {
					const envelope = envelopeOf(flare);
					if (envelope <= 0.02) continue;
					const colour = hsl(flare.hue, clamp(f.params.sat ?? 0.55, 0, 1), 0.62);
					const pts: Lit[] = [];
					for (let i = 0; i < FLARE_STEPS; i++) {
						const u = (i / (FLARE_STEPS - 1)) * 2 - 1;
						const index = Math.round(flare.index + u * reach);
						const node = path[((index % path.length) + path.length) % path.length];
						if (!node) continue;
						const { cx, cy } = cellCentre(f, node.x, node.y);
						pts.push({ cx, cy, colour, weight: (1 - u * u) ** 1.2 });
					}
					strokeRun(g, f, pts, envelope * f.intensity);
				}
			},
		};
	},
};

export default effect;
