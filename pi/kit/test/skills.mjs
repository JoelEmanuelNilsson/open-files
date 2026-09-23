/**
 * Can I hide a skill from the model without breaking its file?
 *
 * Two halves, both pure. `patch.ts` is a string in and a string out: the whole
 * risk of this extension is that a one-line frontmatter edit damages a file
 * that is mostly hand-written prose, so every case here is a file shape that
 * a naive line edit gets wrong — block scalars, CRLF, duplicate keys, a `---`
 * rule inside the body. `model.ts` is the dialog's state: the case that
 * matters there is toggling under a filter, because a draft that does not
 * survive filtering is a checklist that silently loses edits.
 *
 * The view is checked for the one contract the TUI actually enforces — no
 * rendered line is ever wider than the width it was handed — because the row,
 * title and hint lines are each built by a different helper and only some of
 * them clip on their own.
 *
 *   node test/skills.mjs
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const { visibleWidth } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/utils.js`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { setMuted, isPatchable } = await jiti.import(`${ROOT}/extensions/skills/patch.ts`);
const { buildRows, SkillDraft } = await jiti.import(`${ROOT}/extensions/skills/model.ts`);
const { SkillsView } = await jiti.import(`${ROOT}/extensions/skills/view.ts`);
const { applyChanges, describeChanges } = await jiti.import(`${ROOT}/extensions/skills/apply.ts`);

const {
	chmodSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}\n  expected ${b}\n  actual   ${a}`);
};

// --- patch: the ordinary cases ---------------------------------------------

const PLAIN = "---\nname: commit\ndescription: Make a commit\n---\n\nBody text.\n";

eq("mute adds the key last in the block",
	setMuted(PLAIN, true),
	"---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\n\nBody text.\n");

eq("unmute on an already-unmuted file is a no-op",
	setMuted(PLAIN, false),
	undefined);

const MUTED = "---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\n\nBody.\n";

eq("unmute removes the key and leaves the rest",
	setMuted(MUTED, false),
	"---\nname: commit\ndescription: Make a commit\n---\n\nBody.\n");

eq("mute on an already-muted file is a no-op",
	setMuted(MUTED, true),
	undefined);

eq("a round trip returns the original bytes",
	setMuted(setMuted(PLAIN, true), false),
	PLAIN);

// --- patch: the shapes a naive line edit gets wrong -------------------------

eq("a `---` rule in the body is not mistaken for the fence",
	setMuted("---\nname: a\n---\n\ntext\n\n---\n\nmore\n", true),
	"---\nname: a\ndisable-model-invocation: true\n---\n\ntext\n\n---\n\nmore\n");

eq("a block-scalar description survives, key lands at column zero after it",
	setMuted("---\nname: a\ndescription: >\n  one line\n  and another\n---\nbody\n", true),
	"---\nname: a\ndescription: >\n  one line\n  and another\ndisable-model-invocation: true\n---\nbody\n");

eq("an indented lookalike key is left alone",
	setMuted("---\nname: a\nmeta:\n  disable-model-invocation: true\n---\nbody\n", true),
	"---\nname: a\nmeta:\n  disable-model-invocation: true\ndisable-model-invocation: true\n---\nbody\n");

eq("duplicate keys all go, not just the first",
	setMuted("---\nname: a\ndisable-model-invocation: true\nx: 1\ndisable-model-invocation: true\n---\nb\n", false),
	"---\nname: a\nx: 1\n---\nb\n");

eq("a duplicate collapses to one when muting",
	setMuted("---\nname: a\ndisable-model-invocation: true\ndisable-model-invocation: true\n---\nb\n", true),
	"---\nname: a\ndisable-model-invocation: true\n---\nb\n");

eq("spacing around the colon still counts as the key",
	setMuted("---\nname: a\ndisable-model-invocation : true\n---\nb\n", false),
	"---\nname: a\n---\nb\n");

eq("CRLF stays CRLF",
	setMuted("---\r\nname: a\r\n---\r\nbody\r\n", true),
	"---\r\nname: a\r\ndisable-model-invocation: true\r\n---\r\nbody\r\n");

// --- patch: files it must refuse -------------------------------------------

eq("no frontmatter is refused", setMuted("# Just a heading\n", true), undefined);
eq("an unclosed fence is refused", setMuted("---\nname: a\nbody\n", true), undefined);
eq("a fence that is not the first line is refused", setMuted("\n---\nname: a\n---\n", true), undefined);

eq("isPatchable agrees with setMuted on prose", isPatchable("# heading\n"), false);
eq("isPatchable agrees with setMuted on frontmatter", isPatchable(PLAIN), true);

// --- model: rows -----------------------------------------------------------

const skill = (name, muted, scope = "user", origin = "top-level", source = "auto") => ({
	name,
	description: `does ${name}`,
	filePath: `/skills/${name}/SKILL.md`,
	baseDir: `/skills/${name}`,
	sourceInfo: { path: `/skills/${name}/SKILL.md`, source, scope, origin },
	disableModelInvocation: muted,
});

const ROWS = buildRows([skill("tdd", false), skill("commit", true), skill("apply", false, "project")]);

eq("rows sort by name", ROWS.map((row) => row.name), ["apply", "commit", "tdd"]);
eq("rows carry the disk state", ROWS.map((row) => row.muted), [false, true, false]);
eq("rows carry the scope", ROWS.map((row) => row.scope), ["project", "user", "user"]);

// A packaged skill is named by its package: every package this harness loads
// sits under the `user` scope, so the scope word cannot tell two of them apart.
eq("a packaged skill shows its package, shortened to the segment that differs",
	buildRows([
		skill("kit-one", false, "user", "package", "~/dotfiles/pi/kit"),
		skill("npm-one", false, "user", "package", "pi-web-search"),
		skill("trailing", false, "user", "package", "~/some/pkg/"),
	]).map((row) => row.scope),
	["kit", "pi-web-search", "pkg"]);

// --- model: the draft ------------------------------------------------------

const draft = new SkillDraft(ROWS);
eq("active count starts at the disk state", draft.activeCount(), 2);
eq("nothing is changed yet", draft.changes(), []);

draft.toggleAtCursor(); // apply -> muted
eq("one toggle is one change", draft.changes(), [{ name: "apply", filePath: "/skills/apply/SKILL.md", muted: true }]);
eq("the active count follows the draft", draft.activeCount(), 1);

draft.toggleAtCursor(); // back to disk state
eq("toggling back leaves no change", draft.changes(), []);

// The case the whole indexed-draft design exists for.
draft.setQuery("tdd");
eq("the filter narrows the list", draft.visible().map((entry) => entry.row.name), ["tdd"]);
draft.toggleAtCursor(); // tdd -> muted
draft.setQuery("commit");
draft.toggleAtCursor(); // commit -> unmuted
draft.setQuery("");
eq("edits made under different filters all survive",
	draft.changes(),
	[
		{ name: "commit", filePath: "/skills/commit/SKILL.md", muted: false },
		{ name: "tdd", filePath: "/skills/tdd/SKILL.md", muted: true },
	]);
eq("changed rows are marked", [0, 1, 2].map((index) => draft.isChanged(index)), [false, true, true]);

draft.reset();
eq("reset returns to disk", draft.changes(), []);

// --- model: the cursor -----------------------------------------------------

const cursor = new SkillDraft(ROWS);
cursor.moveCursor(-1);
eq("the cursor does not run off the top", cursor.getCursor(), 0);
cursor.moveCursor(99);
eq("the cursor does not run off the bottom", cursor.getCursor(), 2);
cursor.setQuery("commit");
eq("a filter clamps the cursor into what still matches", cursor.getCursor(), 0);
cursor.setQuery("nothing matches this");
eq("an empty result parks the cursor at zero", cursor.getCursor(), 0);
cursor.toggleAtCursor();
eq("toggling with nothing visible changes nothing", cursor.changes(), []);

// --- view: it renders, it clips, and the keys reach the draft ---------------

const theme = {
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
	dim: (t) => t,
	inverse: (t) => t,
	strikethrough: (t) => t,
};

const manyRows = buildRows(
	Array.from({ length: 30 }, (_unused, index) =>
		skill(`skill-number-${index}`, index % 4 === 0, index % 3 === 0 ? "project" : "user"),
	),
);

const openView = (rows = manyRows, terminalRows = 24) => {
	let resolved = "pending";
	const view = new SkillsView(theme, rows, (result) => { resolved = result; }, () => terminalRows);
	return { view, result: () => resolved };
};

let overflows = 0;
let renders = 0;
for (const width of [4, 10, 20, 40, 80, 200]) {
	for (const terminalRows of [3, 12, 24, 60]) {
		const { view } = openView(manyRows, terminalRows);
		const lines = view.render(width);
		renders++;
		if (lines.length > terminalRows) overflows++;
		for (const line of lines) if (visibleWidth(line) > width) overflows++;
	}
}
eq("every render fits its width and its terminal", { renders, overflows }, { renders: 24, overflows: 0 });

eq("an empty skill list still renders", openView([], 24).view.render(80).length > 0, true);

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const CTRL_S = "\x13";
const CTRL_R = "\x12";
const BACKSPACE = "\x7f";

const keys = openView();
keys.view.handleInput(DOWN);
keys.view.handleInput(DOWN);
keys.view.handleInput(" ");
keys.view.handleInput(UP);
keys.view.handleInput(" ");
keys.view.handleInput(CTRL_S);
eq("space toggles the row under the cursor, ctrl+s hands the edits back",
	keys.result().map((change) => change.name),
	["skill-number-1", "skill-number-10"]);

const typed = openView();
for (const character of "number-1x") typed.view.handleInput(character);
typed.view.handleInput(BACKSPACE);
typed.view.render(80);
typed.view.handleInput(" ");
typed.view.handleInput(CTRL_S);
eq("printable keys filter, backspace un-filters, and space still toggles",
	typed.result().map((change) => change.name),
	["skill-number-1"]);

const cancelled = openView();
cancelled.view.handleInput(" ");
cancelled.view.handleInput(ESC);
eq("escape resolves undefined, discarding the draft", cancelled.result(), undefined);

const undone = openView();
undone.view.handleInput(" ");
undone.view.handleInput(CTRL_R);
undone.view.handleInput(CTRL_S);
eq("ctrl+r resets the draft, so ctrl+s writes nothing", undone.result(), []);

// A wheel notch must move the cursor, not land in the filter as text. Default
// step is three lines, and the rows sort 0, 1, 10, 11, so one notch is `-11`.
const wheeled = openView();
wheeled.view.handleInput("\x1b[<65;10;5M"); // SGR, one notch down
const filterRowAfterWheel = wheeled.view.render(80).find((line) => line.trimStart().startsWith("/"));
wheeled.view.handleInput(" ");
wheeled.view.handleInput(CTRL_S);
eq("a wheel notch scrolls by the configured step", wheeled.result().map((c) => c.name), ["skill-number-11"]);
eq("a wheel notch never reaches the filter", filterRowAfterWheel, "  / type to filter");

const wheeledUp = openView();
wheeledUp.view.handleInput("\x1b[<64;10;5M"); // one notch up, already at the top
wheeledUp.view.handleInput(" ");
wheeledUp.view.handleInput(CTRL_S);
eq("a wheel notch up at the top of the list stays put",
	wheeledUp.result().map((c) => c.name), ["skill-number-0"]);

// --- apply: real files, real writes ----------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "pi-kit-skills-"));
const writeSkillInto = (name, file, source, mode = 0o644) => {
	const dir = join(sandbox, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, source, { encoding: "utf8", mode });
	chmodSync(path, mode);
	return path;
};
const writeSkill = (name, source, mode = 0o644) => writeSkillInto(name, "SKILL.md", source, mode);
const change = (name, path, muted) => ({ name, filePath: path, muted });

try {
	const onePath = writeSkill("one", PLAIN, 0o640);
	const twoPath = writeSkill("two", MUTED);

	eq("a mixed batch writes both files",
		applyChanges([change("one", onePath, true), change("two", twoPath, false)]),
		{ written: 2, failures: [] });
	eq("the muted file gained the key", readFileSync(onePath, "utf8"), setMuted(PLAIN, true));
	eq("the unmuted file lost the key", readFileSync(twoPath, "utf8"), setMuted(MUTED, false));
	eq("the original mode survives the rename", statSync(onePath).mode & 0o777, 0o640);
	eq("no temp file is left beside the original", readdirSync(join(sandbox, "one")), ["SKILL.md"]);

	eq("re-applying the same change writes nothing",
		applyChanges([change("one", onePath, true)]),
		{ written: 0, failures: [] });

	// The case the re-read-at-apply-time design exists for: an edit made in
	// another window while the dialog was open must survive the write.
	writeFileSync(onePath, "---\nname: commit\ndescription: Edited elsewhere\ndisable-model-invocation: true\n---\n\nNew body.\n");
	eq("a concurrent edit survives, only the one line is touched",
		[applyChanges([change("one", onePath, false)]), readFileSync(onePath, "utf8")],
		[{ written: 1, failures: [] }, "---\nname: commit\ndescription: Edited elsewhere\n---\n\nNew body.\n"]);

	const missing = join(sandbox, "gone", "SKILL.md");
	const failed = applyChanges([change("gone", missing, true), change("one", onePath, true)]);
	eq("a missing file fails alone; the rest of the batch still lands",
		[failed.written, failed.failures.length, failed.failures[0].startsWith("gone: ")],
		[1, 1, true]);

	const prosePath = writeSkill("prose", "# No frontmatter here\n");
	eq("a file with no frontmatter is skipped, not damaged",
		[applyChanges([change("prose", prosePath, true)]), readFileSync(prosePath, "utf8")],
		[{ written: 0, failures: [] }, "# No frontmatter here\n"]);

	const lockedPath = writeSkillInto("prose", "locked.md", PLAIN);
	chmodSync(join(sandbox, "prose"), 0o500); // the directory now refuses new entries
	try {
		const blocked = applyChanges([change("prose", lockedPath, true)]);
		eq("a directory that refuses writes is one failure, not a crash",
			[blocked.written, blocked.failures.length],
			[0, 1]);
		// The user chose a skill, not a temp file; the report must name a file they
		// can act on. That is the resolved one — for this harness, the path inside
		// the dotfiles checkout rather than the ~/.agents symlink pi reported.
		eq("the failure names the skill's own resolved file and the cause",
			blocked.failures[0],
			`prose: EACCES: ${realpathSync(lockedPath)}`);
		eq("and it leaves no temp file behind",
			readdirSync(join(sandbox, "prose")).filter((entry) => entry.includes(".tmp")),
			[]);
	} finally {
		chmodSync(join(sandbox, "prose"), 0o755);
	}

	// This harness reaches its own skills through ~/.agents/skills, a symlink
	// into the dotfiles checkout, so pi reports every path through that link.
	// Both shapes must survive: a linked directory, and a linked file.
	const realDir = join(sandbox, "real-store");
	mkdirSync(join(realDir, "linked"), { recursive: true });
	const realFile = join(realDir, "linked", "SKILL.md");
	writeFileSync(realFile, PLAIN, "utf8");
	symlinkSync(realDir, join(sandbox, "via-dir"));
	const throughDir = join(sandbox, "via-dir", "linked", "SKILL.md");

	eq("a path through a symlinked directory writes the real file",
		[applyChanges([change("linked", throughDir, true)]), readFileSync(realFile, "utf8")],
		[{ written: 1, failures: [] }, setMuted(PLAIN, true)]);
	eq("the directory symlink still is one", lstatSync(join(sandbox, "via-dir")).isSymbolicLink(), true);
	eq("no temp file is stranded in the link's parent",
		readdirSync(sandbox).filter((entry) => entry.includes(".tmp")),
		[]);

	mkdirSync(join(sandbox, "via-file"), { recursive: true });
	const fileLink = join(sandbox, "via-file", "SKILL.md");
	symlinkSync(realFile, fileLink);
	// Reported rather than thrown: without the realpath resolve the rename
	// swaps the link for a regular file, and readlink on a regular file throws
	// EINVAL. A crash here would still fail the run, but it would not say why.
	const linkTargetOf = (path) => {
		try {
			return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : "not a symlink any more";
		} catch (error) {
			return `unreadable: ${error.code}`;
		}
	};
	eq("a symlinked file is followed, not replaced",
		[
			applyChanges([change("linked", fileLink, false)]),
			linkTargetOf(fileLink),
			readFileSync(realFile, "utf8"),
		],
		[{ written: 1, failures: [] }, realFile, PLAIN]);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

// --- apply: the sentence the notification shows ----------------------------

eq("the summary names both directions",
	describeChanges([change("a", "/a", true), change("b", "/b", false)], 2),
	"2 files written — model can now invoke b; hidden from the model: a");
eq("one file is singular",
	describeChanges([change("a", "/a", true)], 1),
	"1 file written — hidden from the model: a");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
