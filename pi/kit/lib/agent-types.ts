/**
 * Agent types on disk (`~/.pi/agent/agents/*.md`, map C21): one file per
 * type, YAML-ish frontmatter plus a body that is the type's own system prompt.
 *
 * A type sets the child's model, thinking level, prompt body and a routing
 * description — never a tool list (a `tools:` key is read and ignored; which
 * tools a seat carries is `lib/tool-policy.ts`'s answer). The list is rendered into the
 * `Agent` tool description once, at session start, in Claude Code's registry
 * format with `(model, thinking)` where Claude Code prints `(Tools: …)`.
 *
 * Frontmatter keys read: `name`, `description`, `model`, `thinking` (pi's
 * word; Claude Code's `effort` is accepted as the same key), `enabled`. A file
 * with `enabled: false` disables the type — the vendor's convention for
 * switching a built-in off, kept so `Plan.md` keeps working. Comments (`#`),
 * quoted scalars and `>-` / `|` block scalars are the whole YAML subset; the
 * files are hand-written and small, and a real YAML parser would be a
 * dependency for three keys.
 *
 * The body is the prompt exactly as written, trimmed. A type with no body
 * inherits its parent's owned prompt bytes (C10) — the engine decides that,
 * not this module; here an empty body is just an empty string.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The thinking levels a seat may be asked to run at, low to max — Claude
 * Code's effort levels plus pi's `xhigh`, which Opus 4.7+ and Luna carry
 * natively. Any seat may ask for any of them, per spawn or in its type file.
 * What a model cannot run is its own limit, not a policy: the spawn clamps the
 * level to the model's level map (`clampThinkingLevel`), the way pi does for
 * the main seat, and records the level the child actually runs at.
 */
export const AGENT_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

/**
 * What a child seat runs at when neither its type nor the spawn named a level.
 *
 * A constant, deliberately not the parent's level: a child's level is a
 * property of the fleet, not of whatever the main seat was switched to. Joel's
 * default is `high` everywhere. Thinking is output, and output is what the
 * subscription meter charges for, so this constant is the dial for fleet
 * spend. A child that needs another level says so, per spawn or in its type file.
 */
export const CHILD_THINKING: AgentThinkingLevel = "high";

/** Whether a level is one of the ones that exist. */
export function isAgentThinkingLevel(level: string): level is AgentThinkingLevel {
	return (AGENT_THINKING_LEVELS as readonly string[]).includes(level);
}

/** The levels that exist, quoted and listed for refusal text. */
export const AGENT_THINKING_LEVEL_LIST = AGENT_THINKING_LEVELS.map((level) => `"${level}"`).join(", ");

/** One agent type as read off disk. */
export interface AgentType {
	readonly name: string;
	/** The routing rule the orchestrator reads to pick this type. */
	readonly description: string;
	/** Model alias or id (`luna`, `openai-codex/gpt-6-luna`); undefined inherits the parent's. */
	readonly model: string | undefined;
	/** Thinking level; undefined takes pi's default for the model. */
	readonly thinking: AgentThinkingLevel | undefined;
	/** The type's own system prompt; empty when the file has no body. */
	readonly prompt: string;
	/** Where it was read from, for diagnostics. */
	readonly source: string;
}

/** The file did not yield a usable type, and why. */
export interface AgentTypeProblem {
	readonly source: string;
	readonly reason: string;
}

/**
 * Parse one agent type file. Returns `undefined` for a file that is disabled
 * (`enabled: false`); a problem for a file with no frontmatter or no name.
 */
export function parseAgentTypeFile(text: string, source: string): AgentType | AgentTypeProblem | undefined {
	const split = splitFrontmatter(text);
	if (split === undefined) return { source, reason: "no frontmatter block" };
	const fields = parseFrontmatterFields(split.frontmatter);
	if (fields.get("enabled") === "false") return undefined;
	const name = fields.get("name")?.trim();
	if (!name) return { source, reason: "frontmatter has no name" };
	const thinkingRaw = (fields.get("thinking") ?? fields.get("effort"))?.trim();
	if (thinkingRaw !== undefined && thinkingRaw !== "" && !isAgentThinkingLevel(thinkingRaw)) return { source, reason: `thinking: "${thinkingRaw}" — only ${AGENT_THINKING_LEVEL_LIST} exist` };
	const thinking = thinkingRaw !== undefined && isAgentThinkingLevel(thinkingRaw) ? thinkingRaw : undefined;
	const model = fields.get("model")?.trim();
	return {
		name,
		description: (fields.get("description") ?? "").trim(),
		model: model ? model : undefined,
		thinking,
		prompt: split.body.trim(),
		source,
	};
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

/**
 * The type list in Claude Code's registry format, `(model, thinking)` in place
 * of `(Tools: …)`. A type that inherits prints `parent's model`; a type with
 * no thinking level prints `default thinking`. Claude Code's closing line
 * ("send them in a single message") is not appended: the ladder's
 * "several independent jobs — start them in one message" already says it.
 */
export function renderAgentTypeList(types: readonly AgentType[]): string {
	const rows = types.map(
		(type) => `- ${type.name}: ${type.description} (${type.model ?? "parent's model"}, ${type.thinking ?? "default thinking"})`,
	);
	return `${AGENT_TYPE_LIST_OPEN}\n${rows.join("\n")}`;
}

// ---- the YAML subset --------------------------------------------------------

function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (match === null) return undefined;
	return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

/**
 * `key: value` lines, `#` comments, quoted scalars, and `>-`/`>`/`|`/`|-`
 * block scalars whose continuation lines are indented. Unknown constructs are
 * kept as raw text under their key rather than rejected.
 */
function parseFrontmatterFields(frontmatter: string): Map<string, string> {
	const fields = new Map<string, string>();
	const lines = frontmatter.split(/\r?\n/);
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		index++;
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const keyMatch = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
		if (keyMatch === null) continue;
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
	return fields;
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}
