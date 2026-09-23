/** PROTOTYPE — throwaway. Colour arithmetic. */

import type { Rgb } from "./types.ts";

export function rgb(r: number, g: number, b: number): Rgb {
	return { r, g, b };
}

export function hex(value: string): Rgb {
	const n = Number.parseInt(value.replace("#", ""), 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function css(c: Rgb, alpha = 1): string {
	const r = Math.round(clamp(c.r, 0, 255));
	const g = Math.round(clamp(c.g, 0, 255));
	const b = Math.round(clamp(c.b, 0, 255));
	return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

export function lerp(a: Rgb, b: Rgb, t: number): Rgb {
	const k = clamp(t, 0, 1);
	return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return lerp(a, b, t);
}

export function scale(c: Rgb, k: number): Rgb {
	return { r: c.r * k, g: c.g * k, b: c.b * k };
}

export function add(a: Rgb, b: Rgb): Rgb {
	return { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
}

export function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/** 0..1 through a three-stop ramp: base → hot at 0.75, hot → peak above it. */
export function ramp(base: Rgb, hot: Rgb, peak: Rgb, intensity: number): Rgb {
	const t = clamp(intensity, 0, 1);
	return t <= 0.75 ? lerp(base, hot, t / 0.75) : lerp(hot, peak, (t - 0.75) / 0.25);
}

/** h 0..360, s 0..1, l 0..1 */
export function hsl(h: number, s: number, l: number): Rgb {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
	};
	return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}
