import type { Component } from "@earendil-works/pi-tui";
import { arcColor, arcTrack, LABEL_LIGHT, type Light, shadeLine, waveEnabled } from "./prism-light.ts";
import { NOTCH } from "../models/model-label.ts";
import { fg, lerp, SGR_RESET } from "./rgb-color.ts";

/** Notches in the strip: the five-level slider's length and two more. */
export const THINKING_NOTCHES = 7;

/** The strip's plain text: its width, for layout. */
export const THINKING_STRIP = NOTCH.repeat(THINKING_NOTCHES);

const WAVE_PERIOD_MS = 2800;

const TROUGH = 0.18;

const THINKING_LIGHT: Light = { ...LABEL_LIGHT, tempo: 1 };

const WAVE = waveEnabled();

function crest(slot: number, now: number): number {
	const phase = now / WAVE_PERIOD_MS - slot / THINKING_NOTCHES;
	const up = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
	return TROUGH + (1 - TROUGH) * up * up;
}

/** The strip painted at `now`; still, at full hue, when the wave is switched off. */
export function paintThinkingStrip(now: number): string {
	const span = THINKING_NOTCHES - 1;
	let strip = "";
	for (let slot = 0; slot < THINKING_NOTCHES; slot++) {
		const at = slot / span;
		const color = WAVE ? lerp(arcTrack(at), arcColor(at), crest(slot, now)) : arcColor(at);
		strip += `${fg(color)}${NOTCH}${SGR_RESET}`;
	}
	return WAVE ? shadeLine(strip, now / 1000, "self", { light: THINKING_LIGHT }) : strip;
}

/** The transcript row: the strip after `pad` columns, repainted on every render. */
export class ThinkingStrip implements Component {
	constructor(private readonly pad: number) {}

	invalidate(): void {}

	render(width: number): string[] {
		const indent = " ".repeat(this.pad);
		if (width < this.pad + THINKING_NOTCHES) return [];
		try {
			return [indent + paintThinkingStrip(Date.now())];
		} catch {
			return [indent + THINKING_STRIP];
		}
	}
}
