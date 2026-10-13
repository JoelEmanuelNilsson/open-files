import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_THINKING_LEVELS = ["medium", "high", "xhigh"] as const;

/** A level a seat may ask for. */
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export const CHILD_THINKING: AgentThinkingLevel = "medium";

/** Whether a level is one a seat may ask for. */
export function isAgentThinkingLevel(level: string): level is AgentThinkingLevel {
	// SAFETY: the readonly tuple is widened to string[] to test an arbitrary string for membership
	return (AGENT_THINKING_LEVELS as readonly string[]).includes(level);
}

/** The offered levels, quoted and listed for refusal text. */
export const AGENT_THINKING_LEVEL_LIST = AGENT_THINKING_LEVELS.map((level) => `"${level}"`).join(", ");

/** One entry of a `tools` list: a tool name, with the agent types an `Agent(type, …)` entry limits it to. */
export interface AgentToolEntry {
	readonly name: string;
	readonly agentTypes: readonly string[] | undefined;
}

/** One agent type as read off disk. */
export interface AgentType {
	readonly name: string;
	readonly description: string;
	readonly model: string | undefined;
	readonly thinking: AgentThinkingLevel | undefined;
	readonly tools: readonly AgentToolEntry[] | undefined;
	readonly compactAt: number | undefined;
	readonly context: "none" | "full";
	readonly delivery: "batch" | "single";
	readonly prompt: string;
	readonly source: string;
}

/** The file did not yield a usable type, and why. */
export interface AgentTypeProblem {
	readonly source: string;
	readonly reason: string;
}

export function parseAgentTypeFile(text: string, source: string): AgentType | AgentTypeProblem | undefined {
	const split = splitFrontmatter(text);
	if (split === undefined) return { source, reason: "no frontmatter block" };
	const { fields, unreadable } = parseFrontmatterFields(split.frontmatter);
	if (fields.get("enabled") === "false") return undefined;
	const name = fields.get("name")?.trim();
	if (!name) return { source, reason: "frontmatter has no name" };
	if (unreadable.length > 0) return { source, reason: `frontmatter line not "key: value": ${unreadable.map((line) => `"${line.trim()}"`).join(", ")}` };
	const thinkingRaw = (fields.get("thinking") ?? fields.get("effort"))?.trim();
	if (thinkingRaw !== undefined && thinkingRaw !== "" && !isAgentThinkingLevel(thinkingRaw)) return { source, reason: `thinking: "${thinkingRaw}" — only ${AGENT_THINKING_LEVEL_LIST} exist` };
	const thinking = thinkingRaw !== undefined && isAgentThinkingLevel(thinkingRaw) ? thinkingRaw : undefined;
	const model = fields.get("model")?.trim();
	const compactAtRaw = fields.get("compact_at")?.trim();
	const compactAt = compactAtRaw ? Number(compactAtRaw) : undefined;
	if (compactAt !== undefined && !(Number.isInteger(compactAt) && compactAt > 0)) return { source, reason: `compact_at: "${compactAtRaw}" — a positive number of tokens` };
	const context = fields.get("context")?.trim() || "full";
	if (context !== "none" && context !== "full") return { source, reason: `context: "${context}" — only "none" and "full" exist` };
	const delivery = fields.get("delivery")?.trim() || "single";
	if (delivery !== "batch" && delivery !== "single") return { source, reason: `delivery: "${delivery}" — only "batch" and "single" exist` };
	const toolsRaw = fields.get("tools");
	const tools = toolsRaw === undefined ? undefined : parseToolEntries(toolsRaw);
	if (tools !== undefined && "reason" in tools) return { source, reason: tools.reason };
	return {
		name,
		description: (fields.get("description") ?? "").trim(),
		model: model ? model : undefined,
		thinking,
		tools,
		compactAt,
		context,
		delivery,
		prompt: split.body.trim(),
		source,
	};
}

function parseToolEntries(raw: string): AgentToolEntry[] | { readonly reason: string } {
	const entries: AgentToolEntry[] = [];
	for (const part of raw.split(/,(?![^()]*\))/)) {
		if (part.trim() === "") continue;
		const match = /^\s*([^\s(]+)\s*(?:\(([^)]*)\))?\s*$/.exec(part);
		if (match === null) return { reason: `tools: "${part.trim()}" — separate tool names with commas` };
		const agentTypes = match[2]?.split(",").map((type) => type.trim()).filter(Boolean);
		// SAFETY: match[1] is a required capture group of the regex, so it is always a string
		entries.push({ name: match[1] as string, agentTypes });
	}
	return entries;
}

/** Every enabled type in a directory, by name. A missing directory is an empty list. */
export function loadAgentTypes(dir: string): { types: AgentType[]; problems: AgentTypeProblem[] } {
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
	} catch {
		return { types: [], problems: [] };
	}
	const types: AgentType[] = [];
	const problems: AgentTypeProblem[] = [];
	for (const file of files) {
		const source = join(dir, file);
		let text: string;
		try {
			text = readFileSync(source, "utf8");
		} catch (error) {
			problems.push({ source, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		const parsed = parseAgentTypeFile(text, source);
		if (parsed === undefined) continue;
		if ("reason" in parsed) problems.push(parsed);
		else types.push(parsed);
	}
	return { types, problems };
}

/** Opens the rendered type list; the description builder and the tests key on it. */
export const AGENT_TYPE_LIST_OPEN = "Agent types:";

export function renderAgentTypeList(types: readonly AgentType[]): string {
	const rows = types.map(
		(type) => `- ${type.name}: ${type.description} (${type.model ?? "parent's model"}, ${type.thinking ?? "default thinking"})`,
	);
	return `${AGENT_TYPE_LIST_OPEN}\n${rows.join("\n")}`;
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (match === null) return undefined;
	return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

function parseFrontmatterFields(frontmatter: string): { fields: Map<string, string>; unreadable: string[] } {
	const fields = new Map<string, string>();
	const unreadable: string[] = [];
	const lines = frontmatter.split(/\r?\n/);
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		index++;
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const keyMatch = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
		if (keyMatch === null) {
			unreadable.push(line);
			continue;
		}
		const key = keyMatch[1] ?? "";
		const rest = (keyMatch[2] ?? "").trim();
		const blockMatch = /^([>|])([+-]?)$/.exec(rest);
		if (blockMatch !== null) {
			const block: string[] = [];
			while (index < lines.length) {
				const next = lines[index] ?? "";
				if (next.trim() !== "" && !/^\s/.test(next)) break;
				block.push(next.trim());
				index++;
			}
			while (block.length > 0 && block[block.length - 1] === "") block.pop();
			fields.set(key, blockMatch[1] === ">" ? block.join(" ") : block.join("\n"));
			continue;
		}
		fields.set(key, unquote(rest));
	}
	return { fields, unreadable };
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}
