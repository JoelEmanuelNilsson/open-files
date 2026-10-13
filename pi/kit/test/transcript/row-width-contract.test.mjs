import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { sgrTheme as themeStub, stripAnsi as strip } from "../support/tool-row-fixtures.mjs";
process.env.TMUX = "test";

const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const jiti = kitJiti();
const summary = await jiti.import(`${KIT_ROOT}/lib/transcript/call-summary.ts`);
const header = await jiti.import(`${KIT_ROOT}/lib/transcript/call-header.ts`);
const result = await jiti.import(`${KIT_ROOT}/lib/transcript/result-row.ts`);

const sum = (tool, text, args = {}, truncated = false) => summary.summarizeToolResult(tool, text, args, truncated);
const same = (t) => t;
const headerPaints = { dot: same, name: same, punctuation: same, argument: same };
const head = (fields, width) => {
	const component = new header.CallHeader();
	component.set({ state: "done", name: "Read", argument: "", clipEnd: "head", expanded: false, ...fields }, headerPaints);
	return component.render(width);
};
const res = (fields, width = 60) => {
	const component = new result.ResultRow();
	component.set({ summary: null, error: false, duration: null, expanded: false, ...fields }, result.resultPaints(themeStub));
	return component.render(width).map(strip);
};
const boom = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

// ---------------------------------------------------------------------------
// The contract: no line is ever wider than the width it was handed.
// ---------------------------------------------------------------------------

const overflows = [];
const headerCases = {
	"short path": { name: "Read", argument: "lib/a.ts", clipEnd: "head" },
	"long path": { name: "Read", argument: "/Users/joel/dotfiles/pi/kit/lib/transcript/call-argument.ts", clipEnd: "head" },
	"long command": {
		name: "Bash",
		argument: 'ls -la ~/dotfiles/pi/ && echo "===SETTINGS===" && cat ~/dotfiles/pi/settings.json && cat ~/dotfiles/pi/keybindings.json',
		clipEnd: "tail",
	},
	"long command, two rows": {
		name: "Bash",
		argument: 'ls -la ~/dotfiles/pi/ && echo "===SETTINGS===" && cat ~/dotfiles/pi/settings.json && cat ~/dotfiles/pi/keybindings.json',
		clipEnd: "tail",
		headerRows: 2,
	},
	"one unbroken token, two rows": { name: "Bash", argument: `echo ${"x".repeat(300)}`, clipEnd: "tail", headerRows: 2 },
	"long name": { name: "PowerShell", argument: "Get-ChildItem -Recurse", clipEnd: "tail" },
	"no argument": { name: "ListAgents", argument: "", clipEnd: "tail" },
	"cut off": { state: "aborted", name: "Bash", argument: "sleep 100", clipEnd: "tail" },
};
const resultCases = {
	count: { summary: sum("read", Array.from({ length: 412 }, () => "x").join("\n")), duration: "2.4s" },
	note: { summary: { kind: "note", text: "No matches", tone: "warning" } },
	tail: { tail: "PASS src/split-diff.test.ts in 41ms", hidden: 12, duration: "12.0s" },
	failure: { error: true, body: boom, duration: "2.4s" },
	preview: { preview: ["> pi-kit@0.1.0 test", "> node test/run.mjs", "suite"], hidden: 37, duration: "2.4s" },
	"preview of one very long line": { preview: ["x".repeat(300), "y"], hidden: 4 },
};
for (let width = 4; width <= 200; width++) {
	for (const expanded of [false, true]) {
		for (const [label, fields] of Object.entries(headerCases)) {
			for (const one of head({ ...fields, expanded }, width)) {
				const shown = visibleWidth(strip(one));
				if (shown > width) overflows.push(`header ${label} @${width}: ${shown} cols`);
			}
		}
		for (const [label, fields] of Object.entries(resultCases)) {
			for (const one of res({ ...fields, expanded }, width)) {
				const shown = visibleWidth(one);
				if (shown > width) overflows.push(`result ${label} @${width}: ${shown} cols`);
			}
		}
	}
}
const fixtureCount = Object.keys(headerCases).length + Object.keys(resultCases).length;
check(
	`width contract: no row exceeds its width (${fixtureCount} fixtures × widths 4-200 × collapsed and expanded)`,
	overflows.length === 0,
	`${overflows.length} overflowing line(s):\n  ${overflows.slice(0, 5).join("\n  ")}`,
);

await finish();
