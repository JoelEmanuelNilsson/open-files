/**
 * The words on the five agent tools — descriptions, parameter descriptions,
 * and the two refusals. Ruled in `.scratch/orchestration/issues/12`, then
 * cut to what changes behaviour.
 *
 * Claude Code's tool names and its opening sentence, ladder and policy lines,
 * because Claude models are trained on them. Everything else is ours: the
 * delivery rule (ticket 09), `name` as a parameter, `TaskOutput` as the
 * explicit wait, the type list rendered with `(model, thinking)`, and no
 * sentence about cross-session, teams or remote sessions — there is one
 * process here and every agent in it is ours.
 *
 * Every rule is stated once, on the tool where the seat acts on it: the
 * delegation rule (when to read or edit yourself vs. brief an agent) is on
 * `Agent`, resuming a finished agent is on `SendMessage`, "don't poll" is on
 * `ListAgents`. No rule names a tool the reading seat might not carry —
 * `edit`/`write` stand on worker seats that have no `Agent`, so they carry
 * no delegation text.
 *
 * This text sits in the cached prefix of every seat that carries these tools,
 * so it changes only in a commit that also updates the pins in
 * `test/agent-engine.mjs` and `test/agent-doctrine.mjs`.
 */

import { AGENT_THINKING_LEVEL_LIST, AGENT_TYPE_LIST_OPEN, type AgentType, renderAgentTypeList } from "./agent-types.ts";

/** The type a spawn with no `subagent_type` gets — C12's "one job, one result". */
export const DEFAULT_AGENT_TYPE = "worker";

/** The one type whose results batch (ticket 09): explorer output is reading material, not a decision. */
export const EXPLORE_AGENT_TYPE = "explore";

/** The most expensive seat there is: Opus at max reasoning, and the main thread's alone. */
export const ADVISOR_AGENT_TYPE = "advisor";

/** Ruled refusal for a child seat reaching for the advisor. */
export const ADVISOR_MAIN_THREAD_ONLY = `Only the main thread may spawn an ${ADVISOR_AGENT_TYPE}: it is Opus at max reasoning, for the hardest questions Joel's seat faces. Report what you are stuck on and let the seat above you decide.`;

/** The tool names, Claude Code's (C9 as amended by ticket 12). */
export const AGENT_TOOL_NAMES = {
	AGENT: "Agent",
	SEND_MESSAGE: "SendMessage",
	LIST_AGENTS: "ListAgents",
	TASK_OUTPUT: "TaskOutput",
	TASK_STOP: "TaskStop",
} as const;

/**
 * The engine tools that block on another session. The watchdog exempts them
 * (the child runs its own clock) and `session-mode` keeps pinging the cache
 * through them (ticket 10: a wait must not let the desk go cold).
 */
export const AGENT_WAIT_TOOL_NAMES: readonly string[] = [AGENT_TOOL_NAMES.AGENT, AGENT_TOOL_NAMES.TASK_OUTPUT];

/** Map C5: children may nest this deep; a seat at this depth cannot spawn. */
export const AGENT_DEPTH_CAP = 4;

/** Ruled error text (ticket 12) for a spawn from a seat at the depth cap. */
export const DEPTH_LIMIT_ERROR = `Agent depth limit (${AGENT_DEPTH_CAP}) reached. Do the task yourself.`;

/** A level outside `AGENT_THINKING_LEVELS` is an error, not a clamp; a real level the model lacks is clamped at spawn. */
export function thinkingLevelError(asked: string): string {
	return `Thinking level "${asked}" does not exist. Only ${AGENT_THINKING_LEVEL_LIST} do.`;
}

/**
 * Ticket 09's delivery rule, in place of Claude Code's "runs in background,
 * you'll be notified" sentence: results are pushed, in full, so there is
 * nothing to fetch; explorers batch; `TaskOutput` is only for blocking.
 */
export const DELIVERY_PARAGRAPH =
	"Agents run in the background and deliver their results to you in full, unasked — a worker or a lead the moment it lands, explorers together once the last of them has landed. Never fetch a delivered result; `TaskOutput` is only for blocking on an agent you need before you can continue.";

/**
 * The line every delivered result closes with (ticket 09's delivery format).
 * A seat told only "here is a result" narrates it back; this says what to do
 * with it, including that doing nothing is an answer.
 */
export const DELIVERED_RESULT_INSTRUCTION =
	"Act on this or stop. Don't summarise it back, don't re-read what the child read, don't re-verify what it reports as verified. Ending your turn silently is allowed and expected.";

/**
 * The `Agent` description: the ladder, the delegation and delivery rules,
 * the policy lines, then the type list rendered from disk (C21). One
 * function, so the listing can never drift from what is loadable.
 *
 * `workflows` is whether this seat carries the `Workflow` tool (its launch
 * answer, `lib/tool-policy.ts`). A seat without it is never told the rung: a
 * ladder that names a tool the seat has not got costs a turn to discover.
 */
export function agentToolDescription(types: readonly AgentType[], workflows: boolean): string {
	const workflowRung = workflows ? "the same job on many things — a `Workflow`; " : "";
	return `Launch a new agent to handle complex, multi-step tasks. Every agent starts fresh: it reads its brief, not your conversation.

## When to use

Take the first rung that fits: a few edits or one lookup — do it yourself; one job with every follow-up step written into its brief — one worker; an answer you need before you can continue — one worker, then \`TaskOutput\`; several independent jobs — start them in one message; ${workflowRung}several dependent steps while you're away — a lead.

${DELEGATION_LINE} ${SPAWN_PERMISSION_LINE}

${DELIVERY_PARAGRAPH} Never fabricate or predict a pending agent's results; if the user asks before it arrives, say it's still running.

- The agent's final report is not shown to the user — relay what matters.
- Once you've delegated, don't also do it yourself — wait for the result, and don't peek at a running agent's transcript.
- To continue a finished agent's job, \`SendMessage\` it: it keeps its context; a new \`Agent\` starts fresh.
- A worker or an explorer cannot spawn, message or stop agents; a lead can.

${renderAgentTypeList(types)}`;
}

/**
 * The reason the ladder exists, stated once: context is append-only, so what
 * an agent reads or runs is what this conversation never has to hold. Covers
 * ticket 29 §3's edit/write rule (many edits, or edits needing reads or test
 * runs around them, go to a worker) without a second copy on `edit`/`write`.
 */
export const DELEGATION_LINE =
	"Everything you read and every test output you see stays in this conversation forever. Delegate bulk reading and any edit job that needs files read or tests run around it; keep only the conclusion. For one fact in a file you know, search directly.";

/**
 * Codex CLI's loophole-closer, verbatim in substance (`multi_agents_spec.rs:697`,
 * report 66): asking for depth is not asking for a tree. Without it, "research
 * this thoroughly" reads as authorization to fan out, which is how a seat that
 * was told to do the work itself ends up with children.
 */
export const SPAWN_PERMISSION_LINE =
	"Requests for depth, thoroughness, research, investigation or detailed analysis do not count as permission to spawn.";

/**
 * The lineup, stated once where the choice is made — on the parameter. The
 * type list carries each type's default `(model, thinking)`, so overriding
 * is the exception and the one exception is the whole rule: down to `luna`
 * when no judgment is needed.
 */
export const AGENT_MODEL_RULE = `Overrides the type's model. luna — routine, repetitive work and read-only search: scripts, moves, mechanical refactors, finding where things are. opus — everything else: all coding, general work, and the hardest design and architecture questions. It is the strongest model there is.`;

/**
 * The level is a separate axis from the model: any seat, any type, any level.
 * The enum carries the valid set; the prose says only when to move off the
 * type's default.
 */
export const AGENT_THINKING_RULE = "Overrides the type's reasoning level. Raise it for hard judgment or a job that must not be wrong (max is the most); lower it for routine work.";

/**
 * Parameter descriptions for `Agent`. `description` is what the dock and the
 * rows show for the task. `subagent_type` is an enum in the schema (the names
 * on disk), so the valid set is not repeated in prose.
 */
export const AGENT_PARAMS = {
	description: "A short (3-5 word) description of the task",
	prompt: "The task for the agent to perform.",
	subagent_type: `The agent type. Default: ${DEFAULT_AGENT_TYPE}.`,
	name: "Name to address the agent by (SendMessage, TaskOutput, TaskStop). Reusing a name starts a new agent under it; the latest wins. Default: the type plus a number.",
	model: AGENT_MODEL_RULE,
	thinking: AGENT_THINKING_RULE,
	isolation: '"worktree": the agent works in its own git worktree on branch agent/<name>; you merge the branch afterwards.',
	max_turns: "Turn cap. At the cap the agent is told to wrap up, then stopped.",
} as const;

/**
 * The two model families a seat may be put on: Opus for judgment, Luna for
 * everything that needs none. Each alias resolves to the newest model of that
 * family on any provider (`lib/model-family.ts`).
 */
export const AGENT_MODEL_ALIASES = ["opus", "luna"] as const;

/** `SendMessage`: the one channel to an agent, and how a finished agent is resumed. */
export const SEND_MESSAGE_DESCRIPTION = `Send a message to an agent by name. Your plain text output is not visible to agents; this tool is the only channel. A running agent reads it at its next step (\`interrupt: true\` aborts its current tool first). A finished agent resumes with its context intact and reports again when done. Replies come to you unasked. When relaying a message to the user, don't quote it — it's already rendered.`;

export const SEND_MESSAGE_PARAMS = {
	to: "The agent's name, exactly as ListAgents prints it",
	message: "Plain text. Make the first line a self-contained sentence saying what this is about — not a greeting, preamble, or bare @-mention.",
	interrupt: "Abort the agent's current tool call before delivering; otherwise the message waits for its next step.",
} as const;

/** `ListAgents`: the address book, and the one place the no-polling rule lives. No parameters. */
export const LIST_AGENTS_DESCRIPTION = `Lists the agents this session started, live and finished: name, type, status, age, and a one-line last result. Names are the address for SendMessage, TaskOutput and TaskStop. Not for polling — results are delivered to you unasked; to wait on one, use \`TaskOutput\`.`;

/** Default and ceiling for a `TaskOutput` wait, ticket 12. */
export const TASK_OUTPUT_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const TASK_OUTPUT_MAX_TIMEOUT_MS = 2 * 60 * 60_000;

/** `TaskOutput`: the explicit wait — how a seat blocks on a result it needs before it can continue (ticket 12). */
export const TASK_OUTPUT_DESCRIPTION = `Waits for agents and returns their full final replies, each once — a reply you have already read is not returned again. Returns early ("interrupted by Joel") if Joel types; the agents keep running and their results are delivered when they land.`;

export const TASK_OUTPUT_PARAMS = {
	names: "Agents to wait for. Omitted: every agent you started with an unread result.",
	block: "false: return current status without waiting.",
	timeout: "Max wait in ms.",
	transcript: "Also return each agent's conversation (user, assistant and tool-call lines).",
} as const;

/** `TaskStop`: one sentence; the name is the whole interface. */
export const TASK_STOP_DESCRIPTION = `Stops a running agent by name, and any agents it started. The result it produced so far is kept.`;

export const TASK_STOP_PARAMS = {
	name: "The agent to stop.",
} as const;

/** Where the rendered type list starts inside the `Agent` description, for tests and the `/agents` view. */
export function typeListOffset(description: string): number {
	return description.indexOf(AGENT_TYPE_LIST_OPEN);
}
