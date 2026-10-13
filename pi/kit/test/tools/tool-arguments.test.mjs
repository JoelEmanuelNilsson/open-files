/**
 * The tool-argument boundary: a string where the schema declares something else.
 *
 * Report 35 §8 counted three instances of one class in two days — a workflow's
 * `args`, a structured `result`, `read`'s `offset` — so the rule lives in
 * `lib/tools/tool-argument-coercion.ts` and every kit tool hands it to pi's
 * `prepareArguments`, which runs before schema validation.
 *
 * pi's own built-ins convert stringified numbers themselves, so the rule is not wired to them.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
// pi-tui reads terminal capabilities when the transcript modules load.
process.env.TMUX ??= "test";

import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

const { Type } = await import("typebox");
const { coerceDeclaredJsonArguments, jsonArgumentCoercionFor } = await jiti.import(`${KIT_ROOT}/lib/tools/tool-argument-coercion.ts`);

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
// Every kit tool is registered through registerAbortBoundedTool, which applies
// the rule unless the tool prepares its own arguments.
// ---------------------------------------------------------------------------
{
	console.log("\na kit tool coerces with no prepareArguments of its own");
	const { PI_ROOT } = await import("../support/pi-package.mjs");
	const { pathToFileURL } = await import("node:url");
	const { validateToolArguments } = await import(pathToFileURL(path.join(PI_ROOT, "node_modules/@earendil-works/pi-ai/dist/utils/validation.js")).href);
	const { fakeExtensionApi } = await import("../support/fake-extension-api.mjs");
	const { registerAbortBoundedTool } = await jiti.import(`${KIT_ROOT}/lib/tools/tool-abort-bound.ts`);
	const validated = (tool, args) => {
		const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
		try {
			return validateToolArguments(tool, { id: "t", type: "toolCall", name: tool.name, arguments: prepared });
		} catch (error) {
			return error.message;
		}
	};
	const registered = [];
	registerAbortBoundedTool({ registerTool: (tool) => registered.push(tool) }, { name: "probe", label: "probe", description: "probe", parameters: Type.Object({ task: Type.Integer(), names: Type.Array(Type.String()) }), execute: async () => ({ content: [], details: undefined }) });
	const probe = registered[0];
	check('a tool registered without prepareArguments turns "91" into 91', probe.prepareArguments?.({ task: "91" }).task === 91);
	const names = validated(probe, { task: 1, names: '["a","b"]' });
	check("and an array sent as JSON passes pi's validation as the array", JSON.stringify(names.names) === '["a","b"]', JSON.stringify(names));
	const pi = fakeExtensionApi();
	(await jiti.import(`${KIT_ROOT}/extensions/agent-engine/index.ts`)).default(pi.api);
	const stop = validated(pi.tools.get("TaskStop"), { task: "91" });
	check('TaskStop {"task":"91"} is prepared and reaches execute as task 91', pi.tools.get("TaskStop").prepareArguments?.({ task: "91" }).task === 91 && stop.task === 91, JSON.stringify(stop));
}

// ---------------------------------------------------------------------------
// pi's built-ins need no rule of ours
//
// pi validates a built-in's arguments with `Value.Convert` before `Check`, so
// `read` with `offset: "50"` passes pi's own validation and the kit does not
// re-register `read` to repair it.
// ---------------------------------------------------------------------------
{
	console.log("\npi's own read accepts offset as a string");
	const { PI_ROOT, importPi } = await import("../support/pi-package.mjs");
	const { pathToFileURL } = await import("node:url");
	const { validateToolArguments } = await import(pathToFileURL(path.join(PI_ROOT, "node_modules/@earendil-works/pi-ai/dist/utils/validation.js")).href);
	const { createReadToolDefinition } = await importPi("dist/core/tools/index.js");
	const read = createReadToolDefinition(KIT_ROOT);
	check("pi's read definition prepares nothing", read.prepareArguments === undefined);
	const args = validateToolArguments(read, { id: "t", type: "toolCall", name: "read", arguments: { path: "a.ts", offset: "50", limit: "10" } });
	check("offset: \"50\" validates, as the number 50", args.offset === 50 && args.limit === 10, JSON.stringify(args));
}

await finish();
