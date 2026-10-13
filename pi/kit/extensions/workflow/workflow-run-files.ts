import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { refuseToolCall } from "../../lib/agents/agent-refusals.ts";
import type { WorkflowRunFailure } from "../../lib/workflow/workflow-run-store.ts";

/** `run.json`: what a resume needs to know about the run it replays. */
export interface WorkflowRunManifest {
	readonly runId: string;
	readonly sessionId: string;
	readonly name: string;
	readonly description: string;
	readonly args: unknown;
	readonly resumedFrom: string | undefined;
	readonly startedAt: number;
	status: "running" | "completed" | "error" | "stopped";
	completedAt?: number;
	value?: unknown;
	error?: string;
	replay?: string;
	costUsd?: number;
	failures?: readonly WorkflowRunFailure[];
}

/** A run's files, as the lines that point at them name them. */
export interface WorkflowRunFiles {
	readonly runId: string;
	readonly scriptPath: string;
	readonly journalPath: string;
	readonly manifestPath: string;
}

/** A fresh run id: `wf_` and twelve hex. */
export function newWorkflowRunId(): string {
	return `wf_${randomBytes(6).toString("hex")}`;
}

/** The run's directory under the session's. */
export function workflowRunDir(sessionDir: string, runId: string): string {
	return join(sessionDir, "workflows", runId);
}

/** Every file of a run that a line in its result may name. */
export function workflowRunFiles(sessionDir: string, runId: string): WorkflowRunFiles {
	const dir = workflowRunDir(sessionDir, runId);
	return { runId, scriptPath: join(dir, "script.js"), journalPath: join(dir, "journal.jsonl"), manifestPath: join(dir, "run.json") };
}

/** The run's `run.json`, or undefined when it is missing or unreadable. */
export function readWorkflowManifest(sessionDir: string, runId: string): WorkflowRunManifest | undefined {
	try {
		// SAFETY: the manifest is written only by this module as WorkflowRunManifest; a corrupt file throws and is handled by the catch
		return JSON.parse(readFileSync(workflowRunFiles(sessionDir, runId).manifestPath, "utf8")) as WorkflowRunManifest;
	} catch {
		return undefined;
	}
}

/** Writes `run.json` whole; a throw is the caller's to handle. */
export function writeWorkflowManifest(sessionDir: string, manifest: WorkflowRunManifest): void {
	writeFileSync(workflowRunFiles(sessionDir, manifest.runId).manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** `scriptPath` > `script` > `name`. */
export function resolveWorkflowSource(params: { script?: string; scriptPath?: string; name?: string }): { source: string; from: string } {
	if (params.scriptPath !== undefined && params.scriptPath.trim() !== "") {
		try {
			return { source: readFileSync(params.scriptPath, "utf8"), from: params.scriptPath };
		} catch (error) {
			return refuseToolCall(`Unreadable scriptPath ${params.scriptPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (params.script !== undefined && params.script.trim() !== "") return { source: params.script, from: "script" };
	if (params.name !== undefined && params.name.trim() !== "") {
		const file = join(getAgentDir(), "workflows", `${params.name.trim()}.js`);
		if (!existsSync(file)) return refuseToolCall(`Unknown workflow name "${params.name}": no ${file}. Pass the script inline via \`script\` instead.`);
		return { source: readFileSync(file, "utf8"), from: file };
	}
	return refuseToolCall("Workflow needs one of `script`, `scriptPath` or `name`.");
}
