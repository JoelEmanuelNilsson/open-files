import { type ContextEvent, type ContextUsage, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";

import { contextOnlyItems, type InitialSnapshot, type InjectionItem } from "./injection-snapshot.ts";
import { estimateCharTokens } from "./system-prompt-measure.ts";

/** How an invisible reasoning-token estimate was derived without retaining raw signature bytes. */
export interface InvisibleReasoningEstimate {
	readonly tokens: number;
	readonly basis: "provider-reported" | "signature-proxy";
	readonly encoded: boolean;
}

/** One estimated usage category, optionally with a constituent breakdown. */
export interface UsageCategory {
	readonly id: string;
	readonly label: string;
	readonly tokens: number;
	readonly children?: readonly UsageCategory[];
	readonly entries?: readonly UsagePreviewEntry[];
}

/** One content entry shown in a Usage category preview. */
export interface UsagePreviewEntry {
	readonly timestamp?: number;
	readonly breadcrumb: readonly string[];
	readonly tokens: number;
	readonly visibleTokens?: number;
	readonly invisibleReasoning?: InvisibleReasoningEstimate;
	readonly text: string;
}

/** Pi-reported usage; tokens/percent are omitted when unknown (e.g. right after compaction). */
export interface ReportedContextUsage {
	readonly tokens?: number;
	readonly contextWindow: number;
	readonly percent?: number;
}

/** On-demand estimated context composition presented by the Usage view. */
export interface ContextUsageSnapshot {
	readonly computedAt: Date;
	readonly modelLabel?: string;
	readonly reported?: ReportedContextUsage;
	readonly categories: readonly UsageCategory[];
	readonly estimatedTokens: number;
	readonly autoCompactReserveTokens?: number;
}

/** Everything computeContextUsage needs; messages must already be synthetic-filtered. */
export interface UsageInputs {
	snapshot: InitialSnapshot;
	messages: ContextEvent["messages"];
	reported?: ReportedContextUsage;
	modelLabel?: string;
	computedAt?: Date;
	autoCompactReserveTokens?: number;
}

export function computeContextUsage(inputs: UsageInputs): ContextUsageSnapshot {
	const categories = [
		...classifyPromptCategories(inputs.snapshot),
		...classifyMessages(inputs.messages, contextOnlyItems(inputs.snapshot)),
	].filter((category) => category.tokens > 0);
	return {
		computedAt: inputs.computedAt ?? new Date(),
		modelLabel: inputs.modelLabel,
		reported: inputs.reported,
		categories,
		estimatedTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
		autoCompactReserveTokens: inputs.autoCompactReserveTokens,
	};
}

export function collectPreviewEntries(category: UsageCategory): UsagePreviewEntry[] {
	const entries: UsagePreviewEntry[] = [];
	const visit = (node: UsageCategory): void => {
		entries.push(...(node.entries ?? []));
		for (const child of node.children ?? []) visit(child);
	};
	visit(category);
	if (entries.length > 1 && entries.every((entry) => entry.timestamp !== undefined)) {
		entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	}
	return entries;
}

/** Convert pi's nullable ContextUsage to the undefined-based model shape. */
export function toReportedUsage(usage: ContextUsage | undefined): ReportedContextUsage | undefined {
	if (usage === undefined) return undefined;
	return {
		tokens: usage.tokens ?? undefined,
		contextWindow: usage.contextWindow,
		percent: usage.percent ?? undefined,
	};
}

function classifyPromptCategories(snapshot: InitialSnapshot): UsageCategory[] {
	const systemPrompt: UsageCategory[] = [];
	const systemTools: UsageCategory[] = [];
	const customTools: UsageCategory[] = [];
	const mcpTools: UsageCategory[] = [];
	const contextFiles: UsageCategory[] = [];
	const skills: UsageCategory[] = [];
	for (const group of snapshot.groups) {
		for (const item of group.items) {
			switch (item.kind) {
				case "base-prompt":
				case "append-prompt":
				case "prompt-addition":
					systemPrompt.push(leafFromItem(item));
					break;
				case "tool":
					if (item.source.native) systemTools.push(...breakdownFromItem(item));
					else if (isMcpTool(item)) mcpTools.push(leafFromItem(item));
					else customTools.push(leafFromItem(item));
					break;
				case "context-file":
					contextFiles.push(leafFromItem(item));
					break;
				case "skills":
					skills.push(...breakdownFromItem(item));
					break;
				case "message":
					break;
			}
		}
	}
	return withoutEmpty([
		aggregate("system-prompt", "System Prompt", systemPrompt),
		aggregate("system-tools", "System Tools", systemTools),
		aggregate("custom-tools", "Custom Tools", customTools),
		aggregate("mcp-tools", "MCP Tools", mcpTools),
		aggregate("context-files", "Memory (AGENTS.md)", contextFiles),
		aggregate("skills", "Skills", skills),
	]);
}

function isMcpTool(item: InjectionItem): boolean {
	return /(^|[^a-z])mcp([^a-z]|$)/i.test(`${item.source.id} ${item.source.label}`);
}

function classifyMessages(
	messages: ContextEvent["messages"],
	contextOnly: readonly InjectionItem[],
): UsageCategory[] {
	const user: UsagePreviewEntry[] = [];
	const agentText: UsagePreviewEntry[] = [];
	const agentThinking: UsagePreviewEntry[] = [];
	const agentToolCalls: UsagePreviewEntry[] = [];
	const bashExecutions: UsagePreviewEntry[] = [];
	const compacted: UsagePreviewEntry[] = [];
	const toolResults = new Map<string, UsagePreviewEntry[]>();
	const customMessages = new Map<string, UsagePreviewEntry[]>();

	for (const item of contextOnly) {
		appendEntry(customMessages, item.source.label, {
			breadcrumb: [item.label],
			tokens: item.tokens,
			text: item.text,
		});
	}
	for (const message of messages) {
		switch (message.role) {
			case "user":
				user.push({
					timestamp: message.timestamp,
					breadcrumb: ["user"],
					tokens: estimateTokens(message),
					text: contentToText(message.content),
				});
				break;
			case "assistant": {
				const texts = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
				agentText.push(...blockEntries(message.timestamp, "text", texts));
				agentThinking.push(...thinkingEntries(message));
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const args = JSON.stringify(block.arguments);
					agentToolCalls.push({
						timestamp: message.timestamp,
						breadcrumb: ["assistant", block.name],
						tokens: estimateCharTokens(block.name.length + args.length),
						text: `${block.name}(${args})`,
					});
				}
				break;
			}
			case "toolResult":
				appendEntry(toolResults, message.toolName, {
					timestamp: message.timestamp,
					breadcrumb: [message.toolName],
					tokens: estimateTokens(message),
					text: contentToText(message.content),
				});
				break;
			case "custom":
				appendEntry(customMessages, message.customType, {
					timestamp: message.timestamp,
					breadcrumb: [message.customType],
					tokens: estimateTokens(message),
					text: contentToText(message.content),
				});
				break;
			case "bashExecution": {
				const tokens = transformedTokens(message);
				if (tokens !== undefined) {
					bashExecutions.push({
						timestamp: message.timestamp,
						breadcrumb: ["bash"],
						tokens,
						text: `$ ${message.command}\n${message.output}`,
					});
				}
				break;
			}
			case "branchSummary":
				compacted.push({
					timestamp: message.timestamp,
					breadcrumb: ["branch"],
					tokens: transformedTokens(message) ?? 0,
					text: message.summary,
				});
				break;
			case "compactionSummary":
				compacted.push({
					timestamp: message.timestamp,
					breadcrumb: ["compaction"],
					tokens: transformedTokens(message) ?? 0,
					text: message.summary,
				});
				break;
		}
	}

	const toolOutput = aggregate("tool-output", "Tool Output", withoutEmpty([
		...leavesFromMap("tool-result", toolResults),
		leaf("bash-executions", "Bash Executions", bashExecutions),
	]));
	return withoutEmpty([
		leaf("user-messages", "User Messages", user),
		leaf("agent-text-messages", "Agent Text Messages", agentText),
		leaf("agent-thinking-messages", "Agent Thinking Messages", agentThinking),
		leaf("agent-tool-call-messages", "Agent Tool Call Messages", agentToolCalls),
		toolOutput,
		aggregate("extension-messages", "Extensions", leavesFromMap("custom-message", customMessages)),
		leaf("compacted-data", "Compacted Data", compacted),
	]);
}

function leaf(id: string, label: string, entries: readonly UsagePreviewEntry[]): UsageCategory {
	return {
		id,
		label,
		tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
		entries,
	};
}

function leafFromItem(item: InjectionItem): UsageCategory {
	return {
		id: `item:${item.id}`,
		label: item.label,
		tokens: item.tokens,
		entries: [{ breadcrumb: [item.label], tokens: item.tokens, text: item.text }],
	};
}

function transformedTokens(message: ContextEvent["messages"][number]): number | undefined {
	const converted = convertToLlm([message])[0];
	return converted === undefined ? undefined : estimateTokens(converted);
}

type AssistantContextMessage = Extract<ContextEvent["messages"][number], { role: "assistant" }>;

function thinkingEntries(message: AssistantContextMessage): UsagePreviewEntry[] {
	const texts = message.content.flatMap((block) => (block.type === "thinking" ? [block.thinking] : []));
	const visibleTokens = estimateCharTokens(texts.reduce((sum, text) => sum + text.length, 0));
	const reportedTokens = reportedReasoningTokens(message);
	const countedTokens = Math.max(visibleTokens, reportedTokens ?? 0);
	const signatureChars = message.content.reduce((sum, block) => {
		if (block.type === "thinking") return sum + stringLength(block.thinkingSignature);
		if (block.type === "toolCall") return sum + stringLength(block.thoughtSignature);
		return sum;
	}, 0);
	const invisibleReasoning = createInvisibleReasoningEstimate(signatureChars, visibleTokens, reportedTokens);

	if (texts.length === 0) {
		if (countedTokens === 0 && invisibleReasoning === undefined) return [];
		return [{
			timestamp: message.timestamp,
			breadcrumb: ["assistant"],
			tokens: countedTokens,
			...(invisibleReasoning === undefined ? {} : { visibleTokens: 0, invisibleReasoning }),
			text: "",
		}];
	}

	const allocations = allocateTextTokens(texts);
	const entries = texts.map((text, index): UsagePreviewEntry => ({
		timestamp: message.timestamp,
		breadcrumb: texts.length > 1
			? ["assistant", `thinking ${index + 1}/${texts.length}`]
			: ["assistant"],
		tokens: allocations[index] ?? 0,
		text,
	}));
	const first = entries[0];
	if (first !== undefined) {
		const countedInvisibleTokens = countedTokens - visibleTokens;
		entries[0] = {
			...first,
			tokens: first.tokens + countedInvisibleTokens,
			...(invisibleReasoning === undefined
				? {}
				: { visibleTokens: first.tokens, invisibleReasoning }),
		};
	}
	return entries;
}

function createInvisibleReasoningEstimate(
	signatureChars: number,
	visibleTokens: number,
	reportedTokens: number | undefined,
): InvisibleReasoningEstimate | undefined {
	if (reportedTokens !== undefined) {
		const tokens = Math.max(0, reportedTokens - visibleTokens);
		if (tokens === 0) return undefined;
		return {
			tokens,
			basis: "provider-reported",
			encoded: signatureChars > 0,
		};
	}
	if (signatureChars === 0) return undefined;
	return {
		tokens: estimateCharTokens(signatureChars),
		basis: "signature-proxy",
		encoded: true,
	};
}

function reportedReasoningTokens(message: AssistantContextMessage): number | undefined {
	const usage: unknown = message.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	// SAFETY: usage is narrowed to a non-null object above; reasoning is re-checked as a number on the next line
	const reasoning = (usage as { reasoning?: unknown }).reasoning;
	return typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0
		? reasoning
		: undefined;
}

function allocateTextTokens(texts: readonly string[]): number[] {
	const allocations = texts.map((text) => Math.floor(text.length / 4));
	const target = estimateCharTokens(texts.reduce((sum, text) => sum + text.length, 0));
	let remainder = target - allocations.reduce((sum, tokens) => sum + tokens, 0);
	const rankedIndexes = texts
		.map((text, index) => ({ index, remainder: text.length % 4 }))
		.filter((candidate) => candidate.remainder > 0)
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (const candidate of rankedIndexes) {
		if (remainder === 0) break;
		allocations[candidate.index] = (allocations[candidate.index] ?? 0) + 1;
		remainder--;
	}
	return allocations;
}

function stringLength(value: unknown): number {
	return typeof value === "string" ? value.length : 0;
}

function blockEntries(timestamp: number, kind: string, texts: readonly string[]): UsagePreviewEntry[] {
	return texts.map((text, index) => ({
		timestamp,
		breadcrumb: texts.length > 1 ? ["assistant", `${kind} ${index + 1}/${texts.length}`] : ["assistant"],
		tokens: estimateCharTokens(text.length),
		text,
	}));
}

function contentToText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" && block.text !== undefined ? block.text : `[${block.type}]`))
		.join("\n");
}

function breakdownFromItem(item: InjectionItem): UsageCategory[] {
	if (item.children === undefined || item.children.length === 0) return [leafFromItem(item)];
	return item.children.map((child) => leafFromItem(child));
}

function aggregate(id: string, label: string, children: UsageCategory[]): UsageCategory | undefined {
	if (children.length === 0) return undefined;
	return {
		id,
		label,
		tokens: children.reduce((sum, child) => sum + child.tokens, 0),
		children: [...children].sort((a, b) => b.tokens - a.tokens),
	};
}

function withoutEmpty(categories: Array<UsageCategory | undefined>): UsageCategory[] {
	return categories.filter((category): category is UsageCategory => category !== undefined && category.tokens > 0);
}

function appendEntry(
	totals: Map<string, UsagePreviewEntry[]>,
	key: string,
	entry: UsagePreviewEntry,
): void {
	const entries = totals.get(key);
	if (entries === undefined) totals.set(key, [entry]);
	else entries.push(entry);
}

function leavesFromMap(idPrefix: string, totals: Map<string, UsagePreviewEntry[]>): UsageCategory[] {
	return [...totals.entries()].map(([label, entries]) => leaf(`${idPrefix}:${label}`, label, entries));
}
