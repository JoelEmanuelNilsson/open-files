import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
// Widths must be measured the way the TUI measures them: ANSI is free, wide
// characters are not. `.length` is neither.
const { visibleWidth } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/utils.js`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
// pi's own keybinding formatter paints through pi's global theme, so a hint
// asked for before `initTheme` throws. A session has one long before any
// extension draws; this stands in for that.
const piTheme = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
piTheme.initTheme("dark", false);
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const theme = {
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
	dim: (t) => t,
	inverse: (t) => t,
	strikethrough: (t) => t,
};

let pass = 0;
let fail = 0;
const show = (label, fn) => {
	try {
		const out = fn();
		console.log(`--- ${label}\n${out}`);
		pass++;
	} catch (e) {
		fail++;
		console.log(`--- ${label}\nTHREW: ${e.message}\n${e.stack.split("\n").slice(1, 3).join("\n")}`);
	}
};

const tools = new Map();
const api = {
	registerTool: (t) => tools.set(t.name, t),
	registerCommand: () => {},
	registerEntryRenderer: () => {},
	registerShortcut: () => {},
	appendEntry: () => {},
	on: () => {},
	events: { on: () => {}, emit: () => {} },
};

await (await jiti.import(`${ROOT}/extensions/multi-edit.ts`, { default: true }))(api);

const edit = tools.get("edit");
const editResult = {
	content: [{ type: "text", text: "Edited a.ts" }],
	details: {
		diff: [" 1 keep", "-2 old line", "+2 new line", " 3 keep"].join("\n"),
		patch: "@@",
		firstChangedLine: 2,
	},
};
show("edit renderCall", () => edit.renderCall({ path: "src/a.ts", edits: [1, 2] }, theme, {}).render(70).join("\n"));
show("edit renderCall files", () => edit.renderCall({ files: [{ path: "a.ts", edits: [1] }, { path: "b.ts", edits: [1, 2] }] }, theme, {}).render(70).join("\n"));
show("edit renderResult", () => edit.renderResult(editResult, { expanded: false }, theme, {}).render(80).join("\n"));

const big = { ...editResult, details: { ...editResult.details, diff: Array.from({ length: 40 }, (_, i) => `+${i} line`).join("\n") } };
show("edit renderResult truncated", () => edit.renderResult(big, { expanded: false }, theme, {}).render(80).join("\n").split("\n").slice(-2).join("\n"));

// ---------------------------------------------------------------------------
// Split diff: the same edit at the widths a herdr pane actually hands us.
// ---------------------------------------------------------------------------

const diffs = {
	"one-line change": [
		" 276         invalidate() {",
		" 277             cachedLines = undefined;",
		" 278             cachedWidth = undefined;",
		"-279         }",
		"+279         },",
		" 280         handleInput(data: string) {",
		" 281     };",
	].join("\n"),
	"long line": [
		" 41  const registry = new ModelRegistry(settings);",
		"-42    const resolved = await resolveModelScopeWithDiagnostics(registry, cliModel, { allowFallback: true });",
		"+42    const resolved = await resolveModelScopeWithDiagnostics(registry, cliModel, { allowFallback: true, warn: true });",
		" 43  if (!resolved.ok) throw new Error(resolved.diagnostic);",
	].join("\n"),
	"uneven block": [
		" 10  function build(opts) {",
		"-11    const a = 1;",
		"-12    const b = 2;",
		"+11    const a = 1;",
		"+12    const b = 22;",
		"+13    const c = 3;",
		" 14    return a + b;",
	].join("\n"),
	"pure insertion": [" 7   const x = 1;", "+8     const y = 2;", "+9     const z = 3;", " 10  return x;"].join("\n"),
	// Wide characters cost two columns each; `.length` would lie about all of these.
	"wide characters": [
		" 3   const labels = {",
		'-4     greeting: "こんにちは世界",',
		'+4     greeting: "こんばんは世界 🌙",',
		" 5   };",
	].join("\n"),
	"two files": [
		"File: a.ts",
		" 1 keep",
		"-2 const a = 1;",
		"+2 const a = 2;",
		"",
		"File: b.ts",
		" 5 keep",
		"-6 return null;",
		"+6 return undefined;",
	].join("\n"),
};

// The pi pane in a herdr split, the pane beside it, and the tab zoomed.
const WIDTHS = [59, 97, 161];

for (const [label, diff] of Object.entries(diffs)) {
	for (const width of WIDTHS) {
		show(`diff "${label}" @ ${width}`, () => {
			const lines = edit
				.renderResult({ content: [], details: { diff, patch: "", firstChangedLine: 1 } }, { expanded: true }, theme, {})
				.render(width);
			const pad = (l) => l + " ".repeat(Math.max(0, width - visibleWidth(l)));
			return ["┌" + "─".repeat(width) + "┐", ...lines.map((l) => "│" + pad(l) + "│"), "└" + "─".repeat(width) + "┘"].join("\n");
		});
	}
}

// ---------------------------------------------------------------------------
// The contract: the TUI composites on "no line exceeds width". Prove it holds
// at every width from unusably narrow to wide, in every mode, for every fixture.
// ---------------------------------------------------------------------------

const overflows = [];
for (const mode of ["auto", "split", "unified"]) {
	process.env.PI_DIFF_MODE = mode;
	for (const [label, diff] of Object.entries(diffs)) {
		for (let width = 4; width <= 200; width++) {
			for (const expanded of [true, false]) {
				const lines = edit
					.renderResult({ content: [], details: { diff, patch: "", firstChangedLine: 1 } }, { expanded }, theme, {})
					.render(width);
				for (const line of lines) {
					const shown = visibleWidth(line);
					if (shown > width) overflows.push(`${mode}/${label}/@${width}: ${shown} cols in ${JSON.stringify(line)}`);
				}
			}
		}
	}
}
delete process.env.PI_DIFF_MODE;

if (overflows.length > 0) {
	fail++;
	console.log(`--- width contract\n${overflows.length} overflowing line(s):\n  ${overflows.slice(0, 5).join("\n  ")}`);
} else {
	pass++;
	const fixtures = Object.keys(diffs).length;
	console.log(
		`--- width contract\nno line exceeds its width (3 modes × ${fixtures} diffs × widths 4-200 × collapsed/expanded)`,
	);
}

// ---------------------------------------------------------------------------
// The turn timer: the state table, the formatter, and the bottom rule's drop
// priority. All pure, so none of it needs pi, a TUI, or a session — which is
// the whole reason the rules live in `lib/turn-clock.ts` and the pure chrome
// module rather than in the extension body.
// ---------------------------------------------------------------------------

const check = (name, ok, detail = "") => {
	if (ok) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
	}
};

const { FLOOR_MS, IDLE, elapsedMs, formatDuration, readTurn, reduceTurn } = await jiti.import(
	`${ROOT}/lib/turn-clock.ts`,
);
const { bottomRule, contextReading, insignia, rule, scrollIndicator, TOP_ENDS } = await jiti.import(`${ROOT}/extensions/zen-chrome/chrome.ts`);

console.log("\n--- turn clock: the state table");

// Driven on a clock we control, so "thirty seconds later" is exact and no test
// ever sleeps. Assertions are on what the clock *says*, never on its fields.
const T0 = 1_700_000_000_000;
const at = (ms) => T0 + ms;
const drive = (events) => events.reduce((clock, [event, ms]) => reduceTurn(clock, event, at(ms)), IDLE);
const phaseAt = (clock, ms) => readTurn(clock, at(ms)).phase;
const labelAt = (clock, ms) => readTurn(clock, at(ms)).label;

check("idle shows nothing", phaseAt(IDLE, 0) === "empty" && labelAt(IDLE, 0) === "");

const running = drive([["turn_start", 0]]);
check("a turn still under the floor shows nothing", phaseAt(running, FLOOR_MS - 1) === "empty");
check(
	"and goes live exactly at the floor",
	phaseAt(running, FLOOR_MS) === "live" && labelAt(running, FLOOR_MS) === "30s",
	JSON.stringify(readTurn(running, at(FLOOR_MS))),
);

const settled = reduceTurn(running, "turn_settled", at(72_000));
check(
	"settling past the floor holds the final figure",
	phaseAt(settled, 72_000) === "held" && labelAt(settled, 72_000) === "1m 12s",
	JSON.stringify(readTurn(settled, at(72_000))),
);
check("and the held figure stops moving", labelAt(settled, 900_000) === "1m 12s");

// The floor gates the held value as well as the live one: a short turn leaves
// nothing behind, not even after the fact.
const brief = drive([
	["turn_start", 0],
	["turn_settled", 12_000],
]);
check("a sub-floor turn leaves no trace", phaseAt(brief, 12_000) === "empty" && phaseAt(brief, 999_000) === "empty");

// A running turn's slot must never carry the previous turn's number, not even
// during the thirty seconds before it has earned one of its own.
const next = reduceTurn(settled, "turn_start", at(100_000));
check("the next turn clears the held figure at once", phaseAt(next, 100_000) === "empty");
check("and then shows its own", labelAt(next, 100_000 + FLOOR_MS) === "30s");

// A retry and an auto-compaction both re-enter through `agent_start`, which the
// extension feeds in as another turn start. The user's wait did not restart.
const retried = drive([
	["turn_start", 0],
	["turn_start", 40_000],
	["turn_start", 55_000],
]);
check("a retry does not reset the start", labelAt(retried, 72_000) === "1m 12s", labelAt(retried, 72_000));
const compacted = reduceTurn(retried, "turn_settled", at(124_000));
check("and the total is the whole wait, not the last attempt", labelAt(compacted, 124_000) === "2m 04s");
check(
	"a stray second settle cannot zero a held figure",
	labelAt(reduceTurn(compacted, "turn_settled", at(900_000)), 900_000) === "2m 04s",
);

check("a session reset clears a held figure", phaseAt(reduceTurn(settled, "session_reset", at(80_000)), 80_000) === "empty");
check("and a running one", phaseAt(reduceTurn(running, "session_reset", at(80_000)), 80_000) === "empty");

// notify reads this clock too. It must get the same number whether it runs
// before or after zen-chrome closes the turn, or the ping and the frame differ.
check(
	"the clock reads the same either side of settling",
	elapsedMs(running, at(72_000)) === elapsedMs(settled, at(900_000)),
);

console.log("\n--- turn clock: the formatter");

for (const [ms, want] of [
	[0, "0s"],
	[999, "0s"],
	[12_000, "12s"],
	[FLOOR_MS, "30s"],
	[59_999, "59s"],
	[60_000, "1m 00s"],
	[72_000, "1m 12s"],
	[124_000, "2m 04s"],
	[119_600, "2m 00s"],
	[600_000, "10m 00s"],
]) {
	check(`${ms}ms reads as ${want}`, formatDuration(ms) === want, `got ${formatDuration(ms)}`);
}

console.log("\n--- bottom rule: drop priority and width");

const plain = (s) => `\x1b[90m${s}\x1b[0m`;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// The timer owns the single space between it and the context reading.
const timerOf = (label) => (label ? [{ text: `${label} `, paint: plain, atomic: true }] : []);
// One percentage drives the fixture; 1% stands in for 1k tokens in the label.
const tokensFor = (percent) => (percent === null ? null : Math.round(percent * 1000));
const contextOf = (percent) => [
	{ text: contextReading(tokensFor(percent), percent).label, paint: plain, atomic: true },
];
// The cache window, between the timer and the reading; it owns its trailing space.
const cacheOf = (label) => (label ? [{ text: `${label} `, paint: plain, atomic: true }] : []);
const branchOf = (name) => (name ? [{ text: name, paint: plain }] : []);
// agent-dock's count, let into the dashes between the branch and the timer.
const tasksOf = (label) => (label ? [{ text: label, paint: plain, atomic: true }] : []);
const labelsOf = (branchName, taskLabel, timerLabel, percent = 31.4, cacheLabel = "") => ({
	branch: branchOf(branchName),
	tasks: tasksOf(taskLabel),
	timer: timerOf(timerLabel),
	cache: cacheOf(cacheLabel),
	context: contextOf(percent),
	scroll: [],
});

check(
	"the timer sits left of the context reading, the reading ends the rule",
	/^\u2570\u2500 main \u2500+ 1m 12s 31\.4k \u2500\u256f$/.test(strip(bottomRule(60, labelsOf("main", "", "1m 12s"), plain))),
	strip(bottomRule(60, labelsOf("main", "", "1m 12s"), plain)),
);

check(
	"the task count sits between the branch and the timer, dashes either side",
	/^\u2570\u2500 main \u2500+ 2 tasks \u2193 \u2500+ 1m 12s 31\.4k \u2500\u256f$/.test(
		strip(bottomRule(80, labelsOf("main", "2 tasks \u2193", "1m 12s"), plain)),
	),
	strip(bottomRule(80, labelsOf("main", "2 tasks \u2193", "1m 12s"), plain)),
);

check(
	"the cache window sits between the timer and the reading",
	/^\u2570\u2500 main \u2500+ 1m 12s <\u2744 12m 31\.4k \u2500\u256f$/.test(
		strip(bottomRule(60, labelsOf("main", "", "1m 12s", 31.4, "<\u2744 12m"), plain)),
	),
	strip(bottomRule(60, labelsOf("main", "", "1m 12s", 31.4, "<\u2744 12m"), plain)),
);

const problems = [];
const widthsWith = { context: [], branch: [], tasks: [], timer: [], cache: [] };

{
	for (const cacheLabel of ["", "<\u2744 12m"])
	for (const percent of [31.4, null, 96])
	for (const branchName of ["main", "feat/some-quite-long-branch-name", ""]) {
		for (const label of ["1m 12s", "30s", ""]) {
			for (const taskLabel of ["", "1 task \u2193", "12 tasks \u2193"]) {
			for (let w = 0; w <= 200; w++) {
				const line = bottomRule(w, labelsOf(branchName, taskLabel, label, percent, cacheLabel), plain);
				const shown = strip(line);
				const where = `cache=${JSON.stringify(cacheLabel)} pct=${percent} branch=${JSON.stringify(branchName)} tasks=${JSON.stringify(taskLabel)} timer=${JSON.stringify(label)} @${w}`;

				// The invariant the preview already checks, extended to the new rule.
				if (visibleWidth(line) !== w) problems.push(`${where}: produced ${visibleWidth(line)} columns`);

				// The timer is atomic: present whole, or absent. Any fragment of it on
				// screen without the whole reading is a timer cut in half.
				const hasTimer = label !== "" && shown.includes(` ${label} `);
				if (label !== "" && shown.includes(label.slice(0, 3)) && !hasTimer)
					problems.push(`${where}: timer truncated: ${JSON.stringify(shown)}`);

				// The task count is atomic as well, and it is a middle label: it must
				// have a dash on both sides or it has been welded to a neighbour.
				const hasTasks = taskLabel !== "" && shown.includes(` ${taskLabel} `);
				if (taskLabel !== "" && shown.includes(taskLabel.slice(0, 4)) && !hasTasks)
					problems.push(`${where}: task count truncated: ${JSON.stringify(shown)}`);
				if (hasTasks && !new RegExp(`\u2500 ${taskLabel} \u2500`).test(shown))
					problems.push(`${where}: task count without dashes either side: ${JSON.stringify(shown)}`);

				// The context reading is atomic: the whole figure, or nothing.
				const reading = contextReading(tokensFor(percent), percent).label;
				const hasContext = shown.includes(` ${reading} `);
				if (/\dk(?= |$)/.test(shown) && !hasContext) problems.push(`${where}: context reading truncated: ${JSON.stringify(shown)}`);

				// The cache window is atomic, and never outlives the timer.
				const hasCache = cacheLabel !== "" && shown.includes(` ${cacheLabel} `);
				if (shown.includes("\u2744") && !hasCache) problems.push(`${where}: cache window truncated: ${JSON.stringify(shown)}`);
				if (hasCache && !hasTimer && label !== "") problems.push(`${where}: cache window outlived the timer`);

				// Drop priority: context, then branch, then tasks, then timer, then cache.
				const hasBranch = branchName !== "" && shown.includes(` ${branchName} `);
				if (hasBranch && !hasContext) problems.push(`${where}: branch outlived the context reading`);
				if (hasTimer && !hasBranch && branchName !== "") problems.push(`${where}: timer outlived the branch`);
				if (hasTimer && !hasTasks && taskLabel !== "") problems.push(`${where}: timer outlived the task count`);
				if (hasTasks && !hasBranch && branchName !== "") problems.push(`${where}: task count outlived the branch`);

				if (branchName === "main" && label === "1m 12s" && percent === 31.4 && taskLabel === "1 task \u2193" && cacheLabel !== "") {
					if (hasCache) widthsWith.cache.push(w);
					if (hasContext) widthsWith.context.push(w);
					if (hasBranch) widthsWith.branch.push(w);
					if (hasTasks) widthsWith.tasks.push(w);
					if (hasTimer) widthsWith.timer.push(w);
				}
			}
			}
		}
	}
}

check(
	"every bottom rule is exactly its width, context, tasks, timer and cache whole or gone (2 caches \u00d7 3 fills \u00d7 3 branches \u00d7 3 timers \u00d7 3 counts \u00d7 widths 0-200)",
	problems.length === 0,
	problems.slice(0, 5).join("\n       "),
);

const first = (list) => list[0] ?? Infinity;
check(
	`the context reading survives narrower than the branch (${first(widthsWith.context)} vs ${first(widthsWith.branch)})`,
	first(widthsWith.context) < first(widthsWith.branch),
);
check(
	`the branch survives narrower than the task count (${first(widthsWith.branch)} vs ${first(widthsWith.tasks)})`,
	first(widthsWith.branch) < first(widthsWith.tasks),
);
check(
	`the task count survives narrower than the timer (${first(widthsWith.tasks)} vs ${first(widthsWith.timer)})`,
	first(widthsWith.tasks) < first(widthsWith.timer),
);
check(
	`the timer survives narrower than the cache window (${first(widthsWith.timer)} vs ${first(widthsWith.cache)})`,
	first(widthsWith.timer) < first(widthsWith.cache),
);
check(
	"and once the timer fits it never flickers back out",
	widthsWith.timer.at(-1) === 200 && widthsWith.timer.length === 200 - first(widthsWith.timer) + 1,
);

// pi's `↑ 12 more` shares the rule with the labels: it only takes dashes they
// leave free. So with the indicator turned back into dashes, every rule is
// exactly the one drawn without it — no label moved, dropped, or cut for it.
{
	const scrollProblems = [];
	const scrollWidths = [];
	const locationOf = (text) => (text ? [{ text, paint: plain }] : []);
	const modelOf = (text) => (text ? [{ text, paint: plain, atomic: true }] : []);
	for (const [direction, hidden] of [["↑", 12], ["↓", 3], ["↑", 1234]]) {
		const scroll = scrollIndicator(direction, hidden, plain);
		const text = ` ${direction} ${hidden} more `;
		const drawings = [
			...["~/dotfiles", "~/code/a-rather-long-project-directory", ""].flatMap((location) =>
				["opus ▱▱▱▱▱", ""].map((model) => ({
					name: `top ${JSON.stringify(location)} ${JSON.stringify(model)}`,
					draw: (w, s) => rule(w, locationOf(location), modelOf(model), plain, TOP_ENDS, insignia(plain), s),
				})),
			),
			...["", "2 tasks ↓"].map((taskLabel) => ({
				name: `bottom tasks=${JSON.stringify(taskLabel)}`,
				draw: (w, s) => bottomRule(w, { ...labelsOf("main", taskLabel, "1m 12s", 31.4, "<❄ 12m"), scroll: s }, plain),
			})),
		];
		const squash = (line) => line.replace(/\u2500+/g, "\u2500");
		for (const { name, draw } of drawings) {
			// Below the width where the labels stop changing, free dashes come and go with
			// them, and the indicator with the dashes; past it, the indicator must not flicker.
			const settled = squash(strip(draw(200, [])));
			let shownFrom = null;
			for (let w = 0; w <= 200; w++) {
				const where = `${name} ${text.trim()} @${w}`;
				const line = strip(draw(w, scroll));
				if (visibleWidth(line) !== w) scrollProblems.push(`${where}: produced ${visibleWidth(line)} columns`);
				if (line.replace(text, "\u2500".repeat(text.length)) !== strip(draw(w, [])))
					scrollProblems.push(`${where}: the indicator moved a label: ${JSON.stringify(line)}`);
				const shown = line.includes(text);
				if (!shown && line.includes(`${direction} ${hidden}`)) scrollProblems.push(`${where}: indicator cut: ${JSON.stringify(line)}`);
				if (shown && !line.includes(`\u2500${text}\u2500`))
					scrollProblems.push(`${where}: indicator without a dash either side: ${JSON.stringify(line)}`);
				if (squash(strip(draw(w, []))) !== settled) continue;
				if (shown) shownFrom ??= w;
				else if (shownFrom !== null) scrollProblems.push(`${where}: the indicator flickered out after showing at ${shownFrom}`);
			}
			if (name === 'top "~/dotfiles" "opus ▱▱▱▱▱"' && hidden === 12) scrollWidths.push(shownFrom);
		}
	}
	check(
		"the scroll indicator only ever takes free dashes, whole, and once the labels settle never flickers (3 counts × 8 rules × widths 0-200)",
		scrollProblems.length === 0,
		scrollProblems.slice(0, 5).join("\n       "),
	);
	check(`and it fits beside the cwd, the ghost and the model from ${scrollWidths[0]} columns`, scrollWidths[0] <= 54);
}

// ---------------------------------------------------------------------------
// The dock: no blank row under the box.
//
// pi gives the footer entry `minSize: 1`, so in fullscreen a footer that
// renders nothing still reserves a row and the box floats one line above the
// bottom of the screen. The dock here is pi's own — same components, same
// entry options as interactive-mode's VStack — laid out through pi-tui's real
// fullscreen path, so this fails the day either of those changes shape.
// ---------------------------------------------------------------------------

console.log("\n--- the dock: a silent footer costs no row");

const { Container, VStack } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const { renderLayoutFrame } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/layout.js`);
const { fitDockRows } = await jiti.import(`${ROOT}/extensions/zen-chrome/dock.ts`);

const lines = (component) => ({ render: () => component });
const wrap = (child) => {
	const container = new Container();
	container.addChild(child);
	return container;
};

/** pi's dock and fullscreen root, with `footer` in the footer's place. */
const dockWith = (footer) => {
	const transcript = wrap(lines(["transcript"]));
	const editor = wrap(lines(["\u256d\u2500 top \u2500\u256e", "\u2502 hi   \u2502", "\u2570\u2500 bot \u2500\u256f"]));
	const dock = new VStack([
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: new Container(), shrink: 1, minSize: 0 },
		{ component: wrap(footer), shrink: 1, minSize: 1 },
	]);
	const root = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	return { root, tui: { layoutRoot: root } };
};

/** The screen pi would paint, blank rows and all. */
const screen = (root, height = 8) => renderLayoutFrame(root, 20, height, () => {}).lines;
const rowsUnderBox = (painted) => {
	const bottom = painted.findLastIndex((line) => line.includes("bot"));
	return painted.length - 1 - bottom;
};

{
	const stock = { render: () => [] };
	check("pi alone leaves a blank row under the box", rowsUnderBox(screen(dockWith(stock).root)) === 1);
}

{
	// The footer zen-chrome installs: silent unless another extension has set a
	// status, and asking for exactly the rows it is about to use.
	let status = "";
	let fit;
	const footer = {
		render: () => {
			fit ??= fitDockRows(tui, () => footer);
			if (status === "") {
				fit(0);
				return [];
			}
			fit(1);
			return [status];
		},
	};
	const { root, tui } = dockWith(footer);

	check("a silent footer costs no row", rowsUnderBox(screen(root)) === 0);

	status = "indexing\u2026";
	const speaking = screen(root);
	check("a footer with something to say gets its row back", rowsUnderBox(speaking) === 1);
	check("and the status is on it", speaking.at(-1).includes("indexing"), JSON.stringify(speaking.at(-1)));

	status = "";
	check("and gives it up again", rowsUnderBox(screen(root)) === 0);

	// A terminal too short for the box: the footer must still not be the thing
	// that pushes the box off screen, and nothing may throw.
	status = "indexing\u2026";
	check("survives a screen with no room", screen(root, 2).length === 2);
}

{
	// pi's `regular` tuiMode has no layout root, and no reservation to undo.
	const footer = { render: () => [] };
	const fit = fitDockRows({}, () => footer);
	let threw = false;
	try {
		fit(0);
	} catch {
		threw = true;
	}
	check("no layout root is a no-op, not a crash", !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
