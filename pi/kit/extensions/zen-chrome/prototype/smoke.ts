/** PROTOTYPE — throwaway. Runs every effect for 300 frames against a stub canvas to catch throws. */

import { readdirSync } from "node:fs";
import { buildBox, DEFAULT_LABELS } from "./src/core/geometry.ts";
import { DEFAULT_THEME } from "./src/core/palettes.ts";
import { renderFrame } from "./src/core/render.ts";
import type { Effect, Frame, Metrics } from "./src/core/types.ts";

const stub = new Proxy(
	{
		canvas: { width: 900, height: 200 },
		createLinearGradient: () => grad,
		createRadialGradient: () => grad,
		createPattern: () => null,
		measureText: () => ({ width: 8 }),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
	} as Record<string, unknown>,
	{ get: (t, k) => (k in t ? t[k as string] : () => undefined), set: () => true },
) as unknown as CanvasRenderingContext2D;
const grad = { addColorStop: () => undefined };

const metrics: Metrics = { cw: 9, ch: 22, bleed: 45, width: 1200, height: 200, baseline: 16, font: "15px monospace" };
const box = buildBox(118, 4, DEFAULT_LABELS, DEFAULT_THEME.palette);

let failures = 0;
for (const file of readdirSync("./src/effects").sort()) {
	const mod = (await import(`./src/effects/${file}`)) as { default: Effect };
	const effect = mod.default;
	const params: Record<string, number> = {};
	for (const p of effect.params ?? []) params[p.key] = p.value;
	const instance = effect.create();
	try {
		for (let i = 0; i < 300; i++) {
			const t = i / 60;
			const frame: Frame = {
				t,
				dt: 1 / 60,
				since: i < 200 ? t : 0,
				working: i < 200,
				settled: i < 200 ? null : t - 200 / 60,
				box,
				metrics,
				palette: DEFAULT_THEME.palette,
				intensity: 1,
				params,
			};
			renderFrame(stub, frame, instance, 0);
		}
		console.log(`ok    ${effect.id.padEnd(14)} ${file}`);
	} catch (error) {
		failures++;
		console.log(`THROW ${effect.id.padEnd(14)} ${file}: ${(error as Error).message}`);
	}
}
console.log(failures === 0 ? "\nall effects survived 300 frames" : `\n${failures} effect(s) threw`);
