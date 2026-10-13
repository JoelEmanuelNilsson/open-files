import { formatSpendUsd } from "../../lib/agents/agent-spend.ts";
import type { WorkflowRun, WorkflowRunAgent, WorkflowRunFailure } from "../../lib/workflow/workflow-run-store.ts";
import type { WorkflowRunFiles } from "./workflow-run-files.ts";
import { WORKFLOW_RESUME_RULE } from "./workflow-tool-text.ts";

export const WORKFLOW_RESULT_HEAD_MAX_CHARS = 8_000;

/** How much of a too-big value rides with its shape: enough to see what the values look like, not enough to matter. */
export const WORKFLOW_RESULT_PREFIX_CHARS = 2_000;

/** Where the whole value went: a path on disk, or the reason it is not there. */
export type WorkflowResultOnDisk = { readonly path: string } | { readonly path: string; readonly writeError: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeOf(value: unknown): string {
	if (Array.isArray(value)) return `array of ${value.length}`;
	if (typeof value === "string") return `string of ${value.length} chars`;
	if (isPlainObject(value)) return `object with ${Object.keys(value).length} keys`;
	return JSON.stringify(value) ?? String(value);
}

function memberShapeLines(value: unknown): string[] {
	if (isPlainObject(value)) return Object.entries(value).map(([key, member]) => `  .${key} — ${shapeOf(member)}`);
	if (Array.isArray(value) && value.length > 0) return [`  [0] — ${shapeOf(value[0])}`];
	return [];
}

export function headWorkflowResult(value: unknown, rendered: string, whole: WorkflowResultOnDisk): string {
	if (rendered.length <= WORKFLOW_RESULT_HEAD_MAX_CHARS) return "writeError" in whole ? `${rendered}\n[result.json not written: ${whole.writeError}]` : rendered;
	const where = "writeError" in whole ? `the whole value could not be written to ${whole.path}: ${whole.writeError}` : `whole value at ${whole.path}`;
	const filter = isPlainObject(value) ? `.${Object.keys(value)[0] ?? ""}` : Array.isArray(value) ? ".[0]" : ".";
	const lines = [`[workflow result: ${rendered.length} chars; ${where}]`, `Shape: ${shapeOf(value)}`, ...memberShapeLines(value)];
	if (!("writeError" in whole)) lines.push(`Read the rest with jq, e.g. jq '${filter}' ${whole.path}`);
	lines.push(`First ${WORKFLOW_RESULT_PREFIX_CHARS} chars:`, rendered.slice(0, WORKFLOW_RESULT_PREFIX_CHARS));
	return lines.join("\n");
}

/** Failure lines the parent's result carries; the rest are counted and left in `run.json`. */
export const WORKFLOW_RESULT_FAILURES_SHOWN = 20;

/** How much of one failure's reason the result carries: a provider error can be a whole response body. */
export const WORKFLOW_FAILURE_REASON_MAX_CHARS = 300;

function agentCounts(agents: readonly WorkflowRunAgent[]): string {
	const count = (state: WorkflowRunAgent["state"]) => agents.filter((agent) => agent.state === state).length;
	const cached = count("cached");
	const parts = ([["failed", count("failed")], ["skipped", count("skipped")], ["unfinished", count("running")]] as const).filter(([, n]) => n > 0).map(([word, n]) => `${n} ${word}`);
	return `${agents.length - cached} run${parts.length > 0 ? ` (${parts.join(", ")})` : ""}${cached > 0 ? `, ${cached} cached` : ""}`;
}

function failureLine(failure: WorkflowRunFailure): string {
	const flat = failure.reason.replace(/\s+/g, " ").trim();
	const reason = flat.length > WORKFLOW_FAILURE_REASON_MAX_CHARS ? `${flat.slice(0, WORKFLOW_FAILURE_REASON_MAX_CHARS)}…` : flat;
	switch (failure.kind) {
		case "agent": {
			const who = failure.label === `agent #${failure.ordinal}` ? failure.label : `agent "${failure.label}" (#${failure.ordinal})`;
			return `- ${who} ${failure.skipped ? "skipped" : "failed"}: ${reason}`;
		}
		case "item":
			return `- pipeline item at index ${failure.index} dropped: ${reason}`;
		case "task":
			return `- parallel task at index ${failure.index} dropped: ${reason}`;
		case "rejection":
			return `- a promise the script never handled rejected: ${reason}`;
	}
}

export function workflowRunReport(run: WorkflowRun | undefined, files: WorkflowRunFiles, ended: "completed" | "stopped" | "error", spentUsd: number): string[] {
	const agents = run?.agents ?? [];
	const failures = run?.failures ?? [];
	const lines = agents.length > 0 ? [`[agents: ${agentCounts(agents)}]`] : [];
	if (formatSpendUsd(spentUsd) !== "") lines.push(`[spent: ${formatSpendUsd(spentUsd)}]`);
	if (failures.length > 0) {
		lines.push(`[failures: ${failures.length}]`, ...failures.slice(0, WORKFLOW_RESULT_FAILURES_SHOWN).map(failureLine));
		if (failures.length > WORKFLOW_RESULT_FAILURES_SHOWN) lines.push(`… and ${failures.length - WORKFLOW_RESULT_FAILURES_SHOWN} more in ${files.manifestPath} (.failures)`);
	}
	if (ended === "completed" && failures.length === 0) return lines;
	const limitHint = failures.some((failure) => failure.kind === "agent" && !failure.skipped) ? " A failure that names a usage limit fails again until that limit resets: resume after the reset." : "";
	lines.push(`[resume] Workflow({scriptPath: "${files.scriptPath}", resumeFromRunId: "${files.runId}"}) reads ${files.journalPath}. ${WORKFLOW_RESUME_RULE}${limitHint}`);
	return lines;
}

/** The run's return value as the record's `result` text; a string stays raw. The value is JSON data (`WorkflowRunResult.value`), so JSON writes it whole. */
export function renderWorkflowReturnValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
