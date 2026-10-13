/** The meta block as the script declares it; `name` and `description` are required. */
export interface WorkflowMeta {
	readonly name: string;
	readonly description: string;
	readonly [key: string]: unknown;
}

/** The meta and the script with the declaration blanked to its newlines, ready to run as a body. */
export interface ExtractedWorkflowMeta {
	readonly meta: WorkflowMeta;
	readonly body: string;
}

/** Refusals here are author errors; the message is the whole explanation. */
export class WorkflowMetaError extends Error {
	readonly _tag = "WorkflowMetaError" as const;
}

const META_DECLARATION = /export\s+const\s+meta\s*=\s*/y;
const LEADING_TRIVIA = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
const PURE_LITERAL_RULE = "meta must be a pure literal — no variables, calls, spreads, or template interpolation";

/** Read the meta block off a workflow script, or throw {@link WorkflowMetaError}. */
export function extractWorkflowMeta(source: string): ExtractedWorkflowMeta {
	LEADING_TRIVIA.lastIndex = 0;
	LEADING_TRIVIA.exec(source);
	META_DECLARATION.lastIndex = LEADING_TRIVIA.lastIndex;
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
	// SAFETY: value was narrowed to a non-null, non-array object above
	const meta = value as Record<string, unknown>;
	if (typeof meta.name !== "string" || meta.name.trim() === "" || typeof meta.description !== "string" || meta.description.trim() === "") {
		throw new WorkflowMetaError("meta needs name and description");
	}
	let cut = end;
	while (cut < source.length && /[ \t]/.test(source[cut] ?? "")) cut++;
	if (source[cut] === ";") cut++;
	const blank = source.slice(start, cut).replace(/[^\r\n\u2028\u2029]/g, "");
	// SAFETY: meta is validated field by field above
	return { meta: meta as unknown as WorkflowMeta, body: source.slice(0, start) + blank + source.slice(cut) };
}

function describeStart(text: string): string {
	return text.trim() === "" ? "nothing" : JSON.stringify(text.trim().split(/\s/)[0]);
}

function readPureLiteral(source: string, from: number): { json: string; end: number } {
	let i = from;
	let depth = 0;
	const out: string[] = [];
	const stack: Array<"object" | "array"> = [];
	let expectKey = false;
	const refuse = (what: string): never => {
		throw new WorkflowMetaError(`${PURE_LITERAL_RULE} — found ${what}`);
	};
	while (i < source.length) {
		// SAFETY: the loop condition keeps i < source.length
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

function readStringLiteral(source: string, from: number, refuse: (what: string) => never): { text: string; end: number } {
	// SAFETY: callers pass from < source.length, so the index is in range
	const quote = source[from] as string;
	let i = from + 1;
	let text = "";
	while (i < source.length) {
		// SAFETY: the loop condition keeps i < source.length
		const ch = source[i] as string;
		if (ch === "\\") {
			const escape = readEscape(source, i, refuse);
			text += escape.text;
			i += escape.length;
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

const SINGLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

function readEscape(source: string, at: number, refuse: (what: string) => never): { text: string; length: number } {
	const next = source[at + 1];
	if (next === undefined) return refuse("an unterminated string");
	const hex = (digits: string): number => (/^[0-9a-fA-F]+$/.test(digits) ? Number.parseInt(digits, 16) : refuse("a malformed escape"));
	if (next === "x") return { text: String.fromCharCode(hex(source.slice(at + 2, at + 4))), length: 4 };
	if (next === "u" && source[at + 2] === "{") {
		const close = source.indexOf("}", at + 3);
		const code = close === -1 ? refuse("a malformed escape") : hex(source.slice(at + 3, close));
		if (code > 0x10ffff) refuse("a malformed escape");
		return { text: String.fromCodePoint(code), length: close - at + 1 };
	}
	if (next === "u") return { text: String.fromCharCode(hex(source.slice(at + 2, at + 6))), length: 6 };
	if (next === "\r" && source[at + 2] === "\n") return { text: "", length: 3 };
	if (next === "\n" || next === "\r" || next === "\u2028" || next === "\u2029") return { text: "", length: 2 };
	return { text: SINGLE_ESCAPES[next] ?? next, length: 2 };
}
