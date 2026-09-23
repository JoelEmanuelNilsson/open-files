/**
 * PROTOTYPE — throwaway. The outline is a PCB trace: several pulses of current
 * run it at different speeds, and at corners and label edges right-angled spurs
 * branch into the bleed to a solder pad that lights as the pulse goes by.
 */

import { clamp, css, hex, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const TRACE = hex("#1f4a3a");
const CURRENT = hex("#43ffa8");
const PAD = hex("#eaffe0");

interface Spur {
	ring: number;
	pts: Array<{ x: number; y: number }>;
	lit: number;
}

interface Pulse {
	pos: number;
	speed: number;
}

/** Grid cell at a position on the outline path, matching geometry.ts's clockwise order. */
function ringCell(f: Frame, index: number): { x: number; y: number } {
	const { cols, rows, ringLength } = f.box;
	let i = ((Math.round(index) % ringLength) + ringLength) % ringLength;
	if (i < cols) return { x: i, y: 0 };
	i -= cols;
	const side = rows - 2;
	if (i < side) return { x: cols - 1, y: i + 1 };
	i -= side;
	if (i < cols) return { x: cols - 1 - i, y: rows - 1 };
	i -= cols;
	return { x: 0, y: rows - 2 - i };
}

function ringGap(a: number, b: number, len: number): number {
	const d = Math.abs(a - b) % len;
	return Math.min(d, len - d);
}

const effect: Effect = {
	id: "circuit",
	name: "Circuit trace",
	group: "energy",
	blurb: "Current runs the outline and branches down right-angled spurs to solder pads.",
	palette: { hot: CURRENT, peak: PAD },
	params: [
		{ key: "pulses", label: "pulses", min: 1, max: 8, step: 1, value: 4 },
		{ key: "speed", label: "speed (cells/s)", min: 5, max: 160, step: 5, value: 45 },
		{ key: "tail", label: "tail", min: 1, max: 30, step: 1, value: 10 },
		{ key: "spur", label: "spur length", min: 0.2, max: 1, step: 0.05, value: 0.6 },
	],
	create(): EffectInstance {
		let spurs: Spur[] = [];
		let pulses: Pulse[] = [];
		let built = 0;

		const build = (f: Frame) => {
			built = f.box.ringLength;
			const anchors = new Set<number>();
			const { cols, rows } = f.box;
			for (const c of [0, cols - 1, cols + rows - 2, 2 * cols + rows - 3]) anchors.add(c);
			const byRing = new Map<number, Cell>();
			for (const cell of f.box.cells) if (cell.ringIndex >= 0) byRing.set(cell.ringIndex, cell);
			for (let i = 0; i < f.box.ringLength; i++) {
				const here = byRing.get(i);
				const next = byRing.get((i + 1) % f.box.ringLength);
				if (here && next && (here.kind === "label") !== (next.kind === "label")) anchors.add(i);
			}

			const reach = f.metrics.bleed * (f.params.spur ?? 0.6);
			spurs = [...anchors].map((ring) => {
				const c = ringCell(f, ring);
				const { cx, cy } = cellCentre(f, c.x, c.y);
				const vertical = c.y === 0 || c.y === rows - 1;
				const nx = c.x === 0 ? -1 : c.x === cols - 1 ? 1 : 0;
				const ny = c.y === 0 ? -1 : c.y === rows - 1 ? 1 : 0;
				const ox = vertical ? 0 : nx;
				const oy = vertical ? ny : 0;
				const turn = ring % 2 === 0 ? 1 : -1;
				const run = reach * 0.9;
				const p1 = { x: cx + ox * reach, y: cy + oy * reach };
				const p2 = vertical ? { x: p1.x + run * turn, y: p1.y } : { x: p1.x, y: p1.y + run * turn };
				return { ring, pts: [{ x: cx, y: cy }, p1, p2], lit: 0 };
			});

			const n = Math.round(f.params.pulses ?? 4);
			pulses = Array.from({ length: n }, (_, i) => ({
				pos: (f.box.ringLength / n) * i,
				speed: 0.55 + (i % 3) * 0.35 + Math.random() * 0.3,
			}));
		};

		return {
			update(f: Frame) {
				if (built !== f.box.ringLength || pulses.length !== Math.round(f.params.pulses ?? 4)) build(f);
				const base = (f.params.speed ?? 45) * f.intensity;
				for (const p of pulses) {
					if (f.working) p.pos = (p.pos + p.speed * base * f.dt) % f.box.ringLength;
					for (const s of spurs) {
						if (f.working && ringGap(p.pos, s.ring, f.box.ringLength) < 1.4) s.lit = 1;
					}
				}
				for (const s of spurs) s.lit = Math.max(0, s.lit - f.dt * 2.2);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				if (!f.working) return { color: lerp(cell.color, TRACE, 0.35) };
				const tail = f.params.tail ?? 10;
				let level = 0;
				for (const p of pulses) {
					let behind = p.pos - cell.ringIndex;
					if (behind < 0) behind += f.box.ringLength;
					if (behind > f.box.ringLength / 2) continue;
					level = Math.max(level, Math.exp(-behind / tail) * (behind < 1.5 ? 1 : 0.8));
				}
				level = clamp(level * f.intensity, 0, 1);
				const rest = lerp(cell.color, TRACE, 0.4);
				if (level < 0.02) return { color: rest };
				const colour = level > 0.8 ? lerp(CURRENT, PAD, (level - 0.8) / 0.2) : lerp(rest, CURRENT, level / 0.8);
				return { color: colour, glow: level * 12 };
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				g.lineCap = "square";
				g.lineJoin = "miter";
				for (const s of spurs) {
					const lit = s.lit * f.intensity;
					g.globalCompositeOperation = "source-over";
					g.strokeStyle = css(TRACE, 0.85);
					g.lineWidth = 2;
					g.beginPath();
					g.moveTo(s.pts[0].x, s.pts[0].y);
					for (const p of s.pts) g.lineTo(p.x, p.y);
					g.stroke();

					const pad = s.pts[s.pts.length - 1];
					g.fillStyle = css(lerp(TRACE, PAD, lit), 0.9);
					g.beginPath();
					g.arc(pad.x, pad.y, 2.4 + lit * 1.6, 0, Math.PI * 2);
					g.fill();

					if (lit < 0.02) continue;
					g.globalCompositeOperation = "lighter";
					g.shadowBlur = 10 * lit;
					g.shadowColor = css(CURRENT, lit);
					g.strokeStyle = css(CURRENT, lit);
					g.lineWidth = 1.6;
					g.beginPath();
					g.moveTo(s.pts[0].x, s.pts[0].y);
					for (const p of s.pts) g.lineTo(p.x, p.y);
					g.stroke();
					g.fillStyle = css(PAD, lit);
					g.beginPath();
					g.arc(pad.x, pad.y, 2.6 + lit * 2.2, 0, Math.PI * 2);
					g.fill();
					g.shadowBlur = 0;
				}
			},
		};
	},
};

export default effect;
