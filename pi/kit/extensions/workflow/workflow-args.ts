/** A `Workflow` call's `args` as the script will see it, and whether a JSON string was parsed to get there. */
export interface CoercedWorkflowArgs {
	readonly value: unknown;
	readonly coerced: boolean;
}

/** The one line the run logs when `args` arrived as a JSON string and was parsed into the value it encoded. */
export const WORKFLOW_ARGS_COERCED_LOG = "args arrived as a JSON string and were parsed into the value they encode";

/** Parse a JSON-string `args` back into the object or array it encodes; every other value is passed through untouched. */
export function coerceWorkflowArgs(raw: unknown): CoercedWorkflowArgs {
	if (typeof raw !== "string") return { value: raw, coerced: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { value: raw, coerced: false };
	}
	if (typeof parsed !== "object" || parsed === null) return { value: raw, coerced: false };
	return { value: parsed, coerced: true };
}
