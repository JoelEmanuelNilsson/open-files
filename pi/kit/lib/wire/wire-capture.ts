import type { SystemTextBlock } from "./claude-code.ts";

/** The two request shapes this harness owns: Anthropic Messages and ChatGPT-subscription Responses. */
export type WireApi = "anthropic-messages" | "openai-codex-responses";

export interface WireCapture {
	api: WireApi;
	at: Date;
	model: string;
	oauth: boolean;
	degraded: boolean;
	headers: Record<string, string>;
	system: SystemTextBlock[];
	tools: string | undefined;
	messages: string | undefined;
	fields: string | undefined;
}

export function captureWire(input: {
	api: WireApi;
	at: Date;
	model: string;
	oauth: boolean;
	degraded: boolean;
	headers: Record<string, string>;
	system: SystemTextBlock[];
	tools: unknown;
	messages: unknown;
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

const CONTENT_FIELDS = new Set(["system", "instructions", "tools", "messages", "input"]);

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie", "cf-aig-authorization"]);

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
			if (isRecord(message) && Object.keys(message).every((key) => key === "role" || key === "content")) renderContent(lines, message.content);
			else pushFenced(lines, pretty(message), "json");
		});
	}
	return lines.join("\n");
}

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

function wireJson(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const json = JSON.stringify(value);
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

function prettyJson(json: string): string {
	try {
		return pretty(JSON.parse(json));
	} catch {
		return json;
	}
}

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

function pushFenced(lines: string[], text: string, language = ""): void {
	const longest = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longest + 1));
	lines.push("", fence + language, text, fence, "");
}

function isPureTextBlock(value: unknown): value is SystemTextBlock {
	if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") return false;
	return Object.keys(value).every((key) => key === "type" || key === "text" || key === "cache_control");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
