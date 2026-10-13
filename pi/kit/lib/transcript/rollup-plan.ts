import { describeCallArgument } from "./call-argument.ts";
import { collapsible } from "./rollup-line.ts";
import type { HintHold } from "./hint-hold.ts";
import { transcriptPlannerState } from "./rollup-planner-state.ts";
import { skillReadLabel } from "./skill-read.ts";
import { argumentsStreaming } from "./streaming-arguments.ts";

export interface Group {
	ids: string[];
	tools: string[];
	subjects: (string | undefined)[];
	hints: (string | undefined)[];
	running: boolean;
	hint?: HintHold["hint"];
	key: string;
	startedAt?: number;
	expanded: boolean;
}

interface Block {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	partialJson?: string;
	partialArgs?: string;
	n?: string;
}

interface Message {
	role?: string;
	content?: Block[] | string;
	stopReason?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface Entry {
	type?: string;
	message?: Message;
}

const PRINTS = new Set(["compaction", "branch_summary", "custom", "custom_message"]);

function entryOf(value: unknown): Entry {
	// SAFETY: Entry has only optional fields, so any object satisfies it; non-objects become {}
	return (typeof value === "object" && value !== null ? value : {}) as Entry;
}

function subjectOf(block: Block, id: string): string | undefined {
	const args = argumentsOf(block);
	if (args === undefined) return undefined;
	// SAFETY: argumentsOf returned a non-null object; path is re-checked as a string
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" && path !== "" ? path : id;
}

function argumentsOf(block: Block): Record<string, unknown> | undefined {
	const args = block.arguments;
	if (typeof args !== "object" || args === null) return undefined;
	if (argumentsStreaming(block)) return undefined;
	// SAFETY: args was checked to be a non-null object above
	return args as Record<string, unknown>;
}

function hintFor(tool: string, block: Block): string | undefined {
	const args = argumentsOf(block);
	if (args === undefined) return undefined;
	const text = describeCallArgument(tool, args, process.cwd()).text;
	if (text === "") return undefined;
	return tool === "bash" || tool === "powershell" ? `$ ${text}` : text;
}

function blocksOf(message: Message | undefined): Block[] {
	const content = message?.content;
	return Array.isArray(content) ? content : [];
}

function speaks(message: Message | undefined): boolean {
	return blocksOf(message).some((block) => block.type === "text" && (block.text ?? "").trim() !== "");
}

function outcomes(entries: readonly unknown[]): { answered: Set<string>; kept: Set<string> } {
	const answered = new Set<string>();
	const kept = new Set<string>();
	for (const [id, arrival] of transcriptPlannerState().arrivals) {
		answered.add(id);
		if (arrival.failed) kept.add(id);
	}
	for (const value of entries) {
		const entry = entryOf(value);
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "toolResult") {
			const id = message.toolCallId;
			if (typeof id !== "string") continue;
			answered.add(id);
			if (message.isError === true) kept.add(id);
			if (blocksOf(message).some((block) => block.type === "image")) kept.add(id);
			continue;
		}
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "aborted" && message.stopReason !== "error") continue;
		for (const block of blocksOf(message)) if (block.type === "toolCall" && typeof block.id === "string") kept.add(block.id);
	}
	return { answered, kept };
}

export function plan(entries: readonly unknown[], live = false): Group[] {
	const { answered, kept } = outcomes(entries);
	const groups: Group[] = [];
	let ids: string[] = [];
	let tools: string[] = [];
	let subjects: (string | undefined)[] = [];
	let hints: (string | undefined)[] = [];

	const flush = (trailing = false) => {
		if (ids.length > 0) groups.push({ ids, tools, subjects, hints, running: live && trailing, key: ids.join(" "), expanded: false });
		ids = [];
		tools = [];
		subjects = [];
		hints = [];
	};

	for (const value of entries) {
		const entry = entryOf(value);
		if (entry.type !== "message") {
			if (PRINTS.has(entry.type ?? "")) flush();
			continue;
		}
		const message = entry.message;
		if (message?.role === "toolResult") continue;
		if (message?.role !== "assistant") {
			flush();
			continue;
		}
		if (speaks(message)) flush();
		for (const block of blocksOf(message)) {
			if (block.type !== "toolCall") continue;
			const id = block.id;
			const tool = block.name;
			if (typeof id !== "string" || typeof tool !== "string") continue;
			if (!collapsible(tool) || kept.has(id) || skillReadLabel(tool, argumentsOf(block) ?? {}, process.cwd()) !== undefined) {
				flush();
				continue;
			}
			if (!answered.has(id) && !live) {
				flush();
				continue;
			}
			ids.push(id);
			tools.push(tool);
			subjects.push(subjectOf(block, id));
			hints.push(hintFor(tool, block));
		}
	}
	flush(true);
	return groups;
}
