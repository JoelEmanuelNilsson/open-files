import { type WorkflowRun, workflowRunOutcomeCounts, workflowRunPhases } from "../../lib/workflow/workflow-run-store.ts";

/** `/workflows` with nothing to show. True of a session that has run none, which is the only time it prints. */
export const WORKFLOWS_EMPTY_TEXT = "No workflow runs in this session.";

/** Where the live version of the same tree is. `/workflows` is a printout; the dock's view moves. */
export const WORKFLOWS_VIEW_HINT = "↓ then enter on the run for the live view.";

/** One glyph per agent state in `/workflows`' printout. The run view draws its own, in colour. */
export const WORKFLOW_AGENT_GLYPH = { running: "…", cached: "≡", done: "✓", failed: "✗", skipped: "⊘" } as const;

/** One run as text: its phases, their agents, and its log tail. */
export function workflowRunPrintout(run: WorkflowRun): string[] {
	const done = run.agents.filter((agent) => agent.state !== "running").length;
	const state = run.status === "running" ? `${done}/${run.agents.length} agents${run.currentPhase ? ` · phase ${run.currentPhase}` : ""}` : run.status;
	const counts = workflowRunOutcomeCounts(run);
	const lines = [`${run.name} (${run.runId}) — ${state}${counts === "" ? "" : ` · ${counts}`}`];
	for (const phase of workflowRunPhases(run)) {
		lines.push(`  ▸ ${phase.title} ${phase.done}/${phase.total}`);
		for (const agent of phase.agents) lines.push(`    ${WORKFLOW_AGENT_GLYPH[agent.state]} ${agent.label}`);
	}
	for (const log of run.logs.slice(-5)) lines.push(`  · ${log}`);
	return lines;
}
