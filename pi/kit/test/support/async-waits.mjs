/**
 * Waiting in async tests: a plain delay, a deadline-bounded poll, and the load
 * factor that stretches a deadline on a busy machine.
 * A test file imports them, e.g. `import { sleep, until } from "../support/async-waits.mjs";`,
 * then `check("it settled", await until(() => done, 5000));`.
 */

import os from "node:os";

/** Resolves after `ms` milliseconds. */
export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The one-minute load average per core, never below 1: how many times slower than an idle machine work should be expected to run. */
export function loadPerCore() {
	return Math.max(1, os.loadavg()[0] / os.availableParallelism());
}

/**
 * Polls `condition` every `pollMs` until it holds (true) or `ms` times the load
 * factor has passed (false); it is checked once more after the deadline.
 */
export async function until(condition, ms = 5000, pollMs = 10) {
	// `performance.now()`, not `Date.now()`: several files freeze or jump the
	// wall clock, and a deadline read from it would never come, or come at once.
	const startedAt = performance.now();
	while (!condition()) {
		if (performance.now() - startedAt > ms * loadPerCore()) return condition();
		await sleep(pollMs);
	}
	return true;
}
