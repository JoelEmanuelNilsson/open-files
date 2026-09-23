/**
 * PROTOTYPE — throwaway. The spectrum is quantised into facets: fixed runs of
 * cells each hold one flat hue and light as a unit, like a rotating cut gem.
 */

import { clamp, css, hsl, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

function hash(n: number): number {
	const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return s - Math.floor(s);
}

interface Facet {
	start: number;
	length: number;
	centre: number;
	hue: number;
}

const effect: Effect = {
	id: "prism-shatter",
	name: "Prism shatter",
	group: "prism",
	blurb: "The outline is cut into fixed facets; each holds one flat hue and lights whole, one specular flash at a time.",
	params: [
		{ key: "period", label: "lap (s)", min: 1, max: 10, step: 0.1, value: 4 },
		{ key: "arc", label: "lit arc (cells)", min: 4, max: 80, step: 1, value: 30 },
		{ key: "spread", label: "spectrum", min: 40, max: 360, step: 10, value: 240 },
		{ key: "flash", label: "flash (s)", min: 0.2, max: 4, step: 0.1, value: 1.1 },
		{ key: "gain", label: "gain", min: 0.2, max: 1.5, step: 0.05, value: 0.9 },
	],
	create(): EffectInstance {
		let ringLength = 0;
		let facets: Facet[] = [];
		let facetOf: number[] = [];
		let path: Array<{ x: number; y: number }> = [];
		let head = 0;

		const ensureFacets = (f: Frame) => {
			if (ringLength === f.box.ringLength) return;
			ringLength = f.box.ringLength;
			facets = [];
			facetOf = new Array(ringLength).fill(0);
			path = new Array(ringLength);
			for (const c of f.box.cells) if (c.ringIndex >= 0) path[c.ringIndex] = { x: c.x, y: c.y };
			let start = 0;
			// Seeded on ringLength alone, so the cut stays put frame to frame.
			while (start < ringLength) {
				const length = Math.min(3 + Math.floor(hash(ringLength + facets.length * 7.3) * 4), ringLength - start);
				const index = facets.length;
				facets.push({ start, length, centre: start + length / 2, hue: hash(ringLength * 0.37 + index * 2.11) });
				for (let i = start; i < start + length; i++) facetOf[i] = index;
				start += length;
			}
		};

		return {
			update(f: Frame) {
				ensureFacets(f);
				if (!f.working) {
					head = 0;
					return;
				}
				head = ((f.since / (f.params.period ?? 4)) % 1) * ringLength;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0 || facets.length === 0) return null;
				const facet = facets[facetOf[cell.ringIndex] ?? 0];
				if (!facet) return null;
				let d = facet.centre - head;
				if (d > ringLength / 2) d -= ringLength;
				if (d < -ringLength / 2) d += ringLength;
				const arc = Math.max(2, f.params.arc ?? 30) / 2;
				const level = clamp(1 - Math.abs(d) / arc, 0, 1) ** 1.3 * (f.params.gain ?? 0.9) * f.intensity;

				const flashPeriod = f.params.flash ?? 1.1;
				const tick = Math.floor(f.t / flashPeriod);
				const phase = f.t / flashPeriod - tick;
				const chosen = Math.floor(hash(tick * 3.7) * facets.length);
				const flash =
					chosen === facetOf[cell.ringIndex] && phase < 0.4 ? Math.sin((phase / 0.4) * Math.PI) ** 2 : 0;

				if (level <= 0.004 && flash <= 0.004) return null;
				const colour = hsl((facet.hue * (f.params.spread ?? 240) + 330) % 360, 0.8, 0.6);
				const lit = lerp(lerp(cell.color, colour, clamp(level * 1.6, 0, 1)), WHITE, clamp(level ** 3 * 0.5 + flash * f.intensity, 0, 1));
				return { color: lit, glow: (level + flash) * f.metrics.ch * 0.5 };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || facets.length === 0 || path.length === 0) return;
				const flashPeriod = f.params.flash ?? 1.1;
				const tick = Math.floor(f.t / flashPeriod);
				const phase = f.t / flashPeriod - tick;
				if (phase >= 0.4) return;
				const facet = facets[Math.floor(hash(tick * 3.7) * facets.length)];
				if (!facet) return;
				const strength = Math.sin((phase / 0.4) * Math.PI) ** 2 * f.intensity;

				// The specular flash belongs to the facet, so it is stroked over exactly
				// that run of cells — a round gradient at the facet's centre reads as a
				// smudge hanging next to the box rather than a lit edge.
				const pts: Array<{ cx: number; cy: number; u: number }> = [];
				for (let i = 0; i <= facet.length; i++) {
					const node = path[(facet.start + i) % path.length];
					if (!node) continue;
					const { cx, cy } = cellCentre(f, node.x, node.y);
					pts.push({ cx, cy, u: (i / facet.length) * 2 - 1 });
				}
				const first = pts[0];
				const last = pts[pts.length - 1];
				if (!first || !last || pts.length < 2) return;

				const hue = (facet.hue * (f.params.spread ?? 240) + 330) % 360;
				g.globalCompositeOperation = "lighter";
				g.lineCap = "butt";
				g.lineJoin = "round";
				for (const pass of [
					// The widest pass fades faster than the core, so a spent flash leaves no
					// grey smear hanging over the line.
					{ w: f.metrics.ch * 0.8, a: 0.16, colour: hsl(hue, 1, 0.6), curve: 2, blur: 0 },
					{ w: f.metrics.ch * 0.3, a: 0.28, colour: hsl(hue, 0.7, 0.75), curve: 1.4, blur: 0 },
					{ w: f.metrics.lw * 2.2, a: 0.8, colour: WHITE, curve: 1, blur: 0 },
				]) {
					const grad = g.createLinearGradient(first.cx, first.cy, last.cx, last.cy);
					for (const p of pts) {
						const falloff = (1 - p.u * p.u) ** 0.5;
						grad.addColorStop(clamp((p.u + 1) / 2, 0, 1), css(pass.colour, pass.a * strength ** pass.curve * falloff));
					}
					g.strokeStyle = grad;
					g.lineWidth = pass.w;
					g.shadowBlur = pass.blur;
					g.shadowColor = css(pass.colour, 0.3 * strength);
					g.beginPath();
					g.moveTo(first.cx, first.cy);
					for (const p of pts) g.lineTo(p.cx, p.cy);
					g.stroke();
				}
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
