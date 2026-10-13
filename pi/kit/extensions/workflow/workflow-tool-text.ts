/** The name of the skill the description points at; the file is `skills/workflow-authoring/SKILL.md`. */
export const WORKFLOW_AUTHORING_SKILL = "workflow-authoring";

/** Our gate, in place of Claude Code's opt-in paragraph (C20, ticket 08's ladder rungs 5 and the "fix until green" row of 14). */
export const WORKFLOW_FITS_PARAGRAPH =
	"A workflow fits when the same job runs on many things — every file, every ticket, every module — or when the system reports what to fix and you want it fixed until it is green: run the checks, hand each failure to a child, rerun, until nothing fails. A short script starts one child per item, collects the answers, and returns them; only the return value comes back, with a line per failure, so it costs your context nothing while it runs. Scout first — list the items yourself — then run it. One child per item, one pass; tests are the check when a test can check the result, else one agent checks each claim (the saved code-review workflow). One job, or a few independent ones, is the Agent tool's work, not this one's.";

export const WORKFLOW_DESCRIPTION = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes.

${WORKFLOW_FITS_PARAGRAPH}

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\` and a one-line \`description\`. Pass the script inline via \`script\` — do not Write it to a file first, and do not also set the tool's \`name\` input (that selects a saved workflow); it is plain JavaScript, not TypeScript.

Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL}\` skill — the script API (agent/pipeline/parallel/phase/log/args, schema-forced results), the gotchas, resume, and worked examples.`;

/** What a resume replays, as the journal keeps it; the parameter and the result's `[resume]` line both say it in these words. */
export const WORKFLOW_RESUME_RULE = "Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; an edited, new or failed call re-runs, and so does every call that starts after it finishes or fails.";

/** Claude Code's parameter descriptions, with the saved-workflow directory made ours. */
export const WORKFLOW_PARAMS = {
	script:
		"Self-contained workflow script. Must begin with `export const meta = { name, description }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
	scriptPath:
		"Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
	name: "Name of a saved workflow (~/.pi/agent/workflows/<name>.js). Resolves to a self-contained script.",
	args: "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
	resumeFromRunId:
		`Run ID of a prior Workflow invocation to resume from. ${WORKFLOW_RESUME_RULE} Same-session only. A prior run still going is stopped first. Without args, the prior run's are used.`,
} as const;

/** What a workflow child is told when it calls `Workflow` (ticket 54 §1: the script is the judge, the child has hands). */
export const WORKFLOW_IN_WORKFLOW_CHILD =
	"A workflow child may not start a workflow. Do the item you were given with your own tools; if the item is too big, say so in your return value.";

/** Claude Code's run id shape, verbatim. */
export const WORKFLOW_RUN_ID_PATTERN = "^wf_[a-z0-9-]{6,}$";

/** Claude Code's inline script ceiling, verbatim. */
export const WORKFLOW_SCRIPT_MAX_LENGTH = 524288;
