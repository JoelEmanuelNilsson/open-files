/**
 * Claude Code's wire identity — every byte of an Anthropic OAuth request whose
 * job is to say *which client is speaking*, and nothing about what it says.
 * The prompt this harness sends is its own business and lives in
 * `owned-prompt.ts`; this module owns only the mimicry.
 *
 * The *structure* here is read from one Claude Code release and verified
 * against that release's binary by `test/smoke.mjs` — the binary, not
 * documentation and not a third-party adapter, is the oracle. Mirroring a copy
 * instead of the source is how the identity block came to be dropped for a
 * week; when Claude Code changes the structure, the suite fails and a human
 * re-reads the binary.
 *
 * The version *number* is not part of that structure and is not pinned: it is
 * read off the installed binary at load, so it cannot fall behind the machine
 * it runs on.
 *
 * Minified identifiers are named below only to say where a fact was read.
 * Claude Code's bundler regenerates them on every release, so none of them is
 * load-bearing: `test/smoke.mjs` matches the binary on shape — literal values,
 * argument order, field order — with every name a wildcard.
 *
 * The wire shape, as `strings` reads it out of 2.1.276 (verified 2026-09-18):
 *
 *   system: [ attribution , identity , ...prompt ]
 *
 * plus one block of this harness's own after the prompt, carrying the cwd and
 * no `cache_control`, so it sits outside the cached tools+system prefix
 * (`lib/owned-prompt.ts`).
 *
 *   headers: user-agent: claude-cli/<version>, x-app: cli,
 *            X-Claude-Code-Session-Id: <uuid>,
 *            x-claude-code-agent-id / -parent-agent-id  (subagents only)
 *
 * Two invariants hold by construction:
 *
 *   - **Malformed ids cannot reach the wire.** `cc_prev_req` and
 *     `cc_prompt_id` are re-validated here against Claude Code's own regexes;
 *     a value that fails is dropped, exactly as upstream drops it.
 *   - **Subagent facts are all-or-nothing.** Real Claude Code never sends
 *     `cc_is_subagent=true` without the agent-id headers, so `SubagentIdentity`
 *     carries both ids or does not exist, and callers that cannot supply both
 *     get a main-session request.
 *
 * `cc_workload` is deliberately never emitted: upstream reads it from an
 * AsyncLocalStorage store populated only for cron/background workloads, so an
 * interactive session omits it too.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TextBlock } from "./wire-dump.ts";

/**
 * The release the wire structure below was read from — verified against
 * 2.1.276 on 2026-09-18. Used as the version only when no installed binary can
 * be found.
 */
export const LAST_VERIFIED_VERSION = "2.1.276";

/** Where the installer leaves Claude Code: a link to a version-named binary. */
const CLAUDE_LINK = ".local/bin/claude";

/** A released version, as the binary's own file name spells it. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function installedVersion(): string {
	try {
		const name = basename(realpathSync(join(homedir(), CLAUDE_LINK)));
		return VERSION_PATTERN.test(name) ? name : LAST_VERIFIED_VERSION;
	} catch {
		return LAST_VERIFIED_VERSION;
	}
}

/**
 * The Claude Code release this harness presents itself as: the installed one.
 * Resolved once at load — this sits on the session startup path — and feeds
 * both the attribution version hash and the user-agent, so the client can
 * never claim two versions of itself in one request.
 */
export const CLAUDE_CODE_VERSION = installedVersion();

/** Salt for the attribution version hash. */
const BILLING_SALT = "59cf53e54c78";
/** Fixed first-party billing marker (`E` in `tNt`). */
const BILLING_CCH = "00000";
/** `CLAUDE_CODE_ENTRYPOINT`'s value for a terminal session. */
const ENTRYPOINT = "cli";

/** The identity block, second in the system array on every OAuth request. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * `FN()`'s value for a plain CLI session with no agent-SDK wrapper. The
 * parenthesised suffix is upstream's, and its contents are the entrypoint
 * plus the agent-SDK/client-app/workload facts a terminal session has none of.
 */
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, ${ENTRYPOINT})`;

/** Marks the attribution block wherever a system array has to be re-read. */
export const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";

/**
 * Claude Code's canonical tool casing. pi-ai renames every tool whose name
 * matches one of these case-insensitively (`toClaudeCodeName`, applied under
 * `isOAuthToken` in its `api/anthropic-messages.js`), so on an Anthropic OAuth
 * request the model is offered `Read`, never `read`. Owned here so the prompt
 * can name a tool the way the request will; `test/smoke.mjs` pins the list
 * against that file.
 */
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

/** Upstream's `/^req_[A-Za-z0-9_-]{1,36}$/`. */
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,36}$/;
/** Upstream's uuid check, same case-insensitivity. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upstream's `/^[a-z][a-z_]{0,31}$/` on the turn origin. */
const TURN_ORIGIN_PATTERN = /^[a-z][a-z_]{0,31}$/;

/**
 * A subagent turn's two ids. Constructed only through
 * {@link subagentIdentity}, so an instance is proof that both are well-formed.
 */
export interface SubagentIdentity {
	readonly agentId: string;
	readonly parentAgentId: string;
}

/** What one request knows about itself when the attribution line is built. */
export interface AttributionFacts {
	/** The first user message's text; the version hash samples it. */
	readonly firstUserText: string;
	/**
	 * Whether the request goes to first-party api.anthropic.com. Upstream
	 * (`sF()`) gates `cch`, `cc_prev_req` and `cc_prompt_id` on this.
	 */
	readonly firstParty: boolean;
	/** Present only on a subagent's own turns. */
	readonly subagent?: SubagentIdentity;
	/** `request-id` of this session's previous response, if there was one. */
	readonly previousRequestId?: string;
	/** Groups every request caused by one user prompt. */
	readonly promptId?: string;
	/**
	 * What started this turn, in upstream's vocabulary (`human`,
	 * `auto_continuation`, `scheduled`, `peer`, `task_notification`). Added by
	 * 2.1.277. Absent is a line Claude Code also produces, so a turn whose origin
	 * this harness cannot name says nothing rather than claiming one.
	 */
	readonly turnOrigin?: string;
}

/**
 * The attribution block: field order, spacing and gating copied from `tNt`.
 * Ill-formed ids are dropped rather than sent, so the line is always a line
 * Claude Code itself could have produced.
 */
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
	return `${ATTRIBUTION_PREFIX} cc_version=${version}; cc_entrypoint=${ENTRYPOINT};${cch}${subagent}${previous}${prompt}${origin}`;
}

/**
 * The whole `system` array of an Anthropic OAuth request: attribution,
 * identity, prompt, cwd, in that order, as a quadruple.
 *
 * This is the only way a system array is built for such a request, and the
 * only reason the invariant is not one more thing to remember. Two blocks
 * ensured in front of whatever pi happened to send was the old shape, and it
 * had a branch — the branch that let this client claim to be Claude Code
 * while carrying another product's prompt, which the provider refuses as a
 * third-party app. Here there is no array to ensure anything in front of:
 * the caller supplies the prompt and the cwd block, and gets four.
 *
 * Pure string building. It makes no syscall and cannot throw, which matters
 * more than it looks: pi swallows a handler's exception and sends the payload
 * it already had (`dist/core/extensions/runner.js`), so anything that can
 * throw between here and the return is a request that leaves as pi.
 */
export function claudeCodeSystem(facts: AttributionFacts, prompt: TextBlock, cwd: TextBlock): [TextBlock, TextBlock, TextBlock, TextBlock] {
	return [{ type: "text", text: buildAttributionHeader(facts) }, { type: "text", text: CLAUDE_CODE_IDENTITY }, prompt, cwd];
}

/**
 * The headers Claude Code sends that pi-ai does not, plus the user-agent
 * override that keeps the client's version claim single-valued. Returned for
 * merging into pi's per-request header bag, where request-level values win
 * over pi-ai's client defaults regardless of header casing.
 */
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

/**
 * A subagent's identity, or `undefined` when either id is missing or
 * malformed — which keeps a half-declared subagent unrepresentable.
 */
export function subagentIdentity(agentId: string | undefined, parentAgentId: string | undefined): SubagentIdentity | undefined {
	if (agentId === undefined || parentAgentId === undefined) return undefined;
	if (!UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(parentAgentId)) return undefined;
	return { agentId, parentAgentId };
}

/**
 * The session id pi records for a parent session, read out of the session file
 * path stored in a child session's header. `undefined` when the path carries
 * no id, which collapses to "not a subagent" at {@link subagentIdentity}.
 */
export function sessionIdFromPath(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^/]*$/i.exec(path);
	return match?.[1];
}

/** A fresh `cc_prompt_id`. One per user prompt, as upstream. */
export function newPromptId(): string {
	return randomUUID();
}

/**
 * The text the version hash samples, read exactly as upstream's `Nun` reads
 * it: the first user message, and for block content its **first** text block
 * rather than all of them joined.
 */
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

/**
 * Whether a request is first-party, by upstream's rule (`sF()` + `zv()`): no
 * base-url override, or one pointing at api.anthropic.com.
 */
export function isFirstParty(baseUrl: string | undefined): boolean {
	if (baseUrl === undefined || baseUrl === "") return true;
	try {
		return new URL(baseUrl).host === "api.anthropic.com";
	} catch {
		return false;
	}
}

/** Characters 4, 7 and 20 of the first user message, salted and hashed. */
function versionHash(firstUserText: string): string {
	const sampled = [4, 7, 20].map((index) => firstUserText[index] || "0").join("");
	return createHash("sha256").update(`${BILLING_SALT}${sampled}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
