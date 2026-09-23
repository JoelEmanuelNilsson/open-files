/**
 * PROTOTYPE — throwaway. RF interference: outline glyphs dissolve into a noise
 * set and flicker, the noise density breathing between clean signal and heavy
 * hash, with occasional horizontal tears sliding a run of cells sideways.
 */

import { clamp, hex, lerp } from "../core/color.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const SIGNAL = hex("#8fe7ff");
const HASH = hex("#d8f6ff");

const NOISE = ["░", "▒", "▓", "█", "─", "═", "━", "╌", "┄"];

interface Tear {
	start: number;
	len: number;
	dx: number;
	life: number;
	max: number;
}

/** Deterministic 0..1 hash so a cell's noise is stable within a time bucket. */
function hash(a: number, b: number): number {
	const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
	return s - Math.floor(s);
}

const effect: Effect = {
	id: "static",
	name: "Static field",
	group: "energy",
	blurb: "Outline glyphs break up into RF hash; density breathes and the line tears sideways.",
	palette: { hot: SIGNAL, peak: HASH },
	params: [
		{ key: "density", label: "density", min: 0, max: 1, step: 0.05, value: 0.5 },
		{ key: "churn", label: "churn (Hz)", min: 2, max: 60, step: 1, value: 22 },
		{ key: "breath", label: "breath (s)", min: 1, max: 12, step: 0.5, value: 5 },
		{ key: "tears", label: "tears/s", min: 0, max: 12, step: 0.5, value: 2 },
	],
	create(): EffectInstance {
		const tears: Tear[] = [];
		let pending = 0;
		let density = 0;

		return {
			update(f: Frame) {
				if (!f.working) {
					tears.length = 0;
					density = Math.max(0, density - f.dt * 3);
					return;
				}
				const breath = f.params.breath ?? 5;
				const wave = 0.5 - 0.5 * Math.cos((f.since / breath) * Math.PI * 2);
				density = (0.12 + 0.88 * wave ** 1.6) * (f.params.density ?? 0.5) * f.intensity;

				pending += (f.params.tears ?? 2) * (0.3 + density) * f.dt;
				while (pending >= 1) {
					pending -= 1;
					tears.push({
						start: Math.floor(Math.random() * f.box.ringLength),
						len: 4 + Math.floor(Math.random() * 22),
						dx: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 2.5),
						life: 0,
						max: 0.06 + Math.random() * 0.22,
					});
				}
				for (let i = tears.length - 1; i >= 0; i--) {
					const t = tears[i];
					t.life += f.dt;
					if (t.life >= t.max) tears.splice(i, 1);
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working || cell.ringIndex < 0) return null;
				const bucket = Math.floor(f.t * (f.params.churn ?? 22));
				const h = hash(cell.ringIndex + 1, bucket);

				let dx = 0;
				for (const t of tears) {
					const rel = ((cell.ringIndex - t.start) % f.box.ringLength + f.box.ringLength) % f.box.ringLength;
					if (rel < t.len) dx += t.dx * (1 - t.life / t.max);
				}

				const lit = clamp(0.35 + h * 0.9, 0, 1);
				const noisy = h < density && cell.kind !== "label" && cell.kind !== "corner";
				if (!noisy && dx === 0 && density < 0.05) return null;

				const glyph = noisy ? NOISE[Math.floor(hash(cell.ringIndex + 7, bucket + 3) * NOISE.length)] : undefined;
				const strength = noisy ? lit : 0.25 + density * 0.4;
				const colour = lerp(cell.color, noisy ? HASH : SIGNAL, strength * (0.4 + density * 0.6));
				return {
					glyph,
					color: colour,
					dx,
					alpha: clamp(0.55 + strength * 0.45, 0, 1),
					glow: noisy ? strength * 9 : strength * 3,
				};
			},
		};
	},
};

export default effect;
