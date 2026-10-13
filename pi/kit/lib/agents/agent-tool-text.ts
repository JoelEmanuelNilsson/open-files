import { Type } from "typebox";
import { AGENT_THINKING_LEVEL_LIST, AGENT_THINKING_LEVELS, type AgentType, renderAgentTypeList } from "./agent-type-files.ts";
import { REPLY_IDS } from "./reply-formats.ts";

/** The type a spawn with no `subagent_type` gets — C12's "one job, one result". */
export const DEFAULT_AGENT_TYPE = "worker";

/** The one type whose results batch (ticket 09): explorer output is reading material, not a decision. */
export const EXPLORE_AGENT_TYPE = "explore";

/** The tool names, Claude Code's (C9 as amended by ticket 12). */
export const AGENT_TOOL_NAMES = {
	AGENT: "Agent",
	SEND_MESSAGE: "SendMessage",
	LIST_AGENTS: "ListAgents",
	TASK_OUTPUT: "TaskOutput",
	TASK_STOP: "TaskStop",
} as const;

/** The tool a seat carries only when its launcher was told to give it one. */
export const WORKFLOW_TOOL_NAME = "Workflow";

/** The tool a workflow child returns its result through. */
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

/** The `details` of an `Agent`-family tool result; `agent-rows` reads it back (ticket 05 §6, the second contract). */
export interface AgentToolDetails {
	displayName: string;
	description: string;
	subagentType: string;
	toolUses: number;
	outputTokens: number;
	costUsd: number;
	status: string;
	agentId: string;
	name: string;
	error?: string;
}

export const AGENT_WAIT_TOOL_NAMES: readonly string[] = [AGENT_TOOL_NAMES.AGENT, AGENT_TOOL_NAMES.TASK_OUTPUT];

/** Map C5: children may nest this deep; a seat at this depth cannot spawn. */
export const AGENT_DEPTH_CAP = 4;

/** Ruled error text (ticket 12) for a spawn from a seat at the depth cap. */
export const DEPTH_LIMIT_ERROR = `Agent depth limit (${AGENT_DEPTH_CAP}) reached. Do the task yourself.`;

/** A level outside `AGENT_THINKING_LEVELS` is an error, not a clamp; a real level the model lacks is clamped at spawn. */
export function thinkingLevelError(asked: string): string {
	return `Thinking level "${asked}" does not exist. Only ${AGENT_THINKING_LEVEL_LIST} do.`;
}

function batchingTypeList(types: readonly Pick<AgentType, "name" | "delivery">[]): string | undefined {
	const batching = types.filter((type) => type.delivery === "batch").map((type) => type.name);
	if (batching.length === 0) return undefined;
	return batching.length === 1 ? batching[0] : `${batching.slice(0, -1).join(", ")} and ${batching.at(-1)}`;
}

export function deliveryParagraph(types: readonly Pick<AgentType, "name" | "delivery">[]): string {
	const batching = batchingTypeList(types);
	const together = batching === undefined ? "" : `, ${batching} agents together with the others of their type once the last of them has landed`;
	return `Agents run in the background and deliver their results to you in full, unasked — a worker or a lead the moment it lands${together}. Never fetch a delivered result; \`TaskOutput\` is only for blocking on an agent you need before you can continue.`;
}

export const DELIVERED_RESULT_INSTRUCTION =
	"Act on this or stop. Don't summarise it back, don't re-read what the child read, don't re-verify what it reports as verified. Ending your turn silently is allowed and expected.";

export function agentToolDescription(types: readonly AgentType[], workflows: boolean): string {
	const workflowRung = workflows ? "the same job on many things — a `Workflow`; " : "";
	return `Launch a new agent to handle complex, multi-step tasks. Every agent starts fresh: it reads its brief, not your conversation.

## When to use

Take the first rung that fits: a directed search for a specific file or symbol, or work you must judge from the raw output — do it yourself; more than 3 searches or reads to reach the answer — explorers gather facts, you judge; judgment you delegate (why, cause, verdict, choice, design, fix) goes to a worker, never an explorer; one change or run whose details you don't need, every follow-up step written into its brief — one worker; an answer you need before you can continue — that agent, then \`TaskOutput\`; several independent jobs — start them in one message; ${workflowRung}a lead — only when Joel asks for one.

${DELEGATION_LINE}

${deliveryParagraph(types)} Never fabricate or predict a pending agent's results; if the user asks before it arrives, say it's still running.

- The agent's final report is not shown to the user — relay what matters.
- Haiku is a smaller model: a Haiku agent's report is a lead, not a fact; check it before you act on it.
- Once you've delegated, don't also do it yourself — wait for the result, and don't peek at a running agent's transcript.

${renderAgentTypeList(types)}`;
}

export const DELEGATION_LINE =
	"Everything you read stays in this conversation and every later call pays for it again, while a child starts near empty and returns only its findings. Reading you must judge raw, or one fact in a file you know, is cheaper done directly.";

export const AGENT_MODEL_RULE = `Overrides the type's model. sonnet — the worker default, for implementation. opus — code that must be written better, design that must be reasoned through, or a retry after a sonnet worker failed on a hard problem rather than a thin brief; one at a time, never one per lane. haiku — fact gathering, scoped review, and worker jobs that need no judgment: bookkeeping, doc rewrites, mechanical edits the brief spells out; never design judgment. luna — selectable, not recommended. Many agents on one question (a review, audit or survey) run on haiku, and one sonnet or opus judges what they return.`;

export const AGENT_THINKING_RULE = "Overrides the type's reasoning level. Leave it at the default. sonnet runs at medium only; above that, use opus. opus: medium for code that must be written better, high for very hard implementation or design, xhigh for design where catching edge cases matters. Never xhigh for implementation.";

/** The spawn refusal for a sonnet child asked above medium. */
export const SONNET_MEDIUM_ONLY_REFUSAL = "sonnet runs at medium only; for more, use opus at medium or higher.";

export const AGENT_PARAMS = {
	description: "A short (3-5 word) description of the task",
	prompt: "The task for the agent to perform.",
	subagent_type: `The agent type. Default: ${DEFAULT_AGENT_TYPE}.`,
	name: "Name to address the agent by (SendMessage, TaskOutput, TaskStop). Reusing a name starts a new agent under it; the latest wins. Default: the type plus a number.",
	model: AGENT_MODEL_RULE,
	thinking: AGENT_THINKING_RULE,
	cwd: "An existing linked git worktree to start the agent in, shared by several agents on one branch; not with isolation.",
	isolation: '"worktree": the agent works in its own git worktree on branch agent/<name>; you merge the branch afterwards.',
	reply: "Override the reply format. Leave unset: the agent chooses R1-R5 by job kind.",
} as const;

export const AGENT_MODEL_ALIASES = ["opus", "sonnet", "luna", "haiku"] as const;

/** `SendMessage`: the one channel to an agent, and how a finished agent is resumed. */
export const SEND_MESSAGE_DESCRIPTION = `Send a message to an agent you started, by name. Your plain text output is not visible to agents; this tool is the only channel. A running agent reads it at its next step (\`interrupt: true\` aborts its current tool first). An agent that finished under 5 minutes ago resumes with its context intact and reports again when done. SendMessage is for follow-ups on the same job: a new job goes to a fresh \`Agent\`. One idle longer is refused: its cache is cold, so a resume would re-bill its whole context — start a fresh \`Agent\` with a tight brief instead. Replies come to you unasked. When relaying a message to the user, don't quote it — it's already rendered. Messages go down the tree only: the seat that started you reads your final reply.`;

/** `SendMessage`'s refusal for a settled agent idle past the cache window. */
export function coldResumeText(name: string, idleMs: number): string {
	return `Agent "${name}" has been idle ${Math.round(idleMs / 60_000)} min, past the 5-minute prompt cache window: its cache is cold, so resuming it would re-bill its whole context. Start a fresh agent with a tight brief instead (goal, branch and commit, worktree, logs, next steps).`;
}

/** Where a child's answer to its parent goes. */
export const UP_CHANNEL_LINE = "SendMessage reaches only agents you started; to answer the seat that started you, put it in your final reply.";

/** A seat's message as the child reads it: sender first, so the reply goes up the one channel there is. */
export function parentMessageText(sender: string, message: string): string {
	return `[From your parent, ${sender}. SendMessage can't reach it; anything it needs goes in your final reply.]\n\n${message}`;
}

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
export function taskOutputDescription(types: readonly Pick<AgentType, "name" | "delivery">[]): string {
	const batching = batchingTypeList(types);
	const together = batching === undefined ? "" : ` ${batching} agents return together with the others of their type once the last of them has landed, so one call brings the whole batch, and naming one brings the rest; every other agent returns alone.`;
	return `Waits for agents and returns their full final replies, each once — a reply you have already read is not returned again.${together} Or, by \`task\`, waits for your own background bash task, the number in "background as task N", and returns its exit status and output tail, once — its notification then does not repeat it. Give \`names\` or \`task\`, not both. For agents it returns early ("interrupted by Joel" or "interrupted by your parent (…)") when a message arrives; the agents keep running and their results are delivered when they land.`;
}

export const TASK_OUTPUT_PARAMS = {
	task: "The number of your own background bash task to wait for, e.g. 91. Not an agent.",
	names: "Agents to wait for. Omitted: every agent you started with an unread result.",
	block: "false: return current status (and the output tail so far, for a task) without waiting.",
	timeout: "Max wait in ms.",
	transcript: "Also return each agent's conversation (user, assistant and tool-call lines).",
} as const;

/** `TaskStop`: an agent by `name`, or a background bash task by `task`; exactly one. */
export const TASK_STOP_DESCRIPTION = `Stops a running agent by \`name\`, and any agents it started; the result it produced so far is kept. Or stops your own background bash task by \`task\`, the number in "background as task N"; its notification follows, saying it was killed. Give one of the two.`;

export const TASK_STOP_PARAMS = {
	name: "The agent to stop. Not a task number.",
	task: "The number of your own background bash task to stop, e.g. 91. Not an agent.",
} as const;

function stringEnum(values: readonly string[], description: string) {
	return Type.Unsafe<string>({ type: "string", description, ...(values.length > 0 ? { enum: [...values] } : {}) });
}

export function agentParamsFor(typeNames: readonly string[]) {
	const subagentType = stringEnum(typeNames, typeNames.includes(DEFAULT_AGENT_TYPE) ? AGENT_PARAMS.subagent_type : "The agent type.");
	return Type.Object({
		description: Type.String({ description: AGENT_PARAMS.description }),
		prompt: Type.String({ description: AGENT_PARAMS.prompt }),
		subagent_type: typeNames.includes(DEFAULT_AGENT_TYPE) ? Type.Optional(subagentType) : subagentType,
		name: Type.Optional(Type.String({ description: AGENT_PARAMS.name })),
		model: Type.Optional(stringEnum(AGENT_MODEL_ALIASES, AGENT_PARAMS.model)),
		thinking: Type.Optional(stringEnum(AGENT_THINKING_LEVELS, AGENT_PARAMS.thinking)),
		cwd: Type.Optional(Type.String({ description: AGENT_PARAMS.cwd })),
		isolation: Type.Optional(Type.Literal("worktree", { description: AGENT_PARAMS.isolation })),
		reply: Type.Optional(stringEnum(REPLY_IDS, AGENT_PARAMS.reply)),
	});
}
