import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { descendantStoppers, markAgentLive } from "../../lib/agents/agent-live-runs.ts";
import { type AgentRecord, agentIsSettled, agentNameOf, mintAgentTaskId } from "../../lib/agents/agent-registry.ts";
import { type AgentRuntime, agentLifecyclePayload } from "../../lib/agents/agent-runtime.ts";
import type { WorkflowRunStore } from "../../lib/workflow/workflow-run-store.ts";
import { WORKFLOW_ARGS_COERCED_LOG } from "./workflow-args.ts";
import { createWorkflowChildSpawner, type WorkflowChildSpawnerSeat } from "./workflow-child-spawner.ts";
import { WorkflowJournal, type WorkflowJournalIndex } from "./workflow-journal.ts";
import { headWorkflowResult, renderWorkflowReturnValue, type WorkflowResultOnDisk, workflowRunReport } from "./workflow-result-text.ts";
import { readWorkflowManifest, workflowRunDir, workflowRunFiles, writeWorkflowManifest } from "./workflow-run-files.ts";
import { runWorkflow, WorkflowRunError } from "./workflow-runtime.ts";

/** The registry `type` of a workflow run's own record. */
export const WORKFLOW_RECORD_TYPE = "workflow";

export interface LiveWorkflowRun {
	readonly runId: string;
	readonly taskId: string;
	readonly name: string;
	readonly sessionId: string;
	readonly store: WorkflowRunStore;
	readonly controller: AbortController;
	readonly children: Set<string>;
	done: Promise<void>;
}

/** What the `Workflow` call decided before the run starts. */
export interface WorkflowRunStart {
	readonly source: string;
	readonly args: unknown;
	readonly argsCoerced: boolean;
	readonly meta: { readonly name: string; readonly description: string };
	readonly runId: string;
	readonly resumedFrom: string | undefined;
	readonly priorJournal: WorkflowJournalIndex | undefined;
	readonly toolCallId: string;
}

/** The seat's side of a run: who owns it, where its files go, and the seat's live runs. */
export interface WorkflowRunSeat extends WorkflowChildSpawnerSeat {
	readonly sessionId: string;
	sessionDir(): string;
	readonly store: WorkflowRunStore;
	readonly live: Map<string, LiveWorkflowRun>;
}

export function startWorkflowRun(runtime: AgentRuntime, options: WorkflowRunStart, seat: WorkflowRunSeat): AgentRecord {
	const { runId, meta } = options;
	const controller = new AbortController();
	const asked = agentNameOf(meta.name) ?? runtime.registry.nextName(WORKFLOW_RECORD_TYPE);
	const prior = options.resumedFrom !== undefined ? runtime.registry.all().find((record) => record.type === WORKFLOW_RECORD_TYPE && record.sessionId === options.resumedFrom) : undefined;
	const name = prior?.name ?? (runtime.registry.byName(asked) === undefined ? asked : runtime.registry.nextName(asked));
	const model = runtime.host.model();
	const record = runtime.registry.put({
		name,
		taskId: prior?.taskId ?? mintAgentTaskId(),
		ownerSessionId: seat.sessionId,
		type: WORKFLOW_RECORD_TYPE,
		description: meta.description,
		status: "running",
		stoppedBy: undefined,
		depth: runtime.host.depth + 1,
		sessionFile: undefined,
		sessionId: runId,
		cwd: runtime.host.cwd,
		branch: undefined,
		model: model !== undefined ? `${model.provider}/${model.id}` : "",
		thinking: undefined,
		result: undefined,
		error: undefined,
		readBy: undefined,
		readAt: undefined,
		toolUses: 0,
		costUsd: 0,
		totalTokens: 0,
		outputTokens: 0,
		startedAt: Date.now(),
		completedAt: undefined,
		toolCallId: options.toolCallId,
		workflowChild: false,
		brief: undefined,
		laterMessages: [],
	});
	const run: LiveWorkflowRun = { runId, taskId: record.taskId, name, sessionId: seat.sessionId, store: seat.store, controller, children: new Set(), done: Promise.resolve() };
	seat.live.set(runId, run);
	run.store.start({ runId, taskId: record.taskId, name, description: meta.description, startedAt: record.startedAt });
	markAgentLive(seat.sessionId, record.taskId);
	descendantStoppers().set(record.taskId, async () => {
		controller.abort();
		await run.done;
	});
	runtime.host.emit(prior !== undefined ? "subagents:resumed" : "subagents:created", agentLifecyclePayload(record, runId));
	runtime.host.emit("subagents:started", agentLifecyclePayload(record, runId));
	if (options.argsCoerced) seat.progress(run, { type: "log", message: WORKFLOW_ARGS_COERCED_LOG });
	const costs = { usd: 0, tokens: 0, output: 0 };
	const journal = new WorkflowJournal(join(workflowRunDir(seat.sessionDir(), runId), "journal.jsonl"), options.priorJournal);
	const manifest = readWorkflowManifest(seat.sessionDir(), runId);
	const files = workflowRunFiles(seat.sessionDir(), runId);

	run.done = (async () => {
		let status: AgentRecord["status"] = "completed";
		let result: string | undefined;
		let error: string | undefined;
		try {
			const outcome = await runWorkflow({
				source: options.source,
				args: options.args,
				journal,
				spawner: createWorkflowChildSpawner(runtime, run, costs, seat),
				emit: (event) => seat.progress(run, event),
				signal: controller.signal,
			});
			const header = options.resumedFrom !== undefined ? `[resumed from ${options.resumedFrom} — ${outcome.replaySummary}]\n` : "";
			const rendered = renderWorkflowReturnValue(outcome.value);
			const resultPath = join(workflowRunDir(seat.sessionDir(), runId), "result.json");
			let whole: WorkflowResultOnDisk = { path: resultPath };
			try {
				writeFileSync(resultPath, rendered);
			} catch (thrown) {
				whole = { path: resultPath, writeError: thrown instanceof Error ? thrown.message : String(thrown) };
			}
			const report = workflowRunReport(run.store.get(runId), files, "completed", costs.usd);
			result = [headWorkflowResult(outcome.value, `${header}${rendered}`, whole), ...(report.length > 0 ? ["", ...report] : [])].join("\n");
			if (manifest !== undefined) Object.assign(manifest, { status: "completed", completedAt: Date.now(), value: outcome.value, replay: outcome.replaySummary });
		} catch (thrown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown);
			status = thrown instanceof WorkflowRunError && thrown.reason === "stopped" ? "stopped" : "error";
			error = message;
			result = workflowRunReport(run.store.get(runId), files, status, costs.usd).join("\n");
			if (manifest !== undefined) Object.assign(manifest, { status, completedAt: Date.now(), error: message });
		} finally {
			journal.close();
			if (manifest !== undefined) {
				manifest.failures = run.store.get(runId)?.failures ?? [];
				manifest.costUsd = costs.usd;
				try {
					writeWorkflowManifest(seat.sessionDir(), manifest);
				} catch (thrown) {
					const note = `[run.json not updated: ${thrown instanceof Error ? thrown.message : String(thrown)}]`;
					result = result ? `${result}\n\n${note}` : note;
				}
			}
			for (const childId of run.children) {
				if (!agentIsSettled(runtime.registry.byTaskId(childId)?.status ?? "completed")) void runtime.stop(childId, "workflow").catch(() => undefined);
			}
			seat.live.delete(runId);
			run.store.settle(runId, status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed", Date.now());
			descendantStoppers().delete(record.taskId);
		}
		const current = runtime.registry.byName(name);
		const settledRecord: AgentRecord = { ...record, status, result, error, toolUses: 0, costUsd: costs.usd, totalTokens: costs.tokens, outputTokens: costs.output, completedAt: Date.now(), readBy: undefined, readAt: undefined };
		const stored = current?.taskId === record.taskId ? runtime.registry.put(settledRecord) : settledRecord;
		runtime.publishSettled(stored);
	})();
	return record;
}
