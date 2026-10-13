import type { Static, TSchema } from "typebox";
import { coerceDeclaredJsonArguments } from "./tool-argument-coercion.ts";

export function prepareEditArguments<T extends TSchema>(editToolParams: T, args: unknown): Static<T> {
	if (!args || typeof args !== "object") {
		// SAFETY: non-object arguments are returned unchanged for pi's schema validation to reject
		return args as Static<T>;
	}
	// SAFETY: args was narrowed to a non-null object above and coercion returns an object unchanged in shape
	const input = { ...(coerceDeclaredJsonArguments(editToolParams, args) as Record<string, unknown>) };

	if (typeof input.oldText === "string" && (input.newText === undefined || typeof input.newText === "string")) {
		const edits = Array.isArray(input.edits) ? input.edits : [];
		input.edits = [...edits, { oldText: input.oldText, newText: input.newText }];
		delete input.oldText;
		delete input.newText;
	}

	// SAFETY: input is the coerced, legacy-normalised argument object; pi validates it against editToolParams before execute
	return input as Static<T>;
}
