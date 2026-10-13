import { eq, finish, show } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { loadKitExtensions, realToolRows, stripAnsi as strip, textContent as text } from "../support/tool-row-fixtures.mjs";
// pi-tui caches terminal capabilities on first read and reports no image
// support under a multiplexer, which is the case the image fallback exists for.
process.env.TMUX = "test";

const { getCapabilities, setCapabilities } = await importPi("node_modules/@earendil-works/pi-tui/dist/terminal-image.js");
const jiti = kitJiti();

// ---------------------------------------------------------------------------
// Through pi's own row component, which is the only thing that proves it.
// ---------------------------------------------------------------------------

const { tools: registered, toolRenderers } = await loadKitExtensions(jiti, "transcript/index.ts", "bash/index.ts");
const realComponent = await realToolRows(registered, toolRenderers);
function realRow(tool, args, content, options) {
	return realComponent(tool, args, content, options).render(80);
}

const readRow = realRow("read", { path: `${KIT_ROOT}/package.json` }, text("a\nb\nc"));
eq("a row is a blank, a header, and a result", readRow.map(strip), ["", "● Read(package.json)", "  ⎿  Read 3 lines"]);

const pending = realRow("bash", { command: "sleep 5" }, undefined);
eq("a call with no result yet is just its header", pending.map(strip), ["", "● Bash(sleep 5)"]);

const { backgroundHint } = await jiti.import(`${KIT_ROOT}/lib/tools/bash-tool.ts`);
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
	const drawn = realRow("read", { path: `${KIT_ROOT}/shot.png` }, imageContent);
	eq("an image reaches the screen", drawn.some((l) => l.includes("\x1b_G")), true);
	eq("exactly once", drawn.filter((l) => l.includes("\x1b_G")).length, 1);
	eq("and the row says how big it was", strip(drawn[2]), "  ⎿  Read image (72 B)");
} finally {
	setCapabilities(caps);
}
// Under tmux the picture cannot be drawn, so the line naming it is all there is.
const undrawable = realRow("read", { path: `${KIT_ROOT}/shot.png` }, imageContent);
eq("an undrawable image still names itself", /image\/png/.test(strip(undrawable[2])), true);
eq("and does not count the lines of the note", /\d+ lines?$/.test(strip(undrawable[2])), false);

show("rows @ 80", () =>
	[
		...realRow("read", { path: `${KIT_ROOT}/package.json` }, text("a\nb\nc")),
		...realRow("grep", { pattern: "renderCall", path: KIT_ROOT, glob: "*.ts" }, text("a.ts:1: x\nb.ts:9: x")),
		...realRow("bash", { command: "npm test" }, text("all 41 checks ok")),
		...realRow("bash", { command: "cat nope" }, text("cat: nope: No such file"), { error: true }),
	]
		.map(strip)
		.join("\n"),
);

await finish();
