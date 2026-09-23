/**
 * PROTOTYPE — throwaway. The outline scrambles and locks back to its true glyphs
 * behind a wavefront crossing left to right, flashing at the moment each cell locks.
 */

import { hex, lerp } from "../core/color.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const LIVE = hex("#8affc1");
const LOCK = hex("#f2fff7");
const RULE_SET = "│─═━╪╫┼╬╳▚▞┃┄┅╎╏║▒░";
const TEXT_SET = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#@%&$?*";

function hash(a: number, b: number): number {
	const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
	return s - Math.floor(s);
}

const effect: Effect = {
	id: "decode",
	name: "Decode",
	group: "signal",
	blurb: "Ciphered glyphs resolve to the real outline behind a left-to-right wavefront.",
	palette: { hot: LIVE, peak: LOCK },
	params: [
		{ key: "period", label: "sweep (s)", min: 0.6, max: 6, step: 0.1, value: 2.2 },
		{ key: "churn", label: "churn (Hz)", min: 2, max: 60, step: 1, value: 22 },
		{ key: "soft", label: "front softness", min: 0, max: 12, step: 0.5, value: 3 },
	],
	create(): EffectInstance {
		return {
			cell(cell: Cell, f: Frame): CellStyle | null {
				if (!f.working) return null;
				const onRing = cell.ringIndex >= 0;
				if (!onRing && cell.kind !== "label") return null;

				const period = f.params.period ?? 2.2;
				const soft = f.params.soft ?? 3;
				const span = f.box.cols + soft * 2 + 4;
				const front = ((f.since / period) % 1) * span - soft;
				// A per-column wobble stops the front reading as a perfect ruler edge.
				const edge = front + (hash(cell.x, cell.y) - 0.5) * soft;
				const ahead = cell.x - edge;

				if (ahead < -6) return null;

				const churn = f.params.churn ?? 22;
				const bucket = Math.floor(f.t * churn + cell.y * 3);
				const set = cell.kind === "label" ? TEXT_SET : RULE_SET;
				const pick = Math.floor(hash(cell.x * 7.3 + cell.y, bucket) * set.length);

				if (ahead > 0.5) {
					const noiseLevel = Math.min(1, 0.35 + ahead * 0.06) * f.intensity;
					return {
						glyph: set[pick] ?? cell.glyph,
						color: lerp(cell.color, LIVE, 0.55 * f.intensity),
						alpha: 0.35 + 0.5 * hash(bucket, cell.x),
						glow: noiseLevel * 4,
					};
				}

				const flash = Math.exp(-(ahead * ahead) * 0.22) * f.intensity;
				return {
					color: lerp(cell.color, LOCK, Math.min(1, flash * 1.6)),
					glow: flash * 14,
					scale: 1 + flash * 0.18,
				};
			},
		};
	},
};

export default effect;
