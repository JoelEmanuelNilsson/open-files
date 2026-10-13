import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { namedTheme as named, sgrTheme as themeStub, stripAnsi as strip } from "../support/tool-row-fixtures.mjs";
process.env.TMUX = "test";

const { setKeybindings } = await importPi("node_modules/@earendil-works/pi-tui/dist/keybindings.js");
const { KEYBINDINGS } = await importPi("dist/core/keybindings.js");
const jiti = kitJiti();
const summary = await jiti.import(`${KIT_ROOT}/lib/transcript/call-summary.ts`);
const result = await jiti.import(`${KIT_ROOT}/lib/transcript/result-row.ts`);

const sum = (tool, text, args = {}, truncated = false) => summary.summarizeToolResult(tool, text, args, truncated);

// ---------------------------------------------------------------------------
// The result line: five-column gutter, bold count, plain unit.
// ---------------------------------------------------------------------------

const res = (fields, width = 60) => {
	const component = new result.ResultRow();
	component.set({ summary: null, error: false, duration: null, expanded: false, ...fields }, result.resultPaints(themeStub));
	return component.render(width).map(strip);
};

eq("a count", res({ summary: sum("read", "a\nb\nc") }), ["  ⎿  Read 3 lines"]);
eq("the gutter is five columns", res({ summary: sum("read", "a") })[0].indexOf("Read"), 5);
eq("a note", res({ summary: { kind: "note", text: "No matches", tone: "warning" } }), ["  ⎿  No matches"]);
eq("a duration when the wait was felt", res({ summary: sum("read", "a"), duration: "2.4s" }), ["  ⎿  Read 1 line · 2.4s"]);
eq("a tail with the lines it is not showing", res({ tail: "41 passed", hidden: 12 }), ["  ⎿  41 passed  +12 lines"]);
eq("nothing to say draws nothing", res({}), []);

// The settled receipt is the head of the output, not its tail: the answer
// starts at the top, and the last line of a finished command is usually a blank
// or something the exit code already said.
// The key in the hint is read from pi's registry, never written down here: a
// rebound `app.tools.expand` renames every hint in the transcript with it. The
// registry is faked to the one method `keyText` calls, so the check does not
// depend on whoever's `keybindings.json` is on this machine.
const bindKey = (...keys) => setKeybindings({ getKeys: () => keys });
eq("pi still calls the toggle app.tools.expand, bound to ctrl+o", KEYBINDINGS["app.tools.expand"]?.defaultKeys, "ctrl+o");
bindKey("ctrl+o");
eq("the hint names the key pi has bound", result.expandKeyText(), "ctrl+o");
bindKey("ctrl+e");
eq("and follows it when it is rebound", result.moreLinesHint(4), "… +4 lines (ctrl+e to expand)");
bindKey();
eq("an unbound key leaves the count alone rather than naming nothing", result.moreLinesHint(2), "… +2 lines");
bindKey("ctrl+o");
eq("a settled call shows the head of its output", res({ preview: ["one", "two", "three"], hidden: 37 }), [
	"  ⎿  one",
	"     two",
	"     three",
	"     … +37 lines (ctrl+o to expand)",
]);
eq("one hidden line is a line", result.moreLinesHint(1, "ctrl+o"), "… +1 line (ctrl+o to expand)");
eq("two are lines", result.moreLinesHint(2, "ctrl+o"), "… +2 lines (ctrl+o to expand)");
eq("nothing behind the preview means no footer", res({ preview: ["one", "two"], hidden: 0 }), ["  ⎿  one", "     two"]);
// The clock is the row's own annotation, so it rides the row's own line: the
// `… +N lines` footer when there is one, never clipped onto the end of the
// output's first line.
eq("the duration rides the footer, not the output", res({ preview: ["one", "two"], hidden: 4, duration: "2.4s" }), [
	"  ⎿  one",
	"     two",
	"     … +4 lines (ctrl+o to expand) · 2.4s",
]);
// With nothing hidden there is no footer to carry it, and a clock is not worth
// a line of its own.
eq("without a footer it stays on the first line", res({ preview: ["one", "two"], hidden: 0, duration: "2.4s" })[0], "  ⎿  one · 2.4s");
// Collapsed, a preview line keeps exactly one row: three lines of output must
// not become twelve because the pane is narrow.
eq("a preview line is clipped, never wrapped", res({ preview: ["a".repeat(40), "b"], hidden: 0 }, 20), ["  ⎿  " + "a".repeat(14) + "…", "     b"]);
// Expanded, the preview is the whole output and it wraps under the gutter.
eq("ctrl+o wraps it under the gutter instead", res({ preview: ["one two three four", "five"], hidden: 0, expanded: true }, 15), [
	"  ⎿  one two",
	"     three four",
	"     five",
]);

// One primitive, two ends: the live row reads the tail, the settled row the head.
eq("the head of an output", result.outputPreview("a\nb\nc\nd", 2), { lines: ["a", "b"], hidden: 2 });
eq("the tail of the same output", result.outputPreview("a\nb\nc\nd", 2, "tail"), { lines: ["c", "d"], hidden: 2 });
eq("blank lines at either end are the shell's, not information", result.outputPreview("\n\na\nb\n\n\n", 3), { lines: ["a", "b"], hidden: 0 });
eq("nothing printed is nothing to preview", result.outputPreview("\n\n", 3), { lines: [], hidden: 0 });
// A blank line never takes one of the three rows on offer — three lines of a
// build log spent on paragraph breaks say nothing — but it is still below the
// last line on screen, so it is still counted there.
eq("a blank line never spends a preview row", result.outputPreview("a\n\nb\n\nc\n\nd", 3), { lines: ["a", "b", "c"], hidden: 2 });
eq("and the tail end skips them too", result.outputPreview("a\n\nb\n\nc", 1, "tail"), { lines: ["c"], hidden: 4 });

// The number is bold and the unit is not. That is the whole grammar.
const painted = new result.ResultRow();
painted.set({ summary: sum("read", "a\nb\nc"), error: false, duration: null, expanded: false }, result.resultPaints(named));
eq("the count is bold, the words are not", painted.render(60)[0].includes("<text>3"), true);

// A failure keeps its body: the text is the reason you looked.
const boom = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const failed = res({ error: true, body: boom });
eq("a failure elides its head, not its tail", failed[0], "  ⎿  … 8 earlier lines");
eq("and keeps the reason", failed[failed.length - 1], "     line 20");
eq("twelve lines plus the notice", failed.length, result.ERROR_LINES + 1);
eq("expanded keeps all of it", res({ error: true, body: boom, expanded: true }).length, 20);
eq("blank lines in an error are the shell's, not information", res({ error: true, body: ["a", "", "b"] }).length, 2);

// Output only appears under the gutter when it was asked for.
eq("a settled call hides its body", res({ summary: sum("read", "a\nb"), body: ["a", "b"] }).length, 1);
eq("ctrl+o shows it", res({ summary: sum("read", "a\nb"), body: ["a", "b"], expanded: true }).length, 3);

// On a narrow pane the answer survives and the annotation goes.
eq("the duration goes when the answer would lose half the row", res({ tail: "PASS src/split-diff.test.ts", duration: "12.0s" }, 20), [
	"  ⎿  PASS src/split…",
]);
eq("and stays when there is room for both", res({ tail: "PASS src/a.test.ts", duration: "2.4s" }, 40), ["  ⎿  PASS src/a.test.ts · 2.4s"]);

// The last line is the line a running command tails and a finished one keeps.
eq("the last non-blank line", result.lastLine("a\nb\nc\n\n"), { line: "c", hidden: 2 });
eq("no output at all", result.lastLine("\n\n"), { line: "", hidden: 0 });

// A body under the gutter belongs to the call above it.
const inner = { render: (width) => [`w=${width}`, "second"] };
eq("the gutter takes the first line", new result.Gutter(inner).render(60), ["  ⎿  w=55", "     second"]);
eq("and indenting takes none of them", result.indented(inner).render(60), ["     w=55", "     second"]);

await finish();
