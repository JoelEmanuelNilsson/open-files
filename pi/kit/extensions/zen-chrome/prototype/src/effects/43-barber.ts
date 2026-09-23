/**
 * PROTOTYPE — throwaway. The outline becomes an indeterminate progress track:
 * weighted dashes march around it in eased, mechanical steps.
 */

import { hex, lerp } from "../core/color.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const STRIPE = hex("#ffb347");
const CREST = hex("#fff2d0");
const H_WEIGHTS = ["┄", "╌", "─", "━", "━"];
const V_WEIGHTS = ["┆", "╎", "│", "┃", "┃"];
const BLOCKS = ["▁", "▂", "▃", "▄", "▅"];

function easeInOut(u: number): number {
	return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

const effect: Effect = {
	id: "barber",
	name: "Barber pole",
	group: "signal",
	blurb: "Weighted dashes march the outline in eased steps, like a striped pole turning.",
	palette: { hot: STRIPE, peak: CREST },
	params: [
		{ key: "stripe", label: "stripe (cells)", min: 3, max: 30, step: 1, value: 9 },
		{ key: "speed", label: "stripes/s", min: 0.1, max: 6, step: 0.1, value: 1.1 },
		{ key: "ease", label: "ease", min: 0, max: 1, step: 0.05, value: 0.8 },
		{ key: "duty", label: "duty", min: 0.15, max: 0.9, step: 0.05, value: 0.55 },
	],
	create(): EffectInstance {
		let phase = 0;

		return {
			update(f: Frame) {
				if (f.working) phase += (f.params.speed ?? 1.1) * f.dt;
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0 || cell.kind === "label") return null;
				if (!f.working) return null;

				const stripe = Math.max(3, f.params.stripe ?? 9);
				const ease = f.params.ease ?? 0.8;
				const duty = f.params.duty ?? 0.55;

				const step = Math.floor(phase);
				const raw = phase - step;
				const moved = step + (raw * (1 - ease) + easeInOut(raw) * ease);
				const head = moved * stripe;

				const u = (((cell.ringIndex - head) % stripe) + stripe) % stripe;
				const s = u / stripe;
				if (s > duty) {
					// The gap between stripes: dim, but never fully dark.
					return { color: lerp(cell.color, STRIPE, 0.08 * f.intensity), alpha: 0.75 };
				}

				const along = s / duty;
				// Bright at the leading edge, drawn out towards the tail.
				const level = ((1 - along) ** 1.5 * 0.75 + 0.25) * f.intensity;
				const w = Math.min(4, Math.floor(level * 5));
				const vertical = cell.kind === "side";
				const glyph =
					cell.kind === "corner" ? cell.glyph : vertical ? (V_WEIGHTS[w] ?? "│") : (H_WEIGHTS[w] ?? "─");
				const under = !vertical && cell.kind !== "corner" && level > 0.85 ? (BLOCKS[w] ?? glyph) : glyph;

				return {
					glyph: under,
					color: level > 0.8 ? lerp(STRIPE, CREST, (level - 0.8) / 0.2) : lerp(cell.color, STRIPE, level * 1.2),
					glow: level * 7,
				};
			},
		};
	},
};

export default effect;
