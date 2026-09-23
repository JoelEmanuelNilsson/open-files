/**
 * The tool-argument boundary: a string where the schema declares something else.
 *
 * Report 35 §8 counted three instances of one class in two days — a workflow's
 * `args`, a structured `result`, `read`'s `offset` — so the rule lives in
 * `lib/tool-argument-coercion.ts` and every kit tool hands it to pi's
 * `prepareArguments`, which runs before schema validation.
 *
 * Ticket 63: pi's own built-ins validate their arguments themselves, so the
 * same mistake used to survive in `bash` and die in `read`. The transcript
 * extension re-registers those built-ins, and that override is where the rule
 * reaches them.
 */

// pi-tui reads terminal capabilities when the transcript modules load.
import "./env.mjs";
process.env.TMUX ??= "test";

import { execSync } from "node:child_process";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const { Type } = await import("typebox");
const { coerceDeclaredJsonArguments, jsonArgumentCoercionFor } = await jiti.import(`${ROOT}/lib/tool-argument-coercion.ts`);

// ---------------------------------------------------------------------------
// The rule: a string that parses to the declared type is that value
// ---------------------------------------------------------------------------
{
	console.log("\na string where the schema declares something else");
	const schema = Type.Object({
		names: Type.Optional(Type.Array(Type.String())),
		timeout: Type.Optional(Type.Number()),
		block: Type.Optional(Type.Boolean()),
		result: Type.Optional(Type.Object({}, { additionalProperties: true })),
		message: Type.Optional(Type.String()),
		anyJson: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.String()])),
	});
	const coerce = (args) => coerceDeclaredJsonArguments(schema, args);
	check("an array sent as a string of JSON becomes the array", JSON.stringify(coerce({ names: '["a","b"]' }).names) === '["a","b"]');
	check("a number sent as a string becomes the number", coerce({ timeout: "5000" }).timeout === 5000);
	check("a boolean sent as a string becomes the boolean", coerce({ block: "false" }).block === false);
	check("an object sent as a string of JSON becomes the object", coerce({ result: '{"ok":true}' }).result.ok === true);
	check("a declared string is never touched, however JSON it looks", coerce({ message: "[1,2]" }).message === "[1,2]");
	check("a parameter that also declares a string keeps the string: the tool decides what it meant", coerce({ anyJson: "[1,2]" }).anyJson === "[1,2]");
	check("a string that is not JSON is left for the validator to refuse", coerce({ timeout: "soon" }).timeout === "soon");
	check("a string that parses to the wrong type is left too", coerce({ names: '"a"' }).names === '"a"' && coerce({ timeout: "[1]" }).timeout === "[1]");
	check("values that are not strings pass through untouched", coerce({ timeout: 12, names: ["a"] }).timeout === 12);
	check("an unknown parameter is not guessed at", coerce({ nothingLikeIt: "[1]" }).nothingLikeIt === "[1]");
	check("nothing to coerce returns the same object, not a copy", coerce({ timeout: 12 }).timeout === 12 && coerce(undefined) === undefined);
	check("the other arguments survive a coercion", coerce({ names: '["a"]', message: "hi" }).message === "hi");

	const prepare = jsonArgumentCoercionFor(schema);
	check("the prepareArguments form is the same rule", prepare({ timeout: "30" }).timeout === 30);
}

// ---------------------------------------------------------------------------
// Every kit tool with a non-string parameter is wired to it
//
// The point of a boundary rule is that no tool has to remember it; this check
// is what makes forgetting visible.
// ---------------------------------------------------------------------------
{
	console.log("\nthe kit's tools hand their arguments to the rule");
	const fs = await import("node:fs");
	const wired = [
		["extensions/agent-engine.ts", ["jsonArgumentCoercionFor(agentParams)", "jsonArgumentCoercionFor(sendMessageParams)", "jsonArgumentCoercionFor(taskOutputParams)"]],
		["extensions/workflow.ts", ["jsonArgumentCoercionFor(workflowParams)"]],
		["extensions/bash.ts", ["jsonArgumentCoercionFor(bashParams)"]],
		["extensions/multi-edit.ts", ["coerceDeclaredJsonArguments(parameters, args)"]],
	];
	for (const [file, fragments] of wired) {
		const source = fs.readFileSync(path.join(ROOT, file), "utf8");
		check(`${file} coerces before validating`, fragments.every((f) => source.includes(f)), fragments.filter((f) => !source.includes(f)).join());
	}
}

// ---------------------------------------------------------------------------
// pi's built-ins are under the same rule
//
// Through the extension that registers them, not through the library, because
// what the ticket is about is whether the wiring reaches the model's `read`.
// ---------------------------------------------------------------------------
{
	console.log("\npi's built-in tools take the rule too");
	const { Check } = await import("typebox/value");
	const tools = async (transcript) => {
		process.env.PI_TRANSCRIPT = transcript;
		const fresh = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
		const loaded = await fresh.import(`${ROOT}/extensions/transcript/index.ts`);
		const register = loaded.default ?? loaded;
		const registered = new Map();
		register({ registerTool: (tool) => registered.set(tool.name, tool), on: () => {} });
		return registered;
	};

	const on = await tools("on");
	const names = ["read", "grep", "find", "ls", "write"];
	check(`the built-ins are registered: ${names.join(", ")}`, names.every((name) => on.has(name)), [...on.keys()].join(" "));
	check("every one of them prepares its arguments", names.every((name) => typeof on.get(name)?.prepareArguments === "function"));

	const prepared = (name, args) => on.get(name).prepareArguments(args);
	const read = prepared("read", { path: "lib/seat.ts", offset: "50", limit: "10" });
	check("read: the ticket's own call, offset as a string, is a number", read.offset === 50 && read.limit === 10);
	check("read: and it now validates, where the raw arguments did not",
		Check(on.get("read").parameters, read) && !Check(on.get("read").parameters, { path: "lib/seat.ts", offset: "50" }));
	const grep = prepared("grep", { pattern: "seat", ignoreCase: "true", context: "3" });
	check("grep: a boolean and a number sent as strings", grep.ignoreCase === true && grep.context === 3);
	check("find and ls: a limit sent as a string", prepared("find", { pattern: "*.ts", limit: "20" }).limit === 20 && prepared("ls", { limit: "5" }).limit === 5);
	check("write: every parameter is a string, so nothing is touched", prepared("write", { path: "a", content: "[1,2]" }).content === "[1,2]");
	check("a path that looks like JSON stays a path", prepared("read", { path: "[1,2]" }).path === "[1,2]");

	// The override replaces pi's definition wholesale. If pi ever ships a
	// `prepareArguments` of its own on one of these, the coercion silently drops
	// it — so the day that happens is the day this fails.
	const PI_TOOLS = await import(`${PI}/dist/core/tools/index.js`);
	const factories = { read: "createReadToolDefinition", grep: "createGrepToolDefinition", find: "createFindToolDefinition", ls: "createLsToolDefinition", write: "createWriteToolDefinition" };
	const vanilla = Object.fromEntries(Object.entries(factories).map(([name, factory]) => [name, PI_TOOLS[factory](ROOT)]));
	check("pi's own definitions prepare nothing, so the override drops nothing",
		names.every((name) => vanilla[name].prepareArguments === undefined),
		names.filter((name) => vanilla[name].prepareArguments !== undefined).join());
	check("the schema handed to the rule is pi's, not a copy of it", names.every((name) => JSON.stringify(on.get(name).parameters) === JSON.stringify(vanilla[name].parameters)));

	// The rows are a preference; the rule is not.
	const off = await tools("off");
	check("PI_TRANSCRIPT=off keeps the rule", names.every((name) => typeof off.get(name)?.prepareArguments === "function") && off.get("read").prepareArguments({ path: "a", offset: "7" }).offset === 7);
	check("PI_TRANSCRIPT=off hands the rows back to pi", names.every((name) => off.get(name).renderShell === undefined) && names.every((name) => on.get(name).renderShell === "self"));
	delete process.env.PI_TRANSCRIPT;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
