import { processShared } from "../process/process-shared-state.ts";

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

/** How far along one of a run's agents is. `cached` is a journal replay: it never ran this time; `skipped` is one a user stopped by hand. */
export type WorkflowAgentState = "running" | "cached" | "done" | "failed" | "skipped";

/** How the run itself ended, or that it has not. */
export type WorkflowRunStatus = "running" | "completed" | "stopped" | "failed";

/** One agent of a run, as the events and the spawn together describe it. */
export interface WorkflowRunAgent {
	readonly ordinal: number;
	readonly label: string;
	readonly phase: string | undefined;
	readonly state: WorkflowAgentState;
	readonly taskId: string | undefined;
	readonly prompt: string;
	readonly reason: string | undefined;
}

export type WorkflowRunFailure =
	| { readonly kind: "agent"; readonly ordinal: number; readonly label: string; readonly skipped: boolean; readonly reason: string }
	| { readonly kind: "item"; readonly index: number; readonly reason: string }
	| { readonly kind: "task"; readonly index: number; readonly reason: string }
	| { readonly kind: "rejection"; readonly reason: string };

/** One phase of a run and the agents that ran under it. */
export interface WorkflowRunPhase {
	readonly index: number;
	readonly title: string;
	readonly agents: readonly WorkflowRunAgent[];
	readonly done: number;
	readonly total: number;
}

/** One run, live or settled. */
export interface WorkflowRun {
	readonly runId: string;
	readonly taskId: string;
	readonly name: string;
	readonly description: string;
	readonly startedAt: number;
	readonly settledAt: number | undefined;
	readonly status: WorkflowRunStatus;
	readonly currentPhase: string | undefined;
	readonly logs: readonly string[];
	readonly agents: readonly WorkflowRunAgent[];
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

export class WorkflowRunStore {
	private readonly runs = new Map<string, MutableRun>();

	public start(run: { runId: string; taskId: string; name: string; description: string; startedAt: number }): void {
		this.runs.set(run.runId, { ...run, settledAt: undefined, status: "running", currentPhase: undefined, logs: [], agents: new Map(), failures: [] });
	}

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

	public noteSpawn(runId: string, ordinal: number, spawn: { taskId: string; prompt: string }): void {
		const run = this.runs.get(runId);
		const agent = run?.agents.get(ordinal);
		if (run === undefined || agent === undefined) return;
		run.agents.set(ordinal, { ...agent, taskId: spawn.taskId, prompt: spawn.prompt });
	}

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

	public byTaskId(taskId: string): WorkflowRun | undefined {
		for (const run of [...this.runs.values()].reverse()) if (run.taskId === taskId) return snapshot(run);
		return undefined;
	}

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

const stores = (): Map<string, WorkflowRunStore> => processShared(RUN_STORE_SEAM, () => new Map<string, WorkflowRunStore>());

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
