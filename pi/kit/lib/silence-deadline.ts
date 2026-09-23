/**
 * How long a session is allowed to be silent, in one place.
 *
 * The number has two consumers and they must move together. `watchdog` aborts a
 * headless seat that has produced nothing for this long. `session-mode` caps its
 * keep-warm pings at the number that covers the same span — past it the seat is
 * being killed anyway, and warming a dead seat's cache is pure cost. A copied
 * constant would let one drift while the other kept paying for it.
 */

/**
 * 15 minutes, from 6,584 completed tool batches across 275 sessions of the
 * local session store — every batch that was not itself waiting on another
 * agent.
 *
 *   p50 5.7s · p90 28.9s · p99 3.0m · p99.9 6.7m · slowest legitimate 10.1m
 *
 * Batch, not tool, is the right unit: pi persists a batch's tool results
 * together and no built-in tool reports progress, so one batch is exactly one
 * span of silence. Aborting at 3m would have killed 66 real batches (1.0%), at
 * 5m 18 (0.27%), at 10m 2 (0.03%). 12m is the smallest deadline that kills
 * nothing real in the sample; 15m buys 1.5x headroom over the slowest observed
 * real batch (a 10.1m `bash`) for the cost of five more minutes on a wedge that
 * would otherwise never end. The asymmetry decides it: a late kill wastes a
 * slot, an early kill destroys work that was succeeding.
 */
export const DEFAULT_DEADLINE_MS = 15 * 60_000;

/**
 * `PI_WATCHDOG_MS` as a duration, or the default when it is absent or nonsense.
 *
 * Takes a plain value, not `process.env`: each shell reads the environment once
 * at load, so a session's behaviour cannot drift mid-run.
 */
export function resolveDeadlineMs(raw: string | undefined): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEADLINE_MS;
}
