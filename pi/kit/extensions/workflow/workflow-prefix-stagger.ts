import type { WorkflowAgentOptions } from "./workflow-runtime.ts";

/** How long a same-prefix sibling waits for its leader's first turn before it spawns anyway. */
export const WORKFLOW_PREFIX_STAGGER_MS = 5_000;

/** How long a written prefix stays warm: same-key children spawn at once, no leader needed. */
export const WORKFLOW_PREFIX_WARM_MS = 270_000;

/** What one child's spawn is allowed under; both calls are idempotent and safe on a non-leader. */
export interface WorkflowPrefixLease {
	firstTurn(): void;
	release(): void;
}

/** The numbers one `take` runs under; a run with concurrency 1 never overlaps, so it never staggers. */
export interface WorkflowPrefixStaggerOptions {
	readonly concurrency: number;
	readonly staggerMs: number;
	readonly warmMs: number;
}

/** The prefix a child's first request shares with its siblings: model, thinking, type, and whether it carries a schema. */
export function workflowPrefixKey(options: WorkflowAgentOptions): string {
	return JSON.stringify([options.model ?? null, options.thinking ?? null, options.type ?? null, options.schema !== undefined]);
}

const INERT: WorkflowPrefixLease = { firstTurn() {}, release() {} };

type PrefixState = { kind: "leading"; done: Promise<void>; release: () => void } | { kind: "warm"; until: number };

async function raceCap(done: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort = () => {};
	const capped = new Promise<void>((resolve) => {
		// raw-timer: the stagger cap, cleared when the race ends or the run is aborted
		timer = setTimeout(resolve, ms);
		onAbort = () => resolve();
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([done, capped]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/** One run's prompt-cache leaders, keyed by prefix. */
export class WorkflowPrefixStagger {
	readonly #keys = new Map<string, PrefixState>();

	async take(key: string, options: WorkflowPrefixStaggerOptions, signal: AbortSignal): Promise<WorkflowPrefixLease> {
		if (options.concurrency <= 1 || signal.aborted) return INERT;
		const found = this.#keys.get(key);
		if (found?.kind === "warm" && Date.now() < found.until) return INERT;
		if (found?.kind === "leading") {
			await raceCap(found.done, options.staggerMs, signal);
			return INERT;
		}
		let release = () => {};
		const done = new Promise<void>((resolve) => {
			release = resolve;
		});
		const state = { kind: "leading" as const, done, release };
		this.#keys.set(key, state);
		const leading = () => this.#keys.get(key) === state;
		return {
			firstTurn: () => {
				if (!leading()) return;
				this.#keys.set(key, { kind: "warm", until: Date.now() + options.warmMs });
				state.release();
			},
			release: () => {
				if (!leading()) return;
				this.#keys.delete(key);
				state.release();
			},
		};
	}
}
