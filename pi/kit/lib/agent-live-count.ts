/**
 * How many agents are live across the whole process, and which ones each
 * session owns — one number every seat's tail quotes (map C5) and the fact a
 * runner needs to know whether a child that has gone idle is really done or
 * only waiting on its own agents.
 *
 * On `globalThis`, like every cross-session seam in the kit: child sessions
 * run in-process but each gets its own module registry, so a module-level
 * map would count only the session that imported it.
 */

import { shared } from "./shared.ts";

const SEAM = "__piKitLiveAgents";

/** owner session id -> the task ids of its live agents. */
const liveByOwner = (): Map<string, Set<string>> => shared(SEAM, () => new Map<string, Set<string>>());

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

const watchers = (): Map<string, Set<() => void>> => shared(WATCHERS_SEAM, () => new Map<string, Set<() => void>>());

/**
 * Be told when one of `ownerSessionId`'s agents settles. The runner of a
 * child waits on this to learn its child's own children are done, because
 * those run under another runtime. Returns the unsubscribe.
 */
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

const stoppingSessions = (): Set<string> => shared(STOPPING_SEAM, () => new Set<string>());

/**
 * A parent is stopping this session: its own runtime must not wake it for
 * the children the cascade is stopping, or the stop would start a turn.
 */
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
