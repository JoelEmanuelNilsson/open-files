/**
 * workflow-args — what a `Workflow` call's `args` input means by the time the
 * script sees it (ticket 55).
 *
 * Models write this parameter as text: on 2026-09-05 every `Workflow` call of
 * one session, down to a 60-byte placeholder, sent `args` as a JSON string, and
 * two runs died on `args.tests` being undefined. A warning in the description
 * did not stop it, twice. So the seam decides instead of the author: a string
 * that parses as JSON to an object or an array *was* that object or array, and
 * the tool takes it. Anything else — text that is not JSON, or JSON that is a
 * number, a boolean or null — stays the string it arrived as, because a script
 * may legitimately want one.
 */

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
