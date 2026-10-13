import { fg, rgbFromPainted, SGR_RESET } from "../../lib/ui/rgb-color.ts";
import { BOTTOM_ENDS, type Piece, rule, SIDE, TOP_ENDS } from "../../lib/ui/labelled-rule.ts";
import { insignia } from "./prompt-box-rules.ts";
import {
	arcColor,
	arcTrack,
	CALL_LIGHT,
	driftColor,
	FADE_MS,
	FRAME_MS,
	isNotFrame,
	LABEL_LIGHT,
	ONE_HUE,
	ROW_LIGHT,
	shadeBox,
	shadeLine,
} from "../../lib/ui/prism-light.ts";
import { effortSlider, paintSlider, type ThinkingScale } from "../../lib/models/model-label.ts";
import { greyOut, WAKE_MS, wakeAt } from "./box-wake.ts";
import { HOME_GLYPH } from "../../lib/ui/home-glyph.ts";

const piTheme = await import(`${process.env.PI_ROOT ?? ""}/dist/modes/interactive/theme/theme.js`);

const LIGHT = (process.env.PI_ZEN_SURFACE ?? "").toLowerCase() === "light";
piTheme.initTheme(LIGHT ? "light" : undefined, false);
const theme: { fg: (color: string, text: string) => string } = piTheme.theme;


const paint =
	(color: string) =>
	(text: string): string =>
		theme.fg(color, text);
const dim = paint("dim");
const border = paint("border");

const rest = (color: string) => rgbFromPainted(theme.fg(color, "x")) ?? { r: 128, g: 128, b: 128 };

function box(width: number, rows: number): string[] {
	const location: Piece[] = [{ text: `${HOME_GLYPH}/dotfiles`, paint: paint("accent") }];
	const model: Piece[] = [
		{ text: "opus", paint: paint("muted") },
		{ text: ` ${effortSlider(SCALE)}`, paint: () => ` ${slider(SCALE)}`, atomic: true },
	];
	const branch: Piece[] = [{ text: "loading-animations", paint: paint("accent") }];
	const timer: Piece[] = [{ text: "1m 12s", paint: paint("accent"), atomic: true }];

	const messages = ["so how do we make the outline feel alive while you work?", "", "", ""];
	const inner = width - 2;
	const content = (text: string) => border(SIDE) + ` ${text}`.padEnd(inner, " ").slice(0, inner) + border(SIDE);
	return [
		rule(width, location, model, border, TOP_ENDS, insignia(border)),
		...Array.from({ length: rows }, (_, i) => content(messages[i] ?? "")),
		rule(width, branch, timer, border, BOTTOM_ENDS),
	];
}

function slider(scale: ThinkingScale): string {
	return paintSlider(scale, (at, lit) => fg(lit ? arcColor(at) : arcTrack(at)));
}

const SCALE: ThinkingScale = { index: 2, count: 5 };

function drifted(): string {
	return `${paint("muted")("opus")} ${slider(SCALE)}${fg(driftColor(Date.now()))}+${SGR_RESET}`;
}

function label(t: number, fade = 0): string {
	return shadeLine(`${paint("muted")("opus")} ${slider(SCALE)}`, t, "self", { light: LABEL_LIGHT, fade });
}

const WAKE_LOOP_MS = WAKE_MS + 1500;

function waking(elapsedMs: number): string[] {
	const at = elapsedMs % WAKE_LOOP_MS;
	const stage = wakeAt(0, at);
	if (stage === null) return BASE;
	return greyOut(shadeBox(BASE, at / 1000, { light: ONE_HUE, tint: isNotFrame, fade: 1 - stage.light }), stage.grey);
}

const FLASH_PERIOD = 3;

function flashFade(t: number): number {
	return Math.min(1, ((t % FLASH_PERIOD) * 1000) / FADE_MS);
}

const width = Math.min((process.stdout.columns ?? 80) - 2, 100);
const rows = Math.max(1, Math.min(8, Number(process.env.ROWS) || 1));
const BASE = box(width, rows);
const ROW = "  worker  fixing the failing test  opus  2m 04s";
const TASKS = "2 tasks \u2193";
const CALL = `  ${dim("●")} ${paint("toolTitle")("bash")}${paint("muted")("(")}${paint("accent")('rg -n "shadeLine" --type ts')}${paint("muted")(")")}`;

const budget = Number(process.env.DEMO_FRAMES) || (process.stdout.isTTY ? Infinity : 60);
const TOTAL = 2 * BASE.length + 21;

process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
const stop = (code: number) => {
	process.stdout.write(`\x1b[${TOTAL}H\x1b[?25h\n`);
	process.exit(code);
};
process.on("SIGINT", () => stop(0));

const start = Date.now();
let frames = 0;
// raw-timer: the chrome's preview script, run by light-preview.sh; pi never loads it
const timer = setInterval(() => {
	const t = (Date.now() - start) / 1000;
	const out = [
		dim("  the box, while a request is in flight"),
		...shadeBox(BASE, t, { light: ONE_HUE }),
		"",
		dim("  the model label, while the next request would read its prefix from cache"),
		`  ${label(t)}`,
		"",
		dim(`  the model label, for ${FADE_MS}ms after the effort level changes`),
		`  ${label(t, flashFade(t))}`,
		"",
		dim("  the model label, while the level sits away from the one the cache was written at"),
		`  ${drifted()}`,
		"",
		dim("  a background task's row, while its agent works"),
		shadeLine(dim(ROW), t, rest("dim"), { light: ROW_LIGHT }),
		"",
		dim("  the task count in the bottom rule, while an agent works"),
		`  ${shadeLine(dim(TASKS), t, "self", { light: LABEL_LIGHT })}`,
		"",
		dim("  a tool call's header, while the command runs"),
		shadeLine(CALL, t, "self", { light: CALL_LIGHT }),
		"",
		dim("  the box, as a session opens it"),
		...waking(Date.now() - start),
	];
	process.stdout.write(`\x1b[H${out.join("\x1b[K\n")}\x1b[K\x1b[0m`);
	if (++frames >= budget) {
		clearInterval(timer);
		stop(0);
	}
}, FRAME_MS);
