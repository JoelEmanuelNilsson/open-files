/**
 * workflow — the `Workflow` tool (ticket 23, map C17/C20): a JavaScript
 * script that starts one child per item, collects the answers, and returns
 * them, running in the background on the agent engine (ticket 19) so that
 * only its return value and its failures ever enter the seat's context.
 *
 * What this file owns: the tool and its refusals, the run directory
 * (`<sessionDir>/workflows/<runId>/` — `script.js`, `journal.jsonl`,
 * `run.json`), the run as a registry entry (so `ListAgents`, `TaskOutput`,
 * `TaskStop` and the dock treat it like any agent), the spawner that turns
 * the script's `agent()` into an engine child with the workflow tail, a
 * structured-output contract and a stall watchdog, the `StructuredOutput`
 * tool that only a workflow child carries and only a workflow child may use
 * (`lib/tool-policy.ts` cuts it off every other seat's wire), and `/workflows`.
 *
 * What it does not own: the scheduler and the failure table
 * (`lib/workflow-runtime.ts`), the sandbox (`lib/workflow-sandbox.ts`), the
 * journal (`lib/workflow-journal.ts`), the meta reader
 * (`lib/workflow-meta.ts`), the schema check
 * (`lib/workflow-structured-output.ts`), the words
 * (`lib/workflow-tool-text.ts`). Deferred to ticket 25: budget, nesting,
 * retry-one-agent.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { markAgentLive } from "../lib/agent-live-count.ts";
import { jsonArgumentCoercionFor } from "../lib/tool-argument-coercion.ts";
import { type AgentRecord, agentIsSettled, agentNameOf } from "../lib/agent-registry.ts";
import { type AgentProgressEvent, type AgentRuntime, descendantStoppers, shortId } from "../lib/agent-runtime.ts";
import { agentRuntimeOf } from "../lib/agent-runtime-seam.ts";
import { AGENT_DEPTH_CAP, DEPTH_LIMIT_ERROR } from "../lib/agent-tool-text.ts";
import { notice } from "../lib/notice.ts";
import { childSeatOf } from "../lib/seat.ts";
import { coerceWorkflowArgs, WORKFLOW_ARGS_COERCED_LOG } from "../lib/workflow-args.ts";
import { readWorkflowJournal, WorkflowJournal, type WorkflowJournalIndex } from "../lib/workflow-journal.ts";
import { extractWorkflowMeta, WorkflowMetaError } from "../lib/workflow-meta.ts";
import { WORKFLOW_PREFIX_STAGGER_MS, WORKFLOW_PREFIX_WARM_MS, type WorkflowPrefixLease, WorkflowPrefixStagger, workflowPrefixKey } from "../lib/workflow-prefix-stagger.ts";
import { runWorkflow, type WorkflowAgentReport, type WorkflowAgentRequest, type WorkflowAgentSpawner, type WorkflowRunEvent, WorkflowRunError } from "../lib/workflow-runtime.ts";
import { forgetWorkflowRuns, type WorkflowRun, type WorkflowRunAgent, type WorkflowRunFailure, workflowRunOutcomeCounts, workflowRunPhases, type WorkflowRunStore, workflowRunsOf } from "../lib/workflow-runs.ts";
import {
	declareStructuredOutput,
	forgetStructuredOutput,
	noteStructuredOutputMissed,
	prepareStructuredOutputArguments,
	recordStructuredOutputAttempt,
	STRUCTURED_OUTPUT_ACCEPTED_TEXT,
	STRUCTURED_OUTPUT_DESCRIPTION,
	STRUCTURED_OUTPUT_NOT_A_WORKFLOW_CHILD,
	STRUCTURED_OUTPUT_PARAMS,
	STRUCTURED_OUTPUT_TOOL_NAME,
	structuredOutputContractOf,
	structuredOutputExhaustedText,
	structuredOutputInstruction,
	structuredOutputRetryText,
} from "../lib/workflow-structured-output.ts";
import { WORKFLOW_CHILD_CONTRACT, WORKFLOW_DESCRIPTION, WORKFLOW_IN_WORKFLOW_CHILD, WORKFLOW_PARAMS, WORKFLOW_RESUME_RULE, WORKFLOW_RUN_ID_PATTERN, WORKFLOW_SCRIPT_MAX_LENGTH, WORKFLOW_TOOL_NAME } from "../lib/workflow-tool-text.ts";

/** The registry `type` of a workflow run's own record. */
export const WORKFLOW_RECORD_TYPE = "workflow";

/** `/workflows` with nothing to show. True of a session that has run none, which is the only time it prints. */
export const WORKFLOWS_EMPTY_TEXT = "No workflow runs in this session.";

/** Where the live version of the same tree is. `/workflows` is a printout; the dock's view moves. */
export const WORKFLOWS_VIEW_HINT = "↓ then enter on the run for the live view.";

/** One glyph per agent state in `/workflows`' printout. The run view draws its own, in colour. */
export const WORKFLOW_AGENT_GLYPH = { running: "…", cached: "≡", done: "✓", failed: "✗", skipped: "⊘" } as const;

/** The nudge a schema child gets when its turn ended with no `StructuredOutput` call. */
export const STRUCTURED_OUTPUT_NUDGE = `You ended without calling ${STRUCTURED_OUTPUT_TOOL_NAME}. Call it now, exactly once, with \`result\` matching the JSON Schema in your first message.`;

/** After its result is recorded, how long a child may take to end its turn before it is stopped. */
const ACCEPTED_GRACE_MS = 60_000;

/** One slice of the wait for a child, re-armed after every interruption and every timeout: the stall watchdog and the run's abort are what bound a child. */
const WAIT_SLICE_MS = 2 * 60 * 60_000;

/** How long a child may go with no streamed tokens, no tool call and no turn end, while none of its tool calls is running, before it is stopped as stalled (ticket 54 §4). */
const DEFAULT_STALL_MS = 180_000;

/** Attempts a stalling child gets in all. With tools pausing the clock a stall is a hung stream, and a fresh start is the remedy. */
const STALL_ATTEMPTS = 3;

const workflowParams = Type.Object({
	script: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.script, maxLength: WORKFLOW_SCRIPT_MAX_LENGTH })),
	scriptPath: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.scriptPath })),
	name: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.name })),
	// Any JSON value, spelled out: `Type.Unknown` renders as `{}`, and a model given no type writes the value as text (ticket 55).
	args: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()], { description: WORKFLOW_PARAMS.args })),
	resumeFromRunId: Type.Optional(Type.String({ description: WORKFLOW_PARAMS.resumeFromRunId, pattern: WORKFLOW_RUN_ID_PATTERN })),
});

/** `run.json`: what a resume needs to know about the run it replays. */
interface WorkflowRunManifest {
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
	/** Every failure; the parent's result shows the first {@link WORKFLOW_RESULT_FAILURES_SHOWN} and points here for the rest. */
	failures?: readonly WorkflowRunFailure[];
}

/**
 * One live run's controls. What the run *looks like* — its phases, its agents,
 * its log tail — lives in the session's `WorkflowRunStore`, where the dock
 * reads it and where it survives the run's own end.
 */
interface LiveWorkflowRun {
	readonly runId: string;
	readonly taskId: string;
	readonly name: string;
	/** The session that started it and that session's store, held so a run settling after the session ended writes where it began. */
	readonly sessionId: string;
	readonly store: WorkflowRunStore;
	readonly controller: AbortController;
	/** Task ids of every child this run spawned, so a stop reaches exactly them. */
	readonly children: Set<string>;
	done: Promise<void>;
}

/** An expected refusal, thrown so pi marks the tool result as an error (see `agent-engine.ts`). */
function refuse(message: string): never {
	throw new Error(message);
}

function newRunId(): string {
	return `wf_${randomBytes(6).toString("hex")}`;
}

/**
 * What a workflow result may put into the parent's context whole: what the
 * parent can read in one go, not what fits (ticket 58).
 *
 * The old cap was 100 000 chars — 25 000 tokens of a context the tool promises
 * to cost nothing, spent on a truncated JSON the parent then read from disk
 * with `jq` anyway, because half a JSON is unreadable as JSON.
 */
export const WORKFLOW_RESULT_HEAD_MAX_CHARS = 8_000;

/** How much of a too-big value rides with its shape: enough to see what the values look like, not enough to matter. */
export const WORKFLOW_RESULT_PREFIX_CHARS = 2_000;

/** Where the whole value went: a path on disk, or the reason it is not there. */
export type WorkflowResultOnDisk = { readonly path: string } | { readonly path: string; readonly writeError: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One value's type and size, in the words a `jq` filter is written from: `array of 178`, `string of 4102 chars`, `true`. */
function shapeOf(value: unknown): string {
	if (Array.isArray(value)) return `array of ${value.length}`;
	if (typeof value === "string") return `string of ${value.length} chars`;
	if (isPlainObject(value)) return `object with ${Object.keys(value).length} keys`;
	return JSON.stringify(value) ?? String(value);
}

/** The shape one level down: a line per top-level key, or the first element of an array. Nothing for a scalar — {@link shapeOf} already said it. */
function memberShapeLines(value: unknown): string[] {
	if (isPlainObject(value)) return Object.entries(value).map(([key, member]) => `  .${key} — ${shapeOf(member)}`);
	if (Array.isArray(value) && value.length > 0) return [`  [0] — ${shapeOf(value[0])}`];
	return [];
}

/**
 * The return value as the parent reads it: whole under
 * {@link WORKFLOW_RESULT_HEAD_MAX_CHARS}, otherwise its path, its shape and its
 * first {@link WORKFLOW_RESULT_PREFIX_CHARS} chars — everything needed to write
 * the `jq` that reads the rest, and nothing else.
 */
export function headWorkflowResult(value: unknown, rendered: string, whole: WorkflowResultOnDisk): string {
	if (rendered.length <= WORKFLOW_RESULT_HEAD_MAX_CHARS) return rendered;
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

/** A run's files, as the lines that point at them name them. */
export interface WorkflowRunFiles {
	readonly runId: string;
	readonly scriptPath: string;
	readonly journalPath: string;
	readonly manifestPath: string;
}

/** `2 run (1 failed), 3 cached`: a skip is a choice and a failure is not, so each is counted apart. */
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

/**
 * What follows the value in the parent's result: how many agents ran, a line
 * per failure, and the resume call whenever there is something to run again.
 * Without it, three dead agents out of fifty reached the parent as three nulls.
 */
export function workflowRunReport(run: WorkflowRun | undefined, files: WorkflowRunFiles, ended: "completed" | "stopped" | "error"): string[] {
	const agents = run?.agents ?? [];
	const failures = run?.failures ?? [];
	const lines = agents.length > 0 ? [`[agents: ${agentCounts(agents)}]`] : [];
	if (failures.length > 0) {
		lines.push(`[failures: ${failures.length}]`, ...failures.slice(0, WORKFLOW_RESULT_FAILURES_SHOWN).map(failureLine));
		if (failures.length > WORKFLOW_RESULT_FAILURES_SHOWN) lines.push(`… and ${failures.length - WORKFLOW_RESULT_FAILURES_SHOWN} more in ${files.manifestPath} (.failures)`);
	}
	if (ended === "completed" && failures.length === 0) return lines;
	// pi retries rate limits and overloads itself; what still kills a child is a quota, which comes back until it resets.
	const limitHint = failures.some((failure) => failure.kind === "agent" && !failure.skipped) ? " A failure that names a usage limit fails again until that limit resets: resume after the reset." : "";
	lines.push(`[resume] Workflow({scriptPath: "${files.scriptPath}", resumeFromRunId: "${files.runId}"}) reads ${files.journalPath}. ${WORKFLOW_RESUME_RULE}${limitHint}`);
	return lines;
}

/** The run's return value as the record's `result` text; a string stays raw. The value is JSON data (`WorkflowRunResult.value`), so JSON writes it whole. */
export function renderWorkflowReturnValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export default function workflow(pi: ExtensionAPI) {
	let sessionId = "";
	let sessionDir = "";
	let uiCtx: ExtensionContext | undefined;
	const live = new Map<string, LiveWorkflowRun>();
	// Names of workflow children whose spawn is in flight. The registry learns a name only once the engine has made
	// the child's worktree, so a sibling that checked the registry alone would take the same name, and with it the
	// same StructuredOutput contract, nudge address and branch.
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

	/** The session's run store: written here, read by the dock's views and by `/workflows`. */
	const runs = (): WorkflowRunStore => workflowRunsOf(sessionId);

	function notify(message: string): void {
		if (uiCtx?.hasUI) uiCtx.ui.notify(message, "info");
	}

	// ---- the run directory ---------------------------------------------------------

	const runDir = (runId: string) => join(sessionDir, "workflows", runId);
	const manifestPath = (runId: string) => join(runDir(runId), "run.json");

	function readManifest(runId: string): WorkflowRunManifest | undefined {
		try {
			return JSON.parse(readFileSync(manifestPath(runId), "utf8")) as WorkflowRunManifest;
		} catch {
			return undefined;
		}
	}

	function writeManifest(manifest: WorkflowRunManifest): void {
		writeFileSync(manifestPath(manifest.runId), `${JSON.stringify(manifest, null, 2)}\n`);
	}

	/** `scriptPath` > `script` > `name`. */
	function resolveSource(params: { script?: string; scriptPath?: string; name?: string }): { source: string; from: string } {
		if (params.scriptPath !== undefined && params.scriptPath.trim() !== "") {
			try {
				return { source: readFileSync(params.scriptPath, "utf8"), from: params.scriptPath };
			} catch (error) {
				return refuse(`Unreadable scriptPath ${params.scriptPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (params.script !== undefined && params.script.trim() !== "") return { source: params.script, from: "script" };
		if (params.name !== undefined && params.name.trim() !== "") {
			const file = join(getAgentDir(), "workflows", `${params.name.trim()}.js`);
			if (!existsSync(file)) return refuse(`Unknown workflow name "${params.name}": no ${file}. Pass the script inline via \`script\` instead.`);
			return { source: readFileSync(file, "utf8"), from: file };
		}
		return refuse("Workflow needs one of `script`, `scriptPath` or `name`.");
	}

	// ---- the spawner: agent() → an engine child ------------------------------------------

	// Same-prefix siblings all pay the prompt-cache write unless one leads: the first child of a key
	// spawns, the rest wait for its first turn or the cap, then the key is warm
	// (`lib/workflow-prefix-stagger.ts`). The wait precedes the spawn, so no stall clock is running.

	function spawnerFor(runtime: AgentRuntime, run: LiveWorkflowRun, costs: { usd: number; tokens: number; output: number }): WorkflowAgentSpawner {
		/** The settled record, or `aborted`; with `withinMs`, `timeout` once that long has passed with the child still going. */
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
		function count(record: AgentRecord): void {
			costs.usd += record.costUsd;
			costs.tokens += record.totalTokens;
			costs.output += record.outputTokens;
		}
		// A child stopped from the dock or by `TaskStop` was skipped on purpose
		// (ticket 54's ruling); one the run stopped itself — a stall, a cascade —
		// simply died. Only the first is a choice, so only the first reads as one.
		function died(record: AgentRecord): WorkflowAgentReport {
			const skipped = record.stoppedBy === "dock" || record.stoppedBy === "TaskStop";
			if (skipped) return { kind: "died", reason: `${record.name} skipped by hand`, skipped: true };
			return { kind: "died", reason: `${record.name} ${record.status}${record.error ? `: ${record.error}` : ""}` };
		}
		const labelOf = (request: WorkflowAgentRequest) => request.options.label ?? `${run.name}:${request.ordinal}`;
		/** One attempt at one child, from its name to its report; the caller owns the prefix lease and the restart after a stall. Throws only for a refused spawn. */
		async function spawnChild(request: WorkflowAgentRequest, signal: AbortSignal, prefix: WorkflowPrefixLease): Promise<WorkflowAgentReport | { readonly kind: "stalled" }> {
			const base = labelOf(request);
			const taken = (candidate: string) => runtime.registry.byName(candidate) !== undefined || spawningNames.has(candidate);
			let name = base;
			while (taken(name)) name = runtime.registry.nextName(base);
			spawningNames.add(name);
			const schema = request.options.schema;
			const contract = schema !== undefined ? declareStructuredOutput(run.sessionId, name, schema) : undefined;
			contract?.outcome.catch(() => {});
			const prompt = [WORKFLOW_CHILD_CONTRACT, request.prompt, ...(schema !== undefined ? [structuredOutputInstruction(schema)] : [])].join("\n\n");
			let record: AgentRecord;
			try {
				record = await runtime.spawn({
					description: (request.options.label ?? request.prompt.split("\n")[0] ?? "workflow agent").slice(0, 60),
					prompt,
					name,
					workflowChild: true,
					// Its journal `after` is the world its first prompt meets, however long the session took to start or the engine held it.
					onFirstPrompt: request.started,
					...(request.options.type !== undefined ? { subagentType: request.options.type } : {}),
					...(request.options.model !== undefined ? { model: request.options.model } : {}),
					...(request.options.thinking !== undefined ? { thinking: request.options.thinking } : {}),
					...(request.options.isolation !== undefined ? { isolation: request.options.isolation } : {}),
				});
			} catch (error) {
				// A refused spawn — an unknown type, a worktree that cannot be made — rejects this agent() alone, as in Claude Code.
				forgetStructuredOutput(run.sessionId, name);
				throw error;
			} finally {
				spawningNames.delete(name);
			}
			let taskId = record.taskId;
			const stopChild = () => runtime.stop(taskId, "workflow").catch(() => undefined);
			signal.addEventListener("abort", stopChild, { once: true });
			// Called for every child this attempt starts. One that lands after the run ended missed the abort and the
			// run's own sweep; the wait that follows sees the abort at once, and abandoned() stops it.
			const adopt = () => {
				run.children.add(taskId);
				// The ordinal → task-id route the run's view is joined on, and the prompt
				// the script wrote, which nobody else keeps: the engine stores what it
				// sent, contract and all.
				run.store.noteSpawn(run.runId, request.ordinal, { taskId, prompt: request.prompt });
			};
			adopt();
			const stallMs = request.options.stallMs ?? DEFAULT_STALL_MS;
			let stalled = false;
			let stallTimer: ReturnType<typeof setTimeout> | undefined;
			// A tool call runs silent for as long as its work takes — a test suite, a build — so the clock
			// stops while any is in flight; a tool that never returns is its own timeout's to end.
			const toolsInFlight = new Set<string>();
			const rearmStall = () => {
				if (stallTimer !== undefined) clearTimeout(stallTimer);
				stallTimer =
					toolsInFlight.size > 0
						? undefined
						: setTimeout(() => {
								stalled = true;
								void stopChild();
							}, stallMs);
			};
			// The first turn ending is when this child's prompt prefix is written: its same-key siblings may go.
			const onProgress = (event: AgentProgressEvent) => {
				if (event.type === "turn_end") prefix.firstTurn();
				if (event.type === "tool_execution_start") toolsInFlight.add(event.toolCallId);
				if (event.type === "tool_execution_end") toolsInFlight.delete(event.toolCallId);
				rearmStall();
			};
			let unwatch = runtime.watchProgress(taskId, onProgress);
			rearmStall();
			// A child we stopped ourselves settles as `stopped`; the reason it reads is why we stopped it.
			const report = (final: AgentRecord): WorkflowAgentReport | { readonly kind: "stalled" } => (stalled ? { kind: "stalled" } : died(final));
			// A child given up mid-turn is stopped, and what it spent is the run's all the same.
			const abandoned = async (reason: string): Promise<WorkflowAgentReport> => {
				await stopChild();
				const final = runtime.registry.byTaskId(taskId);
				if (final !== undefined) count(final);
				return { kind: "died", reason };
			};
			try {
				// The name asked was made unique, and the contract and the nudge keyed on it: a child named otherwise is not the one they mean.
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
					// Its turn ended with no call: one attempt spent; resume it from its transcript with the nudge.
					const missed = noteStructuredOutputMissed(contract);
					// The contract was rejected with the same words the tool path reports, so both read alike.
					if (missed.kind === "exhausted") return { kind: "schema-exhausted", reason: await contract.outcome.then(() => missed.errors, (error: Error) => error.message) };
					if (missed.kind === "already-recorded") return { kind: "completed", value: await contract.outcome };
					const sent = await runtime.send(name, STRUCTURED_OUTPUT_NUDGE, false);
					taskId = sent.record.taskId;
					adopt();
					unwatch();
					unwatch = runtime.watchProgress(taskId, onProgress);
					// The set is the watched run's; a call the last one never saw end would pause this one's stall clock for good.
					toolsInFlight.clear();
					rearmStall();
				}
			} catch (error) {
				// Past the spawn a child exists, so a throw (a nudge the engine cannot send) is its death, not a refusal.
				await stopChild();
				return { kind: "died", reason: `${name}: ${error instanceof Error ? error.message : String(error)}` };
			} finally {
				unwatch();
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
							// Only the first spawn precedes every child: a restart refused comes after one ran, so it is that child's death.
							if (attempt === 1) throw error;
							return { kind: "died", reason: `${labelOf(request)}: restart refused: ${error instanceof Error ? error.message : String(error)}` };
						}
						if (report.kind !== "stalled") return report;
						if (attempt === STALL_ATTEMPTS) return { kind: "died", reason: `stalled on all ${STALL_ATTEMPTS} attempts (no progress for ${seconds}s each)` };
						progress(run, { type: "log", message: `${labelOf(request)} stalled (no progress for ${seconds}s); starting it again fresh, attempt ${attempt + 1} of ${STALL_ATTEMPTS}` });
					}
				} finally {
					prefix.release();
				}
			},
		};
	}

	// ---- the run ---------------------------------------------------------------------------

	/** The run's own row in the dock. `runId` is what opens its view; the model is the seat's, which is what runs the script. */
	function lifecyclePayload(record: AgentRecord, runId: string): Record<string, unknown> {
		return {
			id: record.taskId,
			name: record.name,
			type: record.type,
			description: record.description,
			model: record.model,
			runId,
			workflowChild: false,
			status: record.status,
			toolUses: record.toolUses,
			durationMs: record.completedAt !== undefined ? record.completedAt - record.startedAt : 0,
			...(record.result !== undefined ? { result: record.result } : {}),
			...(record.error !== undefined ? { error: record.error } : {}),
			usage: { cost: { total: record.costUsd } },
		};
	}

	function progress(run: LiveWorkflowRun, event: WorkflowRunEvent): void {
		run.store.apply(run.runId, event);
		if (event.type === "log") notify(`${run.name}: ${event.message}`);
		// The event still goes out: the dock repaints on it, and the fold it would
		// otherwise have to do itself is already done above.
		pi.events.emit("workflow:progress", { runId: run.runId, taskId: run.taskId, ...event });
	}

	function startRun(runtime: AgentRuntime, options: { source: string; args: unknown; argsCoerced: boolean; meta: { name: string; description: string }; runId: string; resumedFrom: string | undefined; priorJournal: WorkflowJournalIndex | undefined; toolCallId: string }): AgentRecord {
		const { runId, meta } = options;
		const controller = new AbortController();
		// Its children are named after it, so it is named by the engine's rule too.
		const asked = agentNameOf(meta.name) ?? runtime.registry.nextName(WORKFLOW_RECORD_TYPE);
		const name = runtime.registry.byName(asked) === undefined ? asked : runtime.registry.nextName(asked);
		const model = runtime.host.model();
		const record = runtime.registry.put({
			name,
			taskId: shortId(),
			ownerSessionId: sessionId,
			type: WORKFLOW_RECORD_TYPE,
			description: meta.description,
			status: "running",
			depth: runtime.host.depth + 1,
			sessionFile: undefined,
			sessionId: runId,
			cwd: runtime.host.cwd,
			branch: undefined,
			model: model !== undefined ? `${model.provider}/${model.id}` : "",
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
		});
		const run: LiveWorkflowRun = { runId, taskId: record.taskId, name, sessionId, store: runs(), controller, children: new Set(), done: Promise.resolve() };
		live.set(runId, run);
		run.store.start({ runId, taskId: record.taskId, name, description: meta.description, startedAt: record.startedAt });
		markAgentLive(sessionId, record.taskId);
		// Registered before the run starts: `TaskStop`, the dock and a parent's
		// cascade all reach the run through this, and `run.done` is read when called.
		descendantStoppers().set(record.taskId, async () => {
			controller.abort();
			await run.done;
		});
		runtime.host.emit("subagents:created", lifecyclePayload(record, runId));
		runtime.host.emit("subagents:started", lifecyclePayload(record, runId));
		if (options.argsCoerced) progress(run, { type: "log", message: WORKFLOW_ARGS_COERCED_LOG });
		const costs = { usd: 0, tokens: 0, output: 0 };
		const journal = new WorkflowJournal(join(runDir(runId), "journal.jsonl"), options.priorJournal);
		const manifest = readManifest(runId);
		const files: WorkflowRunFiles = { runId, scriptPath: join(runDir(runId), "script.js"), journalPath: join(runDir(runId), "journal.jsonl"), manifestPath: manifestPath(runId) };

		run.done = (async () => {
			let status: AgentRecord["status"] = "completed";
			let result: string | undefined;
			let error: string | undefined;
			try {
				const outcome = await runWorkflow({
					source: options.source,
					args: options.args,
					journal,
					spawner: spawnerFor(runtime, run, costs),
					emit: (event) => progress(run, event),
					signal: controller.signal,
				});
				const header = options.resumedFrom !== undefined ? `[resumed from ${options.resumedFrom} — ${outcome.replaySummary}]\n` : "";
				const rendered = renderWorkflowReturnValue(outcome.value);
				const resultPath = join(runDir(runId), "result.json");
				// The whole value always lands on disk; a full disk must not fail a run that finished, but the banner must not name a file that is not there.
				let whole: WorkflowResultOnDisk = { path: resultPath };
				try {
					writeFileSync(resultPath, rendered);
				} catch (thrown) {
					whole = { path: resultPath, writeError: thrown instanceof Error ? thrown.message : String(thrown) };
				}
				const report = workflowRunReport(run.store.get(runId), files, "completed");
				result = [headWorkflowResult(outcome.value, `${header}${rendered}`, whole), ...(report.length > 0 ? ["", ...report] : [])].join("\n");
				if (manifest !== undefined) Object.assign(manifest, { status: "completed", completedAt: Date.now(), value: outcome.value, replay: outcome.replaySummary });
			} catch (thrown) {
				const message = thrown instanceof Error ? thrown.message : String(thrown);
				status = thrown instanceof WorkflowRunError && thrown.reason === "stopped" ? "stopped" : "error";
				error = message;
				result = workflowRunReport(run.store.get(runId), files, status).join("\n");
				if (manifest !== undefined) Object.assign(manifest, { status, completedAt: Date.now(), error: message });
			} finally {
				journal.close();
				if (manifest !== undefined) {
					manifest.failures = run.store.get(runId)?.failures ?? [];
					// A throw here would skip the rest of this block and leave the run running forever.
					try {
						writeManifest(manifest);
					} catch (thrown) {
						const note = `[run.json not updated: ${thrown instanceof Error ? thrown.message : String(thrown)}]`;
						result = result ? `${result}\n\n${note}` : note;
					}
				}
				// A child still mid-turn when the script ended — a cap threw, a stop — goes too; nobody would read it.
				for (const childId of run.children) {
					if (!agentIsSettled(runtime.registry.byTaskId(childId)?.status ?? "completed")) void runtime.stop(childId, "workflow").catch(() => undefined);
				}
				live.delete(runId);
				// The controls go; the tree stays. A run's view is opened to watch it
				// finish, and it used to go blank at exactly the moment it did.
				run.store.settle(runId, status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed", Date.now());
				descendantStoppers().delete(record.taskId);
			}
			const current = runtime.registry.byName(name);
			// `toolUses` counts tool calls; a run makes none. How many agents it ran
			// is the run store's answer, and the row asks it there.
			const settledRecord: AgentRecord = { ...record, status, result, error, toolUses: 0, costUsd: costs.usd, totalTokens: costs.tokens, outputTokens: costs.output, completedAt: Date.now(), readBy: undefined, readAt: undefined };
			const stored = current?.taskId === record.taskId ? runtime.registry.put(settledRecord) : settledRecord;
			// Announced and delivered by the engine's one settle path, so a workflow
			// run arrives under the same rule as any other child (ticket 09).
			runtime.publishSettled(stored);
		})();
		return record;
	}

	// ---- Workflow --------------------------------------------------------------------------

	pi.registerTool({
		name: WORKFLOW_TOOL_NAME,
		label: "Workflow",
		description: WORKFLOW_DESCRIPTION,
		parameters: workflowParams,
		prepareArguments: jsonArgumentCoercionFor(workflowParams),
		async execute(toolCallId, params) {
			const runtime = agentRuntimeOf(sessionId);
			if (runtime === undefined) return refuse("Agent engine is not ready: no session yet.");
			if (childSeatOf(sessionId)?.workflowChild === true) return refuse(WORKFLOW_IN_WORKFLOW_CHILD);
			if (runtime.host.depth >= AGENT_DEPTH_CAP) return refuse(DEPTH_LIMIT_ERROR);
			const { source, from } = resolveSource(params);
			let meta: ReturnType<typeof extractWorkflowMeta>["meta"];
			try {
				meta = extractWorkflowMeta(source).meta;
			} catch (error) {
				if (error instanceof WorkflowMetaError) return refuse(error.message);
				throw error;
			}
			let resumedFrom: string | undefined;
			let prior: WorkflowRunManifest | undefined;
			if (params.resumeFromRunId !== undefined) {
				prior = readManifest(params.resumeFromRunId);
				if (prior === undefined) return refuse(`No run ${params.resumeFromRunId} under ${join(sessionDir, "workflows")}.`);
				if (prior.sessionId !== sessionId) return refuse(`Run ${params.resumeFromRunId} belongs to another session; resume is same-session only.`);
				const running = live.get(params.resumeFromRunId);
				if (running !== undefined) {
					running.controller.abort();
					await running.done;
				}
				resumedFrom = params.resumeFromRunId;
			}
			const runId = newRunId();
			mkdirSync(runDir(runId), { recursive: true });
			const scriptPath = join(runDir(runId), "script.js");
			writeFileSync(scriptPath, source);
			// The manifest records the value the script ran on, never the raw string: it is what a reader and a resume trust.
			// A resume that names no args runs on the prior run's, so the resume call a result prints is one that works.
			const args = params.args === undefined && prior !== undefined ? { value: prior.args, coerced: false } : coerceWorkflowArgs(params.args);
			writeManifest({ runId, sessionId, name: meta.name, description: meta.description, args: args.value, resumedFrom, startedAt: Date.now(), status: "running" });
			// Counted before the run starts: a replayed hit is taken out of the index.
			const priorJournal = resumedFrom !== undefined ? readWorkflowJournal(join(runDir(resumedFrom), "journal.jsonl")) : undefined;
			const priorEntries = priorJournal !== undefined ? [...priorJournal.values()].reduce((sum, list) => sum + list.length, 0) : 0;
			const record = startRun(runtime, { source, args: args.value, argsCoerced: args.coerced, meta, runId, resumedFrom, priorJournal, toolCallId });
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

	// ---- StructuredOutput: on every seat, honoured only in a workflow child -----------------------

	pi.registerTool({
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		label: "StructuredOutput",
		description: STRUCTURED_OUTPUT_DESCRIPTION,
		parameters: STRUCTURED_OUTPUT_PARAMS,
		prepareArguments: prepareStructuredOutputArguments,
		async execute(_toolCallId, params) {
			const seat = childSeatOf(sessionId);
			const contract = seat !== undefined ? structuredOutputContractOf(seat.parentSessionId, seat.name) : undefined;
			if (contract === undefined) return refuse(STRUCTURED_OUTPUT_NOT_A_WORKFLOW_CHILD);
			const attempt = recordStructuredOutputAttempt(contract, params.result);
			switch (attempt.kind) {
				case "accepted":
					return { content: [{ type: "text", text: STRUCTURED_OUTPUT_ACCEPTED_TEXT }], details: undefined };
				case "already-recorded":
					return { content: [{ type: "text", text: "Already recorded. End your turn now." }], details: undefined };
				case "rejected":
					return refuse(structuredOutputRetryText(attempt));
				case "exhausted":
					return refuse(structuredOutputExhaustedText(attempt.errors));
			}
		},
	});

	// ---- /workflows ---------------------------------------------------------------------------

	/** One run as text: its phases, their agents, and its log tail. */
	function renderRun(run: WorkflowRun): string[] {
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

	pi.registerCommand("workflows", {
		description: "Workflow runs: phases, agents, and the last log lines",
		handler: async (_args, ctx) => {
			const all = runs().list();
			// A run that ended is still a run this session made. The old text said
			// `No workflow running.` the instant one finished, which read as "there
			// was never anything here" on the screen the tool tells you to watch.
			const text = all.length === 0 ? WORKFLOWS_EMPTY_TEXT : [...all.flatMap(renderRun), "", WORKFLOWS_VIEW_HINT].join("\n");
			notice(ctx, text, "info");
		},
	});
}
