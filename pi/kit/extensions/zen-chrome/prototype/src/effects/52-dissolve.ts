/**
 * PROTOTYPE — throwaway. A travelling window of outline characters detaches from
 * the grid, tumbles out into the bleed, and settles back into its exact cell.
 */

import { clamp, css, lerp } from "../core/color.ts";
import { boxRect, cellX, cellY } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

interface Mote {
	ringIndex: number;
	glyph: string;
	x: number;
	y: number;
	dirX: number;
	dirY: number;
	dist: number;
	spin: number;
	life: number;
	span: number;
}

/** Out and back on one smooth arc, so a mote always lands exactly where it left. */
function excursion(t: number): number {
	return Math.sin(Math.PI * clamp(t, 0, 1)) ** 1.15;
}

const effect: Effect = {
	id: "dissolve",
	name: "Dissolve",
	group: "motion",
	blurb: "Outline glyphs peel off into the bleed, tumbling and fading, then reassemble in place.",
	params: [
		{ key: "travel", label: "cells/s", min: 2, max: 60, step: 1, value: 16 },
		{ key: "throw", label: "throw (px)", min: 4, max: 60, step: 1, value: 22 },
		{ key: "span", label: "away (s)", min: 0.4, max: 3, step: 0.1, value: 1.2 },
		{ key: "spin", label: "tumble", min: 0, max: 8, step: 0.25, value: 3 },
	],
	create(): EffectInstance {
		const motes: Mote[] = [];
		const detached = new Set<number>();
		let head = 0;

		return {
			update(f: Frame) {
				const len = f.box.ringLength;
				const rect = boxRect(f);
				const midX = rect.x + rect.w / 2;
				const midY = rect.y + rect.h / 2;

				for (let i = motes.length - 1; i >= 0; i--) {
					const m = motes[i] as Mote;
					m.life += f.dt;
					if (m.life >= m.span) {
						detached.delete(m.ringIndex);
						motes.splice(i, 1);
					}
				}

				if (!f.working) return;
				const before = head;
				head = (head + (f.params.travel ?? 16) * (0.4 + 0.6 * f.intensity) * f.dt) % len;
				const crossed = Math.floor((head < before ? head + len : head)) - Math.floor(before);
				for (let s = 1; s <= crossed; s++) {
					const idx = (Math.floor(before) + s) % len;
					if (detached.has(idx)) continue;
					const cell = f.box.cells.find((c) => c.ringIndex === idx);
					if (!cell || cell.glyph === " ") continue;
					const x = cellX(f, cell.x);
					const y = cellY(f, cell.y);
					let dx = x + f.metrics.cw / 2 - midX;
					let dy = y + f.metrics.ch / 2 - midY;
					const mag = Math.hypot(dx, dy) || 1;
					dx = dx / mag + (Math.random() - 0.5) * 0.5;
					dy = dy / mag + (Math.random() - 0.5) * 0.5;
					detached.add(idx);
					motes.push({
						ringIndex: idx,
						glyph: cell.glyph,
						x,
						y,
						dirX: dx,
						dirY: dy,
						dist: (f.params.throw ?? 22) * (0.4 + Math.random()),
						spin: (Math.random() - 0.5) * 2 * (f.params.spin ?? 3),
						life: 0,
						span: (f.params.span ?? 1.2) * (0.7 + Math.random() * 0.6),
					});
				}
			},

			cell(cell: Cell, _f: Frame): CellStyle | null {
				return cell.ringIndex >= 0 && detached.has(cell.ringIndex) ? { alpha: 0 } : null;
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				g.font = f.metrics.font;
				g.textAlign = "left";
				g.textBaseline = "alphabetic";
				for (const m of motes) {
					const t = m.life / m.span;
					const e = excursion(t);
					const px = m.x + m.dirX * m.dist * e;
					const py = m.y + m.dirY * m.dist * e;
					const colour = lerp(f.palette.base, f.palette.hot, e);
					g.save();
					g.globalAlpha = 1 - 0.6 * e;
					g.translate(px + f.metrics.cw / 2, py + f.metrics.ch / 2);
					g.rotate(m.spin * e);
					g.scale(1 - 0.25 * e, 1 - 0.25 * e);
					g.fillStyle = css(colour);
					g.shadowBlur = 8 * e * f.intensity;
					g.shadowColor = css(f.palette.hot);
					g.fillText(m.glyph, -f.metrics.cw / 2, -f.metrics.ch / 2 + f.metrics.baseline);
					g.restore();
				}
			},
		};
	},
};

export default effect;
