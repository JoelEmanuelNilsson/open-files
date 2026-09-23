/**
 * The wait a seat makes on its agents, and the three ways it ends: the agents
 * settled, the clock ran out, or Joel typed.
 *
 * Yield-on-input is ours to build (ticket 05 H3/H4): pi cannot make a
 * running tool return, so the tool waits on this primitive and the
 * extension's `input` handler calls {@link AgentWaitBoard.interrupt} — the
 * wait returns at once with "interrupted by Joel — N of M done", the children
 * keep running, and Joel's message lands as the steer pi was already queuing
 * it as (Codex's `wait_agent` shape, ticket 04). No polling: a settling agent
 * calls {@link AgentWaitBoard.notify} and every wait re-checks its condition.
 */

/** Why a wait returned. */
export type AgentWaitOutcome = { readonly kind: "settled" } | { readonly kind: "timeout" } | { readonly kind: "interrupted"; readonly by: string };

/** Clock and timer, injected so a test can wait without waiting. */
export interface AgentWaitClock {
	readonly setTimeout: (fn: () => void, ms: number) => unknown;
	readonly clearTimeout: (handle: unknown) => void;
}

const REAL_CLOCK: AgentWaitClock = {
	setTimeout: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingWait {
	readonly done: () => boolean;
	readonly resolve: (outcome: AgentWaitOutcome) => void;
	readonly cancel: () => void;
}

/**
 * All the waits one seat has in flight. `notify` after any status change;
 * `interrupt` when Joel types.
 */
export class AgentWaitBoard {
	readonly #clock: AgentWaitClock;
	readonly #pending = new Set<PendingWait>();

	constructor(clock: AgentWaitClock = REAL_CLOCK) {
		this.#clock = clock;
	}

	/** Waits in flight right now. */
	get size(): number {
		return this.#pending.size;
	}

	/**
	 * Wait until `done()` holds, `timeoutMs` elapses, `signal` aborts, or
	 * {@link interrupt} is called. `done` is checked before waiting, so a
	 * condition already true returns without a tick.
	 */
	wait(done: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<AgentWaitOutcome> {
		if (done()) return Promise.resolve({ kind: "settled" });
		if (signal?.aborted) return Promise.resolve({ kind: "interrupted", by: "abort" });
		return new Promise<AgentWaitOutcome>((resolve) => {
			let finished = false;
			const timer = this.#clock.setTimeout(() => finish({ kind: "timeout" }), Math.max(0, timeoutMs));
			const onAbort = () => finish({ kind: "interrupted", by: "abort" });
			signal?.addEventListener("abort", onAbort, { once: true });
			const pending: PendingWait = {
				done,
				resolve: (outcome) => finish(outcome),
				cancel: () => {
					this.#clock.clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				},
			};
			const finish = (outcome: AgentWaitOutcome) => {
				if (finished) return;
				finished = true;
				pending.cancel();
				this.#pending.delete(pending);
				resolve(outcome);
			};
			this.#pending.add(pending);
		});
	}

	/** Something changed: every wait whose condition now holds returns. */
	notify(): void {
		for (const pending of [...this.#pending]) if (pending.done()) pending.resolve({ kind: "settled" });
	}

	/** Joel typed: every wait returns now, its agents untouched. */
	interrupt(by: string): void {
		for (const pending of [...this.#pending]) pending.resolve({ kind: "interrupted", by });
	}
}

/** Ticket 09's wording for a wait Joel cut short. */
export function interruptedWaitText(by: string, done: number, of: number): string {
	return `interrupted by ${by} — ${done} of ${of} done`;
}
