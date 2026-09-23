// pi-tui caches terminal capabilities on first read and reports no image
// support under a multiplexer, which is the case the image fallback exists for.
import "./env.mjs";
process.env.TMUX = "test";

const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const { visibleWidth } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/utils.js`);
const { getCapabilities, setCapabilities } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/terminal-image.js`);
const { setKeybindings } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/keybindings.js`);
const { KEYBINDINGS } = await import(`${PI}/dist/core/keybindings.js`);
const { existsSync } = await import("node:fs");
const jiti = createJiti(import.meta.url, { interopDefault: true });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const summary = await jiti.import(`${ROOT}/extensions/transcript/summary.ts`);
const line = await jiti.import(`${ROOT}/extensions/transcript/line.ts`);
const describe = await jiti.import(`${ROOT}/extensions/transcript/describe.ts`);
const header = await jiti.import(`${ROOT}/extensions/transcript/header.ts`);
const result = await jiti.import(`${ROOT}/extensions/transcript/result.ts`);
const row = await jiti.import(`${ROOT}/extensions/transcript/row.ts`);
const link = await jiti.import(`${ROOT}/extensions/transcript/link.ts`);
const { HOME_GLYPH } = await jiti.import(`${ROOT}/lib/home-glyph.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}\n  expected ${b}\n  actual   ${a}`);
};
const show = (label, fn) => {
	try {
		console.log(`--- ${label}\n${fn()}`);
		pass++;
	} catch (e) {
		fail++;
		console.log(`--- ${label}\nTHREW: ${e.message}\n${e.stack.split("\n").slice(1, 3).join("\n")}`);
	}
};
const strip = (s) => s.replace(/\x1b\][0-9;]*;?[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// Summaries come from the output contract, never from the shape of the text.
// ---------------------------------------------------------------------------

const sum = (tool, text, args = {}, truncated = false) => summary.summarize(tool, text, args, truncated);
const say = (s) => (s === null ? null : summary.summaryText(s));

eq("read counts lines", say(sum("read", "a\nb\nc")), "Read 3 lines");
eq("read ignores pi's notice", say(sum("read", "a\nb\n\n[3 more lines in file. Use offset=3 to continue.]")), "Read 2 lines");
eq("read admits a truncated count is a floor", say(sum("read", "a\nb", {}, true)), "Read 2+ lines");
eq("one is singular", say(sum("read", "a")), "Read 1 line");

// Context lines use `-`, matches use `:`. Only matches count.
const grepOut = ["src/a.ts:12: const x = 1;", "src/a.ts-13-   return x;", "src/b.ts:4: const x = 2;"].join("\n");
eq("grep counts only matches", say(sum("grep", grepOut)), "Found 2 matches");
// A context line whose text is itself shaped like a match must not be counted.
eq("a match-shaped context line is still context", say(sum("grep", "a.ts-2-   see other.ts:9: here")), "No matches");
eq("grep zero sentinel", sum("grep", "No matches found"), { kind: "note", text: "No matches", tone: "warning" });
eq("find zero sentinel", say(sum("find", "No files found matching pattern")), "No files found");
eq("ls zero sentinel", say(sum("ls", "(empty directory)")), "Empty directory");
eq("ls counts entries", say(sum("ls", "a\nb\nc")), "Listed 3 entries");
eq("find counts files", say(sum("find", "a.ts")), "Found 1 file");

// `write` is counted from what it was handed, not from `Successfully wrote N bytes`.
eq("write counts the content it was given", say(sum("write", "Successfully wrote 6 bytes", { content: "a\nb\nc\n" })), "Wrote 3 lines");
eq("write with no content says nothing", sum("write", "x", {}), null);
eq("an empty write is zero lines", say(sum("write", "x", { content: "" })), "Wrote 0 lines");

eq("bash has no honest count", sum("bash", "anything at all"), null);
eq("an unknown tool has no count", sum("mcp__whatever", "x\ny"), null);

eq("bytes", [summary.formatBytes(900), summary.formatBytes(2048), summary.formatBytes(3_500_000)], ["900 B", "2.0 KB", "3.3 MB"]);

// ---------------------------------------------------------------------------
// Durations below the floor are noise, not information.
// ---------------------------------------------------------------------------

eq("4ms is not worth saying", summary.formatDuration(4), null);
eq("499ms is not worth saying", summary.formatDuration(499), null);
eq("500ms is", summary.formatDuration(500), "0.5s");
eq("seconds", summary.formatDuration(2410), "2.4s");
eq("minutes", summary.formatDuration(125_000), "2m 5s");
eq("59.6s of remainder carries into the minute", summary.formatDuration(599_600), "10m");
eq("whole minutes", summary.formatDuration(120_000), "2m");

// ---------------------------------------------------------------------------
// The clock: started by the call slot, stopped by the result slot, once.
// ---------------------------------------------------------------------------

const ctx = (over = {}) => ({
	args: {},
	toolCallId: "t",
	invalidate: () => {},
	lastComponent: undefined,
	state: {},
	cwd: "/w/kit",
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: true,
	isError: false,
	...over,
});

const clock = ctx({ executionStarted: false, isPartial: true });
row.startClock(clock);
eq("the clock does not start while arguments stream", clock.state.startedAt, undefined);
clock.executionStarted = true;
row.startClock(clock);
const began = clock.state.startedAt;
eq("it starts when execution does", typeof began, "number");
row.startClock(clock);
eq("and only once", clock.state.startedAt, began);
eq("a running call has no duration", row.stopClock(clock), null);
clock.isPartial = false;
clock.state.startedAt = Date.now() - 2400;
eq("a settled one does", row.stopClock(clock), "2.4s");
const stopped = clock.state.endedAt;
clock.state.startedAt = Date.now() - 90_000;
eq("the end is recorded once, not re-read on every frame", clock.state.endedAt, stopped);

// ---------------------------------------------------------------------------
// Paths are spelled the shortest honest way, and clipped from the right end.
// ---------------------------------------------------------------------------

eq("inside the session goes relative", describe.shortPath("/w/kit/lib/a.ts", "/w/kit", "/home/j"), "lib/a.ts");
eq("under home goes to the home glyph", describe.shortPath("/home/j/other/a.ts", "/w/kit", "/home/j"), `${HOME_GLYPH}/other/a.ts`);
// The glyph stands in one column, exactly like the `~` it replaces, so every
// width the transcript computes for a path is unchanged.
eq("and it costs one column", visibleWidth(describe.shortPath("/home/j/a", "/w/kit", "/home/j")), 3);
eq("elsewhere stays absolute", describe.shortPath("/etc/hosts", "/w/kit", "/home/j"), "/etc/hosts");
eq("relative input is left alone", describe.shortPath("lib/a.ts", "/w/kit", "/home/j"), "lib/a.ts");

const at = (tool, args) => describe.describe(tool, args, "/w/kit", "/home/j");
eq("bash shows the command", at("bash", { command: "npm test" }).text, "npm test");
eq("a multi-line command is flattened", at("bash", { command: "a &&\n  b" }).text, "a && b");
eq("a command is clipped from its tail", at("bash", { command: "npm test" }).clip, "tail");
eq("a path is clipped from its head", at("read", { path: "/w/kit/lib/a.ts" }).clip, "head");
eq("read shows the path", at("read", { path: "/w/kit/lib/a.ts" }).text, "lib/a.ts");
eq("read shows the window", at("read", { path: "a.ts", offset: 10, limit: 20 }).text, "a.ts 10-29");
eq("and the offset is the line the link opens at", at("read", { path: "a.ts", offset: 10 }).line, 10);
eq("a whole-file read names no line", at("read", { path: "a.ts" }).line, undefined);
// `List(.)` is honest and reads as nothing. A directory is named, like every
// other path on a row.
eq("listing the session root names it", at("ls", { path: "/w/kit" }).text, "/w/kit");
eq("under home it goes to the home glyph", describe.describe("ls", {}, "/home/j/kit", "/home/j").text, `${HOME_GLYPH}/kit`);
eq("listing anywhere else is unchanged", at("ls", { path: "/w/kit/lib" }).text, "lib");
// `glob` is the built-in's own name for the filter. `include` matched nothing.
eq("grep shows pattern and glob", at("grep", { pattern: "renderCall", path: "/w/kit/lib", glob: "*.ts" }).text, "renderCall in lib (*.ts)");
eq("grep at the session root names no scope", at("grep", { pattern: "renderCall", path: "/w/kit" }).text, "renderCall");
eq("find shows pattern and scope", at("find", { pattern: "*.ts", path: "/w/kit/lib" }).text, "*.ts in lib");
eq("edit names the file", at("edit", { path: "/w/kit/lib/a.ts", edits: [1, 2] }).text, "lib/a.ts");
eq("edit names every file", at("edit", { files: [{ path: "/w/kit/a.ts" }, { path: "/w/kit/b.ts" }] }).text, "a.ts, b.ts");
eq("an unknown tool contributes no argument", at("mcp__x__y", { anything: 1 }).text, "");

// Only an argument that *is* a path can be linked. A grep pattern that happens
// to look like a filename is not a file.
eq("a path argument carries its file", at("read", { path: "/w/kit/lib/a.ts" }).file, "/w/kit/lib/a.ts");
eq("a relative path is resolved for the link", at("read", { path: "lib/a.ts" }).file, "/w/kit/lib/a.ts");
eq("a pattern does not", at("grep", { pattern: "a.ts" }).file, undefined);
eq("a command does not", at("bash", { command: "cat a.ts" }).file, undefined);
eq("a multi-file edit does not", at("edit", { files: [{ path: "/a.ts" }, { path: "/b.ts" }] }).file, undefined);

// ---------------------------------------------------------------------------
// Clipping: which end goes is which half you would have read first.
// ---------------------------------------------------------------------------

eq("what fits is left alone", line.clip("abcdef", 6), "abcdef");
eq("a command keeps its head", line.clip("npm run build --watch", 10), "npm run b…");
eq("a path keeps its tail", line.clip("lib/deep/split-diff.ts", 10, "head"), "…t-diff.ts");
eq("one column is the ellipsis", line.clip("abcdef", 1), "…");
eq("no columns is nothing", line.clip("abcdef", 0), "");
eq("wrapping breaks a token wider than the column", line.wrap("aaaaaa bb", 4), ["aaaa", "aa", "bb"]);

// ---------------------------------------------------------------------------
// The header: one line, always, with the dot carrying the state.
// ---------------------------------------------------------------------------

const same = (t) => t;
const headerPaints = { dot: same, name: same, punctuation: same, argument: same };
const head = (fields, width) => {
	const component = new header.CallHeader();
	component.set({ state: "done", name: "Read", argument: "", clipEnd: "head", expanded: false, ...fields }, headerPaints);
	return component.render(width);
};

eq("name and argument", head({ argument: "lib/split-diff.ts" }, 60), ["● Read(lib/split-diff.ts)"]);
eq("no argument, no parentheses", head({ argument: "" }, 60), ["● Read"]);
eq("the name starts in column 2, where prose does", head({ argument: "x" }, 60)[0].indexOf("Read"), 2);
eq("a long path keeps its filename", head({ argument: "a/very/long/path/to/split-diff.ts" }, 24), ["● Read(…o/split-diff.ts)"]);
eq("a long command keeps its head", head({ name: "Bash", argument: "npm run build -- --watch", clipEnd: "tail" }, 24), ["● Bash(npm run build -…)"]);
eq("too narrow for an argument drops it", head({ argument: "lib/a.ts" }, 8), ["● Read"]);
eq("too narrow for the name clips the name", head({ name: "PowerShell", argument: "x" }, 6), ["● Pow…"]);

{
	// The light is a repaint of a laid-out line, so a settled row still hands back
	// the very array it cached and a running one is shaded without re-laying out.
	const settled = new header.CallHeader();
	settled.set({ state: "done", name: "Read", argument: "lib/a.ts", clipEnd: "head", expanded: false }, headerPaints);
	eq("a settled header returns its cached lines", settled.render(60) === settled.render(60), true);

	const running = new header.CallHeader();
	const fields = { state: "running", name: "Bash", argument: "npm test", clipEnd: "tail", expanded: false };
	// `"self"` lights a glyph off its own truecolour foreground, so an identity
	// paint would leave the row exactly as it found it.
	const truecolour = (text) => `\x1b[38;2;128;128;128m${text}\x1b[39m`;
	const litPaints = { dot: truecolour, name: truecolour, punctuation: truecolour, argument: truecolour };
	running.set({ ...fields, startedAt: Date.now() }, litPaints);
	const hues = new Set((running.render(60)[0].match(/38;2;\d+;\d+;\d+/g) ?? []).filter((c) => c !== "38;2;128;128;128"));
	eq("a running header is lit", hues.size > 1, true);
	const unlit = new header.CallHeader();
	unlit.set(fields, headerPaints);
	eq("a running header with no start time is not", unlit.render(60), ["● Bash(npm test)"]);
}
eq("expanded wraps instead of clipping", head({ name: "Bash", argument: "one two three four five", clipEnd: "tail", expanded: true }, 20), [
	"● Bash(one two",
	"  three four",
	"  five)",
]);

// A shell command is the one argument that earns a second row: its tail carries
// the redirect, the flag and the path being written, so one clipped line drops
// exactly the half you would have read second. Claude Code's two lines, 160
// characters, then `…`.
const COMMAND = "npm run build -- --watch --target es2022 --outfile dist/bundle.js --sourcemap inline";
eq("a command that fits still takes one line", head({ name: "Bash", argument: "npm test", clipEnd: "tail", headerRows: 2 }, 40), ["● Bash(npm test)"]);
const command = (width, fields = {}) => head({ name: "Bash", argument: COMMAND, clipEnd: "tail", headerRows: 2, ...fields }, width);
eq("a long command takes two, aligned under the argument start", command(60), [
	"● Bash(npm run build -- --watch --target es2022 --outfile",
	"       dist/bundle.js --sourcemap inline)",
]);
eq("the continuation starts under the open parenthesis", command(60)[1].search(/\S/), "● Bash(".length);
eq("and what will not fit is cut on the last row", command(30), ["● Bash(npm run build --", "       --watch --target es20…)"]);
// Only the collapsed row is capped. 160 columns is where a header stops
// identifying a call and starts reprinting it — however wide the pane is.
const LONG = "echo " + "x".repeat(400);
const argumentOf = (lines) => strip(lines.join("")).replace(/^● Bash\(/, "").replace(/\)$/, "");
eq("a command is capped at 160 columns on any pane", visibleWidth(argumentOf(head({ name: "Bash", argument: LONG, clipEnd: "tail", headerRows: 2 }, 400))), describe.COMMAND_HEADER_CHARS);
eq(
	"and ctrl+o is not capped: it wraps the whole command",
	visibleWidth(argumentOf(head({ name: "Bash", argument: LONG, clipEnd: "tail", headerRows: 2, expanded: true }, 400))) > describe.COMMAND_HEADER_CHARS,
	true,
);
// Everything that is not a shell command keeps the one-line rule.
eq("a path never takes a second row", head({ name: "Read", argument: "a/very/long/path/to/a/file/named/split-diff.ts", clipEnd: "head" }, 24).length, 1);

// The dot says which of the three states the row is in, and nothing else does.
const dotOf = (state) => strip(head({ state, argument: "a" }, 40)[0])[0];
eq("every state draws the same glyph", [dotOf("running"), dotOf("done"), dotOf("error")], ["●", "●", "●"]);
// Real escapes, so `strip` and `visibleWidth` see what a terminal would.
const themeStub = {
	fg: (color, t) => `\x1b[38;2;${[...color].reduce((n, c) => n + c.charCodeAt(0), 0) % 200};1;1m${t}\x1b[39m`,
	bold: (t) => `\x1b[1m${t}\x1b[22m`,
	bg: (_c, t) => t,
	italic: (t) => t,
};
const named = { fg: (color, t) => `<${color}>${t}`, bold: (t) => t, bg: (_c, t) => t, italic: (t) => t };
eq("colour is what separates them", ["running", "done", "error"].map((s) => header.dotPaint(named, s)("●")), [
	"<dim>●",
	"<success>●",
	"<error>●",
]);
eq("state is read off the row, not tracked", [
	header.stateOf(ctx({ isPartial: true })),
	header.stateOf(ctx({ isPartial: false })),
	header.stateOf(ctx({ isError: true })),
], ["running", "done", "error"]);

// The path is a hyperlink only when the file is really there to open.
const linked = (path, args = {}) => {
	const component = header.toolHeader("read", { path, ...args }, themeStub, ctx({ cwd: ROOT }));
	return component.render(80)[0];
};
setCapabilities({ ...getCapabilities(), hyperlinks: true });
eq("an existing file is clickable", linked(`${ROOT}/package.json`).includes("\x1b]8;;"), true);
eq("a missing one is not", linked(`${ROOT}/nothing-here.json`).includes("\x1b]8;;"), false);
setCapabilities({ ...getCapabilities(), hyperlinks: false });
eq("a terminal without OSC 8 gets no escapes", linked(`${ROOT}/package.json`).includes("\x1b]8;;"), false);

// ---------------------------------------------------------------------------
// Where a click goes. `file://` opens whatever LaunchServices thinks owns the
// extension — QuickTime Player, for a `.ts` file on this machine — so the rows
// link a scheme of their own instead, and carry the line with it.
// ---------------------------------------------------------------------------

const asked = (choice) => {
	if (choice === undefined) delete process.env.PI_TRANSCRIPT_OPEN;
	else process.env.PI_TRANSCRIPT_OPEN = choice;
	link.resetScheme();
};

asked("pi-open");
eq("a link carries the line the call is about", link.linkTo("/w/a.ts", 42), "pi-open:///w/a.ts?line=42");
eq("and says nothing when there is no line", link.linkTo("/w/a.ts"), "pi-open:///w/a.ts");
// `?` and `#` are URL syntax, and the handler splits the line off at the first
// `?`, so a filename containing one has to be encoded or it takes the line with it.
eq("URL syntax in a filename is encoded", link.linkTo("/w/a b#c?.ts", 1), "pi-open:///w/a%20b%23c%3F.ts?line=1");
asked("file");
eq("the old behaviour is one variable away", link.linkTo("/w/a.ts", 42), "file:///w/a.ts");
asked("off");
eq("and no links at all is another", link.linkTo("/w/a.ts", 42), undefined);
asked(undefined);
eq("the default follows whether the handler is installed", link.scheme(), existsSync(link.HANDLER) ? "pi-open" : "file");

asked("pi-open");
setCapabilities({ ...getCapabilities(), hyperlinks: true });
const target = (line) => {
	const match = /\x1b]8;;([^\x1b\x07]*)/.exec(line);
	return match ? match[1] : undefined;
};
eq("a read with an offset opens at that line", target(linked(`${ROOT}/package.json`, { offset: 12 })), `pi-open://${ROOT}/package.json?line=12`);
eq("a read of the whole file opens at the top", target(linked(`${ROOT}/package.json`)), `pi-open://${ROOT}/package.json`);
// `edit` learns its line from the result, one render after the header drew.
const edited = ctx({ cwd: ROOT, state: {} });
header.toolHeader("edit", { path: "package.json", edits: [1] }, themeStub, edited);
edited.state.line = 278;
eq("an edit opens at the line it changed", target(header.toolHeader("edit", { path: "package.json", edits: [1] }, themeStub, edited).render(80)[0]), `pi-open://${ROOT}/package.json?line=278`);
setCapabilities({ ...getCapabilities(), hyperlinks: false });
asked(undefined);

// ---------------------------------------------------------------------------
// A call that was interrupted stopped; it is not still working.
// ---------------------------------------------------------------------------

const cut = ctx({ isPartial: true, toolCallId: "cut" });
let redrawn = 0;
cut.invalidate = () => redrawn++;
header.toolHeader("bash", { command: "sleep 100" }, themeStub, cut);
eq("a running call says so", header.stateOf(cut), "running");
row.quiesce();
eq("once the run settles, a call still in flight was cut off", header.stateOf(cut), "aborted");
eq("and the row is asked to draw itself again", redrawn, 1);
eq("a cut call is hollow where a live one is filled", strip(head({ state: "aborted", argument: "x" }, 40)[0])[0], header.CUT);
// A call that settled before the run did is not watched, so nothing can mark it.
const landed = ctx({ toolCallId: "landed" });
header.toolHeader("bash", { command: "true" }, themeStub, landed);
row.quiesce();
eq("a settled call is left alone", header.stateOf(landed), "done");

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
eq("a note", res({ summary: sum("grep", "No matches found") }), ["  ⎿  No matches"]);
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

// ---------------------------------------------------------------------------
// The hint holds for its minimum. A command printing faster than the eye can
// finish a line leaves nothing readable behind, so the gutter is worth less
// than a blank one. Claude Code's `useMinDisplayTime`, at 700ms.
// ---------------------------------------------------------------------------

const held = {};
const hintAt = (text, ms) => row.heldHint(held, { line: text, hidden: 0 }, false, () => {}, ms)?.line;
eq("the first hint goes up at once", hintAt("PASS a", 1_000), "PASS a");
eq("one replacing it inside the window waits", hintAt("PASS b", 1_100), "PASS a");
// The window is a property of the line on screen, not of the last attempt to
// replace it, or a fast enough command would hold its first line forever.
eq("and the attempt does not restart the window", hintAt("PASS c", 1_690), "PASS a");
eq("past it, the newest one wins", hintAt("PASS c", 1_700), "PASS c");
// The newest value is never carried, only re-read: pi re-runs the result slot
// against the result it still holds. So a command that prints nothing more
// before its window closes still ends on its real last line rather than on the
// one before it, and that costs exactly one booked redraw however many frames
// were refused.
let closed = 0;
const silent = {};
const reopen = () => closed++;
const silentAt = Date.now();
row.heldHint(silent, { line: "first", hidden: 0 }, false, reopen, silentAt);
row.heldHint(silent, { line: "second", hidden: 0 }, false, reopen, silentAt + row.HINT_HOLD_MS - 25);
row.heldHint(silent, { line: "third", hidden: 0 }, false, reopen, silentAt + row.HINT_HOLD_MS - 20);
await new Promise((resolve) => setTimeout(resolve, 60));
eq("a hint that has gone quiet still closes its own window, once", closed, 1);

// A settled render is the record of what a command printed, and a record that
// arrives late is a row that changes after it has finished.
const finishing = {};
row.heldHint(finishing, { line: "PASS a", hidden: 0 }, false, () => {}, 2_000);
eq("settling is never held", row.heldHint(finishing, { line: "PASS z", hidden: 3 }, true, () => {}, 2_010), { line: "PASS z", hidden: 3 });
eq("and takes the hold down with it", finishing.hint, undefined);

// A body under the gutter belongs to the call above it.
const inner = { render: (width) => [`w=${width}`, "second"] };
eq("the gutter takes the first line", new result.Gutter(inner).render(60), ["  ⎿  w=55", "     second"]);
eq("and indenting takes none of them", result.indented(inner).render(60), ["     w=55", "     second"]);

// ---------------------------------------------------------------------------
// The contract: no line is ever wider than the width it was handed.
// ---------------------------------------------------------------------------

const overflows = [];
const headerCases = {
	"short path": { name: "Read", argument: "lib/a.ts", clipEnd: "head" },
	"long path": { name: "Read", argument: "/Users/joel/dotfiles/pi/kit/extensions/transcript/describe.ts", clipEnd: "head" },
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
	note: { summary: sum("grep", "No matches found") },
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
if (overflows.length > 0) {
	fail++;
	console.log(`--- width contract\n${overflows.length} overflowing line(s):\n  ${overflows.slice(0, 5).join("\n  ")}`);
} else {
	pass++;
	console.log(`--- width contract\nno row exceeds its width (${fixtureCount} fixtures × widths 4-200 × collapsed and expanded)`);
}

// ---------------------------------------------------------------------------
// The wiring: the extension takes over exactly the tools it claims.
// ---------------------------------------------------------------------------

const registered = new Map();
const events = [];
const load = async (path) =>
	(await jiti.import(`${ROOT}/extensions/${path}`, { default: true }))({
		registerTool: (t) => registered.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerMessageRenderer: () => {},
		on: (name) => events.push(name),
	});
await load("transcript/index.ts");

eq("claims the built-ins it renders", [...registered.keys()].sort(), ["find", "grep", "ls", "read", "write"]);
// bash is the kit's own tool: extensions/bash.ts registers it and wears this
// extension's receipt, so one registrar holds execution and rendering both.
await load("bash.ts");
eq("bash arrives from its own extension wearing the same receipt", registered.get("bash")?.renderShell, "self");
// Registering powershell would hand a Windows shell to a Mac; pi gates the
// built-in by platform and an override cannot.
eq("never registers powershell off Windows", registered.has("powershell"), process.platform === "win32");
eq("leaves edit to multi-edit", registered.has("edit"), false);
eq("keeps the built-in prompt text", typeof registered.get("bash").promptSnippet, "string");
eq("keeps the built-in schema", typeof registered.get("read").parameters, "object");
// pi's default shell is a padded box with a blank line above and below and a
// background the jarvis themes make transparent. A two-line receipt inside it is
// five lines of mostly nothing.
eq("draws its own shell", [...registered.values()].every((t) => t.renderShell === "self"), true);
eq("puts the rail back on shutdown", events.includes("session_shutdown"), true);
// Message boundaries are watched again, but for a fact rather than a guess: how
// many calls a message has streamed so far, so the rows behind the one being
// waited on never draw. The deleted merging watched them to predict whether more
// calls were coming, which is the thing that could be wrong.
eq("watches a message for the calls it has streamed", events.includes("message_update"), true);

await load("multi-edit.ts");
eq("edit joins the same system", registered.get("edit").renderShell, "self");

// ---------------------------------------------------------------------------
// Through pi's own row component, which is the only thing that proves it.
// ---------------------------------------------------------------------------

const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);
const { ToolExecutionComponent } = await import(`${PI}/dist/modes/interactive/components/index.js`);

const ui = { requestRender: () => {} };
function realComponent(tool, args, content, { partial = false, error = false, expanded = false, id } = {}) {
	const component = new ToolExecutionComponent(tool, id ?? `id-${tool}-${Math.random()}`, args, { showImages: true }, registered.get(tool), ui, ROOT);
	component.setExpanded(expanded);
	component.setArgsComplete();
	component.markExecutionStarted();
	if (content !== undefined) component.updateResult({ content, details: undefined, isError: error }, partial);
	return component;
}
function realRow(tool, args, content, options) {
	return realComponent(tool, args, content, options).render(80);
}
const text = (t) => [{ type: "text", text: t }];

const readRow = realRow("read", { path: `${ROOT}/package.json` }, text("a\nb\nc"));
eq("a row is a blank, a header, and a result", readRow.map(strip), ["", "● Read(package.json)", "  ⎿  Read 3 lines"]);

const pending = realRow("bash", { command: "sleep 5" }, undefined);
eq("a call with no result yet is just its header", pending.map(strip), ["", "● Bash(sleep 5)"]);

const { backgroundHint } = await jiti.import(`${ROOT}/lib/bash.ts`);
const HINT = backgroundHint();
const streaming = realComponent("bash", { command: "npm test" }, text("PASS a\nPASS b\n"), { partial: true });
eq("a running command tails its own output, and offers the background", streaming.render(120).map(strip), ["", "● Bash(npm test)", `  ⎿  PASS b  +1 line · ${HINT}`]);
// The offer is the first thing a narrow row gives up; the count is a fact.
eq("on a narrow row the offer goes before the count", streaming.render(40).map(strip).at(-1), "  ⎿  PASS b  +1 line");
const mute = realRow("bash", { command: "sleep 9" }, text(""), { partial: true });
eq("a running command with nothing printed yet still offers it", mute.map(strip), ["", "● Bash(sleep 9)", `  ⎿  ${HINT}`]);

// The same row, driven frame by frame the way a test runner drives it. Three
// lines inside one window is one line on screen, and the settled row is still
// the truth about where the command ended.
const strobe = realComponent("bash", { command: "npm test" }, text("PASS a\n"), { partial: true, id: "strobe" });
const gutter = () => strip(strobe.render(80).at(-1));
const printed = (t) => {
	strobe.updateResult({ content: text(t), details: undefined, isError: false }, true);
	return gutter();
};
eq("a fast command's gutter does not smear", [printed("PASS a\nPASS b\n"), printed("PASS a\nPASS b\nPASS c\n")], [`  ⎿  PASS a · ${HINT}`, `  ⎿  PASS a · ${HINT}`]);
strobe.updateResult({ content: text("PASS a\nPASS b\nPASS c\n"), details: undefined, isError: false }, false);
// Running, the row tails; settled, it shows the head. Three lines is the whole
// of this command's output, so the settled row is all of it and no footer.
eq("and the row it settles on is the head of what it printed", strobe.render(80).map(strip).slice(-3), [
	"  ⎿  PASS a",
	"     PASS b",
	"     PASS c",
]);

const quiet = realRow("bash", { command: "touch x" }, text(""));
// An empty result line reads as a row that is still working.
eq("a command that printed nothing says so", quiet.map(strip), ["", "● Bash(touch x)", "  ⎿  (no output)"]);

const broke = realRow("bash", { command: "cat nope" }, text("cat: nope: No such file\nexit 1"), { error: true });
eq("a failure keeps its output", broke.map(strip), ["", "● Bash(cat nope)", "  ⎿  cat: nope: No such file", "     exit 1"]);

// pi draws inline images itself, as children of the row. Drawing them from the
// result slot as well is how the same screenshot lands on screen twice.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const imageContent = [...text("Read image file [image/png]"), { type: "image", data: PNG, mimeType: "image/png" }];
const caps = getCapabilities();
try {
	setCapabilities({ ...caps, images: "kitty" });
	const drawn = realRow("read", { path: `${ROOT}/shot.png` }, imageContent);
	eq("an image reaches the screen", drawn.some((l) => l.includes("\x1b_G")), true);
	eq("exactly once", drawn.filter((l) => l.includes("\x1b_G")).length, 1);
	eq("and the row says how big it was", strip(drawn[2]), "  ⎿  Read image (72 B)");
} finally {
	setCapabilities(caps);
}
// Under tmux the picture cannot be drawn, so the line naming it is all there is.
const undrawable = realRow("read", { path: `${ROOT}/shot.png` }, imageContent);
eq("an undrawable image still names itself", /image\/png/.test(strip(undrawable[2])), true);
eq("and does not count the lines of the note", /\d+ lines?$/.test(strip(undrawable[2])), false);

show("rows @ 80", () =>
	[
		...realRow("read", { path: `${ROOT}/package.json` }, text("a\nb\nc")),
		...realRow("grep", { pattern: "renderCall", path: ROOT, glob: "*.ts" }, text("a.ts:1: x\nb.ts:9: x")),
		...realRow("bash", { command: "npm test" }, text("all 41 checks ok")),
		...realRow("bash", { command: "cat nope" }, text("cat: nope: No such file"), { error: true }),
	]
		.map(strip)
		.join("\n"),
);

// ---------------------------------------------------------------------------
// A run of calls collapses to one line: present tense while it runs, past tense
// when it is over.
//
// The grammar and every rule below were read off Claude Code (2.1.247, then
// 2.1.248) running in a pane beside this one, not guessed: one call collapses
// as readily as seven, a failure does not (that one is ours), work that
// finished while its own message is still running says nothing at all, and
// `ctrl+o` puts every row back.
// ---------------------------------------------------------------------------

const group = await jiti.import(`${ROOT}/extensions/transcript/group.ts`);
const rollup = await jiti.import(`${ROOT}/extensions/transcript/rollup.ts`);

const said = (t) => ({ type: "text", text: t });
const thought = (t) => ({ type: "thinking", thinking: t });
const call = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (...content) => ({ type: "message", message: { role: "assistant", content } });
const answer = (id, extra = {}) => ({ type: "message", message: { role: "toolResult", toolCallId: id, content: [said("ok")], isError: false, ...extra } });
const prompt = (t) => ({ type: "message", message: { role: "user", content: [said(t)] } });
const planned = (entries, live = false) => group.plan(entries, live).map((g) => g.ids.join("+"));
/** The same, with an ellipsis on the group whose line is present tense. */
const shape = (entries, live = true) => group.plan(entries, live).map((g) => g.ids.join("+") + (g.running ? "\u2026" : ""));
/** A shell call with its arguments closed, which is when the line can name it. */
const ran = (id, command) => ({ type: "toolCall", id, name: "bash", arguments: { command } });

eq(
	"one message, one group",
	planned([prompt("go"), assistant(said("on it"), call("a", "bash"), call("b", "bash")), answer("a"), answer("b")]),
	["a+b"],
);

// pi adds the whole assistant message at message_start and appends its rows
// after it, so a message that says anything says it above its own calls.
eq(
	"prose between two messages starts a new group",
	planned([assistant(call("a", "bash")), answer("a"), assistant(said("now this"), call("b", "bash")), answer("b")]),
	["a", "b"],
);
eq(
	"a silent message keeps the group going",
	planned([assistant(call("a", "bash")), answer("a"), assistant(call("b", "bash")), answer("b")]),
	["a+b"],
);
// Thinking never breaks a group, hidden or not — Claude Code skips thinking
// blocks when it groups too. With `hideThinkingBlock` on, which is this
// harness's setting, a reasoning model puts a thinking block in front of almost
// every message: counting one as prose made almost every message a group of one
// and put the rollup line out of reach of the models that use it most.
eq("thinking does not break a group", planned([assistant(call("a", "bash")), answer("a"), assistant(thought("hm"), call("b", "bash")), answer("b")]), ["a+b"]);
eq(
	"but text alongside it still does",
	planned([assistant(call("a", "bash")), answer("a"), assistant(thought("hm"), said("now this"), call("b", "bash")), answer("b")]),
	["a", "b"],
);
eq(
	"a thinking model's whole turn is one group",
	planned([assistant(thought("first"), call("a", "read")), answer("a"), assistant(thought("then"), call("b", "bash")), answer("b")]),
	["a+b"],
);
eq("an empty text block is not prose", planned([assistant(call("a", "bash")), answer("a"), assistant(said("  "), call("b", "bash")), answer("b")]), ["a+b"]);

// Everything below is a row that stays on screen, so the run is cut there
// rather than summarised around it.
eq(
	"a failure keeps its row and splits the group",
	planned([assistant(call("a", "read"), call("b", "bash"), call("c", "read")), answer("a"), answer("b", { isError: true }), answer("c")]),
	["a", "c"],
);
eq(
	"a write keeps its row",
	planned([assistant(call("a", "read"), call("b", "write"), call("c", "read")), answer("a"), answer("b"), answer("c")]),
	["a", "c"],
);
eq("an unknown tool keeps its row", planned([assistant(call("a", "read"), call("b", "mcp__x__y")), answer("a"), answer("b")]), ["a"]);
// pi draws the picture as a child of the row whether or not the renderers
// produce a line, so a collapsed row would leave it floating under no header.
eq(
	"a result carrying a picture keeps its row",
	planned([assistant(call("a", "read"), call("b", "read")), answer("a", { content: [{ type: "image", data: "x", mimeType: "image/png" }] }), answer("b")]),
	["b"],
);
// A run that is over has no calls in flight, so one that never came back was
// interrupted, and an interrupted call keeps its row.
eq("an interrupted call keeps its row and splits the group", planned([assistant(call("a", "read"), call("b", "read")), answer("b")]), ["b"]);
eq(
	"the calls either side of it still fold",
	planned([assistant(call("a", "read"), call("b", "read"), call("c", "read")), answer("a"), answer("c")]),
	["a", "c"],
);
// While the run is live, a call that has not come back joins its group and is
// the reason the group speaks in the present tense. pi creates a row for every
// call in a batch as its arguments stream, so without this a seven-call turn is
// seven rows on screen before any of them has run.
//
// The tense is a property of the *run*, not of the results: it is present from
// the first token to `agent_settled`, whatever has already come back. Deciding
// it per result is what made a turn of three commands bounce two lines to one
// and back, since the gap between one result and the next call has nothing in
// flight in it.
const batch = [assistant(call("a", "read"), call("b", "bash"), call("c", "bash"))];
eq("a live batch speaks in the present from the first token", shape(batch), ["a+b+c\u2026"]);
eq("a result landing changes nothing about the tense", shape([...batch, answer("a")]), ["a+b+c\u2026"]);
// A batch runs in parallel, so the third result can land before the second.
eq("nor does one landing out of order", shape([...batch, answer("a"), answer("c")]), ["a+b+c\u2026"]);
eq("nor the last of them, while the model is still going", shape([...batch, answer("a"), answer("b"), answer("c")]), ["a+b+c\u2026"]);
eq("the run stopping is what makes it past", shape([...batch, answer("a"), answer("b"), answer("c")], false), ["a+b+c"]);
eq("a settled run with a call still out keeps that row", shape(batch, false), []);
// Only the group the transcript ends on can be about work still happening;
// everything before it has something printed after it.
eq(
	"only the trailing group is present tense",
	shape([assistant(call("a", "read")), answer("a"), prompt("more"), assistant(call("b", "read"))]),
	["a", "b\u2026"],
);
// A row that stays ends the run whether or not anything is still going.
eq("a write splits a live batch too", shape([assistant(call("a", "read"), call("b", "write"), call("c", "read"))]), ["a", "c\u2026"]);

// A result reaches the planner before it reaches the session, because pi emits
// the event first and a parallel batch writes every result down at the end.
group.noteResult("b", false);
eq("a result that has not been written down yet still folds", planned([assistant(call("a", "read"), call("b", "read")), answer("a")]), ["a+b"]);
group.noteResult("c", true);
eq("and a failure that has not either keeps its row", planned([assistant(call("c", "read"), call("a", "read")), answer("a")]), ["a"]);
group.forgetResults();
eq("forgotten once the session has them", planned([assistant(call("a", "read"), call("b", "read")), answer("a")]), ["a"]);
eq(
	"an interrupted turn keeps every row",
	planned([{ type: "message", message: { role: "assistant", stopReason: "aborted", content: [call("a", "read"), call("b", "read")] } }, answer("a")]),
	[],
);
eq("a user message splits", planned([assistant(call("a", "read")), answer("a"), prompt("more"), assistant(call("b", "read")), answer("b")]), ["a", "b"]);
eq(
	"a compaction summary splits",
	planned([assistant(call("a", "read")), answer("a"), { type: "compaction", summary: "…" }, assistant(call("b", "read")), answer("b")]),
	["a", "b"],
);
// A model change prints nothing, so it cannot separate two rows.
eq(
	"an invisible entry does not",
	planned([assistant(call("a", "read")), answer("a"), { type: "model_change" }, assistant(call("b", "read")), answer("b")]),
	["a+b"],
);
eq("junk in the entries is ignored, not thrown over", planned([null, undefined, 7, "x", { type: "message" }]), []);

// The line itself. Claude Code's grammar to the word: past tense, a bold count,
// a plain unit, only the first clause capitalised.
const clauses = (...tools) => rollup.rollupText(rollup.clausesFor(tools));
eq("one read", clauses("read"), "Read 1 file");
eq("the turn from the screenshot", clauses("ls", "bash", "bash", "bash", "bash", "bash", "bash"), "Listed 1 directory, ran 6 shell commands");
// Fixed order, not call order: search → read → list → shell. Aggregating by tool
// has already destroyed the sequence, so call order only reports which tool went
// first — at the price of the same turn reading differently every time.
eq("clauses take a fixed order, not the call order", clauses("bash", "read", "bash"), "Read 1 file, ran 2 shell commands");
eq("the whole ranking", clauses("bash", "ls", "read", "grep"), "Searched for 1 pattern, read 1 file, listed 1 directory, ran 1 shell command");
eq("the same tools in any order give the same line", clauses("grep", "bash", "read"), clauses("read", "grep", "bash"));
eq("grep", clauses("grep", "grep"), "Searched for 2 patterns");
// Both enumerate paths and Claude Code says the same thing for either, so two
// clauses would be two numbers to add up in your head.
eq("find and ls are one clause", clauses("find", "ls"), "Listed 2 directories");
eq("a tool with no verb contributes nothing", clauses("read", "edit"), "Read 1 file");
eq("nothing to say is no line", new rollup.RollupLine().render(80), []);

// The present tense of the same grammar, for the calls a group is waiting on.
// `Running 2 shell commands…` is Claude Code's own wording, read off the pane.
const doing = (...tools) => rollup.rollupText(rollup.clausesFor(tools, "present"));
eq("claude code's own live wording", doing("bash", "bash"), "Running 2 shell commands");
eq("every verb has a present", [doing("read"), doing("grep"), doing("ls")], ["Reading 1 file", "Searching for 1 pattern", "Listing 1 directory"]);
eq("tools that share a verb share a clause in either tense", doing("find", "ls"), "Listing 2 directories");
eq("and the fixed order holds in the present too", doing("bash", "read", "bash"), "Reading 1 file, running 2 shell commands");

// ---------------------------------------------------------------------------
// A clause that counts nouns dedupes; a clause that counts verbs does not.
//
// `Read N files` names things, so SETUP.html paged five times with `offset` is
// one file. `Ran N shell commands` names acts, and the same command twice
// happened twice. What each call is about comes from the planner, and a call
// that has not said yet is not counted at all: a number counted before it is
// identified is a number that has to be taken back, and this line may never
// take one back.
// ---------------------------------------------------------------------------

const about = (tools, subjects, tense = "past") => rollup.rollupText(rollup.clausesFor(tools, tense, subjects));
eq("the same file twice is one file", about(["read", "read"], ["/x/SETUP.html", "/x/SETUP.html"]), "Read 1 file");
eq("two different files are two", about(["read", "read"], ["/x/a.ts", "/x/b.ts"]), "Read 2 files");
// The whole point of counting nouns: five pages of one file are one file, and
// the five calls that fetched them are not the answer to "what did that turn do".
eq("five pages of one file are one file", about(new Array(5).fill("read"), new Array(5).fill("/x/SETUP.html")), "Read 1 file");
// A verb clause counts acts, so identical ones are still two acts. Nothing about
// `bash` is deduped by the command it ran.
eq("five identical shell commands are five", about(new Array(5).fill("bash"), new Array(5).fill("npm test")), "Ran 5 shell commands");
eq(
	"and identical searches and listings do not dedupe either",
	about(["grep", "grep", "ls", "ls"], ["renderCall", "renderCall", "/tmp", "/tmp"]),
	"Searched for 2 patterns, listed 2 directories",
);
// Passing no subjects at all is a caller that does not know what its calls were
// about, which is a different statement from a call that has not said yet.
eq("a caller with nothing to say about identity counts calls", clauses("read", "read"), "Read 2 files");

// A call whose arguments are still streaming has no path, so it has no identity,
// so it is not counted. The clause reads short for the fraction of a second the
// arguments take to land, and then grows.
eq("a read still streaming its arguments is not counted yet", about(["read", "read"], ["/x/a.ts", undefined], "present"), "Reading 1 file");
eq("and when it lands the count goes up", about(["read", "read"], ["/x/a.ts", "/x/b.ts"], "present"), "Reading 2 files");
// Landing on a path already counted leaves it where it was, which is the case
// that would have run backwards had the streaming call been counted as a call.
eq("landing on a path already there leaves it alone", about(["read", "read"], ["/x/a.ts", "/x/a.ts"], "present"), "Reading 1 file");

/** A call whose arguments have finished streaming. */
const reading = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
// The same call mid-stream, the way pi hands it over: every provider reparses
// the prefix into `arguments` on each delta and keeps the raw buffer beside it
// until the call closes, so a partial path is an ordinary-looking string and the
// buffer is the only thing that says it is still growing.
const mistyping = (id, prefix) => ({ type: "toolCall", id, name: "read", arguments: { path: prefix }, partialJson: `{"path":"${prefix}` });

eq(
	"the planner reads a subject off a landed call and none off a streaming one",
	group.plan([assistant(mistyping("s1", "/x/SET"), reading("s2", "/x/a.ts"))], true)[0].subjects.map((s) => s ?? "(streaming)"),
	["(streaming)", "/x/a.ts"],
);
// Arguments that landed naming no path cannot be compared with anything, so the
// call is its own item rather than a call that vanished.
eq("a landed call naming no path still counts as one", about(["read", "read"], ["n1", "n2"]), "Read 2 files");

// The property itself, over the sequence a real batch goes through: arguments
// stream in one at a time, two of the reads turn out to be the same file, then
// the results land. The read count must never fall between two frames — this is
// the walk that catches a rule which counts a call before it knows its path.
const readCount = (entries) => {
	const [g] = group.plan(entries, true);
	if (!g) return 0;
	const said = rollup.clausesFor(g.tools, g.running ? "present" : "past", g.subjects);
	return said.find((clause) => clause.unit === "file")?.count ?? 0;
};
const batched = [reading("m1", "/x/SETUP.html"), reading("m2", "/x/SETUP.html"), reading("m3", "/x/other.ts"), call("m4", "bash")];
const frames = [
	[assistant(mistyping("m1", "/x/SET"))],
	[assistant(reading("m1", "/x/SETUP.html"), mistyping("m2", "/x/SETUP.ht"))],
	[assistant(reading("m1", "/x/SETUP.html"), reading("m2", "/x/SETUP.html"), mistyping("m3", "/x/o"))],
	[assistant(...batched)],
	[assistant(...batched), answer("m1")],
	[assistant(...batched), answer("m1"), answer("m2")],
	[assistant(...batched), answer("m1"), answer("m2"), answer("m3")],
	[assistant(...batched), answer("m1"), answer("m2"), answer("m3"), answer("m4")],
].map(readCount);
// Frame 3 is the one that matters: two calls, one file. Counting the streaming
// call would have said 2 there and 1 in the next frame.
eq("the read count, frame by frame, as a batch streams in and lands", frames, [0, 1, 1, 2, 2, 2, 2, 2]);
eq("and it never falls between two frames", frames.every((count, i) => i === 0 || count >= frames[i - 1]), true);

const plain = { word: (t) => t, count: (t) => t, dot: (t) => t };
const asLine = (tools, tense, live) => {
	const line = new rollup.RollupLine();
	line.set(rollup.clausesFor(tools, tense), plain, live);
	return line.render(80)[0];
};
const spoken = asLine(["read", "bash", "bash"], "present", true);
const settled = asLine(["read", "bash", "bash"], "past", false);
eq("a live line wears a dot and ends in an ellipsis", spoken, "● Reading 1 file, running 2 shell commands…");
eq("a settled line has neither", settled, "  Read 1 file, ran 2 shell commands");
// The swap from one to the other has to move no word: the dot and its space are
// exactly the indent the past-tense line uses.
eq("and both start in the same column", [spoken.indexOf("R"), settled.indexOf("R")], [2, 2]);

{
	// The rollup line is the row on screen while calls run, so it is the row the
	// chrome's light has to cross. Lit off each glyph's own colour, outside the
	// layout cache, and only while live with a start to phase from.
	const grey = (text) => `\x1b[38;2;128;128;128m${text}\x1b[39m`;
	const litPaints = { word: grey, count: (text) => `\x1b[1m${grey(text)}\x1b[22m`, dot: grey, gutter: grey, hint: grey };
	const huesOf = (lines) => new Set((lines.join("\n").match(/38;2;\d+;\d+;\d+/g) ?? []).filter((c) => c !== "38;2;128;128;128"));
	const clauses = rollup.clausesFor(["read", "bash", "bash"], "present");
	const lit = new rollup.RollupLine();
	lit.set(clauses, litPaints, true, "5.0s", "$ npm test", Date.now() - 5_000);
	const drawn = lit.render(80);
	eq("a live rollup line is lit", huesOf(drawn).size > 1, true);
	eq("and the bold count survives the light", drawn[0].includes("\x1b[1m"), true);
	eq("the light repaints the cached layout, not the cache", lit.render(80).length, drawn.length);
	const unlit = new rollup.RollupLine();
	unlit.set(clauses, litPaints, true, "5.0s");
	eq("a live line with no start time is not", huesOf(unlit.render(80)).size, 0);
	const done = new rollup.RollupLine();
	done.set(rollup.clausesFor(["read", "bash", "bash"], "past"), litPaints, false, null, undefined, Date.now() - 5_000);
	eq("a settled line cannot wear the light however it is called", huesOf(done.render(80)).size, 0);
}

// ---------------------------------------------------------------------------
// Through pi's own rows again: the group has to actually disappear.
// ---------------------------------------------------------------------------

const turn = [
	realComponent("read", { path: `${ROOT}/package.json` }, text("a\nb\nc"), { id: "g1" }),
	realComponent("bash", { command: "whoami" }, text("joel"), { id: "g2" }),
	realComponent("bash", { command: "date" }, text("Thu"), { id: "g3" }),
];
/** A result arriving on a row that had none, which is how a call actually lands. */
const land = (component, content) => component.updateResult({ content, details: undefined, isError: false }, false);
const entries = [prompt("go"), assistant(call("g1", "read"), call("g2", "bash"), call("g3", "bash")), answer("g1"), answer("g2"), answer("g3")];
const drawTurn = () => turn.flatMap((component) => component.render(80)).map(strip);
const headers = () => drawTurn().filter((line) => line.startsWith("●"));
// A row learns the group opened when the lead draws its line, and is asked to
// redraw on the microtask after it. pi schedules its frame on a timer, so the
// app never sees the gap; a test that renders by hand has to wait for it.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The gutter's minimum display time, waited out where a test needs it to change. */
const hold = () => new Promise((resolve) => setTimeout(resolve, row.HINT_HOLD_MS + 20));

eq("while it runs, every call has its row", headers().length, 3);

// The whole turn, the way it happens: pi draws every row of the batch as the
// arguments stream, before any of them has run, and one call at a time comes
// back. Through all of it the line says the same thing — the counts are the
// group's, not the in-flight subset's, so nothing on screen runs backwards.
const running = [
	realComponent("read", { path: `${ROOT}/package.json` }, undefined, { id: "g1" }),
	realComponent("bash", { command: "whoami" }, undefined, { id: "g2" }),
	realComponent("bash", { command: "date" }, undefined, { id: "g3" }),
];
const drawRunning = () => running.flatMap((component) => component.render(80)).map(strip);
const inFlight = [prompt("go"), assistant(reading("g1", `${ROOT}/package.json`), ran("g2", "whoami"), ran("g3", "date"))];

group.regroup(inFlight, true);
eq("a batch in flight is one line, not one row per call", drawRunning(), ["", "● Reading 1 file, running 2 shell commands…", "  ⎿  $ date"]);

land(running[0], text("a\nb\nc"));
group.regroup([...inFlight, answer("g1")], true);
eq("a landing call changes nothing on the line", drawRunning()[1], "● Reading 1 file, running 2 shell commands…");

land(running[1], text("joel"));
group.regroup([...inFlight, answer("g1"), answer("g2")], true);
// The old rule swapped the counted line for the last call's own header here,
// which changed the component under the cursor one frame before the group
// settled. Shape is read off `ids.length`, which cannot shrink.
eq("one call left is still the same line", drawRunning()[1], "● Reading 1 file, running 2 shell commands…");

// The counts a batch settles on are the counts it showed all along: only the
// verb moves. This is the property the whole no-jump rule exists to buy.
const liveText = drawRunning()[1];
land(running[2], text("Mon"));
group.regroup([...inFlight, answer("g1"), answer("g2"), answer("g3")], true);
const numbers = (s) => s.match(/\d+/g)?.join(",") ?? "";
eq("settling moves no number", numbers(drawRunning()[1] ?? ""), numbers(liveText));

land(running[2], text("Thu"));
group.regroup(entries);
eq("and when the run ends, the past tense, in the same column", drawRunning(), ["", "  Read 1 file, ran 2 shell commands"]);

// The line draws its own gutter, naming the newest call it stands for by what
// it was asked to do. The rows underneath draw nothing in either slot, so this
// is the only thing on screen that can say it.
const tailing = [
	realComponent("bash", { command: "npm test" }, text("PASS a\nPASS b\n"), { partial: true, id: "t1" }),
	realComponent("bash", { command: "npm run lint" }, undefined, { id: "t2" }),
];
const drawTailing = () => tailing.flatMap((component) => component.render(80)).map(strip);
group.regroup([assistant(ran("t1", "npm test"), ran("t2", "npm run lint"))], true);
eq("a live line names the newest call it is waiting on", drawTailing(), ["", "● Running 2 shell commands…", "  ⎿  $ npm run lint"]);
// What a folded command prints stays off the line: the gutter is the call's
// name, as Claude Code's `latestDisplayHint` is, not its stdout going past.
await hold();
tailing[1].updateResult({ content: text("lint: 3 files\n"), details: undefined, isError: false }, true);
drawTailing();
await settle();
eq("and keeps naming it once it prints", drawTailing().slice(-1), ["  ⎿  $ npm run lint"]);
eq("and is still two lines", drawTailing().length, 3);

// Through the real rows, which is the only thing that proves the wiring: the
// line says files rather than calls because the planner hands it what each call
// was about, and the same file fetched twice is one file.
const pages = [
	realComponent("read", { path: `${ROOT}/package.json` }, undefined, { id: "p1" }),
	realComponent("read", { path: `${ROOT}/package.json` }, undefined, { id: "p2" }),
	realComponent("bash", { command: "date" }, undefined, { id: "p3" }),
];
group.regroup([assistant(reading("p1", `${ROOT}/package.json`), reading("p2", `${ROOT}/package.json`), ran("p3", "date"))], true);
eq(
	"one file paged twice is one file on the line",
	pages.flatMap((component) => component.render(80)).map(strip),
	["", "● Reading 1 file, running 1 shell command…", "  ⎿  $ date"],
);

// ---------------------------------------------------------------------------
// A group of one draws the line too, from the moment it is seated.
//
// `Running 1 shell command…` over `$ date` says what the row said, in the two
// columns the run will settle in, so a turn of three commands is two lines from
// the first token to the last rather than a block that changes height per call.
// ---------------------------------------------------------------------------

const alone = realComponent("bash", { command: "date" }, undefined, { id: "s1" });
const drawAlone = () => alone.render(80).map(strip);
group.regroup([assistant(ran("s1", "date"))], true);
eq("one call in flight is the line, named by its command", drawAlone(), ["", "● Running 1 shell command…", "  ⎿  $ date"]);
land(alone, text("Thu"));
group.regroup([assistant(ran("s1", "date")), answer("s1")]);
eq("and folds the moment it settles", drawAlone(), ["", "  Ran 1 shell command"]);
alone.setExpanded(true);
eq("ctrl+o and a click put the one row back", drawAlone(), ["", "● Bash(date)", "  ⎿  Thu"]);
alone.setExpanded(false);

// The exceptions are the ones that were always there, and each of them is a row
// the planner never puts in a group at all.
const keeps = (id, tool, args, content, options = {}) => {
	const component = realComponent(tool, args, content, { id, ...options });
	group.regroup([assistant(call(id, tool)), answer(id, options.answer)]);
	return component.render(80).map(strip)[1];
};
eq("a lone write keeps its row", keeps("s2", "write", { path: `${ROOT}/x.txt`, content: "a\n" }, text("Successfully wrote 2 bytes")), "● Write(x.txt)");
eq(
	"a lone failure keeps its row",
	keeps("s3", "bash", { command: "cat nope" }, text("cat: nope: No such file"), { error: true, answer: { isError: true } }),
	"● Bash(cat nope)",
);
eq(
	"a lone read of a picture keeps its row",
	keeps("s4", "read", { path: `${ROOT}/shot.png` }, [{ type: "image", data: "x", mimeType: "image/png" }], {
		answer: { content: [{ type: "image", data: "x", mimeType: "image/png" }] },
	}),
	"● Read(shot.png)",
);
// A run that stopped with the call still out is a call that was interrupted, and
// an interrupted call is the record of what happened.
const hollow = realComponent("bash", { command: "ping -c 25 127.0.0.1" }, undefined, { id: "s5" });
group.regroup([assistant(call("s5", "bash"))]);
row.quiesce();
hollow.invalidate();
eq("a lone call the run left behind keeps its row too", hollow.render(80).map(strip), ["", "○ Bash(ping -c 25 127.0.0.1)"]);

// ---------------------------------------------------------------------------
// Three shell commands, one per message, frame by frame — the shape a thinking
// model actually produces, and the one the old rules bounced on: two lines,
// one to the next, changing words in place, and one shrink at the very end.
//
// The tense used to be read off the results, so the gap between a command
// coming back and the next call being streamed had nothing in flight in it and
// the block fell to one line and grew back. It is read off the run now.
// ---------------------------------------------------------------------------

/** A call mid-stream: pi seats its row on the first token, long before it closes. */
const streamingBash = (id, prefix) => ({ type: "toolCall", id, name: "bash", arguments: { command: prefix }, partialJson: `{"command":"${prefix}` });
const flow = [];
const flowRows = [];
const drawFlow = () => {
	for (const component of flowRows) component.invalidate();
	// The clock is the one thing on the line that is allowed to move on its own,
	// and these frames are seconds apart.
	return flowRows.flatMap((component) => component.render(80)).map(strip).map((line) => line.replace(/ · [\d.]+s/, ""));
};
const prints = (index, text_) => flowRows[index].updateResult({ content: text(text_), details: undefined, isError: false }, true);
const lands = (index, id, text_) => {
	flowRows[index].updateResult({ content: text(text_), details: undefined, isError: false }, false);
	flow.push(answer(id));
	group.regroup(flow, true);
};
/** A frame: draw, let deferred redraws run, draw again. */
const frame = async () => {
	drawFlow();
	await settle();
	return drawFlow();
};
/**
 * The same, for a frame the gutter is allowed to change on.
 *
 * A hint that replaces one put up less than `HINT_HOLD_MS` ago waits its turn,
 * and the wait books its own redraw, so this is what the screen shows a moment
 * later rather than a different rule.
 */
const changed = async () => {
	await hold();
	return await frame();
};
const opens = (id, prefix) => {
	flow.push(assistant(thought("next"), streamingBash(id, prefix)));
	flowRows.push(realComponent("bash", { command: prefix }, undefined, { id }));
	group.regroup(flow, true);
};
const closes = (id, command) => {
	flow[flow.length - 1] = assistant(thought("next"), ran(id, command));
	group.regroup(flow, true);
};

opens("f1", "ec");
eq("a call still streaming its arguments says nothing yet", await frame(), []);
closes("f1", "echo one");
eq("closing them puts it on the line and under it", await frame(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

// The gutter names the call, as Claude Code's `latestDisplayHint` does. Output
// going past is not the transcript saying something.
prints(0, "one\n");
eq("what the command prints does not replace the command", await changed(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

lands(0, "f1", "one\n");
eq("the result landing leaves the block exactly where it was", await frame(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

opens("f2", "ec");
// The whole no-bounce property in one line: the model is thinking, nothing is
// in flight, and the second call has not said what it is yet.
eq("a second call streaming is seated, not counted, and moves nothing", await frame(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

closes("f2", "echo two");
eq("it joins the count and the gutter in the same frame", await changed(), ["", "● Running 2 shell commands…", "  ⎿  $ echo two"]);

lands(1, "f2", "");
opens("f3", "e");
eq("and the third call streaming moves nothing either", await frame(), ["", "● Running 2 shell commands…", "  ⎿  $ echo two"]);
closes("f3", "echo three");
eq("three commands, still two lines", await changed(), ["", "● Running 3 shell commands…", "  ⎿  $ echo three"]);
prints(2, "three\n");
eq("and the newest one printing changes nothing", await changed(), ["", "● Running 3 shell commands…", "  ⎿  $ echo three"]);

lands(2, "f3", "three\n");
group.regroup(flow);
eq("the turn ending is the one shrink in the whole run", await frame(), ["", "  Ran 3 shell commands"]);

group.regroup(entries);

// ctrl+o sets `expanded` on every row at once; a click sets it on the one row a
// collapsed group leaves clickable, which is the line itself.
for (const component of turn) component.setExpanded(true);
await settle();
eq("ctrl+o puts the rows back", headers(), ["● Read(package.json)", "● Bash(whoami)", "● Bash(date)"]);
for (const component of turn) component.setExpanded(false);
await settle();
eq("and takes them away again", drawTurn(), ["", "  Read 1 file, ran 2 shell commands"]);

// Only the lead is clickable once a group is collapsed, so opening it has to
// open the rows it stands for and not just itself.
turn[0].setExpanded(true);
await settle();
eq("the lead speaks for the group", headers(), ["● Read(package.json)", "● Bash(whoami)", "● Bash(date)"]);
turn[0].setExpanded(false);
await settle();
eq("and closing it closes them", drawTurn(), ["", "  Read 1 file, ran 2 shell commands"]);

// A second plan over the same transcript must not disturb what is on screen.
group.regroup(entries);
eq("replanning is idempotent", drawTurn(), ["", "  Read 1 file, ran 2 shell commands"]);

show("a settled turn @ 80", () => {
	const kept = realComponent("bash", { command: "cat nope" }, text("cat: nope: No such file"), { id: "g4", error: true });
	const after = realComponent("read", { path: `${ROOT}/README.md` }, text("a\nb"), { id: "g5" });
	group.regroup([...entries, assistant(call("g4", "bash"), call("g5", "read")), answer("g4", { isError: true }), answer("g5")]);
	return [...turn, kept, after]
		.flatMap((component) => component.render(80))
		.map(strip)
		.join("\n");
});

// The width contract holds for the collapsed line in both tenses — and this is
// the one line in the transcript that wraps rather than clips. Clipping drops
// the last clause, which is the one thing on the line that cannot be guessed;
// a four-clause turn on an 80-column pane ended in `…ran 2 shell comm…` until
// this changed. Claude Code wraps it to the same indent.
const busy = ["grep", "grep", "read", "read", "read", "ls", "bash", "bash"];
const wide = new rollup.RollupLine();
wide.set(rollup.clausesFor(busy), plain);
eq("a long line wraps to the indent it started in", wide.render(60).map(strip), [
	"  Searched for 2 patterns, read 3 files, listed 1 directory,",
	"  ran 2 shell commands",
]);
wide.invalidate();
wide.set(rollup.clausesFor(busy, "present"), plain, true);
eq("and a live one keeps the dot on the first line only", wide.render(60).map(strip), [
	"● Searching for 2 patterns, reading 3 files, listing 1",
	"  directory, running 2 shell commands…",
]);

const tooWide = [];
const lost = [];
for (const [tense, live] of [
	["past", false],
	["present", true],
]) {
	// The clock rides on the live line, so the contract has to hold with it there.
	const clock = live ? "5.0s" : null;
	const whole = rollup.rollupText(rollup.clausesFor(busy, tense)) + (live ? ` · ${clock}…` : "");
	for (let width = 4; width <= 200; width++) {
		wide.invalidate();
		wide.set(rollup.clausesFor(busy, tense), plain, live, clock);
		const lines = wide.render(width).map(strip);
		for (const line of lines) if (visibleWidth(line) > width) tooWide.push(`${tense} ${width}: ${line}`);
		// Every line past the first starts in the same column as the first, so the
		// sentence is the lines joined at their space.
		// Below a column that fits the longest word (`directory,`) a word has to be
		// broken, and a break is not a space. Everything wider than that breaks at
		// spaces only, which is what makes the join sound.
		const said = lines.map((line) => line.slice(2)).join(" ");
		if (width >= 12 && lines.length > 0 && said !== whole) lost.push(`${tense} ${width}: ${said}`);
	}
}
eq("a rollup line never overflows its width", tooWide, []);
eq("and never loses a word to it either", lost, []);

// ---------------------------------------------------------------------------
// The clock. A silent command prints nothing, so without one the screen says
// the same words for a minute and a half and working reads exactly like hung.
// ---------------------------------------------------------------------------

// It belongs to the group, not to any one row: the members of a batch start at
// different moments, and what the line counts is the run.
const clocked = [assistant(call("k1", "grep"), call("k2", "bash"), call("k3", "bash"))];
group.regroup(clocked, true);
/** A row telling the planner when it began, which is what a header render does. */
const beganAt = (id, at) => group.noteRow(ctx({ toolCallId: id, isPartial: true, state: { startedAt: at } }));
beganAt("k2", 1_500);
beganAt("k1", 1_000);
beganAt("k3", 2_000);
eq("the group starts when its earliest member did", group.lineOf("k1").startedAt, 1_000);

group.noteResult("k1", false);
group.regroup([...clocked, answer("k1")], true);
const seatOf = (id) => group.roleOf(ctx({ toolCallId: id }));
// The speaker is the first row of the group and never moves: a result landing
// on it changes what the line says, not which component says it.
eq("a result does not hand the line to another row", [seatOf("k1"), seatOf("k2")], ["line", "hidden"]);
eq("and the clock stays where the run began", group.lineOf("k2").startedAt, 1_000);
group.forgetResults();

// Through the real rows, which is the only thing that proves the wiring.
const ticked = [assistant(call("c1", "bash"), call("c2", "bash"))];
group.regroup(ticked, true);
const clockRows = [
	realComponent("bash", { command: "sleep 30" }, undefined, { id: "c1" }),
	realComponent("bash", { command: "sleep 30" }, undefined, { id: "c2" }),
];
const redrawAll = () => {
	for (const component of clockRows) component.invalidate();
	return clockRows.flatMap((component) => component.render(80)).map(strip);
};
// `formatDuration`'s floor: a line that blinks `0.0s` into existence for two
// frames is the noise this whole extension exists to remove.
eq("a batch that just started shows no clock", redrawAll(), ["", "● Running 2 shell commands…"]);
beganAt("c1", Date.now() - 5_000);
// Spelled by the same function a settled row's `· 2.4s` uses, so one fact is not
// said two ways one line apart.
eq("past the floor it says how long", redrawAll(), ["", "● Running 2 shell commands · 5.0s…"]);

group.regroup([...ticked, answer("c1"), answer("c2")]);
eq("a settled line carries no clock", redrawAll(), ["", "  Ran 2 shell commands"]);

// What the tick is allowed to touch is the whole of what it costs, and this
// codebase refuses periodic repaints for good reasons (`header.ts`). One row per
// live group — the row drawing its line — and nothing for a group beside it that
// has already settled.
const drew = { p1: 0, p2: 0, q1: 0, q2: 0 };
const mixed = [
	assistant(call("q1", "bash"), call("q2", "bash")),
	answer("q1"),
	answer("q2"),
	prompt("now this"),
	assistant(call("p1", "bash"), call("p2", "bash")),
];
group.regroup(mixed, true);
for (const id of Object.keys(drew)) {
	group.noteRow(ctx({ toolCallId: id, isPartial: true, invalidate: () => drew[id]++, state: { startedAt: Date.now() - 5_000 } }));
}
await new Promise((resolve) => setTimeout(resolve, 1_050));
eq("one tick repaints the live group's speaking row and nothing else", [drew.p1 > 0, drew.p2, drew.q1, drew.q2], [true, 0, 0, 0]);

group.ungroup();
for (const component of turn) component.invalidate();
eq("ungrouping puts every row back", headers().length, 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
