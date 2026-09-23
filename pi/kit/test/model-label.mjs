/**
 * The model label in the top rule. **Width is the budget**: `claude-fable-5-1
 * medium` is 22 columns saying what `fable ▱▱▱▱▱` says in 10. Only Claude ids
 * are shortened — anything else is unknown and passes through whole.
 *
 * The effort slider is the model's **own** range, so its length is a reading
 * too: the levels come from pi's rule for which ones a model exposes, pinned
 * here against the installed pi, and the strip is atomic — a pane too narrow
 * for it drops it and keeps the name, because half a slider says the wrong
 * thing rather than less.
 *
 * The rest of that budget is the ghost insignia, and **it is one column, like
 * the `~` it stands for**: `bin/build-ghost-font.py` gives the glyph a one-cell
 * advance and `visibleWidth` measures one, so the two agree. A rule that spends
 * two columns on it draws one dash too few and stops a column short of its own
 * corner — with the side rail and the bottom rule left hanging past it.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { shortModelId, THINKING_LEVELS, thinkingLevels, thinkingScale, effortSlider, effortDrift, paintSlider } = await jiti.import(
	`${ROOT}/extensions/zen-chrome/model-label.ts`,
);
const chrome = await jiti.import(`${ROOT}/extensions/zen-chrome/chrome.ts`);
const { visibleWidth } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/utils.js`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

console.log("model-label: the family, not the version");
eq("fable drops prefix and version", shortModelId("claude-fable-5-1"), "fable");
eq("opus", shortModelId("claude-opus-5"), "opus");
eq("sonnet", shortModelId("claude-sonnet-5-20260101"), "sonnet");
eq("haiku", shortModelId("claude-haiku-4-5"), "haiku");
eq("luna drops gpt and the version", shortModelId("gpt-6-luna"), "luna");
eq("and a dotted version likewise", shortModelId("gpt-5.6-sol"), "sol");
eq("a claude id with no version is left whole", shortModelId("claude-test"), "claude-test");
eq("an id with no family is left whole", shortModelId("gpt-5.5"), "gpt-5.5");

console.log("\nmodel-label: the effort scale is the model's own range");
{
	// pi's list is the source of truth for what levels exist at all. Read it back
	// out of the installed package: a level pi adds and ours misses would draw a
	// short slider, which reads as a level that is nearer the top than it is.
	// Every chunk, because pi's bundle names them by content hash: pinning one
	// filename would pin the test to one release of pi rather than to the list.
	const fs = await import("node:fs");
	const chunks = `${PI}/dist/bundle/chunks`;
	let pinned = null;
	for (const file of fs.readdirSync(chunks).filter((name) => name.endsWith(".js"))) {
		pinned = /\bEXTENDED_THINKING_LEVELS=\[([^\]]*)\]/.exec(fs.readFileSync(`${chunks}/${file}`, "utf8"));
		if (pinned) break;
	}
	eq(
		"the level list is the installed pi's",
		[...THINKING_LEVELS],
		pinned ? pinned[1].split(",").map((level) => level.replace(/"/g, "")) : "pi's level list moved — find it and re-pin",
	);

	const reasoning = { reasoning: true };
	eq("a model with no map exposes off through high", thinkingLevels(reasoning), ["off", "minimal", "low", "medium", "high"]);
	eq("a model that does not reason has no scale", thinkingLevels({ reasoning: false }), []);
	eq("no model at all has no scale", thinkingLevels(undefined), []);
	eq(
		"max joins the scale when the model names a value for it",
		thinkingLevels({ reasoning: true, thinkingLevelMap: { max: "maximal" } }),
		["off", "minimal", "low", "medium", "high", "max"],
	);
	eq(
		"a level mapped to null is not on the scale",
		thinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, low: null } }),
		["off", "medium", "high"],
	);

	eq("the level is a notch on that scale", thinkingScale(reasoning, "high"), { index: 4, count: 5 });
	eq("and off is its bottom notch", thinkingScale(reasoning, "off"), { index: 0, count: 5 });
	eq("a level the model does not expose has no notch", thinkingScale(reasoning, "max"), null);
	eq("a model with no scale has no notch", thinkingScale({ reasoning: false }, "off"), null);

	eq("the track is one slot per level", effortSlider({ index: 2, count: 5 }), "▱▱▱▱▱");
	eq("a three-level model gets three slots", effortSlider({ index: 1, count: 3 }), "▱▱▱");
	eq("the track says the range, not the level", effortSlider({ index: 0, count: 5 }), effortSlider({ index: 4, count: 5 }));
}

console.log("\nmodel-label: the level is the one lit slot");
{
	/** `paintSlider` with the palette stubbed out, so the structure is what is under test. */
	const trace = (scale) => {
		const slots = [];
		const text = paintSlider(scale, (at, lit) => {
			slots.push({ at, lit });
			return "";
		});
		return { slots, text: text.replaceAll("\x1b[0m", "") };
	};

	eq("exactly the current slot is lit", trace({ index: 2, count: 5 }).slots.map((s) => s.lit), [false, false, true, false, false]);
	eq("the bottom level lights the first slot", trace({ index: 0, count: 5 }).slots.map((s) => s.lit), [true, false, false, false, false]);
	eq("the top level lights the last slot", trace({ index: 4, count: 5 }).slots.map((s) => s.lit), [false, false, false, false, true]);
	eq("each slot sits at its own place on the arc", trace({ index: 0, count: 5 }).slots.map((s) => s.at), [0, 0.25, 0.5, 0.75, 1]);
	eq("a three-level scale still spans the whole arc", trace({ index: 0, count: 3 }).slots.map((s) => s.at), [0, 0.5, 1]);
	eq("every slot is the same glyph", trace({ index: 2, count: 5 }).text, "▱▱▱▱▱");
	eq("the painted strip is as wide as the track", trace({ index: 1, count: 4 }).text, effortSlider({ index: 1, count: 4 }));
}

console.log("\nmodel-label: the mark for a level moved since the cache was written");
{
	const at = (index) => ({ index, count: 5 });

	eq("raised, and the move rewrites the conversation", effortDrift(at(3), at(1), true), "+");
	eq("lowered", effortDrift(at(1), at(3), true), "−");
	eq("the mark is one cell", [...effortDrift(at(3), at(1), true)].length, 1);
	eq("a level that has not moved says nothing", effortDrift(at(2), at(2), true), null);
	eq("moved back to where it was says nothing either", effortDrift(at(2), { index: 2, count: 3 }, true), null);
	eq("a move the model reads across costs nothing to say", effortDrift(at(3), at(1), false), null);
	eq("nothing sent yet on this seat: silent, not guessed", effortDrift(at(3), null, true), null);
	eq("one notch up still counts", effortDrift(at(1), at(0), true), "+");
	eq("one notch down still counts", effortDrift(at(0), at(1), true), "−");
}

console.log("\nmodel-label: the slider is whole or absent");
{
	const plain = (text) => text;
	const label = [
		{ text: "opus", paint: plain },
		{ text: " ▱▱▱▱▱", paint: plain, atomic: true },
	];
	const texts = (pieces) => pieces.map((piece) => piece.text);
	eq("a wide enough label keeps both pieces", texts(chrome.fit(label, 10)), ["opus", " ▱▱▱▱▱"]);
	eq("a narrow one drops the slider and keeps the name", texts(chrome.fit(label, 8)), ["opus"]);

	// Where the level is beats what moving it costs, so the mark goes first.
	const marked = [...label, { text: "+", paint: plain, atomic: true }];
	eq("room for all three keeps the mark", texts(chrome.fit(marked, 11)), ["opus", " ▱▱▱▱▱", "+"]);
	eq("one cell short spends the mark and keeps the slider", texts(chrome.fit(marked, 10)), ["opus", " ▱▱▱▱▱"]);
	eq("narrower still leaves only the name", texts(chrome.fit(marked, 8)), ["opus"]);
	eq("the slider is never cut short", chrome.fit(label, 8).some((piece) => piece.text.includes("…")), false);
	eq("a label of nothing but atomic pieces is still all or nothing", chrome.fit([label[1]], 5), []);
}

console.log("\nmodel-label: the top rule fits the pane it is drawn in");
{
	const GHOST = "\u{100000}";
	const plain = (text) => text;
	const label = (text) => [{ text, paint: plain }];
	/** Columns Ghostty puts on screen: the ghost's advance is one cell, so the string measures it. */
	const painted = (line) => visibleWidth(line);
	// The real left label, ghost and all: the pane Joel sees is the one under home.
	const home = chrome.formatCwd("/Users/joel/dotfiles", "/Users/joel");
	const top = (width) =>
		chrome.rule(width, label(home), label("fable ▱▱▱▱▱"), plain, chrome.TOP_ENDS, chrome.insignia(plain));

	eq("the ghost is one cell, because that is what the font's advance is", visibleWidth(GHOST), 1);
	eq("the insignia is the glyph alone — the rule's own spaces flank it", chrome.insignia(plain), [
		{ text: GHOST, paint: plain, atomic: true },
	]);

	for (const width of [40, 60, 80, 120, 200]) {
		const line = top(width);
		eq(`a ${width}-column top rule paints exactly ${width} columns`, painted(line), width);
		eq(`and still carries the ghost at ${width}`, line.includes(GHOST), true);
	}
	// All or nothing, like every middle label: a pane too narrow drops it whole.
	for (const width of [4, 8, 16, 24, 30]) eq(`a ${width}-column rule is still exactly that wide`, painted(top(width)), width);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
