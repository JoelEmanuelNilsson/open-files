/**
 * The workflow runtime: runs one script (`lib/workflow-sandbox.ts`) and owns
 * every hook the script calls. All the throttling lives in `agent()` — the
 * semaphore, the lifetime cap, the journal — which is what lets `pipeline`
 * and `parallel` be naive; a concurrency gate inside them would deadlock a
 * `parallel` nested in a `pipeline` stage.
 *
 * The failure table (ticket 23, asset §4.5):
 *
 *   child dies (terminal error, stopped by Joel)  → agent() returns null; journalled
 *                                                     as failed, never as a result, so a
 *                                                     resumed run re-runs it
 *   no tokens, no tool call and no turn end        → the child is stopped and started again
 *     for stallMs (default 180 s) while none of        fresh, 3 attempts in all; after the
 *     its tool calls is running                        third, or a restart refused, a death
 *   schema validation fails 3×                      → a death too: null, journalled as
 *                                                     failed, agent-failed carries the
 *                                                     validator's last errors; the run goes on
 *   thunk throws inside parallel                    → that slot is null; never rejects
 *   stage throws inside pipeline                    → that item is null, later stages skipped
 *   null item, or a stage returns null              → that item is null, later stages skipped
 *   a promise the script never handles rejects      → a failure in the result; the run goes on
 *   a schema that is not an object schema           → throw, before any child is spawned
 *   type: 'lead'                                    → throw, before any child is spawned
 *   > 1000 lifetime agents                          → throw (runaway backstop)
 *   > 4096 items in one call                        → throw, never silent truncation
 *   a spawn the engine refuses (unknown type)       → that agent() throws; announced as failed,
 *                                                     never journalled: no child ran
 *   a child the engine names otherwise than asked   → stopped at once, and a death
 *   an author error in the script                   → throw
 *
 * The caps, a bad schema and a stop are {@link WorkflowRunError}s, and one
 * ends the run the moment a hook throws it: the sandbox decides on the host's
 * own error and parks the script, so no stage, thunk or `catch` can fold a
 * run-level stop into a dud. The other throws reach the script as its own
 * errors; inside a stage or thunk they become `null`.
 *
 * Children are spawned through a {@link WorkflowAgentSpawner} the extension
 * supplies on top of the agent engine; this file never sees a session.
 */

import os from "node:os";
import { agentNameOf } from "./agent-registry.ts";
import { AGENT_THINKING_LEVEL_LIST, type AgentThinkingLevel, isAgentThinkingLevel } from "./agent-types.ts";
import { type WorkflowJournal, workflowCacheKey } from "./workflow-journal.ts";
import { structuredOutputSchemaRefusal } from "./workflow-structured-output.ts";
import { extractWorkflowMeta, type WorkflowMeta } from "./workflow-meta.ts";
import { startWorkflowScript, type WorkflowScriptCalls, type WorkflowScriptRun, type WorkflowScriptSettled } from "./workflow-sandbox.ts";

/** What `agent(prompt, opts)` accepts. `label` and `phase` are display-only; they, `stallMs` and the prefix durations stay out of the cache key. A `label` arrives trimmed, and a blank one as none. */
export interface WorkflowAgentOptions {
	readonly schema?: unknown;
	readonly model?: string;
	readonly thinking?: AgentThinkingLevel;
	readonly type?: string;
	readonly isolation?: "worktree";
	readonly label?: string;
	readonly phase?: string;
	/** Milliseconds with no streamed tokens, no tool call and no turn end, while none of its tool calls runs, before the child is stopped as stalled and started again fresh. */
	readonly stallMs?: number;
	/** Milliseconds a same-prefix sibling waits for its leader's first turn before spawning anyway. */
	readonly prefixStaggerMs?: number;
	/** Milliseconds a written prefix counts as warm, so same-prefix children spawn at once. */
	readonly prefixWarmMs?: number;
}

/** One child, as the spawner receives it. */
export interface WorkflowAgentRequest {
	readonly prompt: string;
	readonly options: WorkflowAgentOptions;
	/** 1-based, in call order — the display name when there is no label. */
	readonly ordinal: number;
	readonly phase: string | undefined;
	/** The run's concurrency cap: at 1 children never overlap, so the spawner skips the prefix stagger. */
	readonly concurrency: number;
	/** Call each time a child really starts — as its first prompt is sent, after every hold and on every restart. The journal `after` is read at the last call, else as the report comes back: a late read only turns a hit into a miss. */
	readonly started: () => void;
}

/** What the spawner learned; the runtime applies the failure table to it. */
export type WorkflowAgentReport =
	| { readonly kind: "completed"; readonly value: unknown }
	| { readonly kind: "died"; readonly reason: string; readonly skipped?: boolean }
	/** `reason` carries the validator's last errors. */
	| { readonly kind: "schema-exhausted"; readonly reason: string };

/**
 * The seam to the agent engine; `signal` aborts when the run is stopped or ends,
 * and the run settles only once every `run` has returned, so a child's cost is
 * counted before the result is published. `run` throws only for a spawn the
 * engine refused (an unknown type), before any child exists; that rejects the
 * agent() call alone. Once a child exists, whatever befalls it is a report.
 */
export interface WorkflowAgentSpawner {
	run(request: WorkflowAgentRequest, signal: AbortSignal): Promise<WorkflowAgentReport>;
}

/** Progress, for the `/workflows` tree and the tests. */
export type WorkflowRunEvent =
	| { readonly type: "agent-start"; readonly ordinal: number; readonly label: string | undefined; readonly phase: string | undefined }
	| { readonly type: "agent-cached"; readonly ordinal: number; readonly label: string | undefined; readonly phase: string | undefined; readonly isNull: boolean }
	| { readonly type: "agent-done"; readonly ordinal: number }
	| { readonly type: "agent-failed"; readonly ordinal: number; readonly reason: string }
	| { readonly type: "agent-skipped"; readonly ordinal: number; readonly reason: string }
	| { readonly type: "item-failed"; readonly index: number; readonly reason: string }
	| { readonly type: "task-failed"; readonly index: number; readonly reason: string }
	| { readonly type: "rejection-unhandled"; readonly reason: string }
	| { readonly type: "phase"; readonly title: string }
	| { readonly type: "log"; readonly message: string };

/** The three caps. Concurrency is per run; the others are per run's lifetime and per call. */
export interface WorkflowCaps {
	readonly concurrency: number;
	readonly lifetimeAgents: number;
	readonly itemsPerCall: number;
}

/** The ruled numbers: `min(16, CPUs − 2)`, 1000, 4096. */
export const WORKFLOW_CAPS: WorkflowCaps = {
	concurrency: Math.min(16, Math.max(1, os.cpus().length - 2)),
	lifetimeAgents: 1000,
	itemsPerCall: 4096,
};

/** A run-level stop: once a hook throws one, the run ends with it however the script handles it. */
export class WorkflowRunError extends Error {
	readonly _tag = "WorkflowRunError" as const;
	constructor(
		readonly reason: "item-cap" | "lifetime-cap" | "bad-schema" | "stopped",
		message: string,
	) {
		super(message);
	}
}

export interface RunWorkflowOptions {
	readonly source: string;
	readonly args: unknown;
	readonly journal: WorkflowJournal;
	readonly spawner: WorkflowAgentSpawner;
	readonly emit: (event: WorkflowRunEvent) => void;
	/** Aborting ends the run with `workflow stopped`: in-flight children are signalled and the script parks. */
	readonly signal: AbortSignal;
	readonly caps?: Partial<WorkflowCaps>;
	/** The sandbox's cap on the script's synchronous start; tests use a small one. */
	readonly scriptTimeoutMs?: number;
}

export interface WorkflowRunResult {
	/** The script's return value as host data: JSON, or the `String()` of a bigint, a symbol or `undefined`; a function, or a value JSON cannot write, ends the run instead. */
	readonly value: unknown;
	readonly meta: WorkflowMeta;
	/** `agent()` calls handed to the spawner, a refused spawn among them, cache hits not: the count the run store keeps for the `[agents:]` line, here for tests. */
	readonly agentsRun: number;
	/** `N cached` — meaningful when resuming. */
	readonly replaySummary: string;
}

/** The ruled stop message; the extension reports it as the run's error. */
export const WORKFLOW_STOPPED_MESSAGE = "workflow stopped";

/** Why `agent(prompt, {type: 'lead'})` is an author error (ticket 54 §1). */
export const WORKFLOW_LEAD_REFUSAL = "agent() option type cannot be 'lead': a workflow child cannot be a lead — the script is the judge; split the item in the script instead";

/** Run one script to its return value. Throws a host copy of the script's own error, or a {@link WorkflowRunError}. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
	const { meta, body } = extractWorkflowMeta(options.source);
	const caps: WorkflowCaps = { ...WORKFLOW_CAPS, ...options.caps };
	const slots = new WorkflowSemaphore(caps.concurrency);
	const { journal, spawner, emit, signal } = options;
	let lifetime = 0;
	let agentsRun = 0;
	let currentPhase: string | undefined;

	const stopped = () => new WorkflowRunError("stopped", WORKFLOW_STOPPED_MESSAGE);
	if (signal.aborted) throw stopped();
	// Aborted by a stop and by the run's end, whatever ended it: a call still queued or in flight then must not spawn or journal.
	const ended = new AbortController();
	const inFlight = new Set<Promise<WorkflowAgentReport>>();

	async function agent(prompt: unknown, rawOptions?: unknown): Promise<unknown> {
		if (ended.signal.aborted) throw stopped();
		if (typeof prompt !== "string") throw new TypeError(`agent() needs a string prompt, got ${typeof prompt}`);
		const agentOptions = parseAgentOptions(rawOptions);
		const schemaRefusal = agentOptions.schema === undefined ? undefined : structuredOutputSchemaRefusal(agentOptions.schema);
		if (schemaRefusal !== undefined) throw new WorkflowRunError("bad-schema", `agent() option schema ${schemaRefusal}`);
		if (++lifetime > caps.lifetimeAgents) throw new WorkflowRunError("lifetime-cap", `workflow exceeded ${caps.lifetimeAgents} total agents`);
		const ordinal = lifetime;
		const phase = agentOptions.phase ?? currentPhase;
		const call = { key: workflowCacheKey(prompt, agentOptions), label: agentOptions.label, prompt, phase };
		const hit = journal.take(call);
		if (hit !== undefined) {
			emit({ type: "agent-cached", ordinal, label: agentOptions.label, phase, isNull: hit.result === null });
			return hit.result;
		}
		return slots.acquire(async () => {
			if (ended.signal.aborted) throw stopped();
			emit({ type: "agent-start", ordinal, label: agentOptions.label, phase });
			agentsRun++;
			let after: number | undefined;
			const started = () => {
				after = journal.written;
			};
			const spawned = spawner.run({ prompt, options: agentOptions, ordinal, phase, concurrency: caps.concurrency, started }, ended.signal);
			inFlight.add(spawned);
			let report: WorkflowAgentReport;
			try {
				report = await spawned;
			} catch (error) {
				if (ended.signal.aborted) throw stopped();
				emit({ type: "agent-failed", ordinal, reason: error instanceof Error ? error.message : String(error) });
				throw error;
			} finally {
				inFlight.delete(spawned);
			}
			if (ended.signal.aborted) throw stopped();
			switch (report.kind) {
				case "completed":
					journal.append({ ...call, result: report.value, after: after ?? journal.written });
					emit({ type: "agent-done", ordinal });
					return report.value;
				case "died":
					journal.appendFailed(call.key);
					emit({ type: report.skipped === true ? "agent-skipped" : "agent-failed", ordinal, reason: report.reason });
					return null;
				case "schema-exhausted":
					journal.appendFailed(call.key);
					emit({ type: "agent-failed", ordinal, reason: report.reason });
					return null;
			}
		});
	}

	// Copied by index into a host array: a method looked up on the script's array is the script's
	// to replace, and handing it a host callback would hand over the host.
	function itemsOf(raw: unknown, what: string, cap: number): unknown[] {
		if (!Array.isArray(raw)) throw new TypeError(`${what}() needs an array, got ${typeof raw}`);
		const length: unknown = raw.length;
		if (typeof length !== "number") throw new TypeError(`${what}() needs an array, got an array-like`);
		if (length > cap) throw new WorkflowRunError("item-cap", `too many items (${length}); cap is ${cap}`);
		const items: unknown[] = [];
		for (let i = 0; i < length; i++) items.push(raw[i]);
		return items;
	}

	/** Each item flows through every stage on its own — no barrier. */
	async function pipeline(calls: WorkflowScriptCalls, rawItems: unknown, rawStages: unknown): Promise<unknown[]> {
		const items = itemsOf(rawItems, "pipeline", caps.itemsPerCall);
		const stages = itemsOf(rawStages, "pipeline", Number.POSITIVE_INFINITY);
		stages.forEach((stage, i) => {
			if (typeof stage !== "function") throw new TypeError(`pipeline() stage ${i + 1} is not a function`);
		});
		return unboxed(
			await Promise.all(
				items.map(async (item, index): Promise<Boxed> => {
					let acc: unknown = item;
					for (const stage of stages) {
						// A null, a dead child's included, is never a stage's input: the item ends there.
						if (acc === null) return { value: null };
						const settled = await calls.call(stage, [acc, item, index]);
						if (!settled.ok) {
							emit({ type: "item-failed", index, reason: settled.message });
							return { value: null };
						}
						acc = settled.value;
					}
					return { value: acc };
				}),
			),
		);
	}

	/** Run every thunk, await all — a barrier. Never rejects: a failed thunk is `null`. */
	async function parallel(calls: WorkflowScriptCalls, rawThunks: unknown): Promise<unknown[]> {
		const thunks = itemsOf(rawThunks, "parallel", caps.itemsPerCall);
		return unboxed(
			await Promise.all(
				thunks.map(async (thunk, index): Promise<Boxed> => {
					const settled: WorkflowScriptSettled = typeof thunk === "function" ? await calls.call(thunk, []) : { ok: false, message: "parallel() needs an array of functions" };
					if (settled.ok) return { value: settled.value };
					emit({ type: "task-failed", index, reason: settled.message });
					return { value: null };
				}),
			),
		);
	}

	let run: WorkflowScriptRun | undefined;
	const stop = () => {
		ended.abort();
		run?.end(stopped());
	};
	signal.addEventListener("abort", stop, { once: true });
	// Started inside the try: whatever a start throws, the finally still ends every call in flight.
	try {
		run = startWorkflowScript({
			body,
			args: options.args,
			hooks: (calls) => ({
				agent,
				pipeline: (items, stages) => pipeline(calls, items, stages),
				parallel: (thunks) => parallel(calls, thunks),
				phase: (title) => {
					currentPhase = title;
					emit({ type: "phase", title });
				},
				log: (message) => emit({ type: "log", message }),
			}),
			endsRun: (error): error is WorkflowRunError => error instanceof WorkflowRunError,
			unhandledRejection: (reason) => emit({ type: "rejection-unhandled", reason }),
			...(options.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: options.scriptTimeoutMs } : {}),
		});
		const value = await run.outcome;
		return { value, meta, agentsRun, replaySummary: journal.replaySummary() };
	} finally {
		signal.removeEventListener("abort", stop);
		ended.abort();
		await Promise.allSettled(inFlight);
	}
}

function parseAgentOptions(raw: unknown): WorkflowAgentOptions {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object") throw new TypeError(`agent() options must be an object, got ${typeof raw}`);
	// Each option is read once, into a local that is both checked and used: a getter or a proxy answers every read afresh.
	const o = raw as Record<string, unknown>;
	const str = (key: string): string | undefined => {
		const v = o[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "string") throw new TypeError(`agent() option ${key} must be a string`);
		return v;
	};
	const ms = (key: string): number | undefined => {
		const v = o[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new TypeError(`agent() option ${key} must be a positive number of milliseconds`);
		return v;
	};
	const schema = o.schema;
	const model = str("model");
	const thinking = str("thinking");
	const type = str("type");
	const isolation = str("isolation");
	// The label names the child: read here as the engine will name it.
	const label = agentNameOf(str("label"));
	const phase = str("phase");
	const stallMs = ms("stallMs");
	const prefixStaggerMs = ms("prefixStaggerMs");
	const prefixWarmMs = ms("prefixWarmMs");
	if (isolation !== undefined && isolation !== "worktree") throw new TypeError(`agent() option isolation must be 'worktree'`);
	if (thinking !== undefined && !isAgentThinkingLevel(thinking)) throw new TypeError(`agent() option thinking must be one of ${AGENT_THINKING_LEVEL_LIST}, got '${thinking}'`);
	if (type === "lead") throw new TypeError(WORKFLOW_LEAD_REFUSAL);
	return {
		...(schema !== undefined ? { schema: hostCopy(schema) } : {}),
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(type !== undefined ? { type } : {}),
		...(isolation !== undefined ? { isolation: "worktree" as const } : {}),
		...(label !== undefined ? { label } : {}),
		...(phase !== undefined ? { phase } : {}),
		...(stallMs !== undefined ? { stallMs } : {}),
		...(prefixStaggerMs !== undefined ? { prefixStaggerMs } : {}),
		...(prefixWarmMs !== undefined ? { prefixWarmMs } : {}),
	};
}

/**
 * A script value on its way through a host promise. Resolving a host promise
 * with the value itself would read its `then` and call it: a script method,
 * called by the host, which the value may answer differently than it answered
 * the context.
 */
interface Boxed {
	readonly value: unknown;
}

function unboxed(slots: readonly Boxed[]): unknown[] {
	return slots.map((slot) => slot.value);
}

// The host keeps no script object: a JSON copy has nothing of the script's to call later.
function hostCopy(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return value;
	return JSON.parse(JSON.stringify(value));
}

/** A counting semaphore; `acquire` runs `fn` once a slot is free, in arrival order. */
class WorkflowSemaphore {
	#free: number;
	readonly #queue: Array<() => void> = [];

	constructor(size: number) {
		this.#free = Math.max(1, size);
	}

	async acquire<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#free > 0) this.#free--;
		else await new Promise<void>((resolve) => this.#queue.push(resolve));
		try {
			return await fn();
		} finally {
			// Handed straight to the next waiter: a slot counted free for even a
			// tick lets a caller arriving in that tick take it past the waiter.
			const next = this.#queue.shift();
			if (next !== undefined) next();
			else this.#free++;
		}
	}
}
