import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { renderContext as ctx, namedTheme as named, stripAnsi as strip } from "../support/tool-row-fixtures.mjs";
process.env.TMUX = "test";

const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const jiti = kitJiti();
const describe = await jiti.import(`${KIT_ROOT}/lib/transcript/call-argument.ts`);
const header = await jiti.import(`${KIT_ROOT}/lib/transcript/call-header.ts`);
const row = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-row.ts`);

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

eq("name and argument", head({ argument: "lib/transcript/split-diff.ts" }, 60), ["● Read(lib/transcript/split-diff.ts)"]);
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

// A call cut off by the run settling is drawn hollow.
eq("a cut call is hollow where a live one is filled", strip(head({ state: "aborted", argument: "x" }, 40)[0])[0], row.CUT);

await finish();
