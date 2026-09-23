/**
 * Renders the chrome at a range of widths and checks its invariants, without
 * booting a TUI. Run it with `./preview.sh`.
 *
 * The paint functions here are raw ANSI stand-ins for pi's theme, so what you
 * see is the layout, not the exact colours.
 */

import {
	type BottomLabels,
	bottomRule,
	contextReading,
	fit,
	formatCwd,
	isPlainRule,
	type Piece,
	rule,
	SIDE,
	TOP_ENDS,
} from "./chrome.ts";
import { FOLD_ENDS, foldRows } from "./fold.ts";
import { frame, INSET, MIN_WIDTH } from "./message.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HOME_GLYPH } from "../../lib/home-glyph.ts";
import { formatDuration } from "../../lib/turn-clock.ts";

const C = {
	dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
	muted: (s: string) => `\x1b[37m${s}\x1b[0m`,
	accent: (s: string) => `\x1b[34m${s}\x1b[0m`,
	warning: (s: string) => `\x1b[33m${s}\x1b[0m`,
	error: (s: string) => `\x1b[31m${s}\x1b[0m`,
	thinking: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const width = (s: string) => [...bare(s)].length;

const cwdPieces = (cwd: string): Piece[] => [{ text: formatCwd(cwd, "/Users/joel"), paint: C.accent }];
const sessionName = (name?: string): Piece[] => (name ? [{ text: ` • ${name}`, paint: C.dim }] : []);
const location = (cwd: string, name?: string): Piece[] => [...cwdPieces(cwd), ...sessionName(name)];

/** `opus ▱▱▱▱▱`: the family, then the effort as the one lit slot on the model's scale. */
const model = (id: string, slider: string): Piece[] => [
	{ text: id, paint: C.muted },
	// Atomic, like the live one: half a slider is a different, wrong reading.
	{ text: ` ${slider}`, paint: C.thinking, atomic: true },
];

const branch = (name?: string): Piece[] => (name ? [{ text: name, paint: C.accent }] : []);

/**
 * The turn timer, which owns the single space between it and the context
 * reading. Atomic: a clipped duration reads as a different, wrong duration.
 */
const timer = (label?: string): Piece[] => (label ? [{ text: `${label} `, paint: C.accent, atomic: true }] : []);

/** `❄12m` — the cache window, dropped first; owns its trailing space. */
const cache = (label?: string): Piece[] => (label ? [{ text: `${label} `, paint: C.dim, atomic: true }] : []);

/** `31.4k` — the context reading, the last label standing. */
const context = (percent: number | null): Piece[] => {
	// The preview drives everything off one percentage; 1% stands in for 1k tokens.
	const reading = contextReading(percent === null ? null : Math.round(percent * 1000), percent);
	const color = reading.level === "critical" ? C.error : reading.level === "warning" ? C.warning : C.dim;
	return [{ text: reading.label, paint: color, atomic: true }];
};

/**
 * `2 tasks ↓` — the count agent-dock publishes, let into the dashes. Atomic:
 * half a count with half an arrow is not an offer anyone can take up.
 */
const tasks = (label?: string): Piece[] => (label ? [{ text: label, paint: C.dim, atomic: true }] : []);

interface BoxOptions {
	cwd: string;
	name?: string;
	branch?: string;
	timer?: string;
	tasks?: string;
	pct?: number | null;
	cache?: string;
}

const bottomLabels = (opts: BoxOptions): BottomLabels => ({
	branch: branch(opts.branch),
	tasks: tasks(opts.tasks),
	timer: timer(opts.timer),
	cache: cache(opts.cache),
	context: context(opts.pct === undefined ? 31.4 : opts.pct),
	scroll: [],
});

/** Mirrors ChromeEditor.render: the editor lays out at width - 2, the frame closes it. */
function box(total: number, text: string, opts: BoxOptions): string[] {
	const inner = total - 2;
	const content = ` ${text}`.padEnd(inner, " ").slice(0, inner);
	return [
		rule(total, location(opts.cwd, opts.name), model("claude-opus-5", "▱▱▱▱▱"), C.dim, TOP_ENDS),
		C.dim(SIDE) + content + C.dim(SIDE),
		bottomRule(total, bottomLabels(opts), C.dim),
	];
}

/** `4m 10s` beside the task count: the longest-running background agent's elapsed time. */
const agentElapsed = (label?: string): Piece[] => (label ? [{ text: ` ${label}`, paint: C.accent, atomic: true }] : []);

/** Mirrors ChromeEditor.render with an empty prompt: the box folded to one row, or two. */
function folded(total: number, opts: BoxOptions & { agentElapsed?: string }): string[] {
	const labels = bottomLabels(opts);
	const taskPieces = labels.tasks.length > 0 ? [...labels.tasks, ...agentElapsed(opts.agentElapsed)] : [];
	return foldRows(
		total,
		{
			side: [],
			path: cwdPieces(opts.cwd),
			session: sessionName(opts.name),
			branch: labels.branch,
			model: model("opus", "▱▱▱"),
			timer: labels.timer,
			tasks: taskPieces,
			cache: labels.cache,
			context: labels.context,
		},
		C.dim,
	);
}

function show(total: number, text: string, opts: BoxOptions) {
	for (const line of box(total, text, opts)) console.log(line);
	console.log();
}

/**
 * Stands in for what pi hands the user-message wrapper: markdown wrapped to the
 * inner width, one column of gutter, and a blank row of padding top and bottom.
 */
function rendered(text: string, inner: number): string[] {
	const content = inner - 2;
	const rows: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line === "") line = word;
		else if (line.length + 1 + word.length > content) {
			rows.push(line);
			line = word;
		} else line += ` ${word}`;
	}
	if (line !== "") rows.push(line);
	return ["", ...rows.map((row) => ` ${row}`), ""].map((row) => row.padEnd(inner, " "));
}

const message = (total: number, text: string): string[] =>
	frame(rendered(text, total - INSET), total, [{ text: "User", paint: C.accent }], C.dim);

function showMessage(total: number, text: string) {
	const lines = message(total, text);
	for (const line of lines.length > 0 ? lines : rendered(text, total)) console.log(line);
	console.log();
}

console.log("\n=== 80 columns, typical ===\n");
show(80, "what should we do about the flaky test?", { cwd: "/Users/joel/code/pi", branch: "main" });

console.log("=== the cache window, once the turn is done ===\n");
for (const label of ["❄12m", "❄", "❄1h48m"]) {
	show(80, "…", { cwd: "/Users/joel/code/pi", branch: "main", timer: "1m 12s", cache: label });
}

console.log("=== fill levels ===\n");
for (const pct of [null, 0, 8.2, 50, 75, 96]) {
	show(80, "…", { cwd: "/Users/joel/code/pi", branch: "feat/context-reading", pct });
}

console.log("=== the turn timer, as a turn runs ===\n");
for (const ms of [0, 29_000, 30_000, 47_000, 60_000, 72_000, 124_000, 615_000]) {
	const label = ms < 30_000 ? undefined : formatDuration(ms);
	show(80, "…", { cwd: "/Users/joel/code/pi", branch: "main", timer: label });
}

console.log("=== the task count, in the rule ===\n");
for (const count of [undefined, "1 task ↓", "3 tasks ↓"]) {
	show(80, "…", { cwd: "/Users/joel/code/pi", branch: "main", tasks: count });
	show(80, "…", { cwd: "/Users/joel/code/pi", branch: "main", tasks: count, timer: "1m 12s" });
}

console.log("=== narrowing, two tasks running ===\n");
for (const total of [80, 70, 62, 56, 50, 44, 40, 34, 26, 18, 12, 6, 4]) {
	show(total, "…", {
		cwd: "/Users/joel/code/some/deeply/nested/project",
		branch: "main",
		timer: "1m 12s",
		tasks: "2 tasks ↓",
	});
}

console.log("=== narrowing, timer running ===\n");
for (const total of [70, 56, 44, 40, 39, 34, 31, 30, 26, 18, 12, 6, 4]) {
	show(total, "…", {
		cwd: "/Users/joel/code/some/deeply/nested/project",
		branch: "main",
		timer: "1m 12s",
	});
}

console.log("=== narrowing ===\n");
for (const total of [70, 56, 44, 34, 26, 18, 12, 6, 4]) {
	show(total, "…", { cwd: "/Users/joel/code/some/deeply/nested/project", branch: "main" });
}

console.log("=== edge cases ===\n");
show(80, "…", { cwd: "/etc/nginx" });
show(80, "…", { cwd: "/Users/joel", name: "refactor the footer", branch: "main" });

const FOLD_OPTS = {
	cwd: "/Users/joel/dotfiles",
	branch: "main",
	timer: "1m 12s",
	tasks: "2 tasks ↓",
	agentElapsed: "4m 10s",
	cache: "❄4m",
};
const FOLD_WIDTHS = [20, 40, 60, 80, 100, 120, 160, 200];

console.log("=== folded: the empty prompt ===\n");
for (const total of FOLD_WIDTHS) {
	console.log(`${total}:`);
	for (const line of folded(total, FOLD_OPTS)) console.log(line);
	console.log();
}

console.log("=== user message, same box ===\n");
showMessage(80, "what should we do about the flaky test?");
showMessage(
	80,
	"rewrite the footer so the branch and the turn timer hang off the bottom edge of the prompt instead of costing a row of their own",
);
for (const total of [40, 24, MIN_WIDTH, MIN_WIDTH - 1, 8]) showMessage(total, "frame or fall back?");

console.log("=== unit checks ===");
const checks: [string, boolean][] = [
	["formatCwd home", formatCwd("/Users/joel", "/Users/joel") === HOME_GLYPH],
	["formatCwd nested", formatCwd("/Users/joel/a/b", "/Users/joel") === `${HOME_GLYPH}/a/b`],
	["formatCwd is one column wide, like the tilde it replaces", visibleWidth(formatCwd("/Users/joel/a", "/Users/joel")) === 3],
	["formatCwd outside", formatCwd("/etc", "/Users/joel") === "/etc"],
	["formatCwd no home", formatCwd("/etc", undefined) === "/etc"],
	["formatCwd sibling prefix", formatCwd("/Users/joelx/a", "/Users/joel") === "/Users/joelx/a"],
	["fit drops tiny", fit([{ text: "abcdef" }], 3).length === 0],
	["fit truncates", fit([{ text: "abcdefghij" }], 6).length === 1],
	["fit keeps atomic whole", fit([{ text: "1m 12s", atomic: true }], 5).length === 0],
	["isPlainRule yes", isPlainRule("─".repeat(10), 10)],
	["isPlainRule colored", isPlainRule(C.dim("─".repeat(10)), 10)],
	["isPlainRule scroll", !isPlainRule("─── ↑ 3 more ───", 16)],
	["isPlainRule content", !isPlainRule("hello     ", 10)],
];

const bottom = (total: number, opts: Partial<BoxOptions> = {}) =>
	bare(bottomRule(total, bottomLabels({ cwd: "/Users/joel/code/pi", branch: "main", ...opts }), C.dim));

checks.push(["reading null", contextReading(null, null).label === "?"]);
checks.push([
	"reading tokens",
	contextReading(842, 1).label === "842" &&
		contextReading(31_400, 15).label === "31.4k" &&
		contextReading(1_250_000, 90).label === "1.3M",
]);
checks.push(["reading levels", contextReading(0, 95).level === "critical" && contextReading(0, 80).level === "warning" && contextReading(0, 50).level === "normal"]);
checks.push(["the timer sits left of the reading, which ends the rule", / 1m 12s 31\.4k ─╯$/.test(bottom(60, { timer: "1m 12s" }))]);
checks.push(["the cache window sits between the timer and the reading", / 1m 12s ❄12m 31\.4k ─╯$/.test(bottom(60, { timer: "1m 12s", cache: "❄12m" }))]);
checks.push(["the cache window goes before the timer does", !bottom(26, { timer: "1m 12s", cache: "❄12m" }).includes("❄") && bottom(26, { timer: "1m 12s", cache: "❄12m" }).includes("1m 12s")]);
checks.push(["the reading outlives the branch", bottom(12).includes(" 31.4k ") && !bottom(12).includes("main")]);
checks.push(["timer goes before the branch does", !bottom(24, { timer: "1m 12s" }).includes("1m 12s")]);
checks.push(["branch outlives the timer", bottom(24, { timer: "1m 12s" }).includes(" main ")]);
checks.push(["timer vanishes rather than truncating", !bottom(24, { timer: "1m 12s" }).includes("\u2026")]);

// The task count: a middle label, dashes either side, right of the branch and
// left of the cluster — and gone entirely before it could ever be clipped.
const tasked80 = bottom(80, { timer: "1m 12s", tasks: "2 tasks ↓" });
checks.push(["tasks fit an 80-column rule beside the clock", /main ─+ 2 tasks ↓ ─+ 1m 12s 31\.4k ─╯$/.test(tasked80)]);
checks.push(["tasks sit between the branch and the timer", tasked80.indexOf("2 tasks") > tasked80.indexOf("main") && tasked80.indexOf("2 tasks") < tasked80.indexOf("1m 12s")]);
checks.push(["a dash separates the tasks label from the cluster", / 2 tasks ↓ ─+ 1m 12s /.test(tasked80)]);
checks.push(["nothing is drawn for no tasks", !bottom(80, { timer: "1m 12s" }).includes("task")]);
checks.push(["one task reads singular", bottom(80, { tasks: "1 task ↓" }).includes(" 1 task ↓ ")]);
checks.push(["the timer goes before the tasks do", !bottom(34, { timer: "1m 12s", tasks: "2 tasks ↓" }).includes("1m 12s") && bottom(34, { timer: "1m 12s", tasks: "2 tasks ↓" }).includes("2 tasks ↓")]);
checks.push(["tasks go before the branch is squeezed", !bottom(24, { tasks: "2 tasks ↓" }).includes("task") && bottom(24, { tasks: "2 tasks ↓" }).includes(" main ")]);
checks.push(["tasks vanish rather than truncating", !bottom(24, { tasks: "2 tasks ↓" }).includes("\u2026")]);

let widthOk = true;
let cornersOk = true;
for (const total of [4, 5, 8, 13, 21, 34, 55, 89, 144]) {
	for (const timerLabel of [undefined, "47s", "1m 12s", "10m 04s"]) {
		for (const taskLabel of [undefined, "1 task ↓", "12 tasks ↓"]) {
		for (const line of box(total, "hello", {
			cwd: "/Users/joel/code/pi",
			name: "sess",
			branch: "main",
			tasks: taskLabel,
			timer: timerLabel,
		})) {
			if (width(line) !== total) {
				widthOk = false;
				console.log(
					`  width ${total} timer=${timerLabel} tasks=${taskLabel} produced ${width(line)}: ${JSON.stringify(bare(line))}`,
				);
			}
		}
		}
	}
	const [top, , bot] = box(total, "hello", { cwd: "/Users/joel/code/pi", branch: "main" });
	const t = bare(top ?? "");
	const b = bare(bot ?? "");
	if (!t.startsWith("╭") || !t.endsWith("╮") || !b.startsWith("╰") || !b.endsWith("╯")) cornersOk = false;
}
checks.push(["box lines are exactly the given width", widthOk]);

let foldOk = true;
for (let total = 2; total <= 220; total++) {
	for (const opts of [FOLD_OPTS, { cwd: "/Users/joel/code/some/deeply/nested/project" }, { cwd: "/etc", branch: "feat/very-long-branch-name" }]) {
		const rows = folded(total, opts);
		for (const line of rows) {
			const row = bare(line);
			if (line.includes("\n") || width(line) !== total || !row.startsWith(FOLD_ENDS.left) || !row.endsWith(FOLD_ENDS.right)) {
				foldOk = false;
				console.log(`  folded at ${total} produced ${width(line)}: ${JSON.stringify(row)}`);
			}
		}
		if (rows.length < 1 || rows.length > 2) foldOk = false;
	}
}
checks.push(["folded is one or two capped rows, each exactly the given width", foldOk]);
const foldedAt = (total: number) => folded(total, FOLD_OPTS).map(bare);
checks.push(["folded is one row when every reading fits", foldedAt(200).length === 1 && /dotfiles-main ─+ opus ▱▱▱ ─+ 1m 12s ─+ 2 tasks ↓ 4m 10s ─+ ❄4m ─+ 31\.4k ─{1,6}╴$/.test(foldedAt(200)[0] ?? "")]);
checks.push(["folded wraps to two rows, in order, when one cannot hold them", foldedAt(60).length === 2 && foldedAt(60).join("\n").includes("31.4k") && foldedAt(60)[0]?.includes("main") === true]);
checks.push(["folded keeps the path when all else has gone", foldedAt(20)[0]?.includes("dotfiles") === true]);

let messageWidthOk = true;
for (const total of [MIN_WIDTH, 21, 34, 55, 89, 144]) {
	const lines = message(total, "a message long enough to wrap at least once at any of these widths");
	if (lines.length < 3) messageWidthOk = false;
	for (const line of lines) {
		if (width(line) !== total) {
			messageWidthOk = false;
			console.log(`  message width ${total} produced ${width(line)}: ${JSON.stringify(bare(line))}`);
		}
	}
}
checks.push(["message lines are exactly the given width", messageWidthOk]);
checks.push(["message frame is labelled", bare(message(40, "hi")[0] ?? "").startsWith("╭─ User ─")]);
checks.push(["message padding rows are dropped", message(40, "hi").length === 3]);
checks.push(["message declines when too narrow", message(MIN_WIDTH - 1, "hi").length === 0]);
checks.push(["message declines when empty", frame(["    ", "    "], 40, [], C.dim).length === 0]);
checks.push(["corners at every width", cornersOk]);

for (const [name, ok] of checks) console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
