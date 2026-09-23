/**
 * The agent runtime handover: how a seat's live agents survive a session
 * replacement in the same process — a handoff (map C23), where the old
 * session shuts down with reason `new` and the next session in the process
 * is its continuation.
 *
 * At `session_shutdown` for a replacement the engine detaches its runtime and
 * parks it here under the file the replacement will use; at the replacement's
 * `session_start` the engine claims it by its own file and attaches it
 * (`AgentRuntime.attach`). Only a replacement announced as a handoff
 * ({@link announceSessionHandoff}) parks: pi gives a handoff and a `/new`
 * typed by Joel the same shutdown event, and a `/new` must stop the runs
 * like quit, because nobody in that session would read their results.
 *
 * On `globalThis`, like every cross-session seam in the kit: the replacement
 * session loads its extensions through a fresh loader, and module state does
 * not cross that line.
 */

import type { AgentRuntime } from "./agent-runtime.ts";
import { shared } from "./shared.ts";

const SEAM = "__piKitParkedAgentRuntimes";
const HANDOFF_SEAM = "__piKitAnnouncedSessionHandoffs";

/** Ids of the sessions whose replacement in flight is a handoff. */
const announced = (): Set<string> => shared(HANDOFF_SEAM, () => new Set<string>());

/**
 * Declare that the session about to be replaced continues in its replacement
 * (a handoff), so the engine parks its runs instead of stopping them. Call
 * right before `ctx.newSession` and call the returned withdraw in `finally`.
 */
export function announceSessionHandoff(sessionId: string): () => void {
	announced().add(sessionId);
	return () => announced().delete(sessionId);
}

/** Whether this session's replacement in flight was announced as a handoff. */
export function isSessionHandoffAnnounced(sessionId: string): boolean {
	return announced().has(sessionId);
}

/** How long a parked runtime waits to be claimed before its runs are stopped: no session owns them. */
export const PARK_DEADLINE_MS = 30_000;

/** A parked runtime and the deadline that will remove it if no claim comes. */
interface ParkedRuntime {
	readonly runtime: AgentRuntime;
	readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * target session file -> the runtime the outgoing session left for it.
 *
 * The entry cannot outlive its deadline: the same timeout that retires the
 * runtime deletes the entry, and a claim clears the timer (38's finding
 * 7 — the deadline used to free the settles and leave the runtime, with its
 * host, its registry and every session it held, pinned forever).
 */
const parked = (): Map<string, ParkedRuntime> => shared(SEAM, () => new Map<string, ParkedRuntime>());

/** Leave a runtime for the session that will open `targetSessionFile`. Returns false when there is no file to key on. */
export function parkAgentRuntime(targetSessionFile: string | undefined, runtime: AgentRuntime): boolean {
	if (targetSessionFile === undefined) return false;
	runtime.detach();
	const timer = setTimeout(() => {
		if (parked().get(targetSessionFile)?.runtime === runtime) parked().delete(targetSessionFile);
		void runtime.retire("orphaned");
	}, PARK_DEADLINE_MS);
	(timer as { unref?: () => void }).unref?.();
	parked().set(targetSessionFile, { runtime, timer });
	return true;
}

/** The runtime left for this session file, removed from the seam; undefined when none was. */
export function claimParkedAgentRuntime(sessionFile: string | undefined): AgentRuntime | undefined {
	if (sessionFile === undefined) return undefined;
	const entry = parked().get(sessionFile);
	if (entry === undefined) return undefined;
	clearTimeout(entry.timer);
	parked().delete(sessionFile);
	return entry.runtime;
}
