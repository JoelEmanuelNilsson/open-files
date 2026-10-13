import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { processShared } from "../../lib/process/process-shared-state.ts";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../../lib/agents/agent-tool-text.ts";

/** The nudge a schema child gets when its turn ended with no `StructuredOutput` call. */
export const STRUCTURED_OUTPUT_NUDGE = `You ended without calling ${STRUCTURED_OUTPUT_TOOL_NAME}. Call it now, exactly once, with \`result\` matching the JSON Schema in your first message.`;
export const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 3;

/** The tool's description, shown only to workflow children. */
export const STRUCTURED_OUTPUT_DESCRIPTION =
	"Return your result to the workflow that started you. Only for a workflow child whose prompt gives a JSON Schema: call it exactly once, as your final action, with `result` matching that schema. Refused anywhere else — reply in plain text instead.";

export const STRUCTURED_OUTPUT_PARAM_DESCRIPTION = "The result object, matching the JSON Schema in your prompt. A JSON object, not a string of JSON.";

/** The tool's parameters: a typed object, the one shape a contract may ask for. */
export const STRUCTURED_OUTPUT_PARAMS = Type.Object({
	result: Type.Object({}, { additionalProperties: true, description: STRUCTURED_OUTPUT_PARAM_DESCRIPTION }),
});

/** Why this schema cannot be a child's contract, or undefined if it can. */
export function structuredOutputSchemaRefusal(schema: unknown): string | undefined {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return `must be a JSON Schema object, got ${Array.isArray(schema) ? "an array" : typeof schema}`;
	// SAFETY: schema was narrowed to a non-null, non-array object above
	const type = (schema as { type?: unknown }).type;
	if (type !== "object") return `must be a JSON Schema with type "object", got ${type === undefined ? "no type" : JSON.stringify(type)}; wrap anything else in an object (e.g. { type: "object", properties: { items: <your schema> } })`;
	return undefined;
}

/** Read the tool's raw arguments before pi validates them: a `result` sent as a string of JSON is the object it parses to. */
export function prepareStructuredOutputArguments(args: unknown): Static<typeof STRUCTURED_OUTPUT_PARAMS> {
	// SAFETY: args was narrowed to a non-null object; only result is read
	const raw = typeof args === "object" && args !== null ? (args as { result?: unknown }).result : undefined;
	if (typeof raw === "string") {
		try {
			// SAFETY: the parsed JSON is validated against the schema by validateStructuredOutput before use
			return { result: JSON.parse(raw) as Record<string, unknown> };
		} catch {}
	}
	// SAFETY: pi validates the remaining arguments against STRUCTURED_OUTPUT_PARAMS
	return args as Static<typeof STRUCTURED_OUTPUT_PARAMS>;
}

/** The refusal outside a workflow child (the tool is registered everywhere, carried only there). */
export const STRUCTURED_OUTPUT_NOT_A_WORKFLOW_CHILD = "StructuredOutput is only for a workflow child with a schema in its prompt. Reply in plain text instead.";

/** A validation verdict; `errors` is one line per failed keyword, path first. */
export type StructuredOutputVerdict = { readonly ok: true } | { readonly ok: false; readonly errors: string };

/** Check a value against a JSON Schema. */
export function validateStructuredOutput(schema: unknown, value: unknown): StructuredOutputVerdict {
	// SAFETY: Value.Check accepts any schema and reports invalid ones as a verdict
	const tschema = schema as Parameters<typeof Value.Check>[0];
	if (Value.Check(tschema, value)) return { ok: true };
	const errors = [...Value.Errors(tschema, value)].map((error) => `${error.instancePath || "/"} ${error.message}`);
	return { ok: false, errors: errors.length > 0 ? errors.join("; ") : "value does not match the schema" };
}

/** The paragraph appended to a schema child's prompt. */
export function structuredOutputInstruction(schema: unknown): string {
	return `When you are done, call ${STRUCTURED_OUTPUT_TOOL_NAME} exactly once, as your final action, with \`result\` matching this JSON Schema (validated; a mismatch comes back as an error to fix):\n\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``;
}

/** One child's contract: the schema, the attempts so far, and the outcome the parent awaits. */
export interface StructuredOutputContract {
	readonly schema: unknown;
	attempts: number;
	settled: boolean;
	readonly outcome: Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export type StructuredOutputAttempt =
	| { readonly kind: "accepted" }
	| { readonly kind: "rejected"; readonly errors: string; readonly attemptsLeft: number }
	| { readonly kind: "exhausted"; readonly errors: string }
	| { readonly kind: "already-recorded" };

/** Apply one `StructuredOutput` call to its contract. */
export function recordStructuredOutputAttempt(contract: StructuredOutputContract, value: unknown): StructuredOutputAttempt {
	if (contract.settled) return { kind: "already-recorded" };
	const verdict = validateStructuredOutput(contract.schema, value);
	if (verdict.ok) {
		contract.settled = true;
		contract.resolve(value);
		return { kind: "accepted" };
	}
	return fail(contract, verdict.errors);
}

/** The child's turn ended with no call: that was an attempt too. */
export function noteStructuredOutputMissed(contract: StructuredOutputContract): StructuredOutputAttempt {
	if (contract.settled) return { kind: "already-recorded" };
	return fail(contract, `the turn ended without a ${STRUCTURED_OUTPUT_TOOL_NAME} call`);
}

function fail(contract: StructuredOutputContract, errors: string): StructuredOutputAttempt {
	contract.attempts++;
	if (contract.attempts >= STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
		contract.settled = true;
		contract.reject(new Error(`subagent failed schema validation after ${STRUCTURED_OUTPUT_MAX_ATTEMPTS} attempts: ${errors}`));
		return { kind: "exhausted", errors };
	}
	return { kind: "rejected", errors, attemptsLeft: STRUCTURED_OUTPUT_MAX_ATTEMPTS - contract.attempts };
}

/** The error tool result the child reads on a mismatch; it retries against this. */
export function structuredOutputRetryText(attempt: Extract<StructuredOutputAttempt, { kind: "rejected" }>): string {
	return `Schema validation failed: ${attempt.errors}. Call ${STRUCTURED_OUTPUT_TOOL_NAME} again with corrected input (${attempt.attemptsLeft} attempt${attempt.attemptsLeft === 1 ? "" : "s"} left).`;
}

/** What the child reads once its result is recorded. */
export const STRUCTURED_OUTPUT_ACCEPTED_TEXT = "Recorded. You are done — end your turn now with no further text.";

/** What the child reads on the third failure; the parent stops it. */
export function structuredOutputExhaustedText(errors: string): string {
	return `Schema validation failed ${STRUCTURED_OUTPUT_MAX_ATTEMPTS} times (${errors}). Stop: the workflow has been told.`;
}

const CONTRACTS_SEAM = "__piKitWorkflowStructuredOutput";

const contracts = (): Map<string, StructuredOutputContract> => processShared(CONTRACTS_SEAM, () => new Map<string, StructuredOutputContract>());

const contractKey = (parentSessionId: string, childName: string) => `${parentSessionId}\u0000${childName}`;

/** Declare, before spawning, which schema the child named `childName` must satisfy. */
export function declareStructuredOutput(parentSessionId: string, childName: string, schema: unknown): StructuredOutputContract {
	const refusal = structuredOutputSchemaRefusal(schema);
	if (refusal !== undefined) throw new TypeError(`StructuredOutput schema ${refusal}`);
	let resolve: (value: unknown) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const outcome = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const contract: StructuredOutputContract = { schema, attempts: 0, settled: false, outcome, resolve, reject };
	contracts().set(contractKey(parentSessionId, childName), contract);
	return contract;
}

/** The contract a child must satisfy, by its parent's session id and its own name. */
export function structuredOutputContractOf(parentSessionId: string, childName: string): StructuredOutputContract | undefined {
	return contracts().get(contractKey(parentSessionId, childName));
}

export function forgetStructuredOutput(parentSessionId: string, childName: string): void {
	contracts().delete(contractKey(parentSessionId, childName));
}
