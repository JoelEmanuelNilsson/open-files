/**
 * The kit's `edit` tool (extensions/multi-edit/): edits through pi's own
 * argument validation, the legacy argument shapes, and its description.
 */

import { check, finish } from "../support/check-harness.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const ctx = (cwd, sessionId = "s1") => ({
	cwd,
	hasUI: false,
	mode: "print",
	sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	ui: { notify: () => {}, setWidget: () => {}, theme: {} },
});

// pi runs `prepareArguments` and *then* validates against the advertised
// schema (`prepareToolCallArguments` → `validateToolArguments`), so whatever
// prepare returns must satisfy the schema the model was shown. A harness that
// skips the validator passes tests on a tool the live loop rejects — which is
// exactly how a tool once shipped a prepare step that emitted a shape its own
// schema rejected (2026-09-01). Same order, same library, so that class of bug
// now fails here first.
const { Value } = await jiti.import("typebox/value");
const call = async (tool, args, c) => {
	const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
	if (prepared !== undefined && tool.parameters !== undefined) {
		const converted = Value.Convert(tool.parameters, structuredClone(prepared));
		if (!Value.Check(tool.parameters, converted)) {
			const detail = [...Value.Errors(tool.parameters, converted)]
				.map((error) => `${error.path || "/"}: ${error.message}`)
				.join("; ");
			throw new Error(`Validation failed for tool "${tool.name}": ${detail}`);
		}
	}
	return tool.execute("id", prepared, undefined, undefined, c);
};
const expectThrow = async (fn) => {
	try { await fn(); return null; } catch (e) { return e.message; }
};

// ---------------------------------------------------------------------------
console.log("multi-edit");
{
	const { api, tools } = fakeExtensionApi();
	await (await jiti.import(`${KIT_ROOT}/extensions/multi-edit/index.ts`, { default: true }))(api);
	const edit = tools.get("edit");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-edit-"));
	const c = ctx(dir);
	const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);
	const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");

	write("a.txt", "one\ntwo\nthree\n");
	let r = await call(edit, { path: "a.txt", edits: [
		{ oldText: "one", newText: "ONE" },
		{ oldText: "three", newText: "THREE" },
	] }, c);
	check("multi-edit one file", read("a.txt") === "ONE\ntwo\nTHREE\n", read("a.txt"));
	check("details carry diff + patch", Boolean(r.details.diff && r.details.patch.includes("@@")), JSON.stringify(r.details).slice(0, 120));

	write("dup.txt", "x\nx\n");
	check("ambiguous match rejected", (await expectThrow(() => call(edit, { path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] }, c)))?.includes("matches 2 places"));
	check("ambiguous left untouched", read("dup.txt") === "x\nx\n");

	await call(edit, { path: "dup.txt", edits: [{ oldText: "x", newText: "y", replaceAll: true }] }, c);
	check("replaceAll works", read("dup.txt") === "y\ny\n", read("dup.txt"));

	write("del.txt", "alpha\nbeta\ngamma\n");
	await call(edit, { path: "del.txt", edits: [{ oldText: "beta\n" }] }, c);
	check("missing newText deletes the match", read("del.txt") === "alpha\ngamma\n", JSON.stringify(read("del.txt")));

	write("b.txt", "keep\n");
	write("c.txt", "keep\n");
	const err = await expectThrow(() => call(edit, { files: [
		{ path: "b.txt", edits: [{ oldText: "keep", newText: "changed" }] },
		{ path: "c.txt", edits: [{ oldText: "missing", newText: "x" }] },
	] }, c));
	check("dry run aborts whole batch", Boolean(err?.includes("not found")) && read("b.txt") === "keep\n", `${err} / ${JSON.stringify(read("b.txt"))}`);

	await call(edit, { files: [
		{ path: "b.txt", edits: [{ oldText: "keep", newText: "b!" }] },
		{ path: "c.txt", edits: [{ oldText: "keep", newText: "c!" }] },
	] }, c);
	check("multi-file writes both", read("b.txt") === "b!\n" && read("c.txt") === "c!\n");

	write("crlf.txt", "alpha\r\nbeta\r\n");
	await call(edit, { path: "crlf.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, c);
	check("CRLF preserved", read("crlf.txt") === "alpha\r\nBETA\r\n", JSON.stringify(read("crlf.txt")));

	write("loose.txt", "const x = \u201chi\u201d;   \nend\n");
	await call(edit, { path: "loose.txt", edits: [{ oldText: 'const x = "hi";', newText: "const x = 'hi';" }] }, c);
	check("loose unicode/whitespace fallback", read("loose.txt").startsWith("const x = 'hi';"), JSON.stringify(read("loose.txt")));

	write("loose-all.txt", "x \u201c\ny\nx \u201c  \ny\n");
	await call(edit, { path: "loose-all.txt", edits: [{ oldText: 'x "\ny', newText: "Z", replaceAll: true }] }, c);
	check("loose replaceAll replaces each window whole", read("loose-all.txt") === "Z\nZ\n", JSON.stringify(read("loose-all.txt")));

	write("loose-eol.txt", "a \u201cb\u201d\nnext\n");
	await call(edit, { path: "loose-eol.txt", edits: [{ oldText: 'a "b"\n', newText: "c\n" }] }, c);
	check("a loose match keeps the line break oldText ends with", read("loose-eol.txt") === "c\nnext\n", JSON.stringify(read("loose-eol.txt")));

	write("legacy.txt", "old\n");
	await call(edit, { path: "legacy.txt", oldText: "old", newText: "new" }, c);
	check("legacy oldText/newText shape", read("legacy.txt") === "new\n", read("legacy.txt"));

	write("bom.txt", "\ufeffalpha\nbeta\n");
	await call(edit, { path: "bom.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, c);
	check("BOM is invisible to the match and survives the write", read("bom.txt") === "\ufeffALPHA\nbeta\n", JSON.stringify(read("bom.txt")));

	write("q.txt", "a\n");
	check("the two forms cannot be combined", (await expectThrow(() => call(edit, { path: "q.txt", edits: [{ oldText: "a", newText: "b" }], files: [{ path: "q.txt", edits: [{ oldText: "a", newText: "c" }] }] }, c)))?.includes("not both"));
	check("no patch mode", edit.parameters.properties.patch === undefined && !JSON.stringify(edit.promptGuidelines).includes("patch") && !edit.description.includes("patch"));
	check("the nested files[] edit schema carries the same field descriptions", edit.parameters.properties.files.items.properties.edits.items.properties.oldText.description === edit.parameters.properties.edits.items.properties.oldText.description);

	check("no-op edit rejected", (await expectThrow(() => call(edit, { path: "q.txt", edits: [{ oldText: "a", newText: "a" }] }, c)))?.includes("identical"));
	check("missing file rejected", (await expectThrow(() => call(edit, { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }, c)))?.includes("file not found"));

	write("ov.txt", "abcdef\n");
	check("overlapping edits rejected", (await expectThrow(() => call(edit, { path: "ov.txt", edits: [
		{ oldText: "abc", newText: "X" }, { oldText: "bcd", newText: "Y" },
	] }, c)))?.includes("overlap"));

	fs.rmSync(dir, { recursive: true, force: true });
}

// The edit/write rule is gone: `edit` and `write` stand on worker seats that
// carry no `Agent`, so they say nothing about delegating.
{
	console.log("\nno edit/write rule (the edit tool)");
	const { api, tools } = fakeExtensionApi();
	await (await jiti.import(`${KIT_ROOT}/extensions/multi-edit/index.ts`, { default: true }))(api);
	const edit = tools.get("edit");
	check("the kit's `edit` tool names no agent, worker or delegation", edit !== undefined && edit.description.startsWith("Edit files by exact text replacement.") && !/\bAgent\b|worker|delegat/i.test(edit.description));
}

await finish();
