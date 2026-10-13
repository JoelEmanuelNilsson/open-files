import { AGENT_WAIT_TOOL_NAMES } from "../../lib/agents/agent-tool-text.ts";

const WARN_FRACTION = 1 / 3;

const SELF_BOUNDED: ReadonlySet<string> = new Set([
	...AGENT_WAIT_TOOL_NAMES,
	"bash",
]);

/** What the watchdog decided to do about a stretch of silence. */
export type WatchdogAction = {
	kind: "warn" | "abort";
	toolName: string | undefined;
	silentMs: number;
};

/** What the silence clock needs from its host: the deadline, the mode, a clock, a timer and the action sink. */
export interface WatchdogOptions {
	deadlineMs: number;
	mode: "warn" | "abort";
	now: () => number;
	schedule: (delayMs: number, fire: () => void) => () => void;
	act: (action: WatchdogAction) => void;
}

export class Watchdog {
	readonly #options: WatchdogOptions;
	readonly #warnMs: number;
	readonly #inFlight = new Map<string, string>();
	#running = false;
	#lastActivityAt = 0;
	#warnDueAt = 0;
	#warned = false;
	#cancelTimer: (() => void) | undefined;

	constructor(options: WatchdogOptions) {
		this.#options = options;
		this.#warnMs = Math.max(1, Math.round(options.deadlineMs * WARN_FRACTION));
	}

	get timerCount(): number {
		return this.#cancelTimer ? 1 : 0;
	}

	start(): void {
		this.#inFlight.clear();
		this.#running = true;
		this.touch();
		this.#arm(this.#warnMs);
	}

	stop(): void {
		this.#running = false;
		this.#inFlight.clear();
		this.#cancel();
	}

	touch(): void {
		const now = this.#options.now();
		this.#lastActivityAt = now;
		this.#warnDueAt = now + this.#warnMs;
		this.#warned = false;
	}

	toolStart(toolCallId: string, toolName: string): void {
		this.#inFlight.set(toolCallId, toolName);
		this.touch();
	}

	toolEnd(toolCallId: string): void {
		this.#inFlight.delete(toolCallId);
		this.touch();
	}

	#deferred(): boolean {
		for (const name of this.#inFlight.values()) if (SELF_BOUNDED.has(name)) return true;
		return false;
	}

	#blame(): string | undefined {
		for (const name of this.#inFlight.values()) if (!SELF_BOUNDED.has(name)) return name;
		return undefined;
	}

	#cancel(): void {
		this.#cancelTimer?.();
		this.#cancelTimer = undefined;
	}

	#arm(delayMs: number): void {
		this.#cancel();
		this.#cancelTimer = this.#options.schedule(Math.max(0, delayMs), () => {
			this.#cancelTimer = undefined;
			this.#check();
		});
	}

	#check(): void {
		if (!this.#running) return;
		const now = this.#options.now();
		const silentMs = now - this.#lastActivityAt;

		if (this.#deferred()) {
			this.#arm(this.#warnMs);
			return;
		}

		if (this.#options.mode === "abort" && silentMs >= this.#options.deadlineMs) {
			this.#options.act({ kind: "abort", toolName: this.#blame(), silentMs });
			this.stop();
			return;
		}

		if (now >= this.#warnDueAt) {
			this.#warnDueAt = now + this.#warnMs;
			const repeat = this.#warned && this.#options.mode === "warn";
			this.#warned = true;
			if (!repeat) this.#options.act({ kind: "warn", toolName: this.#blame(), silentMs });
		}

		const untilWarn = this.#warnDueAt - now;
		const untilAbort =
			this.#options.mode === "abort"
				? this.#lastActivityAt + this.#options.deadlineMs - now
				: Number.POSITIVE_INFINITY;
		this.#arm(Math.min(untilWarn, untilAbort));
	}
}

export function resolveMode(
	sessionMode: string,
	forced: string | undefined,
): "warn" | "abort" | "off" {
	if (forced === "off" || forced === "warn" || forced === "abort") return forced;
	return sessionMode === "tui" ? "warn" : "abort";
}
