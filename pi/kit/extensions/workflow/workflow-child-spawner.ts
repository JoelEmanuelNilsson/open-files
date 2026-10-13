import { type AgentRecord, agentIsSettled } from "../../lib/agents/agent-registry.ts";
import type { AgentProgressEvent, AgentRuntime } from "../../lib/agents/agent-runtime.ts";
import { backgroundTasksOf, watchBackgroundTasksOf } from "../../lib/tools/background-tasks.ts";
import type { WorkflowRunEvent } from "../../lib/workflow/workflow-run-store.ts";
import { WORKFLOW_PREFIX_STAGGER_MS, WORKFLOW_PREFIX_WARM_MS, type WorkflowPrefixLease, WorkflowPrefixStagger, workflowPrefixKey } from "./workflow-prefix-stagger.ts";
import type { LiveWorkflowRun } from "./workflow-run-lifecycle.ts";
import type { WorkflowAgentReport, WorkflowAgentRequest, WorkflowAgentSpawner } from "./workflow-runtime.ts";
import { declareStructuredOutput, forgetStructuredOutput, noteStructuredOutputMissed, STRUCTURED_OUTPUT_NUDGE, structuredOutputInstruction } from "./workflow-structured-output.ts";

const ACCEPTED_GRACE_MS = 60_000;

const WAIT_SLICE_MS = 2 * 60 * 60_000;

const DEFAULT_STALL_MS = 180_000;

const STALL_ATTEMPTS = 3;

/** What the spawner needs from the seat's workflow extension, shared by every run it starts. */
export interface WorkflowChildSpawnerSeat {
	readonly spawningNames: Set<string>;
	progress(run: LiveWorkflowRun, event: WorkflowRunEvent): void;
}

export function createWorkflowChildSpawner(runtime: AgentRuntime, run: LiveWorkflowRun, costs: { usd: number; tokens: number; output: number }, seat: WorkflowChildSpawnerSeat): WorkflowAgentSpawner {
	async function settled(taskId: string, signal: AbortSignal): Promise<AgentRecord | "aborted">;
	async function settled(taskId: string, signal: AbortSignal, withinMs: number): Promise<AgentRecord | "timeout" | "aborted">;
	async function settled(taskId: string, signal: AbortSignal, withinMs?: number): Promise<AgentRecord | "timeout" | "aborted"> {
		const deadline = withinMs === undefined ? undefined : Date.now() + withinMs;
		for (;;) {
			const current = runtime.registry.byTaskId(taskId);
			if (current !== undefined && agentIsSettled(current.status)) return current;
			const sliceMs = deadline === undefined ? WAIT_SLICE_MS : deadline - Date.now();
			if (sliceMs <= 0) return "timeout";
			const outcome = await runtime.waits.wait(() => agentIsSettled(runtime.registry.byTaskId(taskId)?.status ?? "queued"), sliceMs, signal);
			if (outcome.kind === "interrupted" && outcome.by === "abort") return "aborted";
		}
	}
	const countedUsd = new Map<string, number>();
	function count(record: AgentRecord): void {
		costs.usd += record.costUsd - (countedUsd.get(record.taskId) ?? 0);
		countedUsd.set(record.taskId, record.costUsd);
		costs.tokens += record.totalTokens;
		costs.output += record.outputTokens;
	}
	function died(record: AgentRecord): WorkflowAgentReport {
		const skipped = record.stoppedBy === "dock" || record.stoppedBy === "TaskStop";
		if (skipped) return { kind: "died", reason: `${record.name} skipped by hand`, skipped: true };
		return { kind: "died", reason: `${record.name} ${record.status}${record.error ? `: ${record.error}` : ""}` };
	}
	const labelOf = (request: WorkflowAgentRequest) => request.options.label ?? `${run.name}:${request.ordinal}`;
	async function spawnChild(request: WorkflowAgentRequest, signal: AbortSignal, prefix: WorkflowPrefixLease): Promise<WorkflowAgentReport | { readonly kind: "stalled" }> {
		const base = labelOf(request);
		const taken = (candidate: string) => runtime.registry.byName(candidate) !== undefined || seat.spawningNames.has(candidate);
		let name = base;
		while (taken(name)) name = runtime.registry.nextName(base);
		seat.spawningNames.add(name);
		const schema = request.options.schema;
		const contract = schema !== undefined ? declareStructuredOutput(run.sessionId, name, schema) : undefined;
		contract?.outcome.catch(() => {});
		const prompt = [request.prompt, ...(schema !== undefined ? [structuredOutputInstruction(schema)] : [])].join("\n\n");
		let record: AgentRecord;
		try {
			record = await runtime.spawn({
				description: (request.options.label ?? request.prompt.split("\n")[0] ?? "workflow agent").slice(0, 60),
				prompt,
				name,
				workflowChild: true,
				onFirstPrompt: request.started,
				...(request.options.type !== undefined ? { subagentType: request.options.type } : {}),
				...(request.options.model !== undefined ? { model: request.options.model } : {}),
				...(request.options.thinking !== undefined ? { thinking: request.options.thinking } : {}),
				...(request.options.isolation !== undefined ? { isolation: request.options.isolation } : {}),
				...(request.options.cwd !== undefined ? { cwd: request.options.cwd } : {}),
			});
		} catch (error) {
			forgetStructuredOutput(run.sessionId, name);
			throw error;
		} finally {
			seat.spawningNames.delete(name);
		}
		let taskId = record.taskId;
		const stopChild = () => runtime.stop(taskId, "workflow").catch(() => undefined);
		signal.addEventListener("abort", stopChild, { once: true });
		const adopt = () => {
			run.children.add(taskId);
			run.store.noteSpawn(run.runId, request.ordinal, { taskId, prompt: request.prompt });
		};
		adopt();
		const stallMs = request.options.stallMs ?? DEFAULT_STALL_MS;
		let stalled = false;
		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		const toolsInFlight = new Set<string>();
		let compacting = false;
		const waitsOnBackgroundTask = () => {
			const sessionId = runtime.registry.byTaskId(taskId)?.sessionId;
			return sessionId !== undefined && backgroundTasksOf(sessionId).length > 0 && runtime.liveRun(taskId)?.isIdle === true;
		};
		const rearmStall = () => {
			if (stallTimer !== undefined) clearTimeout(stallTimer);
			stallTimer =
				toolsInFlight.size > 0 || compacting
					? undefined
					// raw-timer: the stall clock of one workflow child, cleared when it rearms or the child ends
					: setTimeout(() => {
							if (waitsOnBackgroundTask()) return rearmStall();
							stalled = true;
							void stopChild();
						}, stallMs);
		};
		const onProgress = (event: AgentProgressEvent) => {
			if (event.type === "turn_end") prefix.firstTurn();
			if (event.type === "tool_execution_start") toolsInFlight.add(event.toolCallId);
			if (event.type === "tool_execution_end") toolsInFlight.delete(event.toolCallId);
			if (event.type === "compaction_start") compacting = true;
			if (event.type === "compaction_end") compacting = false;
			rearmStall();
		};
		let unwatch = runtime.watchProgress(taskId, onProgress);
		let unwatchTasks = watchBackgroundTasksOf(runtime.registry.byTaskId(taskId)?.sessionId ?? "", rearmStall);
		rearmStall();
		const report = (final: AgentRecord): WorkflowAgentReport | { readonly kind: "stalled" } => (stalled ? { kind: "stalled" } : died(final));
		const abandoned = async (reason: string): Promise<WorkflowAgentReport> => {
			await stopChild();
			const final = runtime.registry.byTaskId(taskId);
			if (final !== undefined) count(final);
			return { kind: "died", reason };
		};
		try {
			if (record.name !== name) return await abandoned(`named ${record.name} by the engine, not ${name} as asked`);
			if (contract === undefined) {
				const final = await settled(taskId, signal);
				if (final === "aborted") return await abandoned("aborted");
				count(final);
				return final.status === "completed" ? { kind: "completed", value: final.result ?? "" } : report(final);
			}
			for (;;) {
				const outcome = await Promise.race([
					contract.outcome.then(
						(value) => ({ kind: "value" as const, value }),
						(error: Error) => ({ kind: "exhausted" as const, reason: error.message }),
					),
					settled(taskId, signal).then((final) => ({ kind: "settled" as const, final })),
				]);
				if (outcome.kind === "value") {
					const final = await settled(taskId, signal, ACCEPTED_GRACE_MS);
					if (final === "timeout" || final === "aborted") await stopChild();
					const counted = runtime.registry.byTaskId(taskId);
					if (counted !== undefined) count(counted);
					return { kind: "completed", value: outcome.value };
				}
				if (outcome.kind === "exhausted") {
					await stopChild();
					const counted = runtime.registry.byTaskId(taskId);
					if (counted !== undefined) count(counted);
					return { kind: "schema-exhausted", reason: outcome.reason };
				}
				const final = outcome.final;
				if (final === "aborted") return await abandoned("aborted");
				count(final);
				if (final.status !== "completed") return report(final);
				const missed = noteStructuredOutputMissed(contract);
				if (missed.kind === "exhausted") return { kind: "schema-exhausted", reason: await contract.outcome.then(() => missed.errors, (error: Error) => error.message) };
				if (missed.kind === "already-recorded") return { kind: "completed", value: await contract.outcome };
				const sent = await runtime.send(name, STRUCTURED_OUTPUT_NUDGE, false, "seat");
				taskId = sent.record.taskId;
				adopt();
				unwatch();
				unwatch = runtime.watchProgress(taskId, onProgress);
				toolsInFlight.clear();
				rearmStall();
			}
		} catch (error) {
			await stopChild();
			return { kind: "died", reason: `${name}: ${error instanceof Error ? error.message : String(error)}` };
		} finally {
			unwatch();
			unwatchTasks();
			if (stallTimer !== undefined) clearTimeout(stallTimer);
			signal.removeEventListener("abort", stopChild);
			forgetStructuredOutput(run.sessionId, name);
		}
	}
	const stagger = new WorkflowPrefixStagger();
	return {
		async run(request: WorkflowAgentRequest, signal: AbortSignal): Promise<WorkflowAgentReport> {
			const prefix = await stagger.take(workflowPrefixKey(request.options), { concurrency: request.concurrency, staggerMs: request.options.prefixStaggerMs ?? WORKFLOW_PREFIX_STAGGER_MS, warmMs: request.options.prefixWarmMs ?? WORKFLOW_PREFIX_WARM_MS }, signal);
			const seconds = Math.round((request.options.stallMs ?? DEFAULT_STALL_MS) / 1000);
			try {
				for (let attempt = 1; ; attempt++) {
					if (signal.aborted) return { kind: "died", reason: "aborted" };
					let report: WorkflowAgentReport | { readonly kind: "stalled" };
					try {
						report = await spawnChild(request, signal, prefix);
					} catch (error) {
						if (attempt === 1) throw error;
						return { kind: "died", reason: `${labelOf(request)}: restart refused: ${error instanceof Error ? error.message : String(error)}` };
					}
					if (report.kind !== "stalled") return report;
					if (attempt === STALL_ATTEMPTS) return { kind: "died", reason: `stalled on all ${STALL_ATTEMPTS} attempts (no progress for ${seconds}s each)` };
					seat.progress(run, { type: "log", message: `${labelOf(request)} stalled (no progress for ${seconds}s); starting it again fresh, attempt ${attempt + 1} of ${STALL_ATTEMPTS}` });
				}
			} finally {
				prefix.release();
			}
		},
	};
}
