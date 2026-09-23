/**
 * PROTOTYPE — throwaway. A high-voltage discharge crawls the outline: a jagged
 * white-hot head that advances erratically, forks that jump off into the bleed,
 * corner flashovers, and a whole-box flash every few seconds.
 */

import { clamp, css, hex, lerp } from "../core/color.ts";
import { boxRect, cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const ARC = hex("#7cc6ff");
const CORE = hex("#f4fbff");
const DEEP = hex("#2b4fa8");

interface Bolt {
	pts: Array<{ x: number; y: number }>;
	life: number;
	max: number;
	width: number;
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

function ringPoint(f: Frame, index: number): { cx: number; cy: number } {
	const c = ringCell(f, index);
	return cellCentre(f, c.x, c.y);
}

/** Unit vector pointing out of the box at a ring position. */
function outward(f: Frame, index: number): { nx: number; ny: number } {
	const c = ringCell(f, index);
	const nx = c.x === 0 ? -1 : c.x === f.box.cols - 1 ? 1 : 0;
	const ny = c.y === 0 ? -1 : c.y === f.box.rows - 1 ? 1 : 0;
	const len = Math.hypot(nx, ny) || 1;
	return { nx: nx / len, ny: ny / len };
}

function jagged(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	segments: number,
	wobble: number,
): Array<{ x: number; y: number }> {
	const pts: Array<{ x: number; y: number }> = [];
	const dx = x1 - x0;
	const dy = y1 - y0;
	const len = Math.hypot(dx, dy) || 1;
	const px = -dy / len;
	const py = dx / len;
	for (let i = 0; i <= segments; i++) {
		const t = i / segments;
		const edge = Math.sin(t * Math.PI);
		const off = (Math.random() - 0.5) * wobble * edge;
		pts.push({ x: x0 + dx * t + px * off, y: y0 + dy * t + py * off });
	}
	return pts;
}

const effect: Effect = {
	id: "arc",
	name: "Electric arc",
	group: "energy",
	blurb: "A discharge crawls the outline, throwing forks into the bleed and flashing over at corners.",
	palette: { hot: ARC, peak: CORE },
	params: [
		{ key: "speed", label: "crawl (cells/s)", min: 10, max: 260, step: 5, value: 90 },
		{ key: "forks", label: "forks/s", min: 0, max: 40, step: 1, value: 12 },
		{ key: "spread", label: "head width", min: 1, max: 14, step: 0.5, value: 4 },
		{ key: "flash", label: "flash every (s)", min: 0.8, max: 10, step: 0.2, value: 3.2 },
	],
	create(): EffectInstance {
		let head = 0;
		let jitter = 1;
		let jitterLeft = 0;
		let pendingForks = 0;
		let flash = 0;
		let nextFlash = 2;
		const bolts: Bolt[] = [];

		return {
			update(f: Frame) {
				if (!f.working) {
					bolts.length = 0;
					flash = Math.max(0, flash - f.dt * 6);
					return;
				}
				jitterLeft -= f.dt;
				if (jitterLeft <= 0) {
					jitterLeft = 0.04 + Math.random() * 0.14;
					jitter = Math.random() < 0.18 ? -0.5 + Math.random() : 0.3 + Math.random() * 2.2;
				}
				const speed = (f.params.speed ?? 90) * f.intensity;
				head += speed * jitter * f.dt;

				pendingForks += (f.params.forks ?? 12) * f.intensity * f.dt;
				while (pendingForks >= 1) {
					pendingForks -= 1;
					const at = head + (Math.random() - 0.5) * (f.params.spread ?? 4) * 2;
					const p = ringPoint(f, at);
					const n = outward(f, at);
					const reach = f.metrics.bleed * (0.4 + Math.random() * 1.2);
					const drift = (Math.random() - 0.5) * f.metrics.cw * 6;
					bolts.push({
						pts: jagged(p.cx, p.cy, p.cx + n.nx * reach + drift * 0.3, p.cy + n.ny * reach + drift * 0.15, 5, reach * 0.7),
						life: 0,
						max: 0.09 + Math.random() * 0.14,
						width: 0.8 + Math.random() * 1.4,
					});
				}

				// Flashover: the head near a corner jumps the gap to the far side of the turn.
				const corners = [0, f.box.cols - 1, f.box.cols + f.box.rows - 2, 2 * f.box.cols + f.box.rows - 3];
				for (const corner of corners) {
					const raw = Math.abs(head - corner) % f.box.ringLength;
					const d = Math.min(raw, f.box.ringLength - raw);
					if (d < 3 && Math.random() < 8 * f.dt) {
						const a = ringPoint(f, corner - 4);
						const b = ringPoint(f, corner + 4);
						bolts.push({ pts: jagged(a.cx, a.cy, b.cx, b.cy, 4, f.metrics.ch * 1.2), life: 0, max: 0.14, width: 1.6 });
					}
				}

				nextFlash -= f.dt;
				if (nextFlash <= 0) {
					nextFlash = (f.params.flash ?? 3.2) * (0.7 + Math.random() * 0.6);
					flash = 1;
				}
				flash = Math.max(0, flash - f.dt * 4.5);

				for (let i = bolts.length - 1; i >= 0; i--) {
					const b = bolts[i];
					b.life += f.dt;
					if (b.life >= b.max) bolts.splice(i, 1);
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				let ahead = cell.ringIndex - (((head % len) + len) % len);
				if (ahead > len / 2) ahead -= len;
				if (ahead < -len / 2) ahead += len;
				const sigma = f.params.spread ?? 4;
				const front = Math.exp(-(ahead * ahead) / (2 * sigma * sigma));
				const tail = ahead < 0 ? Math.exp(ahead / (sigma * 5)) * 0.5 : 0;
				const level = clamp((Math.max(front, tail) + flash * 0.8) * f.intensity, 0, 1);
				if (level < 0.02) return null;
				const colour = level > 0.6 ? lerp(ARC, CORE, (level - 0.6) / 0.4) : lerp(cell.color, ARC, level / 0.6);
				return {
					color: colour,
					glow: level * 22,
					dx: level > 0.75 ? (Math.random() - 0.5) * 1.6 : 0,
					dy: level > 0.75 ? (Math.random() - 0.5) * 1.6 : 0,
				};
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				g.globalCompositeOperation = "lighter";
				g.lineCap = "round";
				g.lineJoin = "round";
				for (const b of bolts) {
					const fade = 1 - b.life / b.max;
					g.shadowBlur = 12 * fade;
					g.shadowColor = css(ARC, fade);
					g.strokeStyle = css(DEEP, 0.5 * fade);
					g.lineWidth = b.width * 3.5;
					g.beginPath();
					g.moveTo(b.pts[0].x, b.pts[0].y);
					for (const p of b.pts) g.lineTo(p.x, p.y);
					g.stroke();
					g.strokeStyle = css(CORE, fade);
					g.lineWidth = b.width;
					g.stroke();
				}
				g.shadowBlur = 0;
				if (flash > 0.01) {
					const rect = boxRect(f);
					g.fillStyle = css(ARC, 0.16 * flash * f.intensity);
					g.fillRect(rect.x - f.metrics.bleed, rect.y - f.metrics.bleed, rect.w + f.metrics.bleed * 2, rect.h + f.metrics.bleed * 2);
				}
			},
		};
	},
};

export default effect;
