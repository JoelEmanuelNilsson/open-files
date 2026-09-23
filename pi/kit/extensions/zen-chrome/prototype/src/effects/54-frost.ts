/**
 * PROTOTYPE — throwaway. Ice grows out of the four corners along the outline,
 * meets in the middle of each edge, holds, then thaws back from the meeting points.
 */

import { clamp, css, hex, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const ICE = hex("#9fdcff");
const RIME = hex("#eaf8ff");

const CRYSTALS = ["✦", "✧", "❄", "❅", "⁂", "·"];

function hash(n: number): number {
	const s = Math.sin(n * 78.233 + 12.9898) * 43758.5453;
	return s - Math.floor(s);
}

function smooth(edge: number, width: number, v: number): number {
	return clamp((v - edge) / width, 0, 1);
}

function ease(t: number): number {
	const k = clamp(t, 0, 1);
	return k * k * (3 - 2 * k);
}

function ringGap(a: number, b: number, len: number): number {
	const d = Math.abs(a - b) % len;
	return Math.min(d, len - d);
}

const effect: Effect = {
	id: "frost",
	name: "Frost",
	group: "motion",
	blurb: "Frost fronts crawl from the corners, sprout dendrites into the bleed, then thaw from the middle.",
	palette: { hot: ICE, peak: RIME },
	params: [
		{ key: "cycle", label: "cycle (s)", min: 3, max: 24, step: 0.5, value: 10 },
		{ key: "rough", label: "raggedness", min: 0, max: 6, step: 0.25, value: 2.5 },
		{ key: "crystals", label: "crystals", min: 0, max: 1, step: 0.05, value: 0.35 },
		{ key: "dendrite", label: "dendrites (px)", min: 0, max: 30, step: 1, value: 12 },
	],
	create(): EffectInstance {
		let corners: number[] = [];
		let mids: number[] = [];
		let len = 0;
		let gate = 0;

		const level = (ringIndex: number, f: Frame): number => {
			const p = ((f.since / (f.params.cycle ?? 10)) % 1 + 1) % 1;
			const span = len / 8 + 3;
			const grow = p < 0.5 ? ease(p / 0.5) * span : span;
			const melt = p > 0.62 ? ease((p - 0.62) / 0.38) * span : 0;
			const rough = (hash(ringIndex * 3.1) - 0.5) * (f.params.rough ?? 2.5);

			let dc = Infinity;
			for (const c of corners) dc = Math.min(dc, ringGap(ringIndex, c, len));
			let dm = Infinity;
			for (const m of mids) dm = Math.min(dm, ringGap(ringIndex, m, len));

			const frozen = smooth(0, 1.6, grow + rough - dc);
			const thawed = smooth(0, 1.6, melt + rough - dm);
			return clamp(frozen - thawed, 0, 1) * gate * f.intensity;
		};

		return {
			update(f: Frame) {
				if (len !== f.box.ringLength) {
					len = f.box.ringLength;
					corners = f.box.cells
						.filter((c) => c.kind === "corner")
						.map((c) => c.ringIndex)
						.sort((a, b) => a - b);
					mids = corners.map((c, i) => {
						const next = corners[(i + 1) % corners.length] ?? c;
						const forward = next > c ? next : next + len;
						return Math.round((c + forward) / 2) % len;
					});
				}
				const target = f.working ? 1 : 0;
				gate += (target - gate) * clamp(f.dt * (f.working ? 2.2 : 1.1), 0, 1);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				const v = level(cell.ringIndex, f);
				if (v < 0.02) return null;
				const colour = lerp(cell.color, v > 0.75 ? RIME : ICE, clamp(v * 1.4, 0, 1));
				const seed = hash(cell.ringIndex * 9.7);
				const crystal = v > 0.6 && seed < (f.params.crystals ?? 0.35);
				return {
					color: colour,
					glyph: crystal ? (CRYSTALS[Math.floor(hash(cell.ringIndex * 4.3) * CRYSTALS.length)] ?? "✦") : undefined,
					glow: v * 9,
					scale: crystal ? 0.85 + v * 0.25 : 1,
				};
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				const reach = (f.params.dendrite ?? 12) * f.intensity;
				if (reach <= 0 || gate < 0.02) return;
				g.lineCap = "round";
				for (const cell of f.box.cells) {
					if (cell.ringIndex < 0) continue;
					const v = level(cell.ringIndex, f);
					if (v < 0.5) continue;
					const seed = hash(cell.ringIndex * 1.7);
					if (seed > 0.55) continue;
					// Outward normal: which edge of the box the cell sits on.
					const nx = cell.x === 0 ? -1 : cell.x === f.box.cols - 1 ? 1 : 0;
					const ny = cell.y === 0 ? -1 : cell.y === f.box.rows - 1 ? 1 : 0;
					const { cx, cy } = cellCentre(f, cell.x, cell.y);
					const base = Math.atan2(ny, nx);
					const grown = (v - 0.5) / 0.5;
					g.strokeStyle = css(RIME, 0.5 * grown * gate);
					g.lineWidth = 1;
					for (let b = 0; b < 2; b++) {
						const a = base + (hash(cell.ringIndex * 5.3 + b) - 0.5) * 0.9;
						const l = reach * grown * (0.5 + hash(cell.ringIndex * 7.9 + b) * 0.8);
						const tipX = cx + Math.cos(a) * l;
						const tipY = cy + Math.sin(a) * l;
						g.beginPath();
						g.moveTo(cx + Math.cos(a) * f.metrics.ch * 0.35, cy + Math.sin(a) * f.metrics.ch * 0.35);
						g.lineTo(tipX, tipY);
						g.stroke();
						const branch = a + (b === 0 ? 0.9 : -0.9);
						const mx = cx + Math.cos(a) * l * 0.6;
						const my = cy + Math.sin(a) * l * 0.6;
						g.beginPath();
						g.moveTo(mx, my);
						g.lineTo(mx + Math.cos(branch) * l * 0.35, my + Math.sin(branch) * l * 0.35);
						g.stroke();
					}
				}
			},
		};
	},
};

export default effect;
