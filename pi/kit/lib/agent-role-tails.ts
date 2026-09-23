/**
 * The role tail a child reads in its first user message — the
 * `<sub_agent_context>` block of ticket 12, verbatim.
 *
 * In the first **user** message, never a system block (ticket 02, measured):
 * a child's system prompt is its parent's owned bytes so the child reads the
 * parent's tools+system cache entry. One extra system block costs every
 * message of that prefix.
 *
 * Nothing per-request goes above the tail. The live count and the name are in
 * it precisely because the tail is the first thing after the shared prefix.
 * Ticket 21 owns the wording; the sentences here are the ruled ones, so a
 * type file written later finds them already correct.
 */

import { AGENT_DEPTH_CAP } from "./agent-tool-text.ts";

/** The two roles of map C12, as amended by ticket 29 §3. */
export type AgentRole = "worker" | "lead";

/** Where a child's files live (C19): the parent's directory, or its own worktree. */
export type AgentFilesMode = { readonly kind: "shared" } | { readonly kind: "worktree"; readonly branch: string; readonly path: string };

/** What a tail says about the seat reading it. */
export interface AgentTailFacts {
	readonly role: AgentRole;
	readonly name: string;
	/** 1 for a child of the main seat, up to {@link AGENT_DEPTH_CAP}. */
	readonly depth: number;
	/** Agents live across the whole process when this child was started, this one included. */
	readonly liveCount: number;
	readonly files: AgentFilesMode;
	/** A workflow's child: its reply is a program's return value (ticket 12). */
	readonly workflowChild?: boolean;
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

/** Ticket 57's sentence: the seam takes the last message, so the report has to be in it. */
export const LAST_MESSAGE_LINE =
	'Only your last message is delivered. Put the whole report in it. A message that refers to an earlier message — "as above", "see the report" — delivers nothing.';

/** Ticket 12's lead sentences, verbatim. */
export const LEAD_LINE = "Own this end to end. Delegate the work to your own workers; don't implement it yourself. Report to your parent once, when it's done.";

/** Ticket 12's workflow-child sentence, verbatim. */
export const WORKFLOW_CHILD_LINE =
	"Your final message IS the return value of a function call in a program. Return raw data — no preamble, no summary of what you did.";

/** The `<sub_agent_context>` block for a worker or lead, ticket 12's sentences in order. */
export function renderRoleTail(facts: AgentTailFacts): string {
	const lines: string[] = [];
	lines.push(
		`You are a **${facts.role}** named \`${facts.name}\`, depth ${facts.depth} of ${AGENT_DEPTH_CAP}. ${facts.liveCount} agents are live. Your parent reads only your final reply — put everything that matters in it. Don't wait for or poll agents you didn't start.`,
	);
	lines.push(LAST_MESSAGE_LINE);
	if (facts.role === "lead") lines.push(LEAD_LINE);
	lines.push(facts.files.kind === "worktree" ? worktreeFilesLine(facts.files.branch) : SHARED_FILES_LINE);
	if (facts.workflowChild === true) lines.push(WORKFLOW_CHILD_LINE);
	return `${SUB_AGENT_CONTEXT_OPEN}\n${lines.join("\n")}\n${SUB_AGENT_CONTEXT_CLOSE}`;
}

/** A child's first user message: the tail, then the brief. */
export function renderChildFirstMessage(facts: AgentTailFacts, prompt: string): string {
	return `${renderRoleTail(facts)}\n\n${prompt}`;
}
