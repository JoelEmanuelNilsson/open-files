/**
 * PROTOTYPE — throwaway. A white beam crosses the box interior, enters and
 * exits at two points travelling along the outline, and sprays a spectral fan
 * outward where it leaves the glass.
 */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const WHITE = { r: 255, g: 255, b: 255 };
const CHORD_STEPS = 10;

interface Node {
	x: number;
	y: number;
	nx: number;
	ny: number;
}

const effect: Effect = {
	id: "prism-beam",
	name: "Beam",
	group: "prism",
	blurb: "One ray crosses the interior and disperses into a fan where it exits the outline.",
	params: [
		{ key: "period", label: "period (s)", min: 1, max: 10, step: 0.1, value: 4.2 },
		{ key: "chord", label: "chord", min: 0.15, max: 0.85, step: 0.01, value: 0.42 },
		{ key: "beam", label: "beam alpha", min: 0.05, max: 1, step: 0.05, value: 0.4 },
		{ key: "fan", label: "fan (deg)", min: 10, max: 120, step: 5, value: 55 },
		{ key: "reach", label: "reach", min: 0.2, max: 1.6, step: 0.05, value: 1 },
	],
	create(): EffectInstance {
		let path: Node[] = [];
		let entry = 0;
		let exit = 0;

		const ensurePath = (f: Frame) => {
			if (path.length === f.box.ringLength) return;
			const next: Node[] = new Array(f.box.ringLength);
			for (const c of f.box.cells) {
				if (c.ringIndex < 0) continue;
				let nx = c.x === 0 ? -1 : c.x === f.box.cols - 1 ? 1 : 0;
				let ny = c.y === 0 ? -1 : c.y === f.box.rows - 1 ? 1 : 0;
				if (nx !== 0 && ny !== 0) {
					nx *= Math.SQRT1_2;
					ny *= Math.SQRT1_2;
				}
				if (nx === 0 && ny === 0) ny = -1;
				next[c.ringIndex] = { x: c.x, y: c.y, nx, ny };
			}
			path = next;
		};

		const nodeAt = (index: number): Node | undefined => {
			if (path.length === 0) return undefined;
			const i = Math.round(index);
			return path[((i % path.length) + path.length) % path.length];
		};

		return {
			update(f: Frame) {
				ensurePath(f);
				if (!f.working) {
					entry = 0;
					exit = 0;
					return;
				}
				const len = f.box.ringLength;
				const chord = (f.params.chord ?? 0.42) + Math.sin(f.since * 0.37) * 0.06;
				entry = ((f.since / (f.params.period ?? 4.2)) % 1) * len;
				exit = entry + chord * len;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				const near = (target: number) => {
					let d = cell.ringIndex - target;
					d = ((d % len) + len) % len;
					if (d > len / 2) d -= len;
					return clamp(1 - Math.abs(d) / 4, 0, 1);
				};
				const inHeat = near(entry);
				const outHeat = near(exit);
				const heat = Math.max(inHeat, outHeat);
				if (heat <= 0.01) return null;
				const tint = outHeat > inHeat ? hsl((f.t * 40) % 360, 1, 0.65) : WHITE;
				const level = heat ** 0.7 * f.intensity;
				return { color: lerp(cell.color, lerp(tint, WHITE, 0.55), level), glow: level * f.metrics.ch * 0.6 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				const a = nodeAt(entry);
				const b = nodeAt(exit);
				if (!f.working || !a || !b || f.intensity <= 0.01) return;
				const from = cellCentre(f, a.x, a.y);
				const to = cellCentre(f, b.x, b.y);
				const alpha = (f.params.beam ?? 0.4) * f.intensity;
				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";
				g.lineJoin = "round";

				// The input row carries typed text; the beam is dimmed there so it stays
				// legible. One stroke with a gradient, because ten separately stroked
				// segments show their seams as a dotted line under additive blending.
				const rowTop = cellY(f, 1);
				const rowBottom = cellY(f, 2);
				for (const pass of [
					{ w: f.metrics.ch * 0.5, a: 0.18, blur: f.metrics.ch * 0.4 },
					{ w: f.metrics.lw * 1.6, a: 1, blur: 0 },
				]) {
					const beam = g.createLinearGradient(from.cx, from.cy, to.cx, to.cy);
					for (let s = 0; s <= CHORD_STEPS; s++) {
						const k = s / CHORD_STEPS;
						const y = from.cy + (to.cy - from.cy) * k;
						const over = y >= rowTop && y <= rowBottom ? 0.22 : 1;
						beam.addColorStop(k, css(WHITE, alpha * pass.a * over));
					}
					g.strokeStyle = beam;
					g.lineWidth = pass.w;
					g.shadowBlur = pass.blur;
					g.shadowColor = css(WHITE, 0.25 * alpha);
					g.beginPath();
					g.moveTo(from.cx, from.cy);
					g.lineTo(to.cx, to.cy);
					g.stroke();
				}
				g.shadowBlur = 0;

				const dx = to.cx - from.cx;
				const dy = to.cy - from.cy;
				const travel = Math.atan2(dy, dx);
				const outward = Math.atan2(b.ny, b.nx);
				// Refracted rays leave between the beam's heading and the surface normal.
				const centre = travel + (((outward - travel + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.6;
				const spread = ((f.params.fan ?? 55) * Math.PI) / 180;
				const reach = (f.params.reach ?? 1) * f.metrics.bleed * 1.6;
				const blades = 9;
				for (let i = 0; i < blades; i++) {
					const u = (i / (blades - 1)) * 2 - 1;
					const angle = centre + (u * spread) / 2;
					const colour = hsl(((u * 0.5 + 0.5) * 280 + 335) % 360, 1, 0.6);
					const ex = to.cx + Math.cos(angle) * reach;
					const ey = to.cy + Math.sin(angle) * reach;
					const grad = g.createLinearGradient(to.cx, to.cy, ex, ey);
					grad.addColorStop(0, css(WHITE, 0.55 * f.intensity));
					grad.addColorStop(0.2, css(colour, 0.45 * f.intensity));
					grad.addColorStop(1, css(colour, 0));
					g.strokeStyle = grad;
					g.lineWidth = f.metrics.lw * 1.4;
					g.beginPath();
					g.moveTo(to.cx, to.cy);
					g.lineTo(ex, ey);
					g.stroke();
				}

				// The exit point flares along the outline it is leaving, so the hot spot
				// stays a lit stretch of line instead of a round halo over the box.
				const flare: Array<{ cx: number; cy: number; u: number }> = [];
				for (let s = 0; s < 12; s++) {
					const u = (s / 11) * 2 - 1;
					const node = nodeAt(exit + u * 5);
					if (!node) continue;
					const p = cellCentre(f, node.x, node.y);
					flare.push({ cx: p.cx, cy: p.cy, u });
				}
				const fFirst = flare[0];
				const fLast = flare[flare.length - 1];
				if (!fFirst || !fLast || flare.length < 2) return;
				for (const pass of [
					{ w: f.metrics.ch * 0.8, a: 0.16, blur: f.metrics.ch * 0.5 },
					{ w: f.metrics.lw * 2.2, a: 0.5, blur: 0 },
				]) {
					const grad = g.createLinearGradient(fFirst.cx, fFirst.cy, fLast.cx, fLast.cy);
					for (const p of flare) {
						grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(WHITE, pass.a * f.intensity * (1 - p.u * p.u) ** 1.2));
					}
					g.strokeStyle = grad;
					g.lineWidth = pass.w;
					g.shadowBlur = pass.blur;
					g.shadowColor = css(WHITE, 0.3 * f.intensity);
					g.beginPath();
					g.moveTo(fFirst.cx, fFirst.cy);
					for (const p of flare) g.lineTo(p.cx, p.cy);
					g.stroke();
				}
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
