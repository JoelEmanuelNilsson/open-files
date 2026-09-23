import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A custom message a scope may start a turn with. */
export type TurnMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/**
 * One extension runtime's lifetime: its abort signal, its timers, and the only
 * way it may start a turn. Creating one means a quit with a run in flight calls
 * `ctx.abort()` and waits up to 2 s for that run to settle.
 */
export interface SessionScope {
	/** Aborted when this extension runtime's session shuts down. */
	readonly signal: AbortSignal;
	/** A `setTimeout` cleared at shutdown; returns its cancel. Does nothing once closed. */
	timeout(ms: number, run: () => void): () => void;
	/** A `setInterval` cleared at shutdown; returns its cancel. Does nothing once closed. */
	interval(ms: number, run: () => void): () => void;
	/**
	 * Start a turn with `message` (steered or queued as `deliverAs` when a run is
	 * in flight). False, with nothing sent, before this runtime's first user turn,
	 * while a user prompt is starting, from a session switch or fork until the next
	 * run starts, or once it is shutting down; the caller keeps the message.
	 */
	startTurn(message: TurnMessage, options: { deliverAs: "steer" | "followUp" }): boolean;
	/**
	 * A session switch is coming: every scope of this runtime refuses turns until
	 * the next run starts or shutdown, as it does from `session_before_switch`.
	 */
	holdTurnsForSwitch(): void;
}

/**
 * Closes every scope on one event bus. pi gives each extension loader its own
 * bus, and a reload reuses it but first invalidates the old runtime, which drops
 * that runtime's subscriptions; so the channel reaches one runtime's scopes.
 * Limit: a host that shares one bus across sessions lets any session's shutdown
 * close the other sessions' scopes for good.
 */
const SESSION_SCOPE_CLOSE_CHANNEL = "pi-kit:session-scope:close";

/** Makes every scope on one event bus refuse turns until its next `agent_start`; reaches what the close channel reaches. */
const SESSION_SCOPE_SWITCH_CHANNEL = "pi-kit:session-scope:switch";

/**
 * How long quit waits for the run it aborted to settle. The agent runtime's
 * retire, bounded at 2 s too, comes after it, so a quit can take up to 4 s.
 */
const QUIT_SETTLE_BOUND_MS = 2000;

/**
 * Open the session scope of one extension factory. Call it first in the factory,
 * so its `session_shutdown` handler runs before the extension's own.
 */
export function createSessionScope(pi: ExtensionAPI): SessionScope {
	const controller = new AbortController();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	// Primed once pi has run `before_agent_start` in this runtime: a turn pi starts
	// from a custom message skips that event, and `wire` builds its prompt and the
	// engine its `Agent` description there. A reload or session replacement runs
	// the factory again, so a new runtime starts unprimed.
	let primed = false;
	// A user prompt pi has accepted and not yet run: pi reads as idle until
	// `_runAgentPrompt`, so a turn started here takes the run and the prompt
	// throws "Agent is already processing a prompt". Limit: an input that starts
	// no run leaves this set, refusing turns, until the next run starts: a prompt
	// that dies first (handled by an extension, no model or key, a failed
	// compaction), and `steer()`/`followUp()` while idle (RPC `steer`/`follow_up`,
	// the compaction queue flushed with `willRetry`).
	let promptStarting = false;
	// A switch or fork is coming (a scope saw `session_before_switch` or
	// `session_before_fork`, or an extension decided on one): pi's teardown aborts
	// the outgoing run before `session_shutdown`, and a turn started after that
	// abort, or deferred behind the aborted run's `agent_settled`, runs unaborted
	// in the outgoing session. Every scope of the runtime refuses, since whichever
	// extension starts the turn, it runs in the one session.
	// Limit: a switch that is cancelled or never comes keeps refusing until the
	// next run starts; the refused payload waits for that run.
	let switching = false;

	const close = () => {
		if (controller.signal.aborted) return;
		controller.abort();
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};

	// Unreffed: pi decides when the process exits, and its shutdown clears these.
	const track = (timer: ReturnType<typeof setTimeout>) => {
		timer.unref?.();
		timers.add(timer);
		return () => {
			clearTimeout(timer);
			timers.delete(timer);
		};
	};

	pi.on("before_agent_start", () => {
		primed = true;
		return undefined;
	});
	// A prompt sent while a run is in flight is queued into it and starts none.
	pi.on("input", (_event, ctx) => {
		if (ctx.isIdle()) promptStarting = true;
		return undefined;
	});
	pi.on("agent_start", () => {
		promptStarting = false;
		switching = false;
	});
	pi.events.on(SESSION_SCOPE_SWITCH_CHANNEL, () => {
		switching = true;
	});
	const holdTurnsForSwitch = () => {
		if (!controller.signal.aborted) pi.events.emit(SESSION_SCOPE_SWITCH_CHANNEL, undefined);
		return undefined;
	};
	pi.on("session_before_switch", holdTurnsForSwitch);
	pi.on("session_before_fork", holdTurnsForSwitch);
	// The first scope to see shutdown closes every scope in the runtime, so no
	// extension starts a turn while an earlier one's shutdown handler is awaited.
	// Limit: an extension without a scope, registered before the first one that
	// has one, runs its shutdown handler while the scopes are still open.
	pi.events.on(SESSION_SCOPE_CLOSE_CHANNEL, close);
	let onSettled: (() => void) | undefined;
	pi.on("agent_settled", () => {
		onSettled?.();
	});
	// A compaction outside a run ends with one of these and no settle.
	// Limit: two still wait the full bound at quit — a manual compaction that succeeds
	// (`session_compact` fires while isCompacting is true, so isIdle is false) and a
	// branch summary, which emits no compact event.
	const settledIfIdle = (_event: unknown, ctx: { isIdle(): boolean }) => {
		if (ctx.isIdle()) onSettled?.();
	};
	pi.on("session_compact", settledIfIdle);
	pi.on("session_compact_failed", settledIfIdle);
	pi.on("session_shutdown", async (event, ctx) => {
		if (controller.signal.aborted) return;
		pi.events.emit(SESSION_SCOPE_CLOSE_CHANNEL, undefined);
		// pi's quit (`AgentSessionRuntime.dispose`) shuts down first and aborts a run
		// in flight only as it invalidates the runtime, so that run's settle events
		// would reach invalidated runners. A replacement aborts and waits before its
		// shutdown, and a reload keeps the run. The scopes close first, so nothing
		// the settle handlers do starts a turn or a timer.
		if (event.reason !== "quit" || ctx.isIdle()) return;
		const settled = new Promise<void>((resolve) => {
			onSettled = resolve;
		});
		ctx.abort();
		let bound: ReturnType<typeof setTimeout> | undefined;
		// The macrotask after this scope's `agent_settled` lets every later
		// extension's synchronous settle handler finish first.
		// Limit: a run that ignores the abort delays quit by the bound, and its settle
		// after the bound, like a settle handler that reads ctx after awaiting I/O,
		// still reaches invalidated runners.
		await Promise.race([
			settled.then(() => new Promise<void>((resolve) => setImmediate(resolve))),
			new Promise<void>((resolve) => {
				bound = setTimeout(resolve, QUIT_SETTLE_BOUND_MS);
			}),
		]);
		clearTimeout(bound);
		onSettled = undefined;
	});

	return {
		signal: controller.signal,
		timeout(ms, run) {
			if (controller.signal.aborted) return () => {};
			const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
				timers.delete(timer);
				// Passed through so a fake timer can await the async work it started.
				return run();
			}, ms);
			return track(timer);
		},
		interval(ms, run) {
			if (controller.signal.aborted) return () => {};
			return track(setInterval(run, ms));
		},
		// Limit: a turn pi deferred (`_deferredSettledActions`) earlier in the same
		// `agent_settled` emission that decided the switch still runs after pi's
		// abort, in the outgoing session. That takes an async `agent_settled` handler
		// loaded before continue-session (none in today's loadout); closing it needs
		// pi to drop deferred actions in `teardownCurrent`/`abort`, which 0.87.1 has
		// no hook for.
		startTurn(message, options) {
			if (!primed || promptStarting || switching || controller.signal.aborted) return false;
			pi.sendMessage(message, { deliverAs: options.deliverAs, triggerTurn: true });
			return true;
		},
		holdTurnsForSwitch,
	};
}
