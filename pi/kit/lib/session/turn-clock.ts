import { formatDuration } from "../ui/duration-label.ts";

export const TURN_CLOCK_FLOOR_MS = 30_000;

export interface TurnClock {
	startedAt: number | null;
	lastMs: number | null;
}

/** Nothing running, nothing held. */
export const IDLE_TURN_CLOCK: TurnClock = { startedAt: null, lastMs: null };

export type TurnEvent =
	| "turn_start"
	| "turn_settled"
	| "session_reset";

export function elapsedMs(clock: TurnClock, now: number): number | null {
	return clock.startedAt === null ? clock.lastMs : Math.max(0, now - clock.startedAt);
}

export function reduceTurn(clock: TurnClock, event: TurnEvent, now: number): TurnClock {
	switch (event) {
		case "turn_start":
			return { startedAt: clock.startedAt ?? now, lastMs: null };
		case "turn_settled":
			return { startedAt: null, lastMs: elapsedMs(clock, now) };
		case "session_reset":
			return IDLE_TURN_CLOCK;
	}
}

/** Which of the three states the clock is in, and what that state prints. */
export type TurnPhase =
	| "empty"
	| "live"
	| "held";

export interface TurnReading {
	phase: TurnPhase;
	label: string;
}

const EMPTY: TurnReading = { phase: "empty", label: "" };

export function turnClockReading(clock: TurnClock, now: number): TurnReading {
	const elapsed = elapsedMs(clock, now);
	if (elapsed === null || elapsed < TURN_CLOCK_FLOOR_MS) return EMPTY;
	return { phase: clock.startedAt === null ? "held" : "live", label: formatDuration(elapsed) };
}

export const TURN_CLOCK_KEY = "__piTurnClock";

export function readTurnClock(): TurnClock {
	// SAFETY: the TURN_CLOCK_KEY slot is only written by advanceTurnClock with a TurnClock
	return ((globalThis as Record<string, unknown>)[TURN_CLOCK_KEY] as TurnClock | undefined) ?? IDLE_TURN_CLOCK;
}

export function advanceTurnClock(event: TurnEvent, now: number): TurnClock {
	const next = reduceTurn(readTurnClock(), event, now);
	// SAFETY: globalThis is only used as a keyed bag of process-shared slots
	(globalThis as Record<string, unknown>)[TURN_CLOCK_KEY] = next;
	return next;
}

export function ownsTurnClock(ctx: { mode: string }): boolean {
	return ctx.mode === "tui";
}
