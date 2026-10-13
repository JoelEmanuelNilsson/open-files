/**
 * The kit's `edit` tool's rows (extensions/multi-edit/edit-tool-rows.ts): the
 * call line, the result, the split diff at the widths a herdr pane hands us,
 * and the TUI's "no line exceeds width" contract.
 */

import { check, finish, show } from "../support/check-harness.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { initDarkTheme, importPi, KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { identityTheme } from "../support/identity-theme.mjs";

const jiti = kitJiti({ moduleCache: false });
// Widths must be measured the way the TUI measures them: ANSI is free, wide
// characters are not. `.length` is neither.
const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
// pi's own keybinding formatter paints through pi's global theme, so a hint
// asked for before `initTheme` throws. A session has one long before any
// extension draws; this stands in for that.
await initDarkTheme();

// ---------------------------------------------------------------------------
// The renderers: the call line, the result, and its truncation.
// ---------------------------------------------------------------------------

const theme = identityTheme;

const { api, tools } = fakeExtensionApi();

await (await jiti.import(`${KIT_ROOT}/extensions/multi-edit/index.ts`, { default: true }))(api);

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

check(
	`width contract: no line exceeds its width (3 modes × ${Object.keys(diffs).length} diffs × widths 4-200 × collapsed/expanded)`,
	overflows.length === 0,
	`${overflows.length} overflowing line(s):\n  ${overflows.slice(0, 5).join("\n  ")}`,
);

await finish();
