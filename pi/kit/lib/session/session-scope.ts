import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A custom message a scope may start a turn with. */
export type TurnMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

export interface SessionScope {
	readonly signal: AbortSignal;
	timeout(ms: number, run: () => void): () => void;
	interval(ms: number, run: () => void): () => void;
	startTurn(message: TurnMessage): boolean;
	readonly leaving: boolean;
	onTurnsReopen(run: () => void): void;
}

const SESSION_SCOPE_CLOSE_CHANNEL = "pi-kit:session-scope:close";

const QUIT_SETTLE_BOUND_MS = 2000;

const PROMPT_CONFIRM_BOUND_MS = 1000;

export function createSessionScope(pi: ExtensionAPI): SessionScope {
	const controller = new AbortController();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let primed = false;
	let promptStarting = false;
	let cancelConfirmBound: (() => void) | undefined;
	let refusedWhileStarting = false;
	let reopen: (() => void) | undefined;
	let switching = false;

	const close = () => {
		if (controller.signal.aborted) return;
		controller.abort();
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};

	const track = (timer: ReturnType<typeof setTimeout>) => {
		timer.unref?.();
		timers.add(timer);
		return () => {
			clearTimeout(timer);
			timers.delete(timer);
		};
	};

	const endConfirmBound = () => {
		cancelConfirmBound?.();
		cancelConfirmBound = undefined;
	};
	const awaitConfirm = (ctx: { isIdle(): boolean }) => {
		// raw-timer: the scope's own timers, cleared when it closes, and quit's settle bound, cleared when it resolves
		cancelConfirmBound = track(setTimeout(() => {
			cancelConfirmBound = undefined;
			if (!ctx.isIdle()) return awaitConfirm(ctx);
			promptStarting = false;
			if (!refusedWhileStarting) return;
			refusedWhileStarting = false;
			reopen?.();
		}, PROMPT_CONFIRM_BOUND_MS));
	};

	pi.on("before_agent_start", () => {
		primed = true;
		endConfirmBound();
		return undefined;
	});
	pi.on("input", (_event, ctx) => {
		if (!ctx.isIdle() || controller.signal.aborted) return undefined;
		promptStarting = true;
		endConfirmBound();
		awaitConfirm(ctx);
		return undefined;
	});
	pi.on("agent_start", () => {
		promptStarting = false;
		refusedWhileStarting = false;
		endConfirmBound();
		switching = false;
	});
	const holdTurnsForSwitch = () => {
		switching = true;
		return undefined;
	};
	pi.on("session_before_switch", holdTurnsForSwitch);
	pi.on("session_before_fork", holdTurnsForSwitch);
	pi.events.on(SESSION_SCOPE_CLOSE_CHANNEL, close);
	let onSettled: (() => void) | undefined;
	pi.on("agent_settled", () => {
		onSettled?.();
	});
	const settledIfIdle = (_event: unknown, ctx: { isIdle(): boolean }) => {
		if (ctx.isIdle()) onSettled?.();
	};
	pi.on("session_compact", settledIfIdle);
	pi.on("session_compact_failed", settledIfIdle);
	pi.on("session_shutdown", async (event, ctx) => {
		if (controller.signal.aborted) return;
		pi.events.emit(SESSION_SCOPE_CLOSE_CHANNEL, undefined);
		if (event.reason !== "quit" || ctx.isIdle()) return;
		const settled = new Promise<void>((resolve) => {
			onSettled = resolve;
		});
		ctx.abort();
		let bound: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			settled.then(() => new Promise<void>((resolve) => setImmediate(resolve))),
			new Promise<void>((resolve) => {
				// raw-timer: the scope's own timers, cleared when it closes, and quit's settle bound, cleared when it resolves
				bound = setTimeout(resolve, QUIT_SETTLE_BOUND_MS);
			}),
		]);
		clearTimeout(bound);
		onSettled = undefined;
	});

	return {
		signal: controller.signal,
		get leaving() {
			return switching || controller.signal.aborted;
		},
		timeout(ms, run) {
			if (controller.signal.aborted) return () => {};
			// raw-timer: the scope's own timers, cleared when it closes, and quit's settle bound, cleared when it resolves
			const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
				timers.delete(timer);
				return run();
			}, ms);
			return track(timer);
		},
		interval(ms, run) {
			if (controller.signal.aborted) return () => {};
			// raw-timer: the scope's own timers, cleared when it closes, and quit's settle bound, cleared when it resolves
			return track(setInterval(run, ms));
		},
		startTurn(message) {
			if (!primed || switching || controller.signal.aborted) return false;
			if (promptStarting) {
				refusedWhileStarting = true;
				return false;
			}
			pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
			return true;
		},
		onTurnsReopen(run) {
			reopen = run;
		},
	};
}
