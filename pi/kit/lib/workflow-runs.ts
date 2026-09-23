/**
 * A workflow run as something that can be looked at: its phases, the agents in
 * each, what each agent was asked, and the run's log tail.
 *
 * The runtime has published these events since ticket 23 and, until this file,
 * the only subscriber anywhere was a test. `extensions/workflow.ts` folds them
 * in here as they happen and the dock reads the fold back — one owner, one
 * copy, and no second reducer to disagree with the first.
 *
 * Two facts the events alone do not carry are added at the spawn:
 *
 * - **the child's task id**, which is the join to the dock's row and therefore
 *   the only route from `agent #3` to that agent's model, tokens, tool calls
 *   and duration. The run's agent map is keyed on ordinal and the engine's on
 *   task id; without this the two trees cannot be put beside each other.
 * - **the prompt**, which the spawner has in its hand and nobody else keeps —
 *   the engine stores what it sent (contract and all), not what the script
 *   asked for.
 *
 * **A settled run stays.** `live.delete(runId)` used to throw away the only
 * copy of the tree the moment the run ended, so the view a user opened to watch
 * a run went blank exactly when the result arrived. Runs retire here on the
 * dock's rule — a limit, and never before {@link SETTLED_RUN_GRACE_MS}.
 *
 * Process-wide on `globalThis`, keyed by session id, like the runtime seam:
 * pi loads each extension through its own module cache, so module-level state
 * does not cross from `workflow.ts` to `agent-dock`.
 */

import { shared } from "./shared.ts";
import type { WorkflowRunEvent } from "./workflow-runtime.ts";

/** How far along one of a run's agents is. `cached` is a journal replay: it never ran this time; `skipped` is one a user stopped by hand. */
export type WorkflowAgentState = "running" | "cached" | "done" | "failed" | "skipped";

/** How the run itself ended, or that it has not. */
export type WorkflowRunStatus = "running" | "completed" | "stopped" | "failed";

/** One agent of a run, as the events and the spawn together describe it. */
export interface WorkflowRunAgent {
	/** 1-based, in call order — the run's own key for this agent. */
	readonly ordinal: number;
	readonly label: string;
	readonly phase: string | undefined;
	readonly state: WorkflowAgentState;
	/** The engine's task id, once spawned; the join to the dock's row. Absent for a cached agent, which never ran. */
	readonly taskId: string | undefined;
	/** What the script asked for, without the workflow contract the engine prepends. */
	readonly prompt: string;
	/** Why it failed, when it did. */
	readonly reason: string | undefined;
}

/**
 * Something that went wrong without stopping the run: an agent that failed or
 * was skipped, an item or task the script dropped to `null`, or a promise it
 * left rejected.
 */
export type WorkflowRunFailure =
	| { readonly kind: "agent"; readonly ordinal: number; readonly label: string; readonly skipped: boolean; readonly reason: string }
	| { readonly kind: "item"; readonly index: number; readonly reason: string }
	| { readonly kind: "task"; readonly index: number; readonly reason: string }
	| { readonly kind: "rejection"; readonly reason: string };

/** One phase of a run and the agents that ran under it. */
export interface WorkflowRunPhase {
	/** 1-based, in the order the phase was first seen — what the phase list numbers. */
	readonly index: number;
	readonly title: string;
	readonly agents: readonly WorkflowRunAgent[];
	readonly done: number;
	readonly total: number;
}

/** One run, live or settled. */
export interface WorkflowRun {
	readonly runId: string;
	/** The run's own row in the dock: it is a task like any other. */
	readonly taskId: string;
	readonly name: string;
	readonly description: string;
	readonly startedAt: number;
	readonly settledAt: number | undefined;
	readonly status: WorkflowRunStatus;
	readonly currentPhase: string | undefined;
	readonly logs: readonly string[];
	/** Every agent, in ordinal order. */
	readonly agents: readonly WorkflowRunAgent[];
	/** Every failure, in the order it happened; unlike the log, never trimmed. */
	readonly failures: readonly WorkflowRunFailure[];
}

/** Settled runs kept for the view. Older ones fall off; a live run is never trimmed. */
export const SETTLED_RUN_LIMIT = 10;

/** No settled run is trimmed inside this window, whatever the limit says. The dock's `SETTLED_TASK_GRACE_MS`. */
export const SETTLED_RUN_GRACE_MS = 30_000;

/** Log lines one run keeps. The tail is what a reader wants; the journal has the rest. */
export const RUN_LOG_LIMIT = 50;

/** Agents done, over agents seen. A cached agent is done: it has an answer. */
export function agentIsFinished(agent: WorkflowRunAgent): boolean {
	return agent.state !== "running";
}

/**
 * The run's agents grouped into phases, in the order the phases were first
 * seen and numbered from one.
 *
 * An agent with no phase lands in one unnamed group, which is what a script
 * that never calls `phase()` produces — the common case, and it must not read
 * as a defect.
 */
export function workflowRunPhases(run: WorkflowRun): WorkflowRunPhase[] {
	const order: string[] = [];
	const byPhase = new Map<string, WorkflowRunAgent[]>();
	for (const agent of run.agents) {
		const key = agent.phase ?? "";
		const bucket = byPhase.get(key);
		if (bucket === undefined) {
			order.push(key);
			byPhase.set(key, [agent]);
		} else bucket.push(agent);
	}
	return order.map((key, at) => {
		const agents = byPhase.get(key) ?? [];
		return {
			index: at + 1,
			title: key === "" ? run.name : key,
			agents,
			done: agents.filter(agentIsFinished).length,
			total: agents.length,
		};
	});
}

/**
 * ` · 2 failed · 1 skipped`, or nothing at all — what a run's summary line adds
 * once agents have gone wrong or been stopped by hand. A skip is a choice and a
 * failure is not, so the two are never added together.
 */
export function workflowRunOutcomeCounts(run: WorkflowRun): string {
	const count = (state: WorkflowAgentState) => run.agents.filter((agent) => agent.state === state).length;
	const parts = [count("failed") > 0 ? `${count("failed")} failed` : undefined, count("skipped") > 0 ? `${count("skipped")} skipped` : undefined];
	return parts.filter((part) => part !== undefined).join(" · ");
}

interface MutableRun {
	readonly runId: string;
	readonly taskId: string;
	readonly name: string;
	readonly description: string;
	readonly startedAt: number;
	settledAt: number | undefined;
	status: WorkflowRunStatus;
	currentPhase: string | undefined;
	readonly logs: string[];
	readonly agents: Map<number, WorkflowRunAgent>;
	readonly failures: WorkflowRunFailure[];
}

/**
 * The runs of one session, live and lately settled.
 *
 * Written by the `Workflow` tool as its runs progress; read by the dock's
 * views and by `/workflows`.
 */
export class WorkflowRunStore {
	private readonly runs = new Map<string, MutableRun>();

	/** A run has begun. Replaces any run already under this id. */
	public start(run: { runId: string; taskId: string; name: string; description: string; startedAt: number }): void {
		this.runs.set(run.runId, { ...run, settledAt: undefined, status: "running", currentPhase: undefined, logs: [], agents: new Map(), failures: [] });
	}

	/** Fold one progress event in. Unknown runs are dropped rather than invented. */
	public apply(runId: string, event: WorkflowRunEvent): void {
		const run = this.runs.get(runId);
		if (run === undefined) return;
		switch (event.type) {
			case "agent-start":
			case "agent-cached": {
				const existing = run.agents.get(event.ordinal);
				run.agents.set(event.ordinal, {
					ordinal: event.ordinal,
					label: event.label ?? `agent #${event.ordinal}`,
					phase: event.phase,
					state: event.type === "agent-cached" ? "cached" : "running",
					taskId: event.type === "agent-cached" ? undefined : existing?.taskId,
					prompt: existing?.prompt ?? "",
					reason: undefined,
				});
				break;
			}
			case "agent-done":
				this.setState(run, event.ordinal, "done", undefined);
				break;
			case "agent-failed":
			case "agent-skipped": {
				const skipped = event.type === "agent-skipped";
				this.setState(run, event.ordinal, skipped ? "skipped" : "failed", event.reason);
				const label = run.agents.get(event.ordinal)?.label ?? `agent #${event.ordinal}`;
				run.failures.push({ kind: "agent", ordinal: event.ordinal, label, skipped, reason: event.reason });
				break;
			}
			case "phase":
				run.currentPhase = event.title;
				break;
			case "log":
				this.log(run, event.message);
				break;
			case "item-failed":
				run.failures.push({ kind: "item", index: event.index, reason: event.reason });
				this.log(run, `dropped: ${event.reason}`);
				break;
			case "task-failed":
				run.failures.push({ kind: "task", index: event.index, reason: event.reason });
				this.log(run, `dropped: ${event.reason}`);
				break;
			case "rejection-unhandled":
				run.failures.push({ kind: "rejection", reason: event.reason });
				this.log(run, `unhandled rejection: ${event.reason}`);
				break;
		}
	}

	/**
	 * The child behind an ordinal: its engine task id and the prompt the script
	 * wrote. Called once per spawn, and again after a resume under a new task id.
	 */
	public noteSpawn(runId: string, ordinal: number, spawn: { taskId: string; prompt: string }): void {
		const run = this.runs.get(runId);
		const agent = run?.agents.get(ordinal);
		if (run === undefined || agent === undefined) return;
		run.agents.set(ordinal, { ...agent, taskId: spawn.taskId, prompt: spawn.prompt });
	}

	/** The run is over. Its tree stays readable; see the header. */
	public settle(runId: string, status: Exclude<WorkflowRunStatus, "running">, at: number): void {
		const run = this.runs.get(runId);
		if (run === undefined) return;
		run.status = status;
		run.settledAt = at;
		this.trimSettled(at);
	}

	public get(runId: string): WorkflowRun | undefined {
		const run = this.runs.get(runId);
		return run === undefined ? undefined : snapshot(run);
	}

	/** The run whose own dock row carries this task id. */
	public byTaskId(taskId: string): WorkflowRun | undefined {
		for (const run of this.runs.values()) if (run.taskId === taskId) return snapshot(run);
		return undefined;
	}

	/** Live runs oldest first, then settled ones most recently ended first. */
	public list(): WorkflowRun[] {
		const all = [...this.runs.values()].map(snapshot);
		const live = all.filter((run) => run.status === "running").sort((a, b) => a.startedAt - b.startedAt);
		const settled = all.filter((run) => run.status !== "running").sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
		return [...live, ...settled];
	}

	public clear(): void {
		this.runs.clear();
	}

	private log(run: MutableRun, message: string): void {
		run.logs.push(message);
		if (run.logs.length > RUN_LOG_LIMIT) run.logs.splice(0, run.logs.length - RUN_LOG_LIMIT);
	}

	private setState(run: MutableRun, ordinal: number, state: WorkflowAgentState, reason: string | undefined): void {
		const agent = run.agents.get(ordinal);
		if (agent === undefined) return;
		run.agents.set(ordinal, { ...agent, state, reason });
	}

	private trimSettled(now: number): void {
		const settled = [...this.runs.values()].filter((run) => run.status !== "running").sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
		for (const run of settled.slice(SETTLED_RUN_LIMIT)) {
			if (run.settledAt !== undefined && now - run.settledAt < SETTLED_RUN_GRACE_MS) continue;
			this.runs.delete(run.runId);
		}
	}
}

function snapshot(run: MutableRun): WorkflowRun {
	return {
		runId: run.runId,
		taskId: run.taskId,
		name: run.name,
		description: run.description,
		startedAt: run.startedAt,
		settledAt: run.settledAt,
		status: run.status,
		currentPhase: run.currentPhase,
		logs: [...run.logs],
		agents: [...run.agents.values()].sort((a, b) => a.ordinal - b.ordinal),
		failures: [...run.failures],
	};
}

const RUN_STORE_SEAM = "__piKitWorkflowRuns";

const stores = (): Map<string, WorkflowRunStore> => shared(RUN_STORE_SEAM, () => new Map<string, WorkflowRunStore>());

/** The session's run store, created on first use so writer and reader need no start-up order. */
export function workflowRunsOf(sessionId: string): WorkflowRunStore {
	const existing = stores().get(sessionId);
	if (existing !== undefined) return existing;
	const created = new WorkflowRunStore();
	stores().set(sessionId, created);
	return created;
}

/** The session is over; drop its runs. Every entry pins a run's whole tree. */
export function forgetWorkflowRuns(sessionId: string): void {
	stores().delete(sessionId);
}
