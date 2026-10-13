/**
 * Diffs are painted the way Claude Code paints them.
 *
 * Added and removed rows carry a background across the whole width, the
 * changed span carries a stronger one derived from the row colour.
 *
 *   node test/transcript/diff-view.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = kitJiti();
const { initTheme, loadThemeFromPath } = await importPi("dist/modes/interactive/theme/theme.js");
const { generateDiffString } = await importPi("dist/index.js");
const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const { diffPalette, DiffView } = await jiti.import(`${KIT_ROOT}/lib/transcript/diff-view.ts`);
const { slotColors } = await jiti.import(`${KIT_ROOT}/lib/ui/terminal-slot-colors.ts`);

// Real pi themes, not stand-ins: a hand-written `{ fg }` object answers tokens
// pi's own Theme refuses (`selectedBg` is a background, and `fg` throws on it),
// which is exactly the bug this file exists to catch. The kit's shipped theme
// paints in ANSI slots and gets its own section; these two carry Claude Code's
// diff hexes so the pinned values below stay meaningful whatever the kit ships.
const stage = mkdtempSync(join(tmpdir(), "diff-theme-"));
const base = JSON.parse(readFileSync(`${KIT_ROOT}/themes/ansi.json`, "utf8"));
const themeWith = (name, colors) => {
	const path = join(stage, `${name}.json`);
	writeFileSync(path, JSON.stringify({ ...base, name, colors: { ...base.colors, ...colors } }));
	return loadThemeFromPath(path, "truecolor");
};
const dark = themeWith("dark-hex", { toolDiffAdded: "#225c2b", toolDiffRemoved: "#7a2936" });
const light = themeWith("light-hex", { toolDiffAdded: "#69db7c", toolDiffRemoved: "#c8505a" });
initTheme("dark");

// --- palette -----------------------------------------------------------
{
	const p = diffPalette(dark);
	check("added row is Claude Code's dark green background", p.added("x") === "\x1b[48;2;34;92;43mx\x1b[49m", JSON.stringify(p.added("x")));
	check("removed row is Claude Code's dark red background", p.removed("x") === "\x1b[48;2;122;41;54mx\x1b[49m", JSON.stringify(p.removed("x")));
	check("dark emphasis is brighter than its row", p.addedEmphasis("x") === "\x1b[48;2;61;166;77mx\x1b[49m", JSON.stringify(p.addedEmphasis("x")));
	const l = diffPalette(light);
	check("light row keeps Claude Code's light green", l.added("x").startsWith("\x1b[48;2;105;219;124m"), JSON.stringify(l.added("x")));
	check("light emphasis is deeper than its row", l.addedEmphasis("x").startsWith("\x1b[48;2;63;131;74m"), JSON.stringify(l.addedEmphasis("x")));
	const bare = diffPalette({ fg: (_c, t) => t });
	check("a theme that paints nothing paints nothing", bare.added("x") === "x" && bare.removedEmphasis("x") === "x");
}

// --- geometry ----------------------------------------------------------
{
	const { diff } = generateDiffString("a = 1\nkeep\n", "a = 2\nkeep\nnew\n");
	const p = diffPalette(dark);
	const lines = new DiffView(diff, p, "unified", true).render(40);
	const changed = lines.filter((line) => line.includes("\x1b[48;2;"));
	check("every changed row fills the width", changed.every((line) => visibleWidth(line) === 40), changed.map(visibleWidth).join(","));
	const context = lines.find((line) => line.includes("keep"));
	check("context rows carry no background", context !== undefined && !context.includes("\x1b[48;2;"), context);
	check("the changed span is emphasised", lines[1].includes("\x1b[48;2;61;166;77m2\x1b[49m"), lines[1]);
	const split = new DiffView(diff, p, "split", true).render(60);
	check("split rows fill the width too", split.filter((line) => line.includes("\x1b[48;2;")).every((line) => visibleWidth(line) === 60));
}

// --- a theme painting in ANSI slots ------------------------------------
// themes/ansi.json names slots, and a slot is a full-strength accent rather
// than the tint a hex theme names. The row is mixed from what the terminal
// says that slot and its background are, to the same distance from the
// background Claude Code's hexes sit at.
{
	const indexed = loadThemeFromPath(`${KIT_ROOT}/themes/ansi.json`, "truecolor");
	const p = diffPalette(indexed);
	check("unanswered: the line is the diff colour as text, never a block", p.added("x") === "\x1b[38;5;2mx\x1b[39m", JSON.stringify(p.added("x")));

	const colors = slotColors();
	let listener = null;
	const terminal = { write: () => {}, addInputListener: (fn) => { listener = fn; return () => { listener = null; }; } };
	const luma = (escape) => {
		const [, r, g, b] = /48;2;(\d+);(\d+);(\d+)/.exec(escape).map(Number);
		return 0.299 * r + 0.587 * g + 0.114 * b;
	};
	// end4 dark: slot 2 #96daee, slot 1 #bf82da, background #080b20.
	const answers = "\x1b]4;2;rgb:9696/dada/eeee\x07\x1b]4;1;rgb:bfbf/8282/dada\x07\x1b]11;rgb:0808/0b0b/2020\x07";
	colors.attach(terminal);
	listener(answers);
	const bgLuma = 0.299 * 8 + 0.587 * 11 + 0.114 * 32;
	const added = p.added("x");
	check("answered: the row is a truecolor tint", /^\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m$/.test(added), JSON.stringify(added));
	check("the row sits 65 of luma off the background", Math.abs(luma(added) - bgLuma - 65) < 1.5, `${luma(added)} vs ${bgLuma}`);
	check("the span sits twice as far again", Math.abs(luma(p.addedEmphasis("x")) - bgLuma - 120) < 1.5, p.addedEmphasis("x"));
	check("removed is tinted from its own slot", luma(p.removed("x")) !== luma(added), p.removed("x"));
	check("the text on a row keeps the theme's own foreground", !added.includes("38;"), JSON.stringify(added));

	// A light terminal: the same distance, taken downward, so the row stays light.
	const view = new DiffView(generateDiffString("a = 1\n", "a = 2\n").diff, p, "unified", true);
	const first = view.render(40);
	listener("\x1b]4;2;rgb:6464/7070/2f2f\x07\x1b]11;rgb:fafa/f0f0/e9e9\x07");
	const lightBg = 0.299 * 250 + 0.587 * 240 + 0.114 * 233;
	const lightRow = p.added("x");
	check("on a light background the row is 65 of luma darker", Math.abs(lightBg - luma(lightRow) - 65) < 1.5, `${luma(lightRow)} vs ${lightBg}`);
	check("a row already on screen repaints when the terminal's colours change", view.render(40).join("") !== first.join(""), first.join("|"));
	colors.dispose();
}

await finish();
