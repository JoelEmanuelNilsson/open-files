/**
 * Animated preview of the chrome's light, in the active theme's colours, on all
 * four surfaces that use it: the box outline while a request is in flight, the
 * model label while a fresh session's first request would read its prefix from
 * cache, a background task's row while its agent works, and the header of a
 * tool call that is still running.
 *
 * It drives `prism.ts` itself rather than a copy, so what is previewed here is
 * what ships. Run via `./test.sh`; Ctrl+C stops it. `ROWS=4 ./test.sh` previews
 * a taller box.
 *
 * `PI_ZEN_SURFACE=light ./test.sh` previews the other terminal without flipping
 * macOS appearance: the same variable the prism reads, plus pi's own light
 * theme for the resting colours and a paper background painted behind every
 * row. All three have to move together or the preview is a lie — a light-mode
 * foil judged against dark-theme text on an ink background says nothing about
 * either terminal.
 *
 * Only an interactive terminal gets the run-forever demo: without a TTY (an
 * agent's shell, CI, a pipe) it renders a couple of seconds of frames and
 * exits, so automation can never hang on it. `DEMO_FRAMES=n` bounds it anywhere.
 */

import { FADE_MS, fg, FRAME_MS, rgbFromPainted } from "./animate.ts";
import { BOTTOM_ENDS, insignia, type Piece, rule, SIDE, TOP_ENDS } from "./chrome.ts";
import { arcColor, arcTrack, CALL_LIGHT, driftColor, isNotFrame, LABEL_LIGHT, ROW_LIGHT, shadeBox, shadeLine } from "./prism.ts";
import { effortSlider, paintSlider, type ThinkingScale } from "./model-label.ts";
import { greyOut, WAKE_MS, wakeAt } from "./wake.ts";
import { HOME_GLYPH } from "../../lib/home-glyph.ts";

// The live chrome reads its colours off `ctx.ui.theme`, which only exists inside
// a session; standing pi's global theme up by hand is the only way a standalone
// preview can show the same hues instead of a second, invented palette.
const piTheme = await import(`${process.env.PI_ROOT ?? ""}/dist/modes/interactive/theme/theme.js`);

/**
 * Which terminal to preview. The prism itself reads this too, and answers from
 * the terminal's own background when it is unset — but the preview has no TUI to
 * ask through, so unset here means the surface the light was tuned on.
 */
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
	// The ghost, in both the places the live chrome puts it: standing in for `~`
	// in the path, and on its own as the mark let into the rule. The light
	// carries it like the outline, so a preview without it cannot show that.
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

/**
 * The effort slider through the chrome's own painter, so the preview cannot
 * drift from the rule the way it did while the notches were painted here by
 * hand (2026-09-12).
 */
function slider(scale: ThinkingScale): string {
	return paintSlider(scale, (at, lit) => fg(lit ? arcColor(at) : arcTrack(at)));
}

/** The reading the preview stands in for: the third of five levels. */
const SCALE: ThinkingScale = { index: 2, count: 5 };

/**
 * The label wearing the drift mark: the level has moved since the request that
 * filled the cache, and moving it rewrites the conversation. The mark walks the
 * arc on its own clock, which is why it takes real time rather than the frame's.
 */
function drifted(): string {
	return `${paint("muted")("opus")} ${slider(SCALE)}${fg(driftColor(Date.now()))}+\x1b[0m`;
}

/**
 * The model label: the family and the effort slider, painted first and then lit
 * as one field, each glyph keeping its own colour under it. `fade` 0..1 is how
 * far the light has left it.
 */
function label(t: number, fade = 0): string {
	return shadeLine(`${paint("muted")("opus")} ${slider(SCALE)}`, t, "self", { light: LABEL_LIGHT, fade });
}

/**
 * The box as a session opens it: grey, then lit, then at rest. Looped with a
 * pause on the end so the resting bar — which is most of what the wake is for
 * — is on screen long enough to compare the two against each other.
 */
const WAKE_LOOP_MS = WAKE_MS + 1500;

function waking(elapsedMs: number): string[] {
	const at = elapsedMs % WAKE_LOOP_MS;
	const stage = wakeAt(0, at);
	if (stage === null) return BASE;
	return greyOut(shadeBox(BASE, at / 1000, { tint: isNotFrame, fade: 1 - stage.light }), stage.grey);
}

/** Seconds between the level changes the flash row stands in for. */
const FLASH_PERIOD = 3;

/** How far the flash has faded at `t`: lit at each change, gone `FADE_MS` later. */
function flashFade(t: number): number {
	return Math.min(1, ((t % FLASH_PERIOD) * 1000) / FADE_MS);
}

const width = Math.min((process.stdout.columns ?? 80) - 2, 100);
const rows = Math.max(1, Math.min(8, Number(process.env.ROWS) || 1));
const BASE = box(width, rows);
const ROW = "  worker  fixing the failing test  opus  2m 04s";
// A label's length, so it takes the label light rather than the row's.
const TASKS = "2 tasks \u2193";
// Three colours on one line, the way a live tool row is painted: `"self"` has to
// carry each of them as its own resting colour.
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
const timer = setInterval(() => {
	const t = (Date.now() - start) / 1000;
	const out = [
		dim("  the box, while a request is in flight"),
		...shadeBox(BASE, t),
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
	// Home the cursor and erase to end of line on every row, so a previous run's
	// frames cannot be left on screen underneath this one. The erase runs while
	// the paper is still the active background, so it fills the rest of the row
	// with paper rather than punching the terminal's own colour through it.
	process.stdout.write(`\x1b[H${out.join("\x1b[K\n")}\x1b[K\x1b[0m`);
	if (++frames >= budget) {
		clearInterval(timer);
		stop(0);
	}
}, FRAME_MS);
