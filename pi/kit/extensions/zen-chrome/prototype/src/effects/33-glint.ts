/**
 * PROTOTYPE — throwaway. Brushed metal outline: an anisotropic specular streak
 * slides along it, with a trailing second highlight and a dark rest between passes.
 */

import { clamp, css, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame, Rgb } from "../core/types.ts";

const STEEL: Rgb = { r: 62, g: 66, b: 74 };
const SHEEN: Rgb = { r: 255, g: 252, b: 238 };

function hash(n: number): number {
	const s = Math.sin(n * 91.7) * 43758.5453;
	return s - Math.floor(s);
}

/** 0 while the metal rests, 0..1 as one pass crosses the outline. */
function pass(since: number, period: number, sweep: number): number {
	const phase = (since / period) % 1;
	const active = sweep / period;
	return phase < active ? phase / active : -1;
}

const effect: Effect = {
	id: "glint",
	name: "Glint",
	group: "light",
	blurb: "A long, narrow specular smear slides along brushed metal, then the metal rests dark.",
	params: [
		{ key: "period", label: "period (s)", min: 1, max: 10, step: 0.1, value: 3.6 },
		{ key: "sweep", label: "sweep (s)", min: 0.3, max: 4, step: 0.1, value: 1.1 },
		{ key: "streak", label: "streak (cells)", min: 4, max: 60, step: 1, value: 26 },
		{ key: "brush", label: "brush", min: 0, max: 1, step: 0.05, value: 0.4 },
	],
	create(): EffectInstance {
		let path: Array<{ x: number; y: number }> = [];
		let head = -1;

		const ensurePath = (f: Frame) => {
			if (path.length === f.box.ringLength) return;
			const next: Array<{ x: number; y: number }> = new Array(f.box.ringLength);
			for (const c of f.box.cells) if (c.ringIndex >= 0) next[c.ringIndex] = { x: c.x, y: c.y };
			path = next;
		};

		const level = (ringIndex: number, f: Frame): number => {
			if (head < 0) return 0;
			const len = f.box.ringLength;
			const streak = f.params.streak ?? 26;
			const at = (centre: number, gain: number) => {
				let d = ringIndex - centre;
				if (d > len / 2) d -= len;
				if (d < -len / 2) d += len;
				const u = d / (streak / 2);
				return Math.abs(u) >= 1 ? 0 : (1 - u * u) ** 2 * gain;
			};
			return clamp(at(head, 1) + at(head - streak * 0.9, 0.35), 0, 1);
		};

		return {
			update(f: Frame) {
				ensurePath(f);
				if (!f.working) {
					head = -1;
					return;
				}
				const p = pass(f.since, f.params.period ?? 3.6, Math.min(f.params.sweep ?? 1.1, f.params.period ?? 3.6));
				head = p < 0 ? -1 : (p * 1.3 - 0.15) * f.box.ringLength;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				const rest = lerp(STEEL, cell.color, 0.35);
				if (!f.working) return { color: rest };
				const spec = level(cell.ringIndex, f) * f.intensity;
				const brush =
					cell.kind === "rule" ? (f.params.brush ?? 0.4) * (hash(cell.x * 3.1 + cell.y * 17.3) - 0.5) * 0.5 : 0;
				const colour = lerp(rest, SHEEN, clamp(spec * 1.2 + brush * 0.4, 0, 1));
				return { color: colour, glow: spec * 10, alpha: clamp(0.62 + spec * 0.38 + brush, 0.3, 1) };
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working || head < 0 || path.length === 0) return;
				const streak = f.params.streak ?? 26;
				g.globalCompositeOperation = "lighter";
				const blob = (centre: number, gain: number) => {
					const node = path[((Math.round(centre) % path.length) + path.length) % path.length];
					const ahead = path[((Math.round(centre + 2) % path.length) + path.length) % path.length];
					if (!node || !ahead) return;
					const { cx, cy } = cellCentre(f, node.x, node.y);
					const angle = Math.atan2(ahead.y - node.y, ahead.x - node.x);
					const along = (streak * f.metrics.cw) / 2;
					const across = f.metrics.ch * 0.8;
					g.save();
					g.translate(cx, cy);
					g.rotate(angle);
					g.scale(along, across);
					const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
					grad.addColorStop(0, css(SHEEN, 0.34 * gain * f.intensity));
					grad.addColorStop(0.45, css(SHEEN, 0.1 * gain * f.intensity));
					grad.addColorStop(1, css(SHEEN, 0));
					g.fillStyle = grad;
					g.beginPath();
					g.arc(0, 0, 1, 0, Math.PI * 2);
					g.fill();
					g.restore();
				};
				blob(head, 1);
				blob(head - streak * 0.9, 0.4);
			},
		};
	},
};

export default effect;
