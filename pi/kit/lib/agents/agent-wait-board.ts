/** Why a wait returned. */
export type AgentWaitOutcome = { readonly kind: "settled" } | { readonly kind: "timeout" } | { readonly kind: "interrupted"; readonly by: string };

/** Clock and timer, injected so a test can wait without waiting. */
export interface AgentWaitClock {
	readonly setTimeout: (fn: () => void, ms: number) => unknown;
	readonly clearTimeout: (handle: unknown) => void;
}

const REAL_CLOCK: AgentWaitClock = {
	setTimeout: (fn, ms) => {
		// raw-timer: the runtime's wait clock: a wait is part of an `Agent` tool call and ends with that call's abort signal
		const handle = setTimeout(fn, ms);
		// SAFETY: Node timers expose unref; other hosts return a number, which the optional call skips
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	// SAFETY: handle only ever comes from this module's timer above
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingWait {
	readonly done: () => boolean;
	readonly resolve: (outcome: AgentWaitOutcome) => void;
	readonly cancel: () => void;
}

export class AgentWaitBoard {
	readonly #clock: AgentWaitClock;
	readonly #pending = new Set<PendingWait>();

	constructor(clock: AgentWaitClock = REAL_CLOCK) {
		this.#clock = clock;
	}

	get size(): number {
		return this.#pending.size;
	}

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

	notify(): void {
		for (const pending of [...this.#pending]) if (pending.done()) pending.resolve({ kind: "settled" });
	}

	interrupt(by: string): void {
		for (const pending of [...this.#pending]) pending.resolve({ kind: "interrupted", by });
	}
}
