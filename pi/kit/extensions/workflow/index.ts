import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { awaitUnlessAborted, registerAbortBoundedTool } from "../../lib/tools/tool-abort-bound.ts";
import { refuseToolCall } from "../../lib/agents/agent-refusals.ts";
import { agentRuntimeOf } from "../../lib/agents/agent-runtime-seam.ts";
import { AGENT_DEPTH_CAP, DEPTH_LIMIT_ERROR } from "../../lib/agents/agent-tool-text.ts";
import { notice } from "../../lib/process/human-notice.ts";
import { childSeatOf } from "../../lib/session/seat-identity.ts";
import { coerceWorkflowArgs } from "./workflow-args.ts";
import { readWorkflowJournal } from "./workflow-journal.ts";
import { extractWorkflowMeta, WorkflowMetaError } from "./workflow-meta.ts";
import { newWorkflowRunId, readWorkflowManifest, resolveWorkflowSource, workflowRunDir, type WorkflowRunManifest, writeWorkflowManifest } from "./workflow-run-files.ts";
import { type LiveWorkflowRun, startWorkflowRun, WORKFLOW_RECORD_TYPE } from "./workflow-run-lifecycle.ts";
import { compileWorkflowScript, syntaxErrorAt } from "./workflow-sandbox.ts";
import { WORKFLOWS_EMPTY_TEXT, WORKFLOWS_VIEW_HINT, workflowRunPrintout } from "./workflows-command.ts";
import { forgetWorkflowRuns, type WorkflowRunEvent, type WorkflowRunStore, workflowRunsOf } from "../../lib/workflow/workflow-run-store.ts";
import {
	prepareStructuredOutputArguments,
	recordStructuredOutputAttempt,
	STRUCTURED_OUTPUT_ACCEPTED_TEXT,
	STRUCTURED_OUTPUT_DESCRIPTION,
	STRUCTURED_OUTPUT_NOT_A_WORKFLOW_CHILD,
	STRUCTURED_OUTPUT_PARAMS,
	structuredOutputContractOf,
	structuredOutputExhaustedText,
	structuredOutputRetryText,
} from "./workflow-structured-output.ts";
import { WORKFLOW_DESCRIPTION, WORKFLOW_IN_WORKFLOW_CHILD, WORKFLOW_PARAMS, WORKFLOW_RESUME_RULE, WORKFLOW_RUN_ID_PATTERN, WORKFLOW_SCRIPT_MAX_LENGTH } from "./workflow-tool-text.ts";
import { STRUCTURED_OUTPUT_TOOL_NAME, WORKFLOW_TOOL_NAME } from "../../lib/agents/agent-tool-text.ts";

const workflowParams = Type.Object({
	script: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.script, maxLength: WORKFLOW_SCRIPT_MAX_LENGTH })),
	scriptPath: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.scriptPath })),
	name: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.name })),
	args: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()], { description: WORKFLOW_PARAMS.args })),
	resumeFromRunId: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.resumeFromRunId, pattern: WORKFLOW_RUN_ID_PATTERN })),
});

export default function workflow(pi: ExtensionAPI) {
	let sessionId = "";
	let sessionDir = "";
	let uiCtx: ExtensionContext | undefined;
	const live = new Map<string, LiveWorkflowRun>();
	const spawningNames = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		sessionDir = ctx.sessionManager.getSessionDir();
		uiCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		for (const run of live.values()) run.controller.abort();
		forgetWorkflowRuns(sessionId);
	});

	const runs = (): WorkflowRunStore => workflowRunsOf(sessionId);

	function notify(message: string): void {
		if (uiCtx?.hasUI) uiCtx.ui.notify(message, "info");
	}

	function progress(run: LiveWorkflowRun, event: WorkflowRunEvent): void {
		run.store.apply(run.runId, event);
		if (event.type === "log") notify(`${run.name}: ${event.message}`);
		pi.events.emit("workflow:progress", { runId: run.runId, taskId: run.taskId, ...event });
	}

	const registerWorkflowTool = () =>
		registerAbortBoundedTool(pi, {
		name: WORKFLOW_TOOL_NAME,
		label: "Workflow",
		exposure: "deferred",
		description: WORKFLOW_DESCRIPTION,
		parameters: workflowParams,
		async execute(toolCallId, params, signal) {
			const runtime = agentRuntimeOf(sessionId);
			if (runtime === undefined) return refuseToolCall("Agent engine is not ready: no session yet.");
			if (childSeatOf(sessionId)?.workflowChild === true) return refuseToolCall(WORKFLOW_IN_WORKFLOW_CHILD);
			if (runtime.host.depth >= AGENT_DEPTH_CAP) return refuseToolCall(DEPTH_LIMIT_ERROR);
			const { source, from } = resolveWorkflowSource(params);
			let extracted: ReturnType<typeof extractWorkflowMeta>;
			try {
				extracted = extractWorkflowMeta(source);
			} catch (error) {
				if (error instanceof WorkflowMetaError) return refuseToolCall(error.message);
				throw error;
			}
			const { meta } = extracted;
			let resumedFrom: string | undefined;
			let prior: WorkflowRunManifest | undefined;
			if (params.resumeFromRunId !== undefined) {
				prior = readWorkflowManifest(sessionDir, params.resumeFromRunId);
				if (prior === undefined) return refuseToolCall(`No run ${params.resumeFromRunId} under ${join(sessionDir, "workflows")}.`);
				if (prior.sessionId !== sessionId) return refuseToolCall(`Run ${params.resumeFromRunId} belongs to another session; resume is same-session only.`);
			}
			const args = params.args === undefined && prior !== undefined ? { value: prior.args, coerced: false } : coerceWorkflowArgs(params.args);
			const runId = newWorkflowRunId();
			mkdirSync(workflowRunDir(sessionDir, runId), { recursive: true });
			const scriptPath = join(workflowRunDir(sessionDir, runId), "script.js");
			writeFileSync(scriptPath, source);
			try {
				compileWorkflowScript(extracted.body, scriptPath);
			} catch (error) {
				const refusal = error instanceof SyntaxError ? syntaxErrorAt(error, scriptPath) : error instanceof Error ? error.message : String(error);
				const at = Date.now();
				writeWorkflowManifest(sessionDir, { runId, sessionId, name: meta.name, description: meta.description, args: args.value, resumedFrom: undefined, startedAt: at, status: "error", completedAt: at, error: refusal });
				return refuseToolCall(refusal);
			}
			if (params.resumeFromRunId !== undefined) {
				const running = live.get(params.resumeFromRunId);
				if (running !== undefined) {
					running.controller.abort();
					if ((await awaitUnlessAborted(running.done, signal)) === "aborted") {
						const at = Date.now();
						const cancelled = `Resume cancelled: run ${params.resumeFromRunId} was told to stop and is still stopping; no new run started. Resume it again once it has stopped.`;
						writeWorkflowManifest(sessionDir, { runId, sessionId, name: meta.name, description: meta.description, args: args.value, resumedFrom: params.resumeFromRunId, startedAt: at, status: "stopped", completedAt: at, error: cancelled });
						return refuseToolCall(cancelled);
					}
				}
				resumedFrom = params.resumeFromRunId;
			}
			writeWorkflowManifest(sessionDir, { runId, sessionId, name: meta.name, description: meta.description, args: args.value, resumedFrom, startedAt: Date.now(), status: "running" });
			const priorJournal = resumedFrom !== undefined ? readWorkflowJournal(join(workflowRunDir(sessionDir, resumedFrom), "journal.jsonl")) : undefined;
			const priorEntries = priorJournal !== undefined ? [...priorJournal.values()].reduce((sum, list) => sum + list.length, 0) : 0;
			const record = startWorkflowRun(runtime, { source, args: args.value, argsCoerced: args.coerced, meta, runId, resumedFrom, priorJournal, toolCallId }, { sessionId, sessionDir: () => sessionDir, store: runs(), live, spawningNames, progress });
			return {
				content: [
					{
						type: "text",
						text: [
							"Workflow started in background.",
							`Name: ${record.name}`,
							`Task ID: ${record.taskId}`,
							`Run ID: ${runId}`,
							`Script: ${scriptPath}${from !== "script" ? ` (from ${from})` : ""}`,
							...(resumedFrom !== undefined ? [`Resuming ${resumedFrom}: ${priorEntries} journalled result(s). ${WORKFLOW_RESUME_RULE}`] : []),
							"Its return value comes back when the run lands, with a count of its agents and a line per failure. TaskOutput waits for it now; TaskStop stops it; /workflows prints its phases and agents, and ↓ then enter on the run shows them live.",
						].join("\n"),
					},
				],
				details: {
					displayName: WORKFLOW_RECORD_TYPE,
					description: record.description,
					subagentType: WORKFLOW_RECORD_TYPE,
					toolUses: 0,
					tokens: "",
					status: "background",
					agentId: record.taskId,
					name: record.name,
					runId,
					scriptPath,
				},
			};
		},
	});
	registerWorkflowTool();

	registerAbortBoundedTool(pi, {
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		label: "StructuredOutput",
		defaultActive: false,
		description: STRUCTURED_OUTPUT_DESCRIPTION,
		parameters: STRUCTURED_OUTPUT_PARAMS,
		prepareArguments: prepareStructuredOutputArguments,
		async execute(_toolCallId, params) {
			const seat = childSeatOf(sessionId);
			const contract = seat !== undefined ? structuredOutputContractOf(seat.parentSessionId, seat.name) : undefined;
			if (contract === undefined) return refuseToolCall(STRUCTURED_OUTPUT_NOT_A_WORKFLOW_CHILD);
			const attempt = recordStructuredOutputAttempt(contract, params.result);
			switch (attempt.kind) {
				case "accepted":
					return { content: [{ type: "text", text: STRUCTURED_OUTPUT_ACCEPTED_TEXT }], details: undefined };
				case "already-recorded":
					return { content: [{ type: "text", text: "Already recorded. End your turn now." }], details: undefined };
				case "rejected":
					return refuseToolCall(structuredOutputRetryText(attempt));
				case "exhausted":
					return refuseToolCall(structuredOutputExhaustedText(attempt.errors));
			}
		},
	});

	pi.registerCommand("workflows", {
		description: "Workflow runs: phases, agents, and the last log lines",
		handler: async (_args, ctx) => {
			const all = runs().list();
			const text = all.length === 0 ? WORKFLOWS_EMPTY_TEXT : [...all.flatMap(workflowRunPrintout), "", WORKFLOWS_VIEW_HINT].join("\n");
			notice(ctx, text, "info");
		},
	});
}
