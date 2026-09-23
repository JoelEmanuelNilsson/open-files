/**
 * watchdog — bounds every wait a session can make, and makes the bound visible.
 *
 * The failure it exists for (issue 27): an `Explore` child grepped all of
 * `$HOME`, ripgrep never returned, and pi has no tool-execution timeout
 * anywhere. The child sat in one tool batch for 42.5 minutes, could not be
 * steered (steers drain at loop checkpoints a wedged batch never reaches), and
 * reported itself `running` the whole time. The error class is *unbounded waits
 * with no observable liveness*, and it has a second, latent member: pi-ai's SSE
 * reader parks in `await reader.read()` with no meaningful-event deadline, so a
 * provider that stalls while still sending `ping` keep-alives defeats undici's
 * 300s `bodyTimeout`.
 *
 * Both members look identical from inside the session: the agent is mid-run and
 * *nothing happens*. So this watches one thing — silence while running — rather
 * than one thing per hole. The clock is reset by any observable agent event
 * (turn boundaries, message deltas, tool starts/ends/progress) and only runs
 * between `agent_start` and `agent_settled`. An idle session holds no timer.
 *
 * `agent_settled`, not `agent_end`: pi fires `agent_end` once per agent run and
 * a retry or an auto-compaction produces several within one turn, while
 * `_isAgentRunActive` — the bit behind `ctx.isIdle()` — stays true across all of
 * them. Disarming on `agent_end` would leave a retried turn unwatched.
 *
 * Default agents ship `extensions: true`, so this loads inside every subagent as
 * well as the session that spawned it. That is the point: the abort happens *in*
 * the wedged session, where its own reason can be recorded, rather than from
 * outside where it cannot.
 *
 * Configuration, all optional:
 *   PI_WATCHDOG_MS    deadline in ms (default 900000 — 15 min; the number and
 *                     the evidence behind it live in `lib/silence-deadline.ts`,
 *                     because `session-mode` caps its keep-warm pings against
 *                     the same span and the two must move together)
 *   PI_WATCHDOG_MODE  "abort" | "warn" | "off" (default: abort, warn under TUI)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AGENT_WAIT_TOOL_NAMES } from "../lib/agent-tool-text.ts";
import { resolveDeadlineMs } from "../lib/silence-deadline.ts";

/** Warn at a third of the deadline: early enough to act on, late enough to mean something. */
const WARN_FRACTION = 1 / 3;

/**
 * Tools whose wait is already bounded by something other than this clock.
 *
 * Two kinds. The subagent tools are bounded by a *different session*:
 * `get_subagent_result` legitimately runs 21.3 minutes in the sample (p99
 * 15.8m; 25 of 80 calls over 3m) because it is waiting on a child — and that
 * child runs this same watchdog, so the wait is bounded one level down. Timing
 * them here would abort the orchestrator instead of the wedge.
 *
 * `bash` is bounded by *itself*: the kit's own tool (`extensions/bash.ts`)
 * defaults and clamps every call's `timeout`, and on the main seat a command
 * that reaches it is moved to the background rather than left to hang. A
 * silent `bash` is a command that has printed nothing yet, not a wedge, and
 * warning about it every five minutes was noise the human had already read on
 * the tool's own `Elapsed` line.
 *
 * The owned engine's waits are imported from their owner
 * (`lib/agent-tool-text.ts`), so a tool that blocks on a child cannot be added
 * there without landing here. The vendor names stay as literals until ticket
 * 20 removes the package: the pin is deliberately unowned (issue 01), and
 * reaching in for a four-entry constant would make the kit depend on its
 * module layout. A rename upstream fails safe in the wrong direction — the
 * watchdog would get stricter, not looser — so the cost of drift is a false
 * abort on an orchestrator, which the recorded reason names explicitly.
 */
const SELF_BOUNDED: ReadonlySet<string> = new Set([
	...AGENT_WAIT_TOOL_NAMES,
	"SubagentWorkflow",
	"get_subagent_result",
	"steer_subagent",
	"bash",
]);

/** What the watchdog decided to do about a stretch of silence. */
export type WatchdogAction = {
	kind: "warn" | "abort";
	/** The tool being blamed, or undefined when the silence is in the model stream. */
	toolName: string | undefined;
	/** How long the session had been silent when this fired. */
	silentMs: number;
};

export interface WatchdogOptions {
	deadlineMs: number;
	/** "warn" never aborts; "abort" warns first, then aborts. */
	mode: "warn" | "abort";
	now: () => number;
	/** Schedules `fire` and returns a cancel function. Real timers should be unref'd. */
	schedule: (delayMs: number, fire: () => void) => () => void;
	act: (action: WatchdogAction) => void;
}

/**
 * The silence clock. Pure of pi: it takes observations and time and emits
 * actions. Everything that makes it hard to test — event names, real timers,
 * aborting a real session — lives in the extension shell below.
 *
 * Timer discipline matters here. A streaming turn calls `touch()` once per token
 * delta, so `touch()` does no timer work at all: it writes two fields, and the
 * single armed timer recomputes silence from the clock when it fires. One live
 * timer while running, none while idle, regardless of token rate.
 */
export class Watchdog {
	readonly #options: WatchdogOptions;
	readonly #warnMs: number;
	/** toolCallId -> toolName, for tools started and not yet ended. */
	readonly #inFlight = new Map<string, string>();
	#running = false;
	#lastActivityAt = 0;
	/** Absolute time the next warning is due. Re-armed after each warning. */
	#warnDueAt = 0;
	#cancelTimer: (() => void) | undefined;

	constructor(options: WatchdogOptions) {
		this.#options = options;
		this.#warnMs = Math.max(1, Math.round(options.deadlineMs * WARN_FRACTION));
	}

	/** Live timer count. Zero while idle — the watchdog costs nothing at rest. */
	get timerCount(): number {
		return this.#cancelTimer ? 1 : 0;
	}

	/** The agent began a run. Arms the clock. */
	start(): void {
		this.#inFlight.clear();
		this.#running = true;
		this.touch();
		this.#arm(this.#warnMs);
	}

	/** The agent finished, errored, or was aborted. Disarms and releases the timer. */
	stop(): void {
		this.#running = false;
		this.#inFlight.clear();
		this.#cancel();
	}

	/** Any observable sign of life. Deliberately does no timer work. */
	touch(): void {
		const now = this.#options.now();
		this.#lastActivityAt = now;
		this.#warnDueAt = now + this.#warnMs;
	}

	toolStart(toolCallId: string, toolName: string): void {
		this.#inFlight.set(toolCallId, toolName);
		this.touch();
	}

	toolEnd(toolCallId: string): void {
		this.#inFlight.delete(toolCallId);
		this.touch();
	}

	/** True while a tool whose duration this session does not own is running. */
	#deferred(): boolean {
		for (const name of this.#inFlight.values()) if (SELF_BOUNDED.has(name)) return true;
		return false;
	}

	/**
	 * The tool to blame for the current silence. One name, not a list: a batch
	 * shares a deadline, and naming a single non-exempt tool is enough to find the
	 * wedge in the transcript.
	 */
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

	/** Timer callback. Recomputes silence from the clock; never trusts its own delay. */
	#check(): void {
		if (!this.#running) return;
		const now = this.#options.now();
		const silentMs = now - this.#lastActivityAt;

		// A wait this session does not own. Keep looking, never fire.
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
			// Re-armed rather than latched: in "warn" mode this is the only output,
			// and a human watching a hang wants to be told it is *still* hung.
			this.#warnDueAt = now + this.#warnMs;
			this.#options.act({ kind: "warn", toolName: this.#blame(), silentMs });
		}

		const untilWarn = this.#warnDueAt - now;
		const untilAbort =
			this.#options.mode === "abort"
				? this.#lastActivityAt + this.#options.deadlineMs - now
				: Number.POSITIVE_INFINITY;
		this.#arm(Math.min(untilWarn, untilAbort));
	}
}

/** Duration for a line a person or a model has to read. */
export function humanMs(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds >= 90 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
}

/**
 * The text a parent agent reads when its child is killed.
 *
 * This is the whole observability story, so it says what happened, what was
 * running, and what the reader should do next.
 *
 * Two constraints shape the wording, both load-bearing and both pinned by tests:
 *
 * 1. It must not look like a transient provider failure. pi auto-retries an
 *    errored turn when `isRetryableAssistantError` matches the text against
 *    pi-ai's pattern list ("timeout", "timed out", "terminated", "try your
 *    request again", …). A watchdog abort is the opposite of transient — the
 *    tool that hung once will hang again — so the text stays clear of those
 *    words. "deadline expired", not "timed out".
 * 2. It must survive as the *only* record. `record.result` still holds whatever
 *    partial prose the child managed, and a reader who sees prose assumes an
 *    answer, so the text says outright that everything above it is partial.
 */
export function abortReason(action: WatchdogAction, deadlineMs: number): string {
	const where = action.toolName ? `tool \`${action.toolName}\`` : "the model stream";
	return (
		`watchdog: aborted after ${humanMs(action.silentMs)} with no activity — ` +
		`${where} produced nothing and the ${humanMs(deadlineMs)} deadline expired. ` +
		"Any answer above this line is partial. Re-run with narrower work " +
		"(target repo paths, not `$HOME` or `/`)."
	);
}

/**
 * Warning text, for the one reader who can act on it directly.
 *
 * In "abort" mode it says when the abort comes; in "warn" mode there is no
 * abort coming, so naming a deadline would be a lie the human watches expire
 * ("silent for 20m (deadline 15m)"), and the line says what they can do instead.
 */
export function warnMessage(action: WatchdogAction, deadlineMs: number, mode: "warn" | "abort" = "abort"): string {
	const where = action.toolName ? `\`${action.toolName}\`` : "model stream";
	const tail = mode === "abort" ? `(aborts at ${humanMs(deadlineMs)})` : "— Esc to stop it";
	return `watchdog: ${where} silent for ${humanMs(action.silentMs)} ${tail}`;
}

/**
 * Warn, do not abort, when a human is watching.
 *
 * Takes a plain value, not `process.env`, for the reason
 * {@link resolveDeadlineMs} does: the shell reads the environment once at load,
 * so a session's behaviour cannot drift mid-run.
 *
 * `mode === "tui"` is the only context with a person in front of it: a
 * subagent's session runs the extension runner's default `"print"`, and so does
 * every scripted and RPC session. The rule this encodes is the honest one —
 * *kill unattended waits, report attended ones*. A human can already see a
 * spinner that has not moved and press Esc; taking a fifteen-minute turn away
 * from them because a build was slow is a worse harness than the hang.
 * `PI_WATCHDOG_MODE` overrides in both directions.
 */
export function resolveMode(
	sessionMode: string,
	forced: string | undefined,
): "warn" | "abort" | "off" {
	if (forced === "off" || forced === "warn" || forced === "abort") return forced;
	return sessionMode === "tui" ? "warn" : "abort";
}

type FailedAssistant = { role: "assistant"; stopReason?: string; errorMessage?: string };

/**
 * The two shapes pi gives a turn that did not finish.
 *
 * An abort surfaces as `stopReason: "error"` with "This operation was aborted"
 * when it lands inside the provider stream, and as `stopReason: "aborted"` with
 * "Operation aborted" when it lands between attempts — both appear in the local
 * session store (34 and 26 messages respectively). Which one a given abort takes
 * is not something a watchdog gets to choose, so it must recognise both.
 */
export function isFailedAssistant(message: unknown): message is FailedAssistant {
	const candidate = message as FailedAssistant | null;
	if (!candidate || candidate.role !== "assistant") return false;
	return candidate.stopReason === "error" || candidate.stopReason === "aborted";
}

export default function (pi: ExtensionAPI) {
	const deadlineMs = resolveDeadlineMs(process.env.PI_WATCHDOG_MS);
	const forcedMode = process.env.PI_WATCHDOG_MODE;
	let watchdog: Watchdog | undefined;
	/** Set when an abort fires; consumed by the `message_end` that follows it. */
	let pendingReason: string | undefined;

	pi.registerEntryRenderer<{ text?: string }>("watchdog", (entry, _options, theme) =>
		new Text(theme.fg("error", entry.data?.text ?? "watchdog fired"), 0, 0),
	);

	/**
	 * Built lazily: `mode` is only knowable once a context exists, and a session
	 * that never runs the agent never allocates one.
	 */
	function ensure(ctx: ExtensionContext): Watchdog | undefined {
		if (watchdog) return watchdog;
		const mode = resolveMode(ctx.mode, forcedMode);
		if (mode === "off") return undefined;
		watchdog = new Watchdog({
			deadlineMs,
			mode,
			now: () => Date.now(),
			schedule: (delayMs, fire) => {
				const timer = setTimeout(fire, delayMs);
				timer.unref?.();
				return () => clearTimeout(timer);
			},
			act: (action) => {
				// The authoritative liveness bit, checked at the last possible moment.
				// If the run settled without its event reaching us there is nothing to
				// abort and nothing worth saying, so the watchdog fails quiet rather
				// than firing at an idle session.
				if (ctx.isIdle()) {
					watchdog?.stop();
					return;
				}
				if (action.kind === "warn") {
					// One line, one place. Under the TUI the toast is the line the human
					// sees; headless, the transcript entry is the only trail there is.
					// Both together printed every warning twice.
					const text = warnMessage(action, deadlineMs, mode);
					if (ctx.mode === "tui") ctx.ui.notify(text, "warning");
					else pi.appendEntry("watchdog", { text });
					return;
				}
				const text = abortReason(action, deadlineMs);
				// Recorded first, and unconditionally: an abort can only be explained
				// by something that outlives it.
				pi.appendEntry("watchdog", { text });
				if (ctx.mode === "tui") ctx.ui.notify(text, "error");
				pendingReason = text;
				ctx.abort();
			},
		});
		return watchdog;
	}

	pi.on("agent_start", (_event, ctx) => {
		pendingReason = undefined;
		ensure(ctx)?.start();
	});
	pi.on("agent_settled", () => watchdog?.stop());

	pi.on("agent_end", () => watchdog?.touch());
	pi.on("turn_start", () => watchdog?.touch());
	pi.on("turn_end", () => watchdog?.touch());
	pi.on("message_start", () => watchdog?.touch());
	pi.on("message_update", () => watchdog?.touch());
	pi.on("tool_execution_start", (event) => watchdog?.toolStart(event.toolCallId, event.toolName));
	pi.on("tool_execution_update", () => watchdog?.touch());
	pi.on("tool_execution_end", (event) => watchdog?.toolEnd(event.toolCallId));

	/**
	 * Attribute the abort, and make sure it is not read as success.
	 *
	 * A parent decides a child's fate from the last assistant message: a failure
	 * is reported only for `stopReason: "error"`, which the runtime turns into
	 * `status: "error"` + `Agent failed: <errorMessage>`.
	 * An abort that lands as `stopReason: "aborted"` falls through that check —
	 * the record settles as `"completed"` and the parent reads the child's partial
	 * prose as a finished answer. That is issue 27's "reports itself healthy",
	 * rebuilt by the fix for it, so the rewrite normalises both shapes to `error`.
	 * The classification is also the honest one: `"aborted"` means a caller
	 * cancelled; nobody cancelled this, it failed.
	 *
	 * pi replaces the message in place — agent state, persisted session, and every
	 * later event — so this one rewrite is what the parent ends up reading.
	 */
	pi.on("message_end", (event) => {
		watchdog?.touch();
		const reason = pendingReason;
		if (reason === undefined || !isFailedAssistant(event.message)) return;
		pendingReason = undefined;
		return { message: { ...event.message, stopReason: "error" as const, errorMessage: reason } };
	});
}
