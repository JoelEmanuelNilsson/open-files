/** PROTOTYPE — throwaway. Paints one chatbar frame: effect under, glyphs, effect over. */

import { css } from "./color.ts";
import type { EffectInstance, Frame, Metrics } from "./types.ts";

/**
 * Box-drawing glyphs are stroked, not typed. A font renders them as glyphs sized
 * to its own em box, so at any cell height but one they leave gaps at the joins —
 * which is why the prototype's box looked broken. Real terminals synthesise these
 * characters from the cell rectangle instead, and so does this.
 */
const STROKED = new Set(["─", "│", "╭", "╮", "╰", "╯"]);

/** Half-pixel centres keep a hairline stroke from smearing across two pixels. */
function snap(v: number): number {
	return Math.floor(v) + 0.5;
}

function strokeBox(g: CanvasRenderingContext2D, glyph: string, x0: number, y0: number, m: Metrics, crisp: boolean): void {
	const { cw, ch } = m;
	const cx = crisp ? snap(x0 + cw / 2) : x0 + cw / 2;
	const cy = crisp ? snap(y0 + ch / 2) : y0 + ch / 2;
	const r = Math.min(cw / 2, ch / 2);

	g.lineWidth = m.lw;
	g.lineCap = "butt";
	g.lineJoin = "round";
	g.beginPath();
	switch (glyph) {
		case "─":
			g.moveTo(x0, cy);
			g.lineTo(x0 + cw, cy);
			break;
		case "│":
			g.moveTo(cx, y0);
			g.lineTo(cx, y0 + ch);
			break;
		case "╭":
			g.moveTo(x0 + cw, cy);
			g.lineTo(cx + r, cy);
			g.quadraticCurveTo(cx, cy, cx, cy + r);
			g.lineTo(cx, y0 + ch);
			break;
		case "╮":
			g.moveTo(x0, cy);
			g.lineTo(cx - r, cy);
			g.quadraticCurveTo(cx, cy, cx, cy + r);
			g.lineTo(cx, y0 + ch);
			break;
		case "╰":
			g.moveTo(cx, y0);
			g.lineTo(cx, cy - r);
			g.quadraticCurveTo(cx, cy, cx + r, cy);
			g.lineTo(x0 + cw, cy);
			break;
		case "╯":
			g.moveTo(cx, y0);
			g.lineTo(cx, cy - r);
			g.quadraticCurveTo(cx, cy, cx - r, cy);
			g.lineTo(x0, cy);
			break;
	}
	g.stroke();
}

/** Cell origin in canvas pixels. */
export function cellX(f: Frame, x: number): number {
	return f.metrics.bleed + x * f.metrics.cw;
}

export function cellY(f: Frame, y: number): number {
	return f.metrics.bleed + y * f.metrics.ch;
}

/** Centre of a cell in canvas pixels — what most effects want. */
export function cellCentre(f: Frame, x: number, y: number): { cx: number; cy: number } {
	return { cx: cellX(f, x) + f.metrics.cw / 2, cy: cellY(f, y) + f.metrics.ch / 2 };
}

/** The box's pixel rectangle, outline inclusive. */
export function boxRect(f: Frame): { x: number; y: number; w: number; h: number } {
	return {
		x: f.metrics.bleed,
		y: f.metrics.bleed,
		w: f.box.cols * f.metrics.cw,
		h: f.box.rows * f.metrics.ch,
	};
}

/**
 * Paints one frame. The caller owns the transform — it carries the device pixel
 * ratio, so resetting it here would render the whole bar at half resolution.
 */
export function renderFrame(g: CanvasRenderingContext2D, f: Frame, effect: EffectInstance, bloom: number): void {
	const { metrics, palette } = f;
	g.globalCompositeOperation = "source-over";
	g.fillStyle = css(palette.bg);
	g.fillRect(0, 0, metrics.width, metrics.height);

	effect.update?.(f);
	if (effect.drawUnder) {
		g.save();
		effect.drawUnder(g, f);
		g.restore();
	}

	g.font = metrics.font;
	g.textBaseline = "alphabetic";
	g.textAlign = "left";

	for (const cell of f.box.cells) {
		if (cell.glyph === " " && cell.kind === "interior") continue;
		const style = effect.cell?.(cell, f) ?? null;
		const glyph = style?.glyph ?? cell.glyph;
		if (glyph === " " || glyph === "") continue;
		const colour = style?.color ?? cell.color;
		const alpha = style?.alpha ?? 1;
		if (alpha <= 0.004) continue;

		const px = cellX(f, cell.x) + (style?.dx ?? 0);
		const py = cellY(f, cell.y) + (style?.dy ?? 0);

		if (style?.bg) {
			g.globalAlpha = alpha;
			g.fillStyle = css(style.bg);
			g.fillRect(px, py, metrics.cw + 0.5, metrics.ch + 0.5);
		}

		g.globalAlpha = alpha;
		g.fillStyle = css(colour);
		const glow = (style?.glow ?? 0) + bloom;
		if (glow > 0) {
			g.shadowBlur = glow;
			g.shadowColor = css(colour);
		} else {
			g.shadowBlur = 0;
		}

		const scale = style?.scale ?? 1;
		const moved = scale !== 1 || (style?.dx ?? 0) !== 0 || (style?.dy ?? 0) !== 0;

		const paint = (ox: number, oy: number) => {
			if (STROKED.has(glyph)) {
				g.strokeStyle = css(colour);
				strokeBox(g, glyph, ox, oy, metrics, !moved);
			} else if (glyph === "▌") {
				g.fillRect(ox, oy + metrics.ch * 0.08, metrics.cw * 0.55, metrics.ch * 0.84);
			} else {
				g.fillText(glyph, ox, oy + metrics.baseline);
			}
		};

		if (scale === 1) {
			paint(px, py);
		} else {
			g.save();
			g.translate(px + metrics.cw / 2, py + metrics.ch / 2);
			g.scale(scale, scale);
			paint(-metrics.cw / 2, -metrics.ch / 2);
			g.restore();
		}
	}

	g.shadowBlur = 0;
	g.globalAlpha = 1;
	if (effect.drawOver) {
		g.save();
		effect.drawOver(g, f);
		g.restore();
	}
	g.globalAlpha = 1;
	g.globalCompositeOperation = "source-over";
}
