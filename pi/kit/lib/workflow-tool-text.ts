/**
 * The words on the `Workflow` tool: Claude Code's description (asset
 * `cc-verbatim-strings-q1-8.md` §1, pasted verbatim by Opus inside Claude
 * Code 2.1.258) with its explicit-opt-in gate replaced by ours — map C20:
 * the description says when a workflow fits, the ladder decides — and its
 * canonical example moved to the authoring skill so the standing cost stays
 * near 500 tokens (C17: a lean always-on tool, the script API in a skill).
 *
 * The parameter descriptions are Claude Code's, minus the two "Ignored"
 * legacy fields.
 *
 * This text sits in every seat's cached prefix (C4), so it changes only in a
 * commit that also updates the pins in `test/workflow.mjs`.
 */

export const WORKFLOW_TOOL_NAME = "Workflow";

/** The name of the skill the description points at; the file is `skills/workflow-authoring/SKILL.md`. */
export const WORKFLOW_AUTHORING_SKILL = "workflow-authoring";

/** Our gate, in place of Claude Code's opt-in paragraph (C20, ticket 08's ladder rungs 5 and the "fix until green" row of 14). */
export const WORKFLOW_FITS_PARAGRAPH =
	"A workflow fits when the same job runs on many things — every file, every ticket, every module — or when the system reports what to fix and you want it fixed until it is green: run the checks, hand each failure to a child, rerun, until nothing fails. A short script starts one child per item, collects the answers, and returns them; only the return value comes back, with a line per failure, so it costs your context nothing while it runs. Scout first — list the items yourself — then run it. One child per item, one pass; tests are the check, not reviewers. One job, or a few independent ones, is the Agent tool's work, not this one's.";

export const WORKFLOW_DESCRIPTION = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

${WORKFLOW_FITS_PARAGRAPH}

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\`, a one-line \`description\` and optionally \`phases\` — one \`{ title, detail? }\` per phase() call, titles matched exactly. Pass the script inline via \`script\` — do not Write it to a file first, and do not also set the tool's \`name\` input (that selects a saved workflow); it is plain JavaScript, not TypeScript.

Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL}\` skill — the script API (agent/pipeline/parallel/phase/log/args, schema-forced results), the gotchas, resume, and worked examples.`;

/** What a resume replays, as the journal keeps it; the parameter and the result's `[resume]` line both say it in these words. */
export const WORKFLOW_RESUME_RULE = "Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; an edited, new or failed call re-runs, and so does every call that starts after it finishes or fails.";

/** Claude Code's parameter descriptions, with the saved-workflow directory made ours. */
export const WORKFLOW_PARAMS = {
	script:
		"Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
	scriptPath:
		"Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
	name: "Name of a saved workflow (~/.pi/agent/workflows/<name>.js). Resolves to a self-contained script.",
	args: "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
	resumeFromRunId:
		`Run ID of a prior Workflow invocation to resume from. ${WORKFLOW_RESUME_RULE} Same-session only. A prior run still going is stopped first. Without args, the prior run's are used.`,
} as const;

/**
 * The workflow child's prompt contract (asset `cc-dynamic-workflows-implementation.md`
 * §4.1, verbatim): the two paragraphs every child reads above its brief. The
 * first turns its reply into data; the second stops it inventing the
 * conversation it cannot see. Ticket 12's one-line tail says the first in
 * short; this is the long form, in the prompt, where the brief is.
 */
export const WORKFLOW_CHILD_CONTRACT = `Your final assistant message IS the return value of a function call in a program.
It is not a message to a human. Return raw data — no preamble, no summary of what
you did, no markdown pleasantries, no offers to help further.

You have no access to the conversation that created this task. Everything you need
is in the prompt below. If something is genuinely missing, say so in your return
value rather than guessing at the surrounding context.

You may start explorers to read for you. You may not start a workflow: you were
given one item; do it, and if it is too big say so in your return value.`;

/** What a workflow child is told when it calls `Workflow` (ticket 54 §1: the script is the judge, the child has hands). */
export const WORKFLOW_IN_WORKFLOW_CHILD =
	"A workflow child may not start a workflow. Do the item you were given; start explorers to read for you; if the item is too big, say so in your return value.";

/** Claude Code's run id shape, verbatim. */
export const WORKFLOW_RUN_ID_PATTERN = "^wf_[a-z0-9-]{6,}$";

/** Claude Code's inline script ceiling, verbatim. */
export const WORKFLOW_SCRIPT_MAX_LENGTH = 524288;

/**
 * pi's own heuristic (chars/4) and the kit inventory's (chars/3.7), so a
 * test can hold the description under budget without a tokenizer.
 */
export function estimateWorkflowTextTokens(text: string): { byFour: number; byThreeSeven: number } {
	return { byFour: Math.ceil(text.length / 4), byThreeSeven: Math.ceil(text.length / 3.7) };
}
