import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const LAST_VERIFIED_VERSION = "2.1.284";

const CLAUDE_LINK = ".local/bin/claude";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function installedVersion(): string {
	try {
		const name = basename(realpathSync(join(homedir(), CLAUDE_LINK)));
		return VERSION_PATTERN.test(name) ? name : LAST_VERIFIED_VERSION;
	} catch {
		return LAST_VERIFIED_VERSION;
	}
}

export const CLAUDE_CODE_VERSION = installedVersion();

const BILLING_SALT = "59cf53e54c78";
const BILLING_CCH = "00000";
const ENTRYPOINT = "cli";

/** The identity block, second in the system array on every OAuth request. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, ${ENTRYPOINT})`;

/** Marks the attribution block wherever a system array has to be re-read. */
export const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";

export const CLAUDE_CODE_TOOL_NAMES = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
] as const;

const wireToolNames = new Map<string, string>(CLAUDE_CODE_TOOL_NAMES.map((name) => [name.toLowerCase(), name]));

/** The name an Anthropic OAuth request carries for one of this seat's tools. */
export function claudeCodeToolName(tool: string): string {
	return wireToolNames.get(tool.toLowerCase()) ?? tool;
}

/** Header names Claude Code sends and pi-ai does not. */
export const SESSION_ID_HEADER = "X-Claude-Code-Session-Id";
export const AGENT_ID_HEADER = "x-claude-code-agent-id";
export const PARENT_AGENT_ID_HEADER = "x-claude-code-parent-agent-id";

const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,36}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_ORIGIN_PATTERN = /^[a-z][a-z_]{0,31}$/;
const MAX_TURN_INDEX = 10_000_000;

export interface SubagentIdentity {
	readonly agentId: string;
	readonly parentAgentId: string;
}

/** One text block of an Anthropic request's `system` array. */
export interface SystemTextBlock {
	type: "text";
	text: string;
	cache_control?: Record<string, unknown>;
}

/** What one request knows about itself when the attribution line is built. */
export interface AttributionFacts {
	readonly firstUserText: string;
	readonly firstParty: boolean;
	readonly subagent?: SubagentIdentity;
	readonly previousRequestId?: string;
	readonly promptId?: string;
	readonly turnOrigin?: string;
	readonly turnPosition?: TurnPosition;
}

export interface TurnPosition {
	readonly promptIndex: number;
	readonly turnIndex: number;
}

export function buildAttributionHeader(facts: AttributionFacts): string {
	const version = `${CLAUDE_CODE_VERSION}.${versionHash(facts.firstUserText)}`;
	const cch = facts.firstParty ? ` cch=${BILLING_CCH};` : "";
	const subagent = facts.subagent ? " cc_is_subagent=true;" : "";
	const previous =
		facts.firstParty && facts.previousRequestId !== undefined && REQUEST_ID_PATTERN.test(facts.previousRequestId)
			? ` cc_prev_req=${facts.previousRequestId};`
			: "";
	const prompt =
		facts.firstParty && facts.promptId !== undefined && UUID_PATTERN.test(facts.promptId)
			? ` cc_prompt_id=${facts.promptId};`
			: "";
	const origin =
		facts.firstParty && facts.turnOrigin !== undefined && TURN_ORIGIN_PATTERN.test(facts.turnOrigin)
			? ` cc_turn_origin=${facts.turnOrigin};`
			: "";
	const position =
		facts.firstParty &&
		facts.turnPosition !== undefined &&
		isTurnIndex(facts.turnPosition.promptIndex, 0) &&
		isTurnIndex(facts.turnPosition.turnIndex, 1)
			? ` cc_prompt_index=${facts.turnPosition.promptIndex}; cc_turn_index=${facts.turnPosition.turnIndex};`
			: "";
	return `${ATTRIBUTION_PREFIX} cc_version=${version}; cc_entrypoint=${ENTRYPOINT};${cch}${subagent}${previous}${prompt}${origin}${position}`;
}

function isTurnIndex(value: number, min: number): boolean {
	return Number.isInteger(value) && value >= min && value <= MAX_TURN_INDEX;
}

export function claudeCodeSystem(facts: AttributionFacts, prompt: SystemTextBlock, cwd: SystemTextBlock): [SystemTextBlock, SystemTextBlock, SystemTextBlock, SystemTextBlock] {
	return [{ type: "text", text: buildAttributionHeader(facts) }, { type: "text", text: CLAUDE_CODE_IDENTITY }, prompt, cwd];
}

export function claudeCodeHeaders(session: { sessionId: string; subagent?: SubagentIdentity }): Record<string, string> {
	return {
		"user-agent": CLAUDE_CODE_USER_AGENT,
		[SESSION_ID_HEADER]: session.sessionId,
		...(session.subagent
			? {
					[AGENT_ID_HEADER]: session.subagent.agentId,
					[PARENT_AGENT_ID_HEADER]: session.subagent.parentAgentId,
				}
			: {}),
	};
}

export function subagentIdentity(agentId: string | undefined, parentAgentId: string | undefined): SubagentIdentity | undefined {
	if (agentId === undefined || parentAgentId === undefined) return undefined;
	if (!UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(parentAgentId)) return undefined;
	return { agentId, parentAgentId };
}

export function sessionIdFromPath(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^/]*$/i.exec(path);
	return match?.[1];
}

/** A fresh `cc_prompt_id`. One per user prompt, as upstream. */
export function newPromptId(): string {
	return randomUUID();
}

export function firstUserTextOf(messages: unknown): string {
	const list = Array.isArray(messages) ? messages : [];
	const first = list.find((message): message is Record<string, unknown> => isRecord(message) && message.role === "user");
	if (first === undefined) return "";
	const content = first.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const block = content.find(
		(item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string",
	);
	return block === undefined ? "" : String(block.text);
}

export function isFirstParty(baseUrl: string | undefined): boolean {
	if (baseUrl === undefined || baseUrl === "") return true;
	try {
		return new URL(baseUrl).host === "api.anthropic.com";
	} catch {
		return false;
	}
}

function versionHash(firstUserText: string): string {
	const sampled = [4, 7, 20].map((index) => firstUserText[index] || "0").join("");
	return createHash("sha256").update(`${BILLING_SALT}${sampled}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
