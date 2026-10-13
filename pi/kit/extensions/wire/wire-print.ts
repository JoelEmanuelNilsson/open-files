import { createHash } from "node:crypto";
import { ATTRIBUTION_PREFIX } from "../../lib/wire/claude-code.ts";

const contentOf = (value: unknown): string =>
	JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)) ?? "\u0000undefined";

const hash = (value: unknown): string =>
	createHash("sha256")
		.update(typeof value === "string" ? value : contentOf(value))
		.digest("hex")
		.slice(0, 8);

/** One content block, as much of it as can be recorded without recording it. */
export interface BlockPrint {
	type: string;
	chars: number;
	hash: string;
	keyed?: false;
	thinking?: { chars: number; hash: string };
	signature?: { chars: number; hash: string };
}

export interface MessagePrint {
	role: string;
	hash: string;
	blocks: BlockPrint[];
}

export interface ToolPrint {
	name: string;
	chars: number;
	hash: string;
}

export type ReasoningPrint = Record<string, string>;

/** Everything about a request that can decide a cache question, and nothing else. */
export interface WirePrint {
	system: BlockPrint[];
	tools: ToolPrint[];
	toolsHash: string;
	reasoning: ReasoningPrint;
	messages: MessagePrint[];
	breakpoints: string[];
	bytes: number;
}

export interface PriorPrint {
	system: readonly BlockPrint[];
	tools?: readonly ToolPrint[];
	reasoning?: ReasoningPrint;
	messages?: readonly MessagePrint[];
}

export type WireSection = "tools" | "system" | "messages";

export interface Divergence {
	section: WireSection;
	index: number;
	kind: "changed" | "added" | "removed";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function blockPrint(block: unknown): BlockPrint {
	if (!isRecord(block)) return { type: typeof block, chars: 0, hash: hash(block) };
	const type = typeof block.type === "string" ? block.type : "?";
	const print: BlockPrint = { type, chars: contentOf(block).length, hash: hash(block) };
	if (typeof block.text === "string" && block.text.startsWith(ATTRIBUTION_PREFIX)) print.keyed = false;
	if (type === "thinking" || type === "redacted_thinking") {
		const thinking = str(block.thinking ?? block.data);
		const signature = str(block.signature ?? block.data);
		print.thinking = { chars: thinking.length, hash: hash(thinking) };
		print.signature = { chars: signature.length, hash: hash(signature) };
	}
	return print;
}

function blocksOf(content: unknown): unknown[] {
	if (Array.isArray(content)) return content;
	if (content === undefined) return [];
	return [content];
}

function hasBreakpoint(value: unknown): boolean {
	return isRecord(value) && isRecord(value.cache_control);
}

const REASONING_FIELDS: ReadonlySet<string> = new Set(["thinking", "output_config"]);

function reasoningPrint(payload: Record<string, unknown>): ReasoningPrint {
	const leaves: ReasoningPrint = {};
	const walk = (path: string, value: unknown): void => {
		if (isRecord(value)) {
			for (const key of Object.keys(value).sort()) walk(`${path}.${key}`, value[key]);
			return;
		}
		if (value !== undefined) leaves[path] = JSON.stringify(value);
	};
	for (const field of [...REASONING_FIELDS].sort()) if (payload[field] !== undefined) walk(field, payload[field]);
	return leaves;
}

export function wirePrint(payload: unknown): WirePrint | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;

	const breakpoints: string[] = [];

	const systemBlocks = Array.isArray(payload.system) ? payload.system : [];
	const system = systemBlocks.map((block, index) => {
		if (hasBreakpoint(block)) breakpoints.push(`system[${index}]`);
		return blockPrint(block);
	});

	const toolList = Array.isArray(payload.tools) ? payload.tools : [];
	const tools = toolList.map((tool, index) => {
		if (hasBreakpoint(tool)) breakpoints.push(`tools[${index}]`);
		const json = contentOf(tool);
		return {
			name: isRecord(tool) && typeof tool.name === "string" ? tool.name : "?",
			chars: json.length,
			hash: hash(json),
		};
	});

	const messages = payload.messages.map((message, index) => {
		const record = isRecord(message) ? message : {};
		const blocks = blocksOf(record.content);
		blocks.forEach((block, blockIndex) => {
			if (hasBreakpoint(block)) breakpoints.push(`messages[${index}]/${blockIndex}`);
		});
		return {
			role: typeof record.role === "string" ? record.role : "?",
			hash: hash(message),
			blocks: blocks.map(blockPrint),
		};
	});

	return {
		system,
		tools,
		toolsHash: hash(tools.map((tool) => tool.hash).join(",")),
		reasoning: reasoningPrint(payload),
		messages,
		breakpoints,
		bytes: (JSON.stringify(payload) ?? "").length,
	};
}

function firstIn<T extends { hash: string; keyed?: false }>(
	previous: readonly T[],
	next: readonly T[],
	section: WireSection,
	appendIsFree: boolean,
): Divergence | undefined {
	const common = Math.min(previous.length, next.length);
	for (let index = 0; index < common; index++) {
		if (previous[index].keyed === false || next[index].keyed === false) continue;
		if (previous[index].hash !== next[index].hash) return { section, index, kind: "changed" };
	}
	if (next.length < previous.length) return { section, index: next.length, kind: "removed" };
	if (next.length > previous.length && !appendIsFree) return { section, index: previous.length, kind: "added" };
	return undefined;
}

export function firstDivergence(previous: PriorPrint, next: WirePrint): Divergence | undefined {
	return (
		(previous.tools && firstIn(previous.tools, next.tools, "tools", false)) ??
		firstIn(previous.system, next.system, "system", false) ??
		(previous.messages && firstIn(previous.messages, next.messages, "messages", true)) ??
		undefined
	);
}

/** The last system block carrying a breakpoint — the text every request of this session must repeat byte for byte. */
export function cachedSystemBlock(payload: unknown): { index: number; text: string } | undefined {
	const system = isRecord(payload) && Array.isArray(payload.system) ? payload.system : [];
	for (let index = system.length - 1; index >= 0; index--) {
		const block = system[index];
		if (hasBreakpoint(block) && isRecord(block) && typeof block.text === "string") return { index, text: block.text };
	}
	return undefined;
}
