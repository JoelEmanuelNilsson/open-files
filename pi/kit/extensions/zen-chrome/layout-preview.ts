import { type Piece, rule, SIDE, stripAnsi, TOP_ENDS } from "../../lib/ui/labelled-rule.ts";
import { type BottomLabels, bottomRule, contextReading, formatCwd } from "./prompt-box-rules.ts";
import { foldRows } from "./fold.ts";
import { frameUserMessageBox, INSET, MIN_WIDTH } from "./user-message-box.ts";
import { formatDuration } from "../../lib/ui/duration-label.ts";

const C = {
	dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
	muted: (s: string) => `\x1b[37m${s}\x1b[0m`,
	accent: (s: string) => `\x1b[34m${s}\x1b[0m`,
	warning: (s: string) => `\x1b[33m${s}\x1b[0m`,
	error: (s: string) => `\x1b[31m${s}\x1b[0m`,
	thinking: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const width = (s: string) => [...stripAnsi(s)].length;

const cwdPieces = (cwd: string): Piece[] => [{ text: formatCwd(cwd, "/Users/joel"), paint: C.accent }];
const sessionName = (name?: string): Piece[] => (name ? [{ text: ` • ${name}`, paint: C.dim }] : []);
const location = (cwd: string, name?: string): Piece[] => [...cwdPieces(cwd), ...sessionName(name)];

const model = (id: string, slider: string): Piece[] => [
	{ text: id, paint: C.muted },
	{ text: ` ${slider}`, paint: C.thinking, atomic: true },
];

const branch = (name?: string): Piece[] => (name ? [{ text: name, paint: C.accent }] : []);

const timer = (label?: string): Piece[] => (label ? [{ text: `${label} `, paint: C.accent, atomic: true }] : []);

const cache = (label?: string): Piece[] => (label ? [{ text: `${label} `, paint: C.dim, atomic: true }] : []);

const context = (percent: number | null): Piece[] => {
	const reading = contextReading(percent === null ? null : Math.round(percent * 1000), percent);
	const color = reading.level === "critical" ? C.error : reading.level === "warning" ? C.warning : C.dim;
	return [{ text: reading.label, paint: color, atomic: true }];
};

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

function box(total: number, text: string, opts: BoxOptions): string[] {
	const inner = total - 2;
	const content = ` ${text}`.padEnd(inner, " ").slice(0, inner);
	return [
		rule(total, location(opts.cwd, opts.name), model("claude-opus-5", "▱▱▱▱▱"), C.dim, TOP_ENDS),
		C.dim(SIDE) + content + C.dim(SIDE),
		bottomRule(total, bottomLabels(opts), C.dim),
	];
}

const agentElapsed = (label?: string): Piece[] => (label ? [{ text: ` ${label}`, paint: C.accent, atomic: true }] : []);

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
	frameUserMessageBox(rendered(text, total - INSET), total, [{ text: "User", paint: C.accent }], C.dim);

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
