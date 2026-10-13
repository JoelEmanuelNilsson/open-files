import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { assistant, answer, call, mistyping, reading, stripAnsi as strip } from "../support/tool-row-fixtures.mjs";

const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const jiti = kitJiti();
const rollupPlan = await jiti.import(`${KIT_ROOT}/lib/transcript/rollup-plan.ts`);
const rollup = await jiti.import(`${KIT_ROOT}/lib/transcript/rollup-line.ts`);

// The line itself. Claude Code's grammar to the word: past tense, a bold count,
// a plain unit, only the first clause capitalised.
const clauses = (...tools) => rollup.rollupText(rollup.clausesFor(tools));
eq("one read", clauses("read"), "Read 1 file");
eq("the turn from the screenshot", clauses("read", "bash", "bash", "bash", "bash", "bash", "bash"), "Read 1 file, ran 6 shell commands");
// Fixed order, not call order: read → shell. Aggregating by tool
// has already destroyed the sequence, so call order only reports which tool went
// first — at the price of the same turn reading differently every time.
eq("clauses take a fixed order, not the call order", clauses("bash", "read", "bash"), "Read 1 file, ran 2 shell commands");
eq("the same tools in any order give the same line", clauses("bash", "read"), clauses("read", "bash"));
eq("a tool with no verb contributes nothing", clauses("read", "edit"), "Read 1 file");
eq("nothing to say is no line", new rollup.RollupLine().render(80), []);

// The present tense of the same grammar, for the calls a group is waiting on.
// `Running 2 shell commands…` is Claude Code's own wording, read off the pane.
const doing = (...tools) => rollup.rollupText(rollup.clausesFor(tools, "present"));
eq("claude code's own live wording", doing("bash", "bash"), "Running 2 shell commands");
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

// The same call mid-stream, the way pi hands it over: every provider reparses
// the prefix into `arguments` on each delta and keeps the raw buffer beside it
// until the call closes, so a partial path is an ordinary-looking string and the
// buffer is the only thing that says it is still growing.

eq(
	"the planner reads a subject off a landed call and none off a streaming one",
	rollupPlan.plan([assistant(mistyping("s1", "/x/SET"), reading("s2", "/x/a.ts"))], true)[0].subjects.map((s) => s ?? "(streaming)"),
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
	const [g] = rollupPlan.plan(entries, true);
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

// The width contract holds for the collapsed line in both tenses — and this is
// the one line in the transcript that wraps rather than clips. Clipping drops
// the last clause, which is the one thing on the line that cannot be guessed;
// a four-clause turn on an 80-column pane ended in `…ran 2 shell comm…` until
// this changed. Claude Code wraps it to the same indent.
const busy = ["read", "read", "read", "bash", "bash"];
const wide = new rollup.RollupLine();
wide.set(rollup.clausesFor(busy), plain);
eq("a long line wraps to the indent it started in", wide.render(24).map(strip), [
	"  Read 3 files, ran 2",
	"  shell commands",
]);
wide.invalidate();
wide.set(rollup.clausesFor(busy, "present"), plain, true);
eq("and a live one keeps the dot on the first line only", wide.render(30).map(strip), [
	"● Reading 3 files, running 2",
	"  shell commands…",
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

await finish();
