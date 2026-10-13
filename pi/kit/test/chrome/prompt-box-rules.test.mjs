/**
 * zen-chrome's bottom of the frame (extensions/zen-chrome/prompt-box-rules.ts):
 * the bottom rule's labels and drop priority, the agent count agent-dock lets
 * into it, and the scroll indicator.
 */

import { check, finish } from "../support/check-harness.mjs";
import { importPi, KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";

// Widths must be measured the way the TUI measures them: ANSI is free, wide
// characters are not. `.length` is neither.
const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const jiti = kitJiti();

const { rule, scrollIndicator, TOP_ENDS } = await jiti.import(`${KIT_ROOT}/lib/ui/labelled-rule.ts`);
const { bottomRule, contextReading, insignia } = await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/prompt-box-rules.ts`);

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
console.log("\nzen-chrome: the agent count's key in the rule");
{
	// The count is published by agent-dock and rendered by zen-chrome. Two files,
	// one key — a rename that reaches only one of them puts the count nowhere.
	const chromeSource = ["index.ts", "status-footer.ts", "task-count-glow.ts"]
		.map((file) => fs.readFileSync(`${KIT_ROOT}/extensions/zen-chrome/${file}`, "utf8"))
		.join("\n");
	check("zen-chrome imports the shared key rather than spelling it again", chromeSource.includes("AGENT_TASK_STATUS_KEY"));
	check("zen-chrome keeps the claimed key out of the footer row", /RULE_STATUSES\.has\(key\)/.test(chromeSource));
	// The count only exists while an agent is working, so it is lit for as long as
	// it is drawn — and the frames that light it have to go when it does, or an
	// idle seat repaints 25 times a second forever.
	check("zen-chrome lights the count it draws", /taskGlow\(Boolean\(text\)\)/.test(chromeSource) && /light: LABEL_LIGHT/.test(chromeSource));
	check("and takes the frames down with the label and with the session", (chromeSource.match(/stopTaskFrames\(\)/g) ?? []).length >= 3);
}

// ---------------------------------------------------------------------------
console.log("\nthe agent count in the bottom rule");
{
	const plain = (text) => text;
	const piece = (text, atomic = false) => (text ? [{ text, paint: plain, atomic }] : []);
	const rule = (width, { branch = "main", tasks = "", timer = "", context = "31.4%" } = {}) =>
		bottomRule(
			width,
			{ branch: piece(branch), tasks: piece(tasks, true), timer: piece(timer ? `${timer} ` : "", true), cache: [], context: piece(context, true), scroll: [] },
			plain,
		);

	for (const width of [40, 60, 80, 100, 120, 160]) {
		const line = rule(width, { tasks: "2 tasks ↓", timer: "1m 12s" });
		check(`the rule is exactly ${width} columns wide`, visibleWidth(line) === width, JSON.stringify(line));
	}

	const at80 = rule(80, { tasks: "2 tasks ↓", timer: "1m 12s" });
	check("80 columns holds branch, tasks and clock", /main/.test(at80) && /2 tasks ↓/.test(at80) && /1m 12s/.test(at80), at80);
	check("the tasks label sits between the branch and the clock", at80.indexOf("2 tasks") > at80.indexOf("main") && at80.indexOf("2 tasks") < at80.indexOf("1m 12s"));
	check("dashes separate it from both", / ─+ 2 tasks ↓ ─+ /.test(at80), at80);
	check("no tasks, no label", !rule(80, { timer: "1m 12s" }).includes("task"));

	// The drop order, stated: timer, then tasks, then the branch is squeezed.
	const narrow = rule(30, { tasks: "2 tasks ↓", timer: "1m 12s" });
	check("the timer goes first", !narrow.includes("1m 12s") && narrow.includes("2 tasks ↓"), narrow);
	const narrower = rule(21, { tasks: "2 tasks ↓", timer: "1m 12s" });
	check("then the tasks go", !narrower.includes("task"), narrower);
	check("the branch outlives them both", narrower.includes(" main "), narrower);
	check("nothing is ever clipped on the way down", !narrower.includes("…"), narrower);
	for (const width of [4, 8, 12, 20, 26, 34, 46]) {
		check(`a ${width}-column rule is still exactly that wide`, visibleWidth(rule(width, { tasks: "12 tasks ↓", timer: "10m 04s" })) === width);
	}
	check("a long branch is squeezed rather than dropped",
		rule(30, { branch: "a-very-long-feature-branch-name", tasks: "2 tasks ↓" }).includes("…"));
}

await finish();
