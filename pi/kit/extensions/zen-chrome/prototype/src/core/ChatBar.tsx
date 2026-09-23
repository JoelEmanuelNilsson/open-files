/** PROTOTYPE — throwaway. One animated chatbar: a canvas, a clock, and one effect instance. */

import { useEffect, useMemo, useRef } from "react";
import { buildBox, DEFAULT_LABELS, type Labels } from "./geometry.ts";
import { renderFrame } from "./render.ts";
import type { Effect, Frame, Metrics, Palette } from "./types.ts";

export interface ChatBarProps {
	effect: Effect;
	palette: Palette;
	cols: number;
	rows: number;
	/** Font size in px; cell size derives from it. */
	size: number;
	working: boolean;
	speed: number;
	intensity: number;
	bloom: number;
	params: Record<string, number>;
	labels?: Labels;
	/** Frames per second cap — the contact sheet runs slower than focus mode. */
	fps?: number;
	paused?: boolean;
}

const FONT_STACK = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';

function metricsFor(size: number, cols: number, rows: number): Metrics {
	// A terminal cell: the font's advance width, and a line height near 1.3.
	const cw = Math.round(size * 0.6 * 100) / 100;
	const ch = Math.round(size * 1.32 * 100) / 100;
	const bleed = Math.round(size * 3);
	return {
		cw,
		ch,
		lw: Math.max(1, Math.round(size / 14)),
		bleed,
		width: cols * cw + bleed * 2,
		height: rows * ch + bleed * 2,
		baseline: ch / 2 + size * 0.35,
		font: `${size}px ${FONT_STACK}`,
	};
}

export function ChatBar(props: ChatBarProps) {
	const { effect, palette, cols, rows, size, working, speed, intensity, bloom, params, fps = 60, paused } = props;
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const metrics = useMemo(() => metricsFor(size, cols, rows), [size, cols, rows]);
	const box = useMemo(() => buildBox(cols, rows, props.labels ?? DEFAULT_LABELS, palette), [cols, rows, props.labels, palette]);

	// The instance owns particle systems and integrators, so it must survive re-renders
	// and be rebuilt only when the effect itself changes.
	const instance = useMemo(() => effect.create(), [effect]);
	const live = useRef({ working, speed, intensity, bloom, params, palette, box, metrics, paused });
	live.current = { working, speed, intensity, bloom, params, palette, box, metrics, paused };

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const g = canvas.getContext("2d");
		if (!g) return;

		let raf = 0;
		let last = performance.now();
		let scaled = 0;
		let workingSince: number | null = null;
		let settledAt: number | null = null;
		let acc = 0;
		const interval = 1000 / fps;

		const loop = (now: number) => {
			raf = requestAnimationFrame(loop);
			const realDt = Math.min(now - last, 100);
			last = now;
			acc += realDt;
			if (acc < interval) return;
			acc = 0;

			const s = live.current;
			const dt = (realDt / 1000) * s.speed;
			if (!s.paused) scaled += dt;

			if (s.working && workingSince === null) {
				workingSince = scaled;
				settledAt = null;
			}
			if (!s.working && workingSince !== null) {
				workingSince = null;
				settledAt = scaled;
			}

			const dpr = window.devicePixelRatio || 1;
			const m = s.metrics;
			if (canvas.width !== Math.round(m.width * dpr)) {
				canvas.width = Math.round(m.width * dpr);
				canvas.height = Math.round(m.height * dpr);
				canvas.style.width = `${m.width}px`;
				canvas.style.height = `${m.height}px`;
			}

			const frame: Frame = {
				t: scaled,
				dt: s.paused ? 0 : dt,
				since: workingSince === null ? 0 : scaled - workingSince,
				working: s.working,
				settled: settledAt === null ? null : scaled - settledAt,
				box: s.box,
				metrics: m,
				palette: s.palette,
				intensity: s.intensity,
				params: s.params,
			};

			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			renderFrame(g, frame, instance, s.bloom);
		};

		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [instance, fps]);

	return <canvas ref={canvasRef} style={{ display: "block", borderRadius: 6 }} />;
}
