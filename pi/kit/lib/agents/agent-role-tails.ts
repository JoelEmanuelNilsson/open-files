import { AGENT_DEPTH_CAP, EXPLORE_AGENT_TYPE } from "./agent-tool-text.ts";
import { type ReplyId, renderReplyRule } from "./reply-formats.ts";

/** The roles of map C12, as amended by ticket 29 §3; the explorer and design-review seats carry no write tool. */
export type AgentRole = "worker" | "lead" | "explorer" | "reviewer" | "design-review";

/** The role an agent type runs as. */
export function roleOfType(typeName: string): AgentRole {
	switch (typeName) {
		case "lead":
			return "lead";
		case EXPLORE_AGENT_TYPE:
			return "explorer";
		case "reviewer":
			return "reviewer";
		case "design-review":
			return "design-review";
		default:
			return "worker";
	}
}

/** Whether the role's tail carries the reply formats: the explorer and design-review seats report as their own prompts say, and have no write tool to move detail to a file. */
export function roleUsesReplyFormats(role: AgentRole): boolean {
	return role !== "explorer" && role !== "design-review";
}

/** Where a child's files live (C19): the parent's directory, or its own worktree. */
export type AgentFilesMode = { readonly kind: "shared" } | { readonly kind: "worktree"; readonly branch: string; readonly path: string };

/** What a tail says about the seat reading it. */
export interface AgentTailFacts {
	readonly role: AgentRole;
	readonly name: string;
	readonly depth: number;
	readonly liveCount: number;
	readonly files: AgentFilesMode;
	readonly workflowChild?: boolean;
	readonly replyDir?: string;
	readonly reply?: ReplyId;
}

export const SUB_AGENT_CONTEXT_OPEN = "<sub_agent_context>";
export const SUB_AGENT_CONTEXT_CLOSE = "</sub_agent_context>";

/** Ticket 12's files line for the shared directory, verbatim. */
export const SHARED_FILES_LINE =
	"You share this directory with other agents. Edit only the files your job needs. Never revert or reformat someone else's change. If you must touch a file outside your job, say so in your report.";

/** Ticket 12's files line for a worktree, verbatim, with the branch filled in. */
export function worktreeFilesLine(branch: string): string {
	return `You work in your own copy of the repo on branch \`${branch}\`. Commit there. Your report must name the branch and the files you changed.`;
}

/** What a seat with no write tool reads where a worker reads the files line. */
export const READ_ONLY_LINE = "You are read-only: report what you found and any change it calls for; your parent makes the change.";

/** Ticket 57's sentence: the seam takes the last message, so the report has to be in it. */
export const LAST_MESSAGE_LINE =
	'Only your last message is delivered. Put the whole report in it. A message that refers to an earlier message — "as above", "see the report" — delivers nothing.';

/** What a workflow child is told about its final reply: the script reads it as data. */
export const WORKFLOW_CHILD_CONTRACT = `Your final assistant message IS the return value of a function call in a program.
It is not a message to a human. Return raw data — no preamble, no summary of what
you did, no markdown pleasantries, no offers to help further.

You have no access to the conversation that created this task. Everything you need
is in the prompt below. If something is genuinely missing, say so in your return
value rather than guessing at the surrounding context.

You were given one item: do it with your own tools, and if it is too big say so in
your return value.`;

/** Ticket 12's lead sentences, verbatim. */
export const LEAD_LINE = "Own this end to end. Delegate the work to your own workers; don't implement it yourself. Report to your parent once, when it's done.";

/** The `<sub_agent_context>` block for a worker, lead or explorer, ticket 12's sentences in order. */
export function renderRoleTail(facts: AgentTailFacts): string {
	const lines: string[] = [];
	const workflowChild = facts.workflowChild === true;
	const reach = workflowChild
		? "SendMessage reaches only agents you started."
		: "Your parent reads only your final reply — put everything that matters in it, including answers to its messages; SendMessage reaches only agents you started.";
	lines.push(
		`You are ${/^[aeiou]/.test(facts.role) ? "an" : "a"} **${facts.role}** named \`${facts.name}\`, depth ${facts.depth} of ${AGENT_DEPTH_CAP}. ${facts.liveCount} agents are live. ${reach} Don't wait for or poll agents you didn't start.`,
	);
	lines.push(workflowChild ? WORKFLOW_CHILD_CONTRACT : LAST_MESSAGE_LINE);
	if (facts.role === "lead") lines.push(LEAD_LINE);
	if (facts.role === "explorer" || facts.role === "design-review") lines.push(READ_ONLY_LINE);
	else if (facts.role !== "reviewer") lines.push(facts.files.kind === "worktree" ? worktreeFilesLine(facts.files.branch) : SHARED_FILES_LINE);
	if (!workflowChild && facts.replyDir !== undefined) lines.push(renderReplyRule(facts.replyDir, facts.reply));
	return `${SUB_AGENT_CONTEXT_OPEN}\n${lines.join("\n")}\n${SUB_AGENT_CONTEXT_CLOSE}`;
}

/** A child's first user message: the tail, then the brief. */
export function renderChildFirstMessage(facts: AgentTailFacts, prompt: string): string {
	return `${renderRoleTail(facts)}\n\n${prompt}`;
}
