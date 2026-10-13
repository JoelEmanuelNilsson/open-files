import { notice } from "../process/human-notice.ts";
import { processShared } from "../process/process-shared-state.ts";
import { readLogTail } from "./background-task-log.ts";
import type { SettledTask } from "./background-task-notification.ts";
import type { BackgroundTask } from "./bash-result-notices.ts";

/** How a task's process group ended: its shell's exit code, or the signal that killed it; both null when the group is gone and the shell never reported. */
export type TaskEnd = { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };

/** A task's result, with how it ended: on its own, stopped by `TaskStop`, or killed when its owner ended. */
export type EndedTask = SettledTask & { readonly how: "exited" | "stopped" | "killed-with-owner" };

/** The process behind a task, as the registry drives it. */
export interface TaskProcess {
	kill(): boolean;
	readonly exitedWith: TaskEnd | undefined;
}

/** Offers a finished task's notice to its owner: `turned` waits for its `message_end`, `appended` is delivered, `not-now` is held for {@link reofferHeldBackgroundTasks}. */
export type NoticeSink = (task: EndedTask) => "turned" | "appended" | "not-now";

/** The task's process side: its group finished. */
export interface BackgroundTaskHandle {
	finished(end: TaskEnd): void;
}

/** How a `TaskOutput` read ended: the result, the state so far, or no result because its notice or its owner's end carries it. */
export type TaskReading =
	| { readonly state: "finished" | "running" | "timed-out" | "aborted"; readonly task: SettledTask }
	| { readonly state: "noticed"; readonly task: BackgroundTask }
	| { readonly state: "owner-ended"; readonly task: BackgroundTask };

/** What `TaskStop` did: sent the kill, found the result already on its way to the conversation, or took the result of a task that had ended. */
export type TaskStopReply = { readonly at: "stopping" } | { readonly at: "in-conversation" } | { readonly at: "ended"; readonly result: EndedTask };

type TaskState =
	| { readonly at: "running" }
	| { readonly at: "killing" }
	| { readonly at: "noticed"; readonly result: EndedTask }
	| { readonly at: "held"; readonly result: EndedTask };

interface Entry {
	readonly owner: string;
	readonly task: BackgroundTask;
	readonly proc: TaskProcess;
	readonly notice: NoticeSink;
	readonly startedAt: number;
	readonly waiters: Set<(reading: TaskReading) => void>;
	state: TaskState;
}

const registry = (): Map<string, Map<number, Entry>> => processShared("__piKitBackgroundTaskRegistry", () => new Map<string, Map<number, Entry>>());

const lastIdByOwner = (): Map<string, number> => processShared("__piKitBackgroundTaskLastId", () => new Map<string, number>());

const watchersByOwner = (): Map<string, Set<() => void>> => processShared("__piKitBackgroundTaskWatchers", () => new Map<string, Set<() => void>>());

const entryOf = (owner: string, id: number): Entry | undefined => registry().get(owner)?.get(id);

const isRegistered = (entry: Entry): boolean => entryOf(entry.owner, entry.task.id) === entry;

function resultOf(entry: Entry, end: TaskEnd, how: EndedTask["how"]): EndedTask {
	return { ...entry.task, exitCode: end.exitCode, signal: end.signal, durationMs: Date.now() - entry.startedAt, tail: readLogTail(entry.task.logPath), how };
}

function remove(entry: Entry, reading: TaskReading): void {
	const tasks = registry().get(entry.owner);
	if (tasks?.get(entry.task.id) !== entry) return;
	tasks.delete(entry.task.id);
	if (tasks.size === 0) registry().delete(entry.owner);
	for (const resolve of [...entry.waiters]) resolve(reading);
	for (const listener of [...(watchersByOwner().get(entry.owner) ?? [])]) {
		try {
			listener();
		} catch (error) {
			notice(undefined, `background tasks: a watcher of ${entry.owner} threw: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
}

function chooseSink(entry: Entry, result: EndedTask): void {
	if (entry.waiters.size > 0) return remove(entry, { state: "finished", task: result });
	entry.state = { at: "noticed", result };
	const verdict = entry.notice(result);
	if (!isRegistered(entry)) return;
	if (verdict === "appended") remove(entry, { state: "finished", task: result });
	else if (verdict === "not-now") entry.state = { at: "held", result };
}

/** The owner's next task id, unique within the process across reloads of its session. */
export function nextBackgroundTaskId(owner: string): number {
	const id = (lastIdByOwner().get(owner) ?? 0) + 1;
	lastIdByOwner().set(owner, id);
	return id;
}

/** Register a task moved to the background; its owner holds it until its result reaches one destination. Throws when the owner already holds the id. */
export function adoptBackgroundTask(owner: string, task: BackgroundTask, proc: TaskProcess, notice: NoticeSink, startedAt: number): BackgroundTaskHandle {
	const tasks = registry().get(owner) ?? new Map<number, Entry>();
	if (tasks.has(task.id)) throw new Error(`background task ${task.id} of ${owner} is already registered`);
	const entry: Entry = { owner, task, proc, notice, startedAt, waiters: new Set(), state: { at: "running" } };
	tasks.set(task.id, entry);
	registry().set(owner, tasks);
	return {
		finished(end) {
			if (!isRegistered(entry) || (entry.state.at !== "running" && entry.state.at !== "killing")) return;
			chooseSink(entry, resultOf(entry, end, entry.state.at === "killing" ? "stopped" : "exited"));
		},
	};
}

/** Offer every held notice of `owner` again, as its next turn starts. */
export function reofferHeldBackgroundTasks(owner: string): void {
	for (const entry of [...(registry().get(owner)?.values() ?? [])]) if (isRegistered(entry) && entry.state.at === "held") chooseSink(entry, entry.state.result);
}

/** Read the owner's task `id` for `TaskOutput`: waits up to `waitMs` for its end (0 reads without waiting); a result read this way is not notified. Undefined when the owner holds no such task. */
export function readBackgroundTask(owner: string, id: number, waitMs: number, signal?: AbortSignal): Promise<TaskReading> | undefined {
	const entry = entryOf(owner, id);
	if (entry === undefined) return undefined;
	const { state } = entry;
	if (state.at === "noticed") return Promise.resolve({ task: entry.task, state: "noticed" });
	if (state.at === "held") {
		const reading: TaskReading = { task: state.result, state: "finished" };
		remove(entry, reading);
		return Promise.resolve(reading);
	}
	const soFar = (at: "running" | "timed-out" | "aborted"): TaskReading => ({
		task: { ...entry.task, exitCode: null, signal: null, durationMs: Date.now() - entry.startedAt, tail: readLogTail(entry.task.logPath) },
		state: at,
	});
	if (waitMs <= 0) return Promise.resolve(soFar("running"));
	return new Promise((resolve) => {
		const end = (reading: TaskReading): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			entry.waiters.delete(end);
			resolve(reading);
		};
		const onAbort = (): void => end(soFar("aborted"));
		// raw-timer: the wait's own bound, cleared when it ends
		const timer = setTimeout(() => end(soFar("timed-out")), waitMs);
		entry.waiters.add(end);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const endedAsReported = (entry: Entry, how: EndedTask["how"]): EndedTask => resultOf(entry, entry.proc.exitedWith ?? { exitCode: null, signal: null }, how);

/** Stop the owner's task `id` for `TaskStop`. Undefined when the owner holds no such task. */
export function stopBackgroundTask(owner: string, id: number): TaskStopReply | undefined {
	const entry = entryOf(owner, id);
	if (entry === undefined) return undefined;
	const { state } = entry;
	if (state.at === "killing") return { at: "stopping" };
	if (state.at === "noticed") return { at: "in-conversation" };
	if (state.at === "held") {
		remove(entry, { state: "finished", task: state.result });
		return { at: "ended", result: state.result };
	}
	if (entry.proc.kill()) {
		entry.state = { at: "killing" };
		return { at: "stopping" };
	}
	const result = endedAsReported(entry, "exited");
	const waited = entry.waiters.size > 0;
	remove(entry, { state: "finished", task: result });
	return waited ? { at: "in-conversation" } : { at: "ended", result };
}

/** The notice of the owner's task `id` is in its conversation. */
export function deliveredBackgroundTask(owner: string, id: number): void {
	const entry = entryOf(owner, id);
	if (entry?.state.at === "noticed") remove(entry, { state: "finished", task: entry.state.result });
}

function takenAtOwnerEnd(entry: Entry): EndedTask | undefined {
	const { state } = entry;
	if (state.at === "noticed") return undefined;
	if (state.at === "held") return state.result;
	if (state.at === "killing") return endedAsReported(entry, "stopped");
	return endedAsReported(entry, entry.proc.kill() ? "killed-with-owner" : "exited");
}

/** End every task of `owner`: running ones killed; returns each result not already in its conversation. Its waiters are told the owner ended. Synchronous. */
export function endBackgroundTasksOf(owner: string): EndedTask[] {
	const ended: EndedTask[] = [];
	for (const entry of [...(registry().get(owner)?.values() ?? [])]) {
		if (!isRegistered(entry)) continue;
		const result = takenAtOwnerEnd(entry);
		remove(entry, { state: "owner-ended", task: entry.task });
		if (result !== undefined) ended.push(result);
	}
	return ended;
}

/** The tasks a session owns whose result has not reached a destination. */
export function backgroundTasksOf(owner: string): BackgroundTask[] {
	return [...(registry().get(owner)?.values() ?? [])].map((entry) => entry.task);
}

/** Whether a session other than `owner` holds a task numbered `id`. */
export function otherSessionHoldsBackgroundTask(owner: string, id: number): boolean {
	return [...registry()].some(([other, tasks]) => other !== owner && tasks.has(id));
}

/** Be told when one of a session's background tasks leaves the registry; a watcher that throws is logged. Returns the unsubscribe. */
export function watchBackgroundTasksOf(owner: string, fn: () => void): () => void {
	const all = watchersByOwner();
	const set = all.get(owner) ?? new Set<() => void>();
	set.add(fn);
	all.set(owner, set);
	return () => {
		set.delete(fn);
		if (set.size === 0 && all.get(owner) === set) all.delete(owner);
	};
}

/** The log paths of every registered task, in any session of this process. */
export function heldLogPaths(): Set<string> {
	const paths = new Set<string>();
	for (const tasks of registry().values()) for (const entry of tasks.values()) paths.add(entry.task.logPath);
	return paths;
}

const endedWithSession = (): Map<string, EndedTask[]> => processShared("__piKitEndedBackgroundTasksBySession", () => new Map<string, EndedTask[]>());

/** Keep the tasks a runtime's shutdown ended, after any already kept, for the next runtime of the same session to report. */
export function stashTasksEndedWithSession(sessionId: string, tasks: readonly EndedTask[]): void {
	if (tasks.length > 0) endedWithSession().set(sessionId, [...(endedWithSession().get(sessionId) ?? []), ...tasks]);
}

/** The stashed tasks of this session, removed: they are reported once. */
export function takeTasksEndedWithSession(sessionId: string): EndedTask[] {
	const tasks = endedWithSession().get(sessionId) ?? [];
	endedWithSession().delete(sessionId);
	return tasks;
}
