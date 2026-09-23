/**
 * How long the current turn has been running, and how that reads in the frame.
 *
 * `zen-chrome` owns the clock and prints it in the prompt box's bottom rule;
 * `notify` reads it for the duration in its desktop ping. They meet on
 * `globalThis` because pi's extension loader builds a fresh jiti instance per
 * extension with module caching disabled, so a module-level variable is never
 * shared between two of them — the same reason `cache-window` and `side-flag`
 * live there.
 *
 * They meet on this file for the rules, because two extensions with two
 * definitions of "a turn" is exactly the drift this module exists to prevent.
 *
 * A turn, as pinned against pi's own emit sites:
 *
 *   - `before_agent_start` fires once per user prompt, on the `prompt()` path.
 *   - `agent_start` / `agent_end` fire once *per attempt*: the post-run loop
 *     re-enters through `agent.continue()` for a retry, an auto-compaction or
 *     a queued message, and each re-entry raises them again.
 *   - `agent_settled` fires once, from the `finally` around the whole run, so
 *     it lands on normal completion, on ESC, and on a retry-exhausted error
 *     alike.
 *
 * So the turn is `before_agent_start` → `agent_settled`, and anything anchored
 * on `agent_start` restarts mid-turn and under-reports how long you waited.
 */

/**
 * How long a turn must run before its duration is worth a place in the frame.
 *
 * Claude Code's number. Below it the frame stays quiet, both while running and
 * after settling, so a short turn leaves no trace at all.
 */
export const FLOOR_MS = 30_000;

export interface TurnClock {
	/** Epoch ms the running turn started, or null when no turn is running. */
	startedAt: number | null;
	/** How long the last settled turn took, in ms, or null when none has. */
	lastMs: number | null;
}

/** Nothing running, nothing held. */
export const IDLE: TurnClock = { startedAt: null, lastMs: null };

/**
 * What moves the clock.
 *
 * Named for the turn rather than for pi's events, because the mapping is the
 * adapter's business and the point of this module is that there is one turn.
 */
export type TurnEvent =
	/** `before_agent_start` — the user is now waiting. */
	| "turn_start"
	/** `agent_settled` — the whole run is over, however it ended. */
	| "turn_settled"
	/** `session_start` — a switch, fork, resume or reload; nothing survives it. */
	| "session_reset";

/**
 * How long the user has been waiting, or waited: the running turn's elapsed
 * time, or the last settled turn's total once nothing is running.
 *
 * One function for both because every reader wants the same number and the
 * distinction between "still going" and "just finished" is a rendering
 * decision, not a measurement one. It also makes settling idempotent, so a
 * stray second `agent_settled` cannot overwrite a real duration with zero.
 */
export function elapsedMs(clock: TurnClock, now: number): number | null {
	return clock.startedAt === null ? clock.lastMs : Math.max(0, now - clock.startedAt);
}

/**
 * The state table, transcribed.
 *
 * `turn_start` is sticky: it assigns a start only when none is set, so the
 * clock measures the wait rather than the attempt. pi happens not to re-raise
 * `before_agent_start` mid-turn today, but a message steered into a running
 * turn does raise it, and the user's wait did not restart when they typed.
 *
 * `turn_start` also clears the held value, so a running turn's slot can never
 * contain information about the turn before it — not even during the thirty
 * seconds before it has earned a number of its own.
 */
export function reduceTurn(clock: TurnClock, event: TurnEvent, now: number): TurnClock {
	switch (event) {
		case "turn_start":
			return { startedAt: clock.startedAt ?? now, lastMs: null };
		case "turn_settled":
			return { startedAt: null, lastMs: elapsedMs(clock, now) };
		case "session_reset":
			return IDLE;
	}
}

/** Which of the three states the clock is in, and what that state prints. */
export type TurnPhase =
	/** Idle with nothing held, or running but still under the floor. */
	| "empty"
	/** Running, past the floor: a number that moves. */
	| "live"
	/** Settled, having crossed the floor: a number that stays put. */
	| "held";

export interface TurnReading {
	phase: TurnPhase;
	/** The formatted duration, or `""` when the phase is `empty`. */
	label: string;
}

const EMPTY: TurnReading = { phase: "empty", label: "" };

/**
 * What the timer slot says right now.
 *
 * The floor is applied here rather than in the reducer so that the clock stores
 * one honest number and each reader applies its own threshold — `notify` pings
 * from twelve seconds, the frame prints from thirty.
 */
export function readTurn(clock: TurnClock, now: number): TurnReading {
	const elapsed = elapsedMs(clock, now);
	if (elapsed === null || elapsed < FLOOR_MS) return EMPTY;
	return { phase: clock.startedAt === null ? "held" : "live", label: formatDuration(elapsed) };
}

/**
 * `47s`, `1m 12s`, `2m 04s`.
 *
 * Whole seconds under a minute, floored, so the number never runs ahead of the
 * wait it describes. Past a minute the seconds are rounded — with the carry at
 * 59.5s handled, or a turn would print `1m 60s` — and padded to two digits, so
 * the slot keeps its width and the right-anchored cluster beside it does not
 * shuffle a column sideways every ten seconds.
 *
 * Hours are not a case. A turn that long has other problems, and `93m 04s`
 * still reads.
 */
export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 60_000) return `${Math.floor(safe / 1000)}s`;
	let minutes = Math.floor(safe / 60_000);
	let seconds = Math.round((safe % 60_000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export const TURN_CLOCK_KEY = "__piTurnClock";

export function readTurnClock(): TurnClock {
	return ((globalThis as Record<string, unknown>)[TURN_CLOCK_KEY] as TurnClock | undefined) ?? IDLE;
}

/**
 * Move the published clock. **Only `zen-chrome` may call this**, and only in the
 * session wearing the frame — see `ownsTurnClock`.
 */
export function advanceTurnClock(event: TurnEvent, now: number): TurnClock {
	const next = reduceTurn(readTurnClock(), event, now);
	(globalThis as Record<string, unknown>)[TURN_CLOCK_KEY] = next;
	return next;
}

/**
 * Whether this session may write the clock.
 *
 * pi runs subagents in-process and `/btw` opens a side thread the same way, and
 * each loads its own copy of this kit onto the same `globalThis`. They raise
 * the full lifecycle at their own handlers, so without a gate a background
 * agent's turn would overwrite the number in front of the user.
 *
 * The gate is the signal the chrome already uses to decide whether it owns the
 * frame: the session whose mode is `tui`. Not `isSideSession`, which is true
 * only while a side session is being *created* and would miss a subagent
 * entirely.
 *
 * The limit that buys: a subagent is indistinguishable from a top-level `print`
 * session by mode alone, so a headless run publishes nothing and readers see an
 * idle clock. Stated rather than worked around, because one writer is the whole
 * point of this module.
 */
export function ownsTurnClock(ctx: { mode: string }): boolean {
	return ctx.mode === "tui";
}
