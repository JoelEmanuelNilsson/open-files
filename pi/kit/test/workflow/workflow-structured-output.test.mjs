/**
 * `StructuredOutput`'s contract, offline: validated at the tool boundary,
 * three attempts, through the module's own exports.
 */

import { check, checkThrows, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
// 4. structured output: validated at the tool boundary, three attempts
// ---------------------------------------------------------------------------
{
	const so = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-structured-output.ts`);
	const { STRUCTURED_OUTPUT_TOOL_NAME } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-tool-text.ts`);
	console.log("\nstructured output");
	const schema = { type: "object", additionalProperties: false, required: ["file", "fixed"], properties: { file: { type: "string" }, fixed: { type: "boolean" } } };
	check("the tool is named StructuredOutput and allows 3 attempts", STRUCTURED_OUTPUT_TOOL_NAME === "StructuredOutput" && so.STRUCTURED_OUTPUT_MAX_ATTEMPTS === 3);
	check("a valid value passes", so.validateStructuredOutput(schema, { file: "a.ts", fixed: true }).ok === true);
	const bad = so.validateStructuredOutput(schema, { file: 1, extra: 2 });
	check("an invalid value fails with every error named by path", bad.ok === false && bad.errors.includes("/file") && bad.errors.includes("fixed") && bad.errors.includes("additional"), bad.errors);
	check("a non-object schema (an array of strings) validates too", so.validateStructuredOutput({ type: "array", items: { type: "string" } }, ["a"]).ok === true && so.validateStructuredOutput({ type: "array", items: { type: "string" } }, [1]).ok === false);
	// Ticket 37: `result` was `Type.Unknown`, a property with no type at all, and
	// every model filled it with a string of JSON — 180 rejections out of 180.
	check("the tool's `result` parameter is a typed object, so the provider constrains the call", so.STRUCTURED_OUTPUT_PARAMS.properties.result.type === "object" && so.STRUCTURED_OUTPUT_PARAMS.required.includes("result"), JSON.stringify(so.STRUCTURED_OUTPUT_PARAMS));
	check("a `result` sent as a string of JSON is parsed before pi validates it", JSON.stringify(so.prepareStructuredOutputArguments({ result: '{"file":"a.ts","fixed":true}' })) === '{"result":{"file":"a.ts","fixed":true}}');
	check("an unparseable string and a real object are passed through untouched", so.prepareStructuredOutputArguments({ result: "not json" }).result === "not json" && so.prepareStructuredOutputArguments({ result: { a: 1 } }).result.a === 1);
	check("only an object schema may be a contract, so the declared type can never contradict it", so.structuredOutputSchemaRefusal(schema) === undefined && so.structuredOutputSchemaRefusal({ type: "array", items: { type: "string" } })?.includes('type "object"') === true && so.structuredOutputSchemaRefusal({ properties: {} })?.includes("no type") === true && so.structuredOutputSchemaRefusal("x")?.includes("got string") === true);
	await checkThrows("declaring a contract on a non-object schema throws where it is constructed", () => so.declareStructuredOutput("parent-0", "bad", { type: "array" }), 'StructuredOutput schema must be a JSON Schema with type "object"');

	const instruction = so.structuredOutputInstruction(schema);
	check("the instruction tells the child to call StructuredOutput once, last, with the schema inline", instruction.includes("call StructuredOutput exactly once, as your final action") && instruction.includes('"required"') && instruction.includes("fixed"), instruction);

	const contract = so.declareStructuredOutput("parent-1", "fix:a.ts", schema);
	check("a declared contract is found by parent session and child name", so.structuredOutputContractOf("parent-1", "fix:a.ts") === contract && so.structuredOutputContractOf("parent-1", "other") === undefined);
	const first = so.recordStructuredOutputAttempt(contract, { file: 1 });
	const second = so.recordStructuredOutputAttempt(contract, { file: "a", fixed: "yes" });
	check("two bad attempts are rejected with the errors and the attempts left", first.kind === "rejected" && first.attemptsLeft === 2 && second.kind === "rejected" && second.attemptsLeft === 1 && second.errors.includes("/fixed"), JSON.stringify([first, second]));
	const third = so.recordStructuredOutputAttempt(contract, { file: "a", fixed: true });
	check("a good third attempt is accepted and settles the outcome with the value", third.kind === "accepted" && (await contract.outcome).fixed === true);
	check("a further call after acceptance is refused as already recorded", so.recordStructuredOutputAttempt(contract, { file: "b", fixed: true }).kind === "already-recorded");
	so.forgetStructuredOutput("parent-1", "fix:a.ts");
	check("forget removes it", so.structuredOutputContractOf("parent-1", "fix:a.ts") === undefined);

	const doomed = so.declareStructuredOutput("parent-1", "doomed", schema);
	doomed.outcome.catch(() => {});
	so.recordStructuredOutputAttempt(doomed, {});
	check("a turn that ends without a call counts as an attempt", so.noteStructuredOutputMissed(doomed).kind === "rejected");
	const last = so.recordStructuredOutputAttempt(doomed, {});
	check("the third failure is exhausted and the outcome rejects", last.kind === "exhausted" && (await doomed.outcome.then(() => "resolved", (e) => e.message)).includes("3 attempts"));
	so.forgetStructuredOutput("parent-1", "doomed");
}

await finish();
