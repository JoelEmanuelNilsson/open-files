/**
 * PROTOTYPE — throwaway. Bolts leap across the interior between two random
 * points on the outline: jagged additive polylines with a short afterglow, and
 * a white flare at each anchor cell.
 */

import { clamp, css, hex, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const BOLT = hex("#6fb4ff");
const CORE = hex("#ffffff");
const HALO = hex("#9b6bff");

interface Bolt {
	pts: Array<{ x: number; y: number }>;
	a: number;
	b: number;
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

/** Midpoint-displacement path between two points, wobble measured perpendicular. */
function fracture(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	depth: number,
	wobble: number,
): Array<{ x: number; y: number }> {
	let pts = [
		{ x: x0, y: y0 },
		{ x: x1, y: y1 },
	];
	let amp = wobble;
	for (let d = 0; d < depth; d++) {
		const next: Array<{ x: number; y: number }> = [];
		for (let i = 0; i < pts.length - 1; i++) {
			const p = pts[i];
			const q = pts[i + 1];
			next.push(p);
			const dx = q.x - p.x;
			const dy = q.y - p.y;
			const len = Math.hypot(dx, dy) || 1;
			const off = (Math.random() - 0.5) * amp;
			next.push({ x: (p.x + q.x) / 2 + (-dy / len) * off, y: (p.y + q.y) / 2 + (dx / len) * off });
		}
		next.push(pts[pts.length - 1]);
		pts = next;
		amp *= 0.55;
	}
	return pts;
}

const effect: Effect = {
	id: "tesla",
	name: "Tesla",
	group: "energy",
	blurb: "Bolts jump across the interior between outline anchors, flaring white and fading fast.",
	palette: { hot: BOLT, peak: CORE },
	params: [
		{ key: "rate", label: "bolts/s", min: 0, max: 12, step: 0.5, value: 3.5 },
		{ key: "decay", label: "afterglow (s)", min: 0.1, max: 1.2, step: 0.05, value: 0.4 },
		{ key: "wobble", label: "wobble", min: 0, max: 3, step: 0.1, value: 1 },
	],
	create(): EffectInstance {
		const bolts: Bolt[] = [];
		let pending = 0;

		return {
			update(f: Frame) {
				if (!f.working) {
					bolts.length = 0;
					pending = 0;
					return;
				}
				pending += (f.params.rate ?? 3.5) * f.intensity * f.dt;
				while (pending >= 1) {
					pending -= 1;
					const len = f.box.ringLength;
					const a = Math.floor(Math.random() * len);
					// Keep the endpoints far apart so the bolt actually crosses the box.
					const b = Math.floor((a + len * (0.25 + Math.random() * 0.5)) % len);
					const pa = ringCell(f, a);
					const pb = ringCell(f, b);
					const ca = cellCentre(f, pa.x, pa.y);
					const cb = cellCentre(f, pb.x, pb.y);
					const span = Math.hypot(cb.cx - ca.cx, cb.cy - ca.cy);
					bolts.push({
						pts: fracture(ca.cx, ca.cy, cb.cx, cb.cy, 5, span * 0.22 * (f.params.wobble ?? 1)),
						a,
						b,
						life: 0,
						max: (f.params.decay ?? 0.4) * (0.7 + Math.random() * 0.6),
						width: 1 + Math.random() * 1.6,
					});
				}
				for (let i = bolts.length - 1; i >= 0; i--) {
					const bolt = bolts[i];
					bolt.life += f.dt;
					if (bolt.life >= bolt.max) bolts.splice(i, 1);
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				let level = 0;
				for (const bolt of bolts) {
					const fade = (1 - bolt.life / bolt.max) ** 1.4;
					for (const end of [bolt.a, bolt.b]) {
						const raw = Math.abs(cell.ringIndex - end) % f.box.ringLength;
						const d = Math.min(raw, f.box.ringLength - raw);
						level = Math.max(level, fade * Math.exp(-(d * d) / 8));
					}
				}
				level = clamp(level * f.intensity, 0, 1);
				if (level < 0.02) return null;
				const colour = level > 0.5 ? lerp(BOLT, CORE, (level - 0.5) / 0.5) : lerp(cell.color, BOLT, level / 0.5);
				return { color: colour, glow: level * 24, scale: 1 + level * 0.15 };
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				if (bolts.length === 0) return;
				g.globalCompositeOperation = "lighter";
				g.lineCap = "round";
				g.lineJoin = "round";
				for (const bolt of bolts) {
					const fade = (1 - bolt.life / bolt.max) ** 1.5 * f.intensity;
					const flicker = 0.7 + 0.3 * Math.sin(f.t * 90 + bolt.a);
					g.beginPath();
					g.moveTo(bolt.pts[0].x, bolt.pts[0].y);
					for (const p of bolt.pts) g.lineTo(p.x, p.y);

					g.shadowBlur = 18 * fade;
					g.shadowColor = css(HALO, fade);
					g.strokeStyle = css(HALO, 0.35 * fade);
					g.lineWidth = bolt.width * 6;
					g.stroke();

					g.shadowColor = css(BOLT, fade);
					g.strokeStyle = css(BOLT, 0.7 * fade * flicker);
					g.lineWidth = bolt.width * 2.4;
					g.stroke();

					g.shadowBlur = 0;
					g.strokeStyle = css(CORE, fade * flicker);
					g.lineWidth = bolt.width * 0.8;
					g.stroke();

					for (const p of [bolt.pts[0], bolt.pts[bolt.pts.length - 1]]) {
						g.fillStyle = css(CORE, fade);
						g.shadowBlur = 20 * fade;
						g.shadowColor = css(BOLT, fade);
						g.beginPath();
						g.arc(p.x, p.y, 2 + 3 * fade, 0, Math.PI * 2);
						g.fill();
					}
				}
				g.shadowBlur = 0;
			},
		};
	},
};

export default effect;
