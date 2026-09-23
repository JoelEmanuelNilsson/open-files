/**
 * The `/prompt` dump: the whole context window of the last provider request,
 * verbatim (issues/37). `/prompt` exists so the human can read exactly what
 * the model read — that is the only way to trust the harness — so this module
 * has one fidelity contract and one safety contract:
 *
 * **Fidelity.** Tools and messages are snapshotted the moment the request
 * goes out, as the compact JSON the wire serializer would produce — not as
 * live references a later turn could mutate, and not as counts that discard
 * the content. Tools render in wire order (that order *is* the cached
 * prefix). Two counting conventions, both labelled where they appear: system
 * blocks are counted as raw text (what the tokenizer actually sees), tools
 * and messages as their compact wire JSON. A message block renders as raw
 * text only when it is *purely* text — `type`/`text`/`cache_control` and
 * nothing else — so a field this module has never heard of falls through to
 * the exact-JSON branch instead of silently vanishing behind a count that
 * says it went out. Pretty-printing and fencing exist only so a human can
 * read it; they are labelled as presentation, never counted.
 *
 * **Totality.** {@link captureWire} runs inside `before_provider_request`,
 * whose *return value is the request* — pi drops that value if the handler
 * throws, which would strip the owned system prompt off the wire. So capture
 * can never throw: anything that fails to serialize degrades to "not
 * captured" in the dump instead. Rendering happens later, on the human's
 * command, and is total too — a dump that dies half-way is a dump that hides
 * the second half.
 *
 * Raw text (system blocks, message text) is emitted inside a fence one
 * backtick longer than any backtick run in the content, so the owned prompt —
 * which contains code fences — survives verbatim instead of tearing the
 * document apart at its first example.
 */

export interface TextBlock {
	type: "text";
	text: string;
	cache_control?: Record<string, unknown>;
}

/** The two request shapes this harness owns: Anthropic Messages and ChatGPT-subscription Responses. */
export type WireApi = "anthropic-messages" | "openai-codex-responses";

export interface WireCapture {
	api: WireApi;
	at: Date;
	model: string;
	oauth: boolean;
	degraded: boolean;
	/**
	 * Anthropic: the Claude Code headers this harness adds. Codex: the header bag
	 * pi handed extensions, credentials redacted — this harness adds none there.
	 */
	headers: Record<string, string>;
	/**
	 * The system blocks as sent. Held structured, not serialized: this is the
	 * very array the returned request carries, so whatever the provider client
	 * serializes, the capture holds the same objects and cannot disagree with
	 * the wire.
	 */
	system: TextBlock[];
	/** The payload's `tools`, as compact wire JSON. `undefined`: absent or unserializable. */
	tools: string | undefined;
	/** The payload's `messages` (Anthropic) or `input` (Codex), as compact wire JSON. `undefined`: absent or unserializable. */
	messages: string | undefined;
	/** Every other payload field (model, reasoning, cache key…), as compact wire JSON. `undefined`: not handed over. */
	fields: string | undefined;
}

/**
 * Snapshot one request. Total: a value that cannot be serialized is recorded
 * as `undefined` rather than thrown on the provider hot path. Whole-array,
 * deliberately: the provider client stringifies the same data in one call,
 * so a payload with one unserializable element never becomes a request at
 * all — "not captured" is then the truth, and per-element salvage would
 * describe a wire that cannot exist.
 */
export function captureWire(input: {
	api: WireApi;
	at: Date;
	model: string;
	oauth: boolean;
	degraded: boolean;
	headers: Record<string, string>;
	system: TextBlock[];
	tools: unknown;
	messages: unknown;
	/** The request payload, read only for the fields the other inputs do not hold. */
	payload?: unknown;
}): WireCapture {
	return {
		api: input.api,
		at: input.at,
		model: input.model,
		oauth: input.oauth,
		degraded: input.degraded,
		headers: Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name, CREDENTIAL_HEADERS.has(name.toLowerCase()) ? "(redacted)" : value])),
		system: input.system,
		tools: wireJson(input.tools),
		messages: wireJson(input.messages),
		fields: isRecord(input.payload) ? wireJson(Object.fromEntries(Object.entries(input.payload).filter(([key]) => !CONTENT_FIELDS.has(key)))) : undefined,
	};
}

/** The payload fields the dump shows in their own sections. */
const CONTENT_FIELDS = new Set(["system", "instructions", "tools", "messages", "input"]);

/** Headers whose value is a secret: named in the dump, never copied into it. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);

/** Render the dump. Total: whatever the capture holds, every part renders. */
export function renderWireCapture(capture: WireCapture): string {
	const tools = parseArray(capture.tools);
	const messages = parseArray(capture.messages);
	const systemChars = capture.system.reduce((sum, block) => sum + block.text.length, 0);
	const toolsChars = capture.tools?.length ?? 0;
	const messagesChars = capture.messages?.length ?? 0;

	const codex = capture.api === "openai-codex-responses";
	const lines: string[] = [
		"# The wire",
		"",
		`- api: ${capture.api}`,
		`- model: ${capture.model}`,
		`- captured: ${capture.at.toISOString()}`,
		`- oauth: ${capture.oauth}`,
		`- degraded (no options capture): ${capture.degraded}`,
		`- total: ~${tokens(systemChars) + tokens(toolsChars) + tokens(messagesChars)} tokens ` +
			`(system ~${tokens(systemChars)} + tools ~${tokens(toolsChars)} + messages ~${tokens(messagesChars)}; ` +
			"chars/4 — system as raw text, tools and messages as wire JSON; an estimate, not the provider's count)",
		"",
		codex
			? "## headers (as pi handed them to extensions; this harness adds none — pi-ai adds auth, account, originator, user-agent and transport headers as it sends)"
			: "## claude code headers",
		"",
	];
	for (const [name, value] of Object.entries(capture.headers)) lines.push(`- ${name}: ${value}`);
	if (Object.keys(capture.headers).length === 0) lines.push(codex ? "- (none)" : "- (none — not an OAuth request)");

	if (codex) {
		lines.push("", `## instructions (~${tokens(systemChars)} tokens)`);
		for (const block of capture.system) pushFenced(lines, block.text);
	} else {
		lines.push("", `## system blocks (${capture.system.length}, ~${tokens(systemChars)} tokens)`, "");
		capture.system.forEach((block, index) => {
			lines.push(`### block ${index} — ${block.text.length} chars, ~${tokens(block.text.length)} tokens${cacheNote(block.cache_control)}`);
			pushFenced(lines, block.text);
		});
	}

	if (capture.fields !== undefined) {
		lines.push("## request fields");
		pushFenced(lines, prettyJson(capture.fields), "json");
	}

	if (capture.tools === undefined) {
		lines.push("## tools", "", "(not captured — the payload carried no tools, or they could not be serialized)", "");
	} else if (tools === undefined) {
		// Captured, but not an array. Whatever this is, it went on the wire, so
		// it is shown exactly — and the totals line above already counted it.
		lines.push(`## tools (unexpected non-array shape, ~${tokens(toolsChars)} tokens as JSON, shown exactly)`);
		pushFenced(lines, prettyJson(capture.tools), "json");
	} else {
		lines.push(`## tools (${tools.length}, ~${tokens(toolsChars)} tokens as JSON, wire order)`, "");
		for (const tool of tools) {
			const chars = wireJson(tool)?.length ?? 0;
			lines.push(`### ${nameOf(tool)} — ${chars} chars, ~${tokens(chars)} tokens${cacheNote(isRecord(tool) ? tool.cache_control : undefined)}`);
			pushFenced(lines, pretty(tool), "json");
		}
	}

	const conversation = codex ? "input" : "messages";
	if (capture.messages === undefined) {
		lines.push(`## ${conversation}`, "", "(not captured — the payload carried no messages, or they could not be serialized)", "");
	} else if (messages === undefined) {
		lines.push(`## ${conversation} (unexpected non-array shape, ~${tokens(messagesChars)} tokens as JSON, shown exactly)`);
		pushFenced(lines, prettyJson(capture.messages), "json");
	} else {
		lines.push(`## ${conversation} (${messages.length}, ~${tokens(messagesChars)} tokens as JSON)`, "");
		messages.forEach((message, index) => {
			const chars = wireJson(message)?.length ?? 0;
			const role = isRecord(message) && typeof message.role === "string" ? message.role : isRecord(message) && typeof message.type === "string" ? message.type : "?";
			lines.push(`### message ${index} — ${role}, ${chars} chars, ~${tokens(chars)} tokens`, "");
			// A Responses item (a function call, a reasoning item) or a message with
			// fields beside role and content has bytes the content view would hide.
			if (isRecord(message) && Object.keys(message).every((key) => key === "role" || key === "content")) renderContent(lines, message.content);
			else pushFenced(lines, pretty(message), "json");
		});
	}
	return lines.join("\n");
}

/**
 * One message's `content`: a plain string, or the block array. Pure text
 * blocks are the bulk of a context window and render raw; every other block
 * renders as its exact JSON, pretty-printed — a rule, not a type list, so a
 * block shape this module has never heard of still shows every byte it
 * carries. "Pure" is decided on the block's keys, not its `type`: a text
 * block carrying one extra field (a `citations`, say) holds bytes the raw
 * view would hide, so it takes the JSON branch and shows all of them.
 */
function renderContent(lines: string[], content: unknown): void {
	if (content === undefined) {
		lines.push("#### (no content field)", "");
		return;
	}
	if (typeof content === "string") {
		lines.push("#### text (string content)");
		pushFenced(lines, content);
		return;
	}
	if (!Array.isArray(content)) {
		lines.push("#### content (unrecognized shape)");
		pushFenced(lines, pretty(content), "json");
		return;
	}
	content.forEach((block, index) => {
		if (isPureTextBlock(block)) {
			lines.push(`#### block ${index} — text${cacheNote(block.cache_control)}`);
			pushFenced(lines, block.text);
			return;
		}
		const type = isRecord(block) && typeof block.type === "string" ? block.type : "?";
		lines.push(`#### block ${index} — ${type}`);
		pushFenced(lines, pretty(block), "json");
	});
}

/** Compact JSON as the wire serializer would emit it, or `undefined` — never a throw. */
function wireJson(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const json = JSON.stringify(value);
		// JSON.stringify returns undefined for functions/symbols; a payload field
		// is never one, but totality means handling it, not assuming it.
		return typeof json === "string" ? json : undefined;
	} catch {
		return undefined;
	}
}

function parseArray(json: string | undefined): unknown[] | undefined {
	if (json === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** A captured JSON string, pretty-printed for reading — or shown as-is if it will not re-parse. */
function prettyJson(json: string): string {
	try {
		return pretty(JSON.parse(json));
	} catch {
		return json;
	}
}

/** ~tokens from wire chars. The provider's tokenizer is not consulted; chars/4 is labelled everywhere it appears. */
const tokens = (chars: number): number => Math.ceil(chars / 4);

const cacheNote = (cacheControl: unknown): string => (cacheControl === undefined ? "" : ` cache_control=${wireJson(cacheControl) ?? "?"}`);

const nameOf = (tool: unknown): string => (isRecord(tool) && typeof tool.name === "string" ? tool.name : "?");

function pretty(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return "(unserializable)";
	}
}

/** A fence longer than any backtick run in the content, so the content can never close it. */
function pushFenced(lines: string[], text: string, language = ""): void {
	const longest = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longest + 1));
	lines.push("", fence + language, text, fence, "");
}

/** A block that is nothing but text: `type`/`text`/`cache_control` and no other key. */
function isPureTextBlock(value: unknown): value is TextBlock {
	if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") return false;
	return Object.keys(value).every((key) => key === "type" || key === "text" || key === "cache_control");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
