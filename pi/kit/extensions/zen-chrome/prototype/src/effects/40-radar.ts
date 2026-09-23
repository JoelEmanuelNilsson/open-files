/**
 * PROTOTYPE — throwaway. A beam sweeps from the box centre; outline cells light
 * as it crosses them and drain behind it, with random contacts and a settle ping.
 */

import { css, hex, lerp } from "../core/color.ts";
import { boxRect, cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const SWEEP = hex("#39ff9a");
const CONTACT = hex("#eaffe8");
const TAU = Math.PI * 2;

interface Contact {
	ringIndex: number;
	life: number;
	max: number;
}

/** Angle of `a` behind `beam`, 0..2π. */
function behind(beam: number, a: number): number {
	let d = beam - a;
	while (d < 0) d += TAU;
	while (d >= TAU) d -= TAU;
	return d;
}

const effect: Effect = {
	id: "radar",
	name: "Radar",
	group: "signal",
	blurb: "A beam sweeps from the centre; the outline lights where it passes and drains behind.",
	palette: { hot: SWEEP, peak: CONTACT },
	params: [
		{ key: "period", label: "sweep (s)", min: 0.8, max: 8, step: 0.1, value: 3 },
		{ key: "trail", label: "trail (revs)", min: 0.1, max: 1.5, step: 0.05, value: 0.55 },
		{ key: "contacts", label: "contacts/s", min: 0, max: 6, step: 0.1, value: 1.2 },
		{ key: "wedge", label: "wedge", min: 0, max: 1, step: 0.05, value: 0.5 },
	],
	create(): EffectInstance {
		const contacts: Contact[] = [];
		let pending = 0;
		let beam = 0;

		const centre = (f: Frame) => {
			const rect = boxRect(f);
			return { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 };
		};

		return {
			update(f: Frame) {
				const period = f.params.period ?? 3;
				if (f.working) beam = (beam + (TAU * f.dt) / period) % TAU;

				pending += (f.working ? (f.params.contacts ?? 1.2) * f.intensity : 0) * f.dt;
				while (pending >= 1) {
					pending -= 1;
					contacts.push({
						ringIndex: Math.floor(Math.random() * f.box.ringLength),
						life: 0,
						max: 0.5 + Math.random() * 0.9,
					});
				}
				for (let i = contacts.length - 1; i >= 0; i--) {
					const c = contacts[i] as Contact;
					c.life += f.dt;
					if (c.life >= c.max) contacts.splice(i, 1);
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0 || !f.working) return null;
				const { cx, cy } = centre(f);
				const p = cellCentre(f, cell.x, cell.y);
				const angle = Math.atan2(p.cy - cy, p.cx - cx);
				const tail = TAU * (f.params.trail ?? 0.55);
				let level = Math.exp(-behind(beam, angle < 0 ? angle + TAU : angle) / (tail * 0.45)) * f.intensity;

				let blip = 0;
				for (const c of contacts) {
					if (c.ringIndex !== cell.ringIndex) continue;
					blip = Math.max(blip, (1 - c.life / c.max) ** 2);
				}
				level = Math.min(1.6, level + blip * 1.4 * f.intensity);
				if (level < 0.02) return null;

				const colour = level > 1 ? CONTACT : lerp(cell.color, SWEEP, Math.min(1, level * 1.25));
				return {
					color: level > 1 ? lerp(SWEEP, CONTACT, level - 1) : colour,
					glow: level * 8,
					scale: 1 + blip * 0.35,
				};
			},

			drawUnder(g: CanvasRenderingContext2D, f: Frame) {
				if (!f.working) return;
				const { cx, cy } = centre(f);
				const rect = boxRect(f);
				const reach = Math.hypot(rect.w, rect.h);
				const span = TAU * 0.5 * (f.params.wedge ?? 0.5) * 0.5;
				const gain = 0.5 * f.intensity;

				g.globalCompositeOperation = "lighter";
				const steps = 22;
				for (let i = 0; i < steps; i++) {
					const t = i / steps;
					const a = beam - t * span;
					const fade = (1 - t) ** 2 * gain * 0.09;
					g.beginPath();
					g.moveTo(cx, cy);
					g.arc(cx, cy, reach, a - span / steps, a);
					g.closePath();
					g.fillStyle = css(SWEEP, fade);
					g.fill();
				}
				g.strokeStyle = css(SWEEP, 0.35 * f.intensity);
				g.lineWidth = 1;
				g.beginPath();
				g.moveTo(cx, cy);
				g.lineTo(cx + Math.cos(beam) * reach, cy + Math.sin(beam) * reach);
				g.stroke();
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				const s = f.settled;
				if (s === null || s > 1.6) return;
				const { cx, cy } = centre(f);
				const rect = boxRect(f);
				g.globalCompositeOperation = "lighter";
				for (let k = 0; k < 3; k++) {
					const age = s - k * 0.18;
					if (age <= 0) continue;
					const t = Math.min(1, age / 1.4);
					const r = t * Math.hypot(rect.w, rect.h) * 0.6;
					g.strokeStyle = css(CONTACT, (1 - t) ** 2 * 0.5 * f.intensity);
					g.lineWidth = 2 * (1 - t) + 0.4;
					g.beginPath();
					g.ellipse(cx, cy, r, r * (rect.h / rect.w), 0, 0, TAU);
					g.stroke();
				}
			},
		};
	},
};

export default effect;
