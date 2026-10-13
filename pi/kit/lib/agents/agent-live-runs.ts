import { processShared } from "../process/process-shared-state.ts";

const SEAM = "__piKitLiveAgents";

const liveByOwner = (): Map<string, Set<string>> => processShared(SEAM, () => new Map<string, Set<string>>());

/** Record a run as live under its owner. */
export function markAgentLive(ownerSessionId: string, taskId: string): void {
	const owners = liveByOwner();
	const set = owners.get(ownerSessionId) ?? new Set<string>();
	set.add(taskId);
	owners.set(ownerSessionId, set);
}

/** Record a run as settled, and tell whoever is watching the owner. Idempotent. */
export function markAgentSettled(ownerSessionId: string, taskId: string): void {
	const owners = liveByOwner();
	const set = owners.get(ownerSessionId);
	if (set === undefined) return;
	set.delete(taskId);
	if (set.size === 0) owners.delete(ownerSessionId);
	for (const listener of watchers().get(ownerSessionId) ?? []) listener();
}

const WATCHERS_SEAM = "__piKitLiveAgentWatchers";

const watchers = (): Map<string, Set<() => void>> => processShared(WATCHERS_SEAM, () => new Map<string, Set<() => void>>());

export function watchLiveAgentsOf(ownerSessionId: string, listener: () => void): () => void {
	const all = watchers();
	const set = all.get(ownerSessionId) ?? new Set<() => void>();
	set.add(listener);
	all.set(ownerSessionId, set);
	return () => {
		set.delete(listener);
		if (set.size === 0) all.delete(ownerSessionId);
	};
}

/** Live agents in the process, every owner counted. */
export function liveAgentCount(): number {
	let count = 0;
	for (const set of liveByOwner().values()) count += set.size;
	return count;
}

const STOPPING_SEAM = "__piKitStoppingSessions";

const stoppingSessions = (): Set<string> => processShared(STOPPING_SEAM, () => new Set<string>());

export function markSessionStopping(sessionId: string): void {
	stoppingSessions().add(sessionId);
}

/** Whether a parent has marked this session as stopping. */
export function isSessionStopping(sessionId: string): boolean {
	return stoppingSessions().has(sessionId);
}

/** The session is gone; forget the mark. */
export function forgetSessionStopping(sessionId: string): void {
	stoppingSessions().delete(sessionId);
}

/** Task ids of the live agents one session owns. */
export function liveAgentsOf(ownerSessionId: string): ReadonlySet<string> {
	return liveByOwner().get(ownerSessionId) ?? new Set<string>();
}

const STOPPERS_SEAM = "__piKitAgentStoppers";

export function descendantStoppers(): Map<string, () => Promise<void>> {
	return processShared(STOPPERS_SEAM, () => new Map<string, () => Promise<void>>());
}
