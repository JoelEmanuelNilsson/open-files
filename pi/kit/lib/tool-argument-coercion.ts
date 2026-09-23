/**
 * tool-argument-coercion — a model asked for a non-string parameter sometimes
 * sends a string of it, and the tool call dies on validation.
 *
 * Three instances in two days (report 35 §8): a workflow's `args` as a JSON
 * string, a structured `result` as a JSON string, `read`'s `offset` as `"50"`.
 * Fixing it a fourth time inside a fourth tool is the signal that it belongs at
 * the boundary every tool shares: pi calls `prepareArguments` on the raw
 * arguments *before* schema validation, so one rule applied there closes the
 * class for every tool that opts in.
 *
 * The rule, and it is narrow on purpose: a **string** where the parameter's
 * schema declares an object, array, number, integer or boolean, which parses as
 * JSON to exactly that declared type, is that value. Anything else is left
 * untouched for the validator to refuse as loudly as it does today — a string
 * that does not parse, a parse whose type is not declared, and, deliberately,
 * every parameter whose schema allows a string at all: there the string the
 * model sent is already a legal value, and a tool that means something else by
 * it (a workflow's `args`, `lib/workflow-args.ts`) has to say so itself.
 *
 * Top-level parameters only. A string nested inside an object-valued parameter
 * is that parameter's own business.
 */

import type { Static, TSchema } from "typebox";

/** Applies {@link coerceDeclaredJsonArguments} to a tool's raw arguments; hand it to `registerTool`'s `prepareArguments`. */
export function jsonArgumentCoercionFor<T extends TSchema>(schema: T): (args: unknown) => Static<T> {
	// Safe: the cast claims no more than `prepareArguments` already promises — pi validates the
	// returned value against this same schema, and coercion only ever replaces a string with the
	// value that schema declares.
	return (args: unknown) => coerceDeclaredJsonArguments(schema, args) as Static<T>;
}

/** Parse a string argument back into the object, array, number or boolean its parameter is declared as; every other argument is returned as it arrived. */
export function coerceDeclaredJsonArguments(schema: unknown, args: unknown): unknown {
	const properties = propertiesOf(schema);
	if (properties === undefined || typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const raw = args as Record<string, unknown>;
	let coerced: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== "string") continue;
		const declared = declaredJsonTypes(properties[key]);
		if (declared.size === 0 || declared.has("string")) continue;
		const parsed = parseJson(value);
		if (parsed === undefined || !declared.has(jsonTypeOf(parsed.value))) continue;
		coerced ??= { ...raw };
		coerced[key] = parsed.value;
	}
	return coerced ?? args;
}

/** The JSON Schema type names one parameter accepts, flattened through `anyOf`/`oneOf`; empty when the schema names none. */
function declaredJsonTypes(property: unknown): Set<string> {
	const types = new Set<string>();
	if (typeof property !== "object" || property === null) return types;
	const node = property as { type?: unknown; anyOf?: unknown; oneOf?: unknown; const?: unknown };
	if (typeof node.type === "string") types.add(node.type);
	if (Array.isArray(node.type)) for (const name of node.type) if (typeof name === "string") types.add(name);
	if (node.const !== undefined) types.add(jsonTypeOf(node.const));
	for (const branch of [node.anyOf, node.oneOf]) {
		if (!Array.isArray(branch)) continue;
		for (const option of branch) for (const name of declaredJsonTypes(option)) types.add(name);
	}
	// A number-declared parameter takes an integer literal and vice versa; the validator's own range checks still apply.
	if (types.has("number")) types.add("integer");
	if (types.has("integer")) types.add("number");
	return types;
}

function propertiesOf(schema: unknown): Record<string, unknown> | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	const properties = (schema as { properties?: unknown }).properties;
	return typeof properties === "object" && properties !== null ? (properties as Record<string, unknown>) : undefined;
}

function parseJson(text: string): { value: unknown } | undefined {
	try {
		return { value: JSON.parse(text) };
	} catch {
		return undefined;
	}
}

function jsonTypeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value;
}
