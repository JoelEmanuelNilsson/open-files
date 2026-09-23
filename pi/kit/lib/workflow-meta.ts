/**
 * Workflow meta extraction: the `export const meta = {...}` block a workflow
 * script must begin with, read *before* the script runs.
 *
 * The block is read statically because it is shown (name, description,
 * phases) before anything executes, and a description that had to be
 * computed by running the script could lie about what the script does. So
 * the literal is accepted only if every token in it is a literal: strings,
 * numbers, booleans, null, arrays, objects, and bare identifiers only where
 * an object key goes. A variable, a call, a spread or a `${}` interpolation
 * is refused loudly — the ruled wording, "meta must be a pure literal".
 *
 * No parser is vendored; a small tokenizer walks the literal, which is the
 * whole grammar here. The value itself is then read with `JSON.parse` after
 * a literal-to-JSON rewrite, so nothing is ever evaluated.
 */

/** One `phases` entry: the title a `phase()` call is matched to, exactly. */
export interface WorkflowPhaseMeta {
	readonly title: string;
	readonly detail?: string;
	readonly model?: string;
}

/** The meta block as the script declares it; `name` and `description` are required. */
export interface WorkflowMeta {
	readonly name: string;
	readonly description: string;
	readonly whenToUse?: string;
	readonly phases?: readonly WorkflowPhaseMeta[];
	readonly [key: string]: unknown;
}

/** The meta and the script with the declaration cut out, ready to run as a body. */
export interface ExtractedWorkflowMeta {
	readonly meta: WorkflowMeta;
	readonly body: string;
}

/** Refusals here are author errors; the message is the whole explanation. */
export class WorkflowMetaError extends Error {
	readonly _tag = "WorkflowMetaError" as const;
}

const META_DECLARATION = /export\s+const\s+meta\s*=\s*/g;
const PURE_LITERAL_RULE = "meta must be a pure literal — no variables, calls, spreads, or template interpolation";

/** Read the meta block off a workflow script, or throw {@link WorkflowMetaError}. */
export function extractWorkflowMeta(source: string): ExtractedWorkflowMeta {
	META_DECLARATION.lastIndex = 0;
	const match = META_DECLARATION.exec(source);
	if (match === null) throw new WorkflowMetaError("script must begin with `export const meta = {...}` (a pure literal; plain JavaScript, not TypeScript)");
	const start = match.index;
	const literalStart = start + match[0].length;
	if (source[literalStart] !== "{") throw new WorkflowMetaError(`${PURE_LITERAL_RULE} — found ${describeStart(source.slice(literalStart, literalStart + 20))}`);
	const { json, end } = readPureLiteral(source, literalStart);
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new WorkflowMetaError(`${PURE_LITERAL_RULE} — ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkflowMetaError(`${PURE_LITERAL_RULE} — meta must be an object`);
	const meta = value as Record<string, unknown>;
	if (typeof meta.name !== "string" || meta.name.trim() === "" || typeof meta.description !== "string" || meta.description.trim() === "") {
		throw new WorkflowMetaError("meta needs name and description");
	}
	let cut = end;
	while (cut < source.length && /[ \t]/.test(source[cut] ?? "")) cut++;
	if (source[cut] === ";") cut++;
	return { meta: meta as unknown as WorkflowMeta, body: source.slice(0, start) + source.slice(cut) };
}

function describeStart(text: string): string {
	return text.trim() === "" ? "nothing" : JSON.stringify(text.trim().split(/\s/)[0]);
}

/**
 * Walk the literal from its opening brace, emitting JSON for every token
 * accepted and throwing on anything else. Returns the JSON and the offset
 * just past the closing brace.
 */
function readPureLiteral(source: string, from: number): { json: string; end: number } {
	let i = from;
	let depth = 0;
	const out: string[] = [];
	/** True when the next identifier may be an object key (after `{` or `,` inside an object). */
	const stack: Array<"object" | "array"> = [];
	let expectKey = false;
	const refuse = (what: string): never => {
		throw new WorkflowMetaError(`${PURE_LITERAL_RULE} — found ${what}`);
	};
	while (i < source.length) {
		const ch = source[i] as string;
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			const nl = source.indexOf("\n", i);
			i = nl === -1 ? source.length : nl;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const close = source.indexOf("*/", i + 2);
			if (close === -1) refuse("an unterminated comment");
			i = close + 2;
			continue;
		}
		if (ch === "{") {
			depth++;
			stack.push("object");
			out.push("{");
			expectKey = true;
			i++;
			continue;
		}
		if (ch === "[") {
			depth++;
			stack.push("array");
			out.push("[");
			expectKey = false;
			i++;
			continue;
		}
		if (ch === "}" || ch === "]") {
			const opened = stack.pop();
			if (opened === undefined || (ch === "}" ? opened !== "object" : opened !== "array")) refuse(`a stray ${ch}`);
			// A trailing comma is JavaScript, not JSON: drop it.
			if (out[out.length - 1] === ",") out.pop();
			out.push(ch);
			depth--;
			i++;
			if (depth === 0) return { json: out.join(""), end: i };
			expectKey = false;
			continue;
		}
		if (ch === ",") {
			out.push(",");
			expectKey = stack[stack.length - 1] === "object";
			i++;
			continue;
		}
		if (ch === ":") {
			out.push(":");
			expectKey = false;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			const { text, end } = readStringLiteral(source, i, refuse);
			out.push(JSON.stringify(text));
			i = end;
			continue;
		}
		if (ch === "." && source[i + 1] === "." && source[i + 2] === ".") refuse("a spread");
		const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
		if (number !== null && !(ch === "-" && !/[\d.]/.test(source[i + 1] ?? ""))) {
			const literal = number[0];
			out.push(String(Number(literal)));
			i += literal.length;
			continue;
		}
		const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
		if (word !== null) {
			const name = word[0];
			const after = source.slice(i + name.length).replace(/^[ \t\r\n]+/, "");
			if (expectKey && after.startsWith(":")) {
				out.push(JSON.stringify(name));
				i += name.length;
				continue;
			}
			if (name === "true" || name === "false" || name === "null") {
				if (after.startsWith("(") || after.startsWith(".")) refuse(`a call on ${name}`);
				out.push(name);
				i += name.length;
				continue;
			}
			refuse(after.startsWith("(") ? `a call (${name}(…))` : `a variable (${name})`);
		}
		if (ch === "(") refuse("a call");
		refuse(JSON.stringify(ch));
	}
	return refuse("an unterminated literal");
}

/** A single- or double-quoted string, or a template with no `${` in it, as its runtime text. */
function readStringLiteral(source: string, from: number, refuse: (what: string) => never): { text: string; end: number } {
	const quote = source[from] as string;
	let i = from + 1;
	let text = "";
	while (i < source.length) {
		const ch = source[i] as string;
		if (ch === "\\") {
			const next = source[i + 1];
			if (next === undefined) refuse("an unterminated string");
			text += unescapeChar(next as string, source, i);
			i += next === "u" ? 6 : next === "x" ? 4 : 2;
			continue;
		}
		if (ch === quote) return { text, end: i + 1 };
		if (quote === "`" && ch === "$" && source[i + 1] === "{") refuse("template interpolation");
		if (quote !== "`" && ch === "\n") refuse("an unterminated string");
		text += ch;
		i++;
	}
	return refuse("an unterminated string");
}

function unescapeChar(next: string, source: string, at: number): string {
	switch (next) {
		case "n":
			return "\n";
		case "t":
			return "\t";
		case "r":
			return "\r";
		case "b":
			return "\b";
		case "f":
			return "\f";
		case "v":
			return "\v";
		case "0":
			return "\0";
		case "u":
			return String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 6), 16));
		case "x":
			return String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 4), 16));
		default:
			return next;
	}
}
