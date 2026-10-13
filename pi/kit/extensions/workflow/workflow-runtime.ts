import path from "node:path";
import { agentNameOf } from "../../lib/agents/agent-registry.ts";
import { REPLY_IDS, type ReplyId, replySchema } from "../../lib/agents/reply-formats.ts";
import { AGENT_THINKING_LEVEL_LIST, type AgentThinkingLevel, isAgentThinkingLevel } from "../../lib/agents/agent-type-files.ts";
import { type WorkflowJournal, workflowCacheKey } from "./workflow-journal.ts";
import { structuredOutputSchemaRefusal } from "./workflow-structured-output.ts";
import { extractWorkflowMeta, type WorkflowMeta } from "./workflow-meta.ts";
import { startWorkflowScript, type WorkflowScriptCalls, type WorkflowScriptRun, type WorkflowScriptSettled } from "./workflow-sandbox.ts";
import type { WorkflowRunEvent } from "../../lib/workflow/workflow-run-store.ts";

/** What `agent(prompt, opts)` accepts. `label` and `phase` are display-only; they, `stallMs` and the prefix durations stay out of the cache key. A `label` arrives trimmed, and a blank one as none. */
export interface WorkflowAgentOptions {
	readonly schema?: unknown;
	readonly model?: string;
	readonly thinking?: AgentThinkingLevel;
	readonly type?: string;
	readonly isolation?: "worktree";
	readonly cwd?: string;
	readonly label?: string;
	readonly phase?: string;
	readonly stallMs?: number;
	readonly prefixStaggerMs?: number;
	readonly prefixWarmMs?: number;
}

/** One child, as the spawner receives it. */
export interface WorkflowAgentRequest {
	readonly prompt: string;
	readonly options: WorkflowAgentOptions;
	readonly ordinal: number;
	readonly phase: string | undefined;
	readonly concurrency: number;
	readonly started: () => void;
}

/** What the spawner learned; the runtime applies the failure table to it. */
export type WorkflowAgentReport =
	| { readonly kind: "completed"; readonly value: unknown }
	| { readonly kind: "died"; readonly reason: string; readonly skipped?: boolean }
	| { readonly kind: "schema-exhausted"; readonly reason: string };

export interface WorkflowAgentSpawner {
	run(request: WorkflowAgentRequest, signal: AbortSignal): Promise<WorkflowAgentReport>;
}

/** The three caps. Concurrency is per run; the others are per run's lifetime and per call. */
export interface WorkflowCaps {
	readonly concurrency: number;
	readonly lifetimeAgents: number;
	readonly itemsPerCall: number;
}

/** The ruled numbers: 16 agents at once, 1000 per run, 4096 items per call. */
export const WORKFLOW_CAPS: WorkflowCaps = {
	concurrency: 16,
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
	readonly signal: AbortSignal;
	readonly caps?: Partial<WorkflowCaps>;
	readonly scriptTimeoutMs?: number;
}

export interface WorkflowRunResult {
	readonly value: unknown;
	readonly meta: WorkflowMeta;
	readonly agentsRun: number;
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

	function itemsOf(raw: unknown, what: string, cap: number): unknown[] {
		if (!Array.isArray(raw)) throw new TypeError(`${what}() needs an array, got ${typeof raw}`);
		const length: unknown = raw.length;
		if (typeof length !== "number") throw new TypeError(`${what}() needs an array, got an array-like`);
		if (length > cap) throw new WorkflowRunError("item-cap", `too many items (${length}); cap is ${cap}`);
		const items: unknown[] = [];
		for (let i = 0; i < length; i++) items.push(raw[i]);
		return items;
	}

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

const AGENT_OPTION_KEYS = ["schema", "reply", "model", "thinking", "type", "isolation", "label", "phase", "stallMs", "prefixStaggerMs", "prefixWarmMs", "cwd"];

const CLAUDE_CODE_OPTION_KEYS: Readonly<Record<string, string>> = { agentType: "type", effort: "thinking" };

function parseAgentOptions(raw: unknown): WorkflowAgentOptions {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object") throw new TypeError(`agent() options must be an object, got ${typeof raw}`);
	// SAFETY: raw was checked to be a non-undefined object; each option is type-checked below
	const o = raw as Record<string, unknown>;
	for (const key of Object.keys(o)) {
		if (AGENT_OPTION_KEYS.includes(key)) continue;
		const piKey = Object.hasOwn(CLAUDE_CODE_OPTION_KEYS, key) ? CLAUDE_CODE_OPTION_KEYS[key] : undefined;
		throw new TypeError(`unknown agent() option ${key}: ${key === "max_turns" || key === "maxTurns" ? "turn limits do not exist" : piKey !== undefined ? `pi calls it ${piKey}` : `the options are ${AGENT_OPTION_KEYS.join(", ")}`}`);
	}
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
	const replyId = str("reply");
	// SAFETY: includes is the membership check; the cast only widens the literal union for it
	if (replyId !== undefined && !REPLY_IDS.includes(replyId as ReplyId)) throw new TypeError(`agent() option reply must be one of ${REPLY_IDS.join(", ")}, got '${replyId}'`);
	if (replyId !== undefined && o.schema !== undefined) throw new TypeError("agent() takes reply or schema, not both");
	// SAFETY: replyId was checked against REPLY_IDS above
	const schema = replyId !== undefined ? replySchema(replyId as ReplyId) : o.schema;
	const model = str("model");
	const thinking = str("thinking");
	const type = str("type");
	const isolation = str("isolation");
	const cwd = str("cwd");
	const label = agentNameOf(str("label"));
	const phase = str("phase");
	const stallMs = ms("stallMs");
	const prefixStaggerMs = ms("prefixStaggerMs");
	const prefixWarmMs = ms("prefixWarmMs");
	if (isolation !== undefined && isolation !== "worktree") throw new TypeError(`agent() option isolation must be 'worktree'`);
	if (cwd !== undefined && !path.isAbsolute(cwd)) throw new TypeError(`agent() option cwd must be an absolute path, got '${cwd}'`);
	if (thinking !== undefined && !isAgentThinkingLevel(thinking)) throw new TypeError(`agent() option thinking must be one of ${AGENT_THINKING_LEVEL_LIST}, got '${thinking}'`);
	if (type === "lead") throw new TypeError(WORKFLOW_LEAD_REFUSAL);
	return {
		...(schema !== undefined ? { schema: hostCopy(schema) } : {}),
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(type !== undefined ? { type } : {}),
		...(isolation !== undefined ? { isolation: "worktree" as const } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		...(label !== undefined ? { label } : {}),
		...(phase !== undefined ? { phase } : {}),
		...(stallMs !== undefined ? { stallMs } : {}),
		...(prefixStaggerMs !== undefined ? { prefixStaggerMs } : {}),
		...(prefixWarmMs !== undefined ? { prefixWarmMs } : {}),
	};
}

interface Boxed {
	readonly value: unknown;
}

function unboxed(slots: readonly Boxed[]): unknown[] {
	return slots.map((slot) => slot.value);
}

function hostCopy(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return value;
	return JSON.parse(JSON.stringify(value));
}

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
			const next = this.#queue.shift();
			if (next !== undefined) next();
			else this.#free++;
		}
	}
}
