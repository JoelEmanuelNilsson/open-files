import type { Static, TSchema } from "typebox";

/** Applies {@link coerceDeclaredJsonArguments} to a tool's raw arguments; hand it to `registerTool`'s `prepareArguments`. */
export function jsonArgumentCoercionFor<T extends TSchema>(schema: T): (args: unknown) => Static<T> {
	// SAFETY: coercion only rewrites JSON-encoded strings into the values the schema declares, so the result has the schema's static type
	return (args: unknown) => coerceDeclaredJsonArguments(schema, args) as Static<T>;
}

/** Parse a string argument back into the object, array, number or boolean its parameter is declared as; every other argument is returned as it arrived. */
export function coerceDeclaredJsonArguments(schema: unknown, args: unknown): unknown {
	const properties = propertiesOf(schema);
	if (properties === undefined || typeof args !== "object" || args === null || Array.isArray(args)) return args;
	// SAFETY: args was narrowed to a non-null, non-array object above
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

function declaredJsonTypes(property: unknown): Set<string> {
	const types = new Set<string>();
	if (typeof property !== "object" || property === null) return types;
	// SAFETY: property was narrowed to a non-null object above; each field is type-checked
	const node = property as { type?: unknown; anyOf?: unknown; oneOf?: unknown; const?: unknown };
	if (typeof node.type === "string") types.add(node.type);
	if (Array.isArray(node.type)) for (const name of node.type) if (typeof name === "string") types.add(name);
	if (node.const !== undefined) types.add(jsonTypeOf(node.const));
	for (const branch of [node.anyOf, node.oneOf]) {
		if (!Array.isArray(branch)) continue;
		for (const option of branch) for (const name of declaredJsonTypes(option)) types.add(name);
	}
	if (types.has("number")) types.add("integer");
	if (types.has("integer")) types.add("number");
	return types;
}

function propertiesOf(schema: unknown): Record<string, unknown> | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	// SAFETY: schema was narrowed to a non-null object above
	const properties = (schema as { properties?: unknown }).properties;
	// SAFETY: properties was narrowed to a non-null object above
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
