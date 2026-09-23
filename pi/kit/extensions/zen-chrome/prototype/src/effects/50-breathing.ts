/**
 * PROTOTYPE — throwaway. The outline breathes: brightness and stroke weight
 * swell together, light box glyphs giving way to heavy then double ones.
 */

import { clamp, lerp, ramp } from "../core/color.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const HEAVY: Record<string, string> = {
	"─": "━",
	"│": "┃",
	"╭": "┏",
	"╮": "┓",
	"╰": "┗",
	"╯": "┛",
};

const DOUBLE: Record<string, string> = {
	"─": "═",
	"│": "║",
	"╭": "╔",
	"╮": "╗",
	"╰": "╚",
	"╯": "╝",
};

/** Asymmetric breath: a shorter inhale, a longer relaxed exhale, both eased. */
function breath(phase: number): number {
	const p = phase - Math.floor(phase);
	const inhale = 0.42;
	const k = p < inhale ? p / inhale : 1 - (p - inhale) / (1 - inhale);
	return 0.5 - 0.5 * Math.cos(Math.PI * clamp(k, 0, 1));
}

const effect: Effect = {
	id: "breathing",
	name: "Breathing",
	group: "motion",
	blurb: "The whole outline inhales: light strokes thicken to heavy then double, glow swelling with them.",
	params: [
		{ key: "period", label: "breath (s)", min: 2, max: 9, step: 0.25, value: 4 },
		{ key: "depth", label: "depth", min: 0.2, max: 1, step: 0.05, value: 0.85 },
		{ key: "weight", label: "thickening", min: 0, max: 1, step: 0.05, value: 0.8 },
		{ key: "bloom", label: "glow", min: 0, max: 20, step: 0.5, value: 9 },
	],
	create(): EffectInstance {
		// Lags the working flag so the box eases into and out of breathing.
		let gate = 0;

		return {
			update(f: Frame) {
				const target = f.working ? 1 : 0;
				const rate = f.working ? 1.1 : 0.45;
				gate += (target - gate) * clamp(rate * f.dt * 2, 0, 1);
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0 || gate < 0.01) return null;
				const period = f.params.period ?? 4;
				const depth = f.params.depth ?? 0.85;
				const weight = f.params.weight ?? 0.8;
				const level = breath(f.since / period) * depth * f.intensity * gate;
				if (level < 0.01) return null;

				// Corners lead the breath slightly — the box fills from its edges.
				const bias = cell.kind === "corner" ? 1.08 : 1;
				const swell = clamp(level * bias, 0, 1);
				const w = swell * weight;
				const glyph = w > 0.78 ? DOUBLE[cell.glyph] : w > 0.42 ? HEAVY[cell.glyph] : undefined;

				return {
					color: lerp(cell.color, ramp(cell.color, f.palette.hot, f.palette.peak, swell), 0.9),
					glyph,
					glow: swell * (f.params.bloom ?? 9),
					scale: 1 + swell * 0.05,
				};
			},
		};
	},
};

export default effect;
