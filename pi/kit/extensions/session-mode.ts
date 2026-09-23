/**
 * session-mode — one launch question that fixes everything cache-shaped.
 *
 * Three ways a session with a human at it can start, picked once, before
 * anything is cached:
 *   short+ping  the default. Anthropic 5m cache — cheapest writes (1.25x) — plus a
 *               gap-armed replay ping at MAIN_GAP_PING_MS, so a pause costs one
 *               cache read instead of a full-prefix rewrite.
 *   short       the same 5m cache with nothing keeping it warm.
 *   keepalive   1h cache (writes at 2x) + a byte-identical replay ping of the last
 *               request every KEEPALIVE_PING_MS while idle, so the cache never
 *               expires while the seat is in use.
 *
 * Neither chain outlives the human. A seat that is doing nothing and waiting for
 * nothing stops pinging once Joel has been silent for the mode's window — 30m on
 * the 5m desk, 2h on the wide one (issues/36) — because past that the bet the
 * ping represents (there will be a next turn) has lost, and every read after it
 * is charged for nothing. One predicate, {@link chainAlive}, gates every arming
 * and every firing in both chains, so that is one fact rather than four.
 *
 * There is no mid-session switch and no plain 1h mode: a 1h cache without pings
 * dies at the first long pause, and a combination you would never use is not
 * offered. A second question follows the three rows: whether this seat carries
 * the `Workflow` tool, off unless Joel says yes. It is asked here, at launch,
 * for the same reason retention is — turning a tool on mid-session rewrites the
 * whole cached prefix (~$1 at 60k) — and the answer is published on the seat
 * (`lib/seat.ts`), which is what cuts the tool off the wire and refuses it by
 * name (`lib/tool-policy.ts`). This extension still withdraws no tool itself.
 *
 * A third way exists but is never offered, because nobody is there to be asked:
 * a session with no UI — every subagent — takes {@link HEADLESS_CHOICE}, which is
 * the default choice on a tighter cadence (GAP_PING_MS), pinging only while the
 * seat is in flight or has live children and stopping the moment it settles
 * without them ({@link HEADLESS_IDLE_MS}).
 *
 * Cache mechanism: retention is a property of each outgoing payload, owned per
 * session. The before_provider_request hook normalizes every cache_control
 * breakpoint to this session's TTL — `ttl:"1h"` in keepalive, the bare 5m
 * default otherwise. Extension instances are per session by construction, so a
 * subagent's fresh in-process instance picks its own retention and keeps it,
 * whatever any other session chose — there is no process-global state to race
 * on. (This extension never reads or writes PI_CACHE_RETENTION; the env
 * mechanism was Bug A, .scratch/perfect-harness/issues/13.)
 *
 * Ping mechanism: `lib/ping.ts`, which owns the replay — and owns *not*
 * building an envelope for it: a ping is a real pi-ai request with the payload
 * pinned, so the headers are the ones pi-ai would have sent anyway. This module
 * owns only the *policy* — when a session pings, how often, and when it stops —
 * and it never owns the payload: the bytes come from `wire`, the one handler
 * that produces the final request. See that module's header for why a
 * self-captured payload was a full-price cache write wearing a ping's clothes.
 *
 * Both answers are persisted as one custom session entry and restored on resume.
 *
 * The window it publishes (`lib/cache-window.ts`, rendered by zen-chrome) is
 * anchored on the request that wrote the cache, and on the TTL that request
 * carried — then corrected against the provider's own accounting: a keepalive
 * write whose usage carries no 1h slice means Anthropic granted 5m, and the
 * clock must report that, not what we asked for. The same rule governs a halted
 * chain: once nothing renews the cache, the bar counts down to the last write's
 * real expiry instead of showing keepalive's open-ended glyph. Only the instance
 * that owns a UI publishes, because the window lives on globalThis and subagent
 * instances in the same process would otherwise overwrite the main session's
 * countdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { liveAgentsOf, watchLiveAgentsOf } from "../lib/agent-live-count.ts";
import { AGENT_WAIT_TOOL_NAMES } from "../lib/agent-tool-text.ts";
import { BASH_MAX_TIMEOUT_SEC } from "../lib/bash.ts";
import {
	accounted,
	type CacheMode,
	type Cold,
	forgetCacheWindow,
	LONG_TTL_MS,
	publishCacheWindow,
	publishRenewal,
	SHORT_TTL_MS,
	ttlFromPayload,
} from "../lib/cache-window.ts";
import { publishPingTarget, readPingTarget, sendPing } from "../lib/ping.ts";
import { declareSeatWorkflows } from "../lib/seat.ts";
import { createSessionScope } from "../lib/session-scope.ts";
import { resolveDeadlineMs } from "../lib/silence-deadline.ts";
import { type PrefixKey, recordWarmPrefix, warmPrefixDir, withdrawRenewal } from "../lib/warm-prefix.ts";

/** Kept as "cache-mode" so sessions persisted before the rename still restore. */
const ENTRY_TYPE = "cache-mode";
/** Why the chain stopped, written to the session file so a resume can read it. */
const HALT_ENTRY_TYPE = "cache-pings-off";

/** 55m, not 59m: margin for request latency and clock skew against the 1h TTL. */
const KEEPALIVE_PING_MS = 55 * 60 * 1000;
/** Give up an idle keep-alive ping after this long. It has an hour of slack. */
const PING_TIMEOUT_MS = 60 * 1000;

/**
 * 4:30 into a headless seat's 5m window, leaving 30s of margin for latency and
 * clock skew — not 4:55, which has none.
 */
const GAP_PING_MS = 4.5 * 60 * 1000;
/**
 * 4:40 into the main seat's 5m window, against a headless seat's 4:30: 20s of
 * margin is enough where nothing is racing a watchdog, and every ping not sent
 * is a full cache read not paid for (issues/33).
 */
const MAIN_GAP_PING_MS = 4 * 60 * 1000 + 40 * 1000;
/**
 * How long a seat that is doing nothing and waiting for nothing keeps pinging
 * after Joel's last message: 45 minutes on the 5m desk, 2 hours on the wide one
 * (issues/36; 30 minutes until 2026-05, raised because a lunch break was
 * costing the rewrite).
 *
 * Chosen, not derived, and the ticket says so. The break-even answers "how long
 * is pinging still cheaper than one rewrite for a session he is coming back to":
 * a ping costs the prefix at the cache-read price, and letting the entry expire
 * costs it at the write price instead of the read the next turn pays anyway, so
 * one idle gap breaks even at (write − read) / read pings — ($5 − $0.20) / $0.20
 * = 24 on Opus 5.5, about 112 minutes at 4:40 (`bin/ping-economics.mjs` prints
 * it from pi's model table). This answers a different
 * question — a session he is not coming back to — where the saving is zero and
 * the whole ping bill is the price. So the number sits at "long enough that a
 * coffee break is free", and the cost of being wrong is one 1.25x rewrite.
 */
const IDLE_SHUTOFF_SHORT_MS = 45 * 60 * 1000;
const IDLE_SHUTOFF_LONG_MS = 2 * 60 * 60 * 1000;
/**
 * The one retry, measured from when the *first* attempt was issued rather than
 * from when it failed. That is what makes "the retry is still inside the
 * window" true rather than hopeful: however the first attempt dies — refused in
 * a millisecond or hung to its timeout — the retry goes out by 4:45, fifteen
 * seconds before the entry expires.
 */
const GAP_RETRY_MS = 15 * 1000;
/**
 * A gap ping that has not answered in 15s has lost its race, and the remaining
 * margin is better spent on the retry than on waiting. Much shorter than the
 * idle keep-alive's minute, because the deadline is 30s away rather than 5
 * minutes.
 */
const GAP_TIMEOUT_MS = 15 * 1000;

/**
 * The one launch question, and what its answer means. Asked as a select with
 * "No" first rather than as `ui.confirm`, because pi's confirm is a select with
 * "Yes" first: Enter would carry the tool, and the answer given every day is no.
 * Enter and Escape both take "No".
 */
const WORKFLOWS_TITLE = "Carry the Workflow tool?";
const WORKFLOWS_MESSAGE =
	"Off by default. A workflow runs the same job over many items from a script. The answer holds for this whole session — a tool turned on later rewrites the cached prefix.";
const WORKFLOWS_OPTIONS = ["No", "Yes"] as const;

/**
 * What a UI-less session gets, which in practice means every subagent: a plain
 * 5m window, and a ping that keeps it from ever expiring.
 *
 * This supersedes the `long` (1h, no pings) policy ticket 26 drew from a real
 * finding. The finding stands — Anthropic starts the retention clock when the
 * writing request *begins*, so a 30–40k-token thinking turn streaming for
 * 250–335s can spend its own 5m window — but the insurance was priced against
 * the wrong operating point, and the numbers are lopsided (issues/33):
 *
 *   - 21 sessions of wire trace, 376 request-start gaps on high-thinking build
 *     seats: median 7s, p99 69s, **max 134s**. Not one gap reached half the
 *     window.
 *   - Replaying that corpus under both policies: $103.93 at 5m against $117.61
 *     at 1h — **+13.2% for an event that happened zero times in 376 chances**.
 *     The 1h premium is simply 0.75 x final context, because every token of a
 *     conversation is cache-written exactly once: $0.56 / $1.13 / $2.81 per
 *     session at 50k / 100k / 250k on opus.
 *   - 1h only wins past ~7 full-context pings or ~0.65 full misses per session,
 *     which is 30–41 minutes of cumulative silent stalling — and the watchdog
 *     kills any child silent for 15 minutes.
 *
 * So the window is cheap and the gap is covered by pinging rather than by
 * buying an hour of retention nobody uses. The ping is tail insurance for the
 * 600s bash call and the very long thinking turn, not the thing carrying the
 * win: even a naked 5m cache with no pings beats 1h at the observed gaps.
 */
const HEADLESS_CHOICE = { mode: "short" as CacheMode };

/**
 * How long a headless seat keeps pinging once it has settled with no live
 * children: not at all.
 *
 * A settled subagent has reported to its parent, and a resume is rare —
 * `bin/ping-economics.mjs` prints how rare, and what the pings after a seat's
 * last request cost, from the wire traces. Pinging a settled seat pays only if
 * its resume lands within the break-even (see {@link IDLE_SHUTOFF_SHORT_MS}):
 * (write − read) / read pings. So the chain stops at the settle, and a resume
 * pays one rewrite. That is the intended trade.
 */
const HEADLESS_IDLE_MS = 0;

/**
 * The one way a session with a human at it starts: the 5m desk, pinged across
 * pauses, stopping {@link IDLE_SHUTOFF_SHORT_MS} after Joel's last message.
 *
 * This used to be a launch question with two rows — this one and "Long" (1h
 * cache, keep-alive pings, 2h shutoff) — and before that a third, short with
 * the pings off. Both went the same way: a row offered every session has to
 * earn the second it takes to skip, and only this one was ever picked. The 1h
 * desk lost on the numbers too (see {@link HEADLESS_CHOICE}).
 *
 * Dropping the rows does not delete the seats. A session file written before
 * this carries `mode: "keepalive"` or `ping: false`, and a resume restores what
 * it says rather than asking again, so both are still reachable -- by resume
 * only, which is how `smoke.mjs` reaches them. A headless seat is not this
 * seat either: it pings on a tighter cadence, because an orchestrator waiting
 * on children has the longest gaps of all.
 */
const MAIN_CHOICE = { mode: "short" as CacheMode, ping: true };

function isCacheMode(value: unknown): value is CacheMode {
	return value === "short" || value === "long" || value === "keepalive";
}

/**
 * How many ping rounds a headless seat may fire while nothing observable
 * happens in it and it has no child to wait on. A ceiling against a hung
 * in-flight state, not the test of whether the seat is working: that test is
 * `busyOrWaiting`, and a settled seat stops without reaching this.
 *
 * Declared limit: a seat's own in-flight work is silent for at most the longer
 * of two bounds. A subagent's `bash` call is killed at its timeout, clamped to
 * BASH_MAX_TIMEOUT_SEC (30m, `lib/bash.ts`), and the watchdog exempts bash.
 * A stream or any other tool is aborted by the watchdog at its silence deadline
 * (15m, `lib/silence-deadline.ts`). Past that span the seat is in flight only
 * by bookkeeping, or because the watchdog was set to warn or off. The `+ 1` is
 * margin for the kill itself. Waiting on children has no ceiling: each child is
 * bounded by these same rules one level down, and the chain ends when the
 * children settle; a live-agent record that is never settled is the residual.
 *
 * It bounds *rounds*, not HTTP requests: a round that fails retries once, so
 * the true ceiling is twice this in attempts.
 */
function gapPingCap(deadlineMs: number): number {
	return Math.ceil(Math.max(BASH_MAX_TIMEOUT_SEC * 1000, deadlineMs) / GAP_PING_MS) + 1;
}

export default function (pi: ExtensionAPI) {
	const scope = createSessionScope(pi);
	let mode: CacheMode = "short";
	/** Whether this seat carries the `Workflow` tool. Decided once, before the first request. */
	let workflows = false;
	let sessionId = "";
	let agentRunning = false;
	/**
	 * Epoch ms of the last sign this seat is in use: a message from Joel, a real
	 * provider request, a turn or a child settling. A ping is not one of them — it
	 * replays bytes without going through the request path — which is what lets
	 * this measure silence rather than measuring its own chain.
	 */
	let lastActivityAt = 0;
	/** The window this session was resumed with, so it cannot inherit another mode's. */
	let restoredIdleMs: number | undefined;
	let unwatchAgents: (() => void) | undefined;
	/**
	 * Engine waits in flight (`Agent` on a fork, `TaskOutput`). A seat inside one
	 * is running by pi's account and idle by the cache's: nothing of its own will
	 * touch the provider until the child answers, which can be an hour away. So
	 * the keep-alive chain runs through a wait as if the seat were idle, and the
	 * headless gap chain's round ceiling does not apply — the watchdog exempts the
	 * same tools, so the seat is legitimately alive (ticket 05 H6, ticket 10).
	 */
	let engineWaits = 0;
	/** The TTL the last request actually carried, so a replay ping can reuse it. */
	let writtenTtl = 0;
	let warmUntil = 0;
	/** When the last provider request started; every TTL clock anchors here. */
	let lastRequestAt = 0;
	/** The model the last request went out on; the window is warm for it alone. */
	let lastModel: string | undefined;
	/** The reasoning level the last request went out at; see `CacheWindow.reasoning`. */
	let lastReasoning: string | undefined;
	let uiSession = false;
	/** Evidence said a keepalive write came back 5m. Pings stop: a 55m ping
	 * against a 5m entry is a guaranteed full-prefix rewrite, not a refresh. */
	let retentionDenied = false;
	let retentionWarned = false;
	/** A ping failed, or the window ran out. Nothing renews the cache after this. */
	let pingsHalted = false;

	// The two schedules keep separate timers even though no session runs both.
	// One shared timer would let `agent_start`'s keepalive disarm silently cancel
	// a headless seat's gap ping — a bug with no symptom until a cache bill.
	let cancelKeepalive: (() => void) | undefined;
	let cancelGap: (() => void) | undefined;
	/**
	 * Whether this seat runs the gap chain: every headless seat, and the default
	 * choice at a seat with a human at it.
	 */
	let gapPinging = false;
	/**
	 * Ping rounds fired since this seat last showed activity: a real request, a
	 * stream delta, or a tool starting, updating or ending.
	 */
	let silentRounds = 0;
	let gapCap = gapPingCap(resolveDeadlineMs(process.env.PI_WATCHDOG_MS));
	/**
	 * Which stretch of silence the gap chain is currently covering. Bumped by
	 * every real request.
	 *
	 * A ping runs concurrently with requests by design, so a ping can outlive the
	 * window it was sent to save. Without a generation, that finished ping still
	 * gets to decide the schedule: on failure it calls `scheduleGapPing`, which
	 * disarms — cancelling the timer the newer request had just armed and leaving
	 * the seat with no ping at all until the request after that. The seat then
	 * pays exactly the full-prefix rewrite this whole mechanism exists to prevent.
	 * Cheap to close, so it is closed rather than priced.
	 */
	let gapEpoch = 0;

	/**
	 * A cache write happened at `at` carrying `ttl`. Both come from the request
	 * itself: the clock starts when the provider sees the prompt, not when the run
	 * finishes, and a long run would otherwise over-report by its whole duration.
	 */
	function recordWrite(at: number, ttl: number): void {
		writtenTtl = ttl;
		warmUntil = at + ttl;
		publish();
	}

	/**
	 * The window one request opened: its own start, and the retention its payload
	 * asked for. `fallbackTtl` covers a payload that asks for no cache at all.
	 *
	 * The one derivation, called live and again after a reload, so the two anchors
	 * cannot drift; before this they were separate code that agreed by inspection
	 * and only the resume path was tested (issues/45). Limit, stated: the anchor is
	 * still this hook's own `now()` rather than the published `PingTarget.at`, so
	 * the value cannot depend on whether `wire`'s handler for the same event ran
	 * before this one — pi promises no order between two extensions.
	 */
	function anchorWindow(payload: unknown, at: number, fallbackTtl?: number): void {
		lastRequestAt = at;
		const ttl = ttlFromPayload(payload) ?? fallbackTtl;
		if (ttl !== undefined) recordWrite(at, ttl);
	}

	/** Every clock in this module reads here, so a test can drive them all. */
	function now(): number {
		return Date.now();
	}

	/**
	 * A successful replay restarted the provider's clock for the prefix it
	 * carried, and every other seat on this machine may read that off the ledger
	 * (`lib/warm-prefix.ts`). Real requests file themselves from `wire`, which
	 * owns the bytes; a ping's bytes are the target's, so its key is too.
	 */
	function ledgerRefreshed(prefixKey: PrefixKey | undefined, model: string, at: number, ttl: number): void {
		if (prefixKey === undefined) return;
		try {
			const keep = keepUntil();
			recordWarmPrefix(warmPrefixDir(), prefixKey, sessionId, { model, at, ttlMs: ttl, ...(keep === undefined ? {} : { keepUntil: keep }) });
		} catch {
			// The ledger is a status-bar input; a failed write may not touch the chain.
		}
	}

	/** Nothing will replay this seat's prefix from here: take the commitment out of the ledger, keep the anchor. */
	function ledgerWithdrawn(): void {
		const prefixKey = readPingTarget(sessionId)?.prefixKey;
		if (prefixKey === undefined) return;
		try {
			withdrawRenewal(warmPrefixDir(), prefixKey, sessionId);
		} catch {
			// Same as above: the ledger may not take the seat down with it.
		}
	}

	/** Silence this session's chain tolerates once nothing is running. Joel's numbers, by mode. */
	function idleWindowMs(): number {
		if (!uiSession) return HEADLESS_IDLE_MS;
		return restoredIdleMs ?? (mode === "keepalive" ? IDLE_SHUTOFF_LONG_MS : IDLE_SHUTOFF_SHORT_MS);
	}

	/** Whether this seat runs either ping chain at all. */
	function chainRuns(): boolean {
		return gapPinging || mode === "keepalive";
	}

	/**
	 * The seat is doing something, or waiting for something that will make it
	 * speak again: a turn in flight, an engine wait, an agent or workflow of its
	 * own still live. Such a seat gets a next turn, so its cache is worth keeping.
	 *
	 * Limit, stated: a backgrounded bash run is not counted. `extensions/bash.ts`
	 * keeps its runs in a module-local map with no cross-module seam, and the cost
	 * of the miss is one 1.25x rewrite when the run reports back.
	 */
	function busyOrWaiting(): boolean {
		return agentRunning || waitingOnChildren();
	}

	/** Blocked in an engine wait, or owner of an agent or workflow still live. */
	function waitingOnChildren(): boolean {
		return engineWaits > 0 || liveAgentsOf(sessionId).size > 0;
	}

	/**
	 * Whether this chain may still ping: the seat is doing something, or Joel is
	 * still here. The single condition every arming and every firing gates on, so
	 * that "an abandoned session stops pinging" is one fact rather than four.
	 */
	function chainAlive(): boolean {
		return busyOrWaiting() || now() - lastActivityAt < idleWindowMs();
	}

	/** What ends this seat's warmth: the TTL, the shutoff's date, or the window a busy seat holds open. */
	function coldClock(): Cold {
		if (!chainRuns() || pingsHalted) return { kind: "ttl" };
		if (busyOrWaiting()) return { kind: "held", windowMs: idleWindowMs() };
		return { kind: "shutoff", at: lastActivityAt + idleWindowMs() };
	}

	/**
	 * How long this seat commits to replaying its prefix, for the machine-wide
	 * ledger. Read off {@link coldClock} so the number the bar counts down and the
	 * number other seats read cannot disagree.
	 */
	function keepUntil(): number | undefined {
		const cold = coldClock();
		if (cold.kind === "ttl") return undefined;
		return cold.kind === "held" ? now() + cold.windowMs : cold.at;
	}

	/**
	 * The status bar, from current state. `as` overrides the mode where the window
	 * we can still honour is narrower than the one the session asked for.
	 */
	function publish(as: CacheMode = mode): void {
		publishCacheWindow(sessionId, {
			mode: as,
			warmUntil,
			...(lastModel === undefined ? {} : { model: lastModel }),
			...(lastReasoning === undefined ? {} : { reasoning: lastReasoning }),
			cold: coldClock(),
		});
	}

	/** The seat is in use: restart the silence this chain is measuring. */
	function touch(): void {
		lastActivityAt = now();
		publish();
	}

	/**
	 * Force every cache breakpoint in an Anthropic payload to this session's TTL:
	 * `ttl:"1h"` in keepalive, the bare 5m default otherwise. Both directions
	 * matter — pi-ai still reads PI_CACHE_RETENTION from live process.env when it
	 * builds the payload, so a value leaked into the environment would otherwise
	 * silently buy 1h writes (at 2x) for a short-mode session.
	 * Field-disjoint from every other payload writer (they own system blocks and
	 * headers; this owns `cache_control.ttl`) and idempotent, so handler order
	 * cannot change the wire result.
	 */
	function normalizeCacheTtl(payload: Record<string, unknown>, long: boolean): void {
		const sections: unknown[] = [payload.tools, payload.system];
		if (Array.isArray(payload.messages)) {
			for (const message of payload.messages) {
				sections.push((message as { content?: unknown } | null)?.content);
			}
		}
		for (const section of sections) {
			if (!Array.isArray(section)) continue;
			for (const block of section) {
				const control = (block as { cache_control?: { type?: unknown; ttl?: unknown } } | null)?.cache_control;
				if (control?.type !== "ephemeral") continue;
				if (long) control.ttl = "1h";
				else delete control.ttl;
			}
		}
	}

	function apply(choice: { mode: CacheMode; ping: boolean; workflows: boolean }, persist: boolean): void {
		mode = choice.mode;
		gapPinging = choice.ping;
		workflows = choice.workflows;
		// Published before the first request goes out, which is what makes "the tool
		// set is settled at launch" true rather than hoped for.
		declareSeatWorkflows(sessionId, workflows);
		publish();
		// The window rides with the mode, so a resumed session cannot inherit another
		// mode's idea of how long a silence is allowed to run.
		if (persist) pi.appendEntry(ENTRY_TYPE, { mode, ping: gapPinging, workflows, idleMs: idleWindowMs() });
		if (mode !== "keepalive") stopKeepaliveTimer();
	}

	// ---- the interactive keepalive chain ---------------------------------------

	function stopKeepaliveTimer(): void {
		cancelKeepalive?.();
		cancelKeepalive = undefined;
	}

	/**
	 * Stop pinging, both chains, and stop the status bar promising a window
	 * nothing renews. The last write's expiry is real, so the bar counts down to
	 * it instead of showing keepalive's open-ended glyph — the same correction the
	 * retention denial detector makes, for the same reason.
	 *
	 * The reason goes in the session file: a chain that stopped on its own is
	 * otherwise indistinguishable from one that was never armed.
	 */
	function haltPings(reason: string): void {
		stopKeepaliveTimer();
		stopGapTimer();
		if (pingsHalted) return;
		pingsHalted = true;
		pi.appendEntry(HALT_ENTRY_TYPE, { reason, mode, at: now() });
		ledgerWithdrawn();
		publish("short");
	}

	/** Running, and not parked inside an engine wait: the seat's own requests keep the cache warm. */
	function busyWithOwnRequests(): boolean {
		return agentRunning && engineWaits === 0;
	}

	/**
	 * Arm the next keep-alive ping. `delayMs` defaults to the full interval; an
	 * engine wait passes the remainder of the interval measured from the request
	 * that wrote the entry, because the wait began some way into the window.
	 */
	function scheduleKeepalive(notify: (msg: string, level: "info" | "warning" | "error") => void, delayMs = KEEPALIVE_PING_MS): void {
		stopKeepaliveTimer();
		if (mode !== "keepalive" || retentionDenied || pingsHalted || busyWithOwnRequests()) return;
		if (!chainAlive()) {
			notify("session-mode: idle for the window with nothing running — keep-alive pings stopped", "info");
			haltPings("idle");
			return;
		}
		if (readPingTarget(sessionId) === undefined) return;
		// A keep-warm ping may never take down the session it is warming. Nothing in
		// either chain throws today; the catch makes that a property, not a hope.
		cancelKeepalive = scope.timeout(delayMs, () => runKeepalivePing(notify).catch(() => {}));
	}

	async function runKeepalivePing(notify: (msg: string, level: "info" | "warning" | "error") => void): Promise<void> {
		cancelKeepalive = undefined;
		const target = readPingTarget(sessionId);
		if (mode !== "keepalive" || retentionDenied || pingsHalted || busyWithOwnRequests() || !target) return;
		if (!chainAlive()) {
			notify("session-mode: idle for the window with nothing running — keep-alive pings stopped", "info");
			haltPings("idle");
			return;
		}

		const sentAt = now();
		const result = await sendPing(target, PING_TIMEOUT_MS, scope.signal);
		target.record(result);
		if (scope.signal.aborted) return;
		if (result.ok) {
			// The ping replays the last payload verbatim, so it renews the same TTL.
			recordWrite(sentAt, writtenTtl || LONG_TTL_MS);
			// The provider's clock restarted at this ping, so the anchor a reload
			// resumes from is this send, not the request's: resuming from the request
			// called a window the pings had kept open closed (2026-09-09).
			publishPingTarget({ ...target, at: sentAt });
			ledgerRefreshed(target.prefixKey, target.model.id, sentAt, writtenTtl || LONG_TTL_MS);
			scheduleKeepalive(notify); // keep going until the idle shutoff
			return;
		}
		// A timeout is the network, not a verdict: the entry may well still be
		// there, and the alternative to trying again in an hour is not trying.
		// Everything else — a rejected status, an unresolvable credential — will
		// still be true in an hour, so the chain stops and says so.
		if (result.reason === "timeout") {
			scheduleKeepalive(notify);
			return;
		}
		notify(`session-mode: keep-alive ping failed (${result.detail}) — stopping pings`, "warning");
		haltPings(`ping failed: ${result.detail}`);
	}

	// ---- the headless gap chain ------------------------------------------------

	function stopGapTimer(): void {
		cancelGap?.();
		cancelGap = undefined;
	}

	/** The main seat pings at 4:40, a headless seat at 4:30. */
	function gapPingMs(): number {
		return uiSession ? MAIN_GAP_PING_MS : GAP_PING_MS;
	}

	/**
	 * A real request just went out, so the window is fresh and the ping budget
	 * starts over. Re-arming here rather than at `agent_settled` is the whole
	 * point: the gap that kills a headless seat is *inside* a streaming turn or a
	 * long tool call, not between turns (issues/26), and by the time a turn
	 * stalls its payload is already captured.
	 */
	function armGapPing(delayMs = gapPingMs()): void {
		if (!gapPinging) return;
		// A real request is proof of life and rewrites the entry anyway, so whatever
		// stopped this chain — a shutoff Joel has walked back from, a pair of failed
		// rounds — is over.
		pingsHalted = false;
		silentRounds = 0;
		gapEpoch++;
		scheduleGapPing(delayMs, 0);
	}

	/**
	 * Pick a chain back up from bytes an earlier instance of this extension left
	 * on the seam.
	 *
	 * A reload rebuilds every extension while the seat, its conversation and the
	 * provider's entry go on. Arming only from a real request left that window
	 * with nothing renewing it, so the first thing typed after a reload paid the
	 * full-prefix rewrite this mode exists to avoid (issues/43). The anchor is the
	 * captured request's own send time, not this instant, because that is when the
	 * provider's clock started.
	 */
	function resumeChain(notify: (msg: string, level: "info" | "warning" | "error") => void): void {
		const target = readPingTarget(sessionId);
		if (target === undefined) return;
		anchorWindow(target.payload, target.at, SHORT_TTL_MS);
		// A window that closed while the seat was down is not worth a ping: a replay
		// against an entry the provider has dropped is a full-price write wearing a
		// ping's clothes. The next real request pays the one rewrite it owed anyway.
		if (warmUntil <= now()) return;
		if (mode === "keepalive") scheduleKeepalive(notify, Math.max(0, target.at + KEEPALIVE_PING_MS - now()));
		else armGapPing(Math.max(0, target.at + gapPingMs() - now()));
	}

	function scheduleGapPing(delayMs: number, attempt: number): void {
		stopGapTimer();
		const epoch = gapEpoch;
		cancelGap = scope.timeout(delayMs, () => runGapPing(attempt, epoch).catch(() => {}));
	}

	/**
	 * One gap ping, and the decision about the next.
	 *
	 * Deliberately unaware of whether a request is in flight: a ping concurrent
	 * with a streaming turn is safe, because that turn's entry was written when it
	 * began and the ping is what refreshes it. Deliberately silent, too — a failed
	 * round costs one bounded rewrite and there is nothing for a human to do about
	 * it, and the wire trace is where a ping is read.
	 */
	async function runGapPing(attempt: number, epoch: number): Promise<void> {
		// Stale: a real request has re-armed since this timer was set, so the window
		// this firing was meant to save is already fresh. Returning before touching
		// `cancelGap` is deliberate — it now belongs to the newer round.
		if (epoch !== gapEpoch || !gapPinging) return;
		cancelGap = undefined;
		if (!chainAlive()) return haltPings("idle");
		// The retry belongs to the round that failed, so only a first attempt spends
		// budget — the ceiling bounds rounds, and each round is at most two attempts.
		if (attempt === 0) {
			if (silentRounds >= gapCap && !waitingOnChildren()) return haltPings("silent past the in-flight bound");
			silentRounds++;
		}
		const target = readPingTarget(sessionId);
		// Nothing cached yet: no bytes to replay, and no window to save. The next
		// request arms a fresh timer.
		if (target === undefined) return;

		const sentAt = now();
		const result = await sendPing(target, GAP_TIMEOUT_MS, scope.signal);
		target.record(result);
		// Re-checked, not assumed: this is the far side of a network round trip, and
		// a request, a shutdown or a whole newer round may have happened across it.
		if (epoch !== gapEpoch || !gapPinging || scope.signal.aborted) return;
		const elapsed = now() - sentAt;
		if (result.ok) {
			recordWrite(sentAt, writtenTtl || SHORT_TTL_MS);
			// The provider's clock restarted at this ping, so the anchor a reload
			// resumes from is this send, not the request's: resuming from the request
			// called a window the pings had kept open closed (2026-09-09).
			publishPingTarget({ ...target, at: sentAt });
			ledgerRefreshed(target.prefixKey, target.model.id, sentAt, writtenTtl || SHORT_TTL_MS);
			// Anchored on when the ping *started*, because that is when Anthropic
			// restarted the clock. A ping that took 10s must not push the next one
			// 10s past the window it just bought.
			scheduleGapPing(Math.max(0, gapPingMs() - elapsed), 0);
			return;
		}
		if (attempt === 0) scheduleGapPing(Math.max(0, GAP_RETRY_MS - elapsed), 1);
		// Both attempts failed. The next real request rewrites the context once, at
		// 1.25x — one bounded miss, self-healing, and exactly what a seat with no
		// pings at all would have paid.
	}

	async function askWorkflows(ui: {
		select(title: string, options: string[], opts: { signal: AbortSignal }): Promise<string | undefined>;
	}): Promise<void> {
		// Title and message on two lines, which is how pi's own confirm lays it out.
		const picked = await ui.select(`${WORKFLOWS_TITLE}\n${WORKFLOWS_MESSAGE}`, [...WORKFLOWS_OPTIONS], { signal: scope.signal });
		// A session that ended with the question open answered nothing.
		if (scope.signal.aborted) return;
		// Escape means the default. Every answer is persisted, No included: the
		// handoff continuation carries this entry forward (`carriedEntries`), and a
		// seat with no entry made its successor ask again (2026-09-22).
		apply({ ...MAIN_CHOICE, workflows: picked === "Yes" }, true);
	}

	// This kit warms its own cache, so pi's warmer is stopped on every seat --
	// not because two warmers are wasteful, but because pi's one corrupts the
	// ledger this kit keeps.
	//
	// Its request is not something that happens beside this extension. `onPayload`
	// is part of the agent config, `agent-loop.js` spreads that config into the
	// stream options, `sdk.js`'s `buildRequestOptions` spreads those into the
	// options it hands `cacheWarmer.start`, and the warmer spreads them once more
	// -- so pi's warm request goes out through this seat's own
	// `before_provider_request` and is instrumented as if it were a turn. In pi's
	// `streaming` mode the only window it fires in is a turn still streaming at
	// 90% of the TTL (`onAgentSettled` stops it otherwise), which is exactly when
	// a real request is in flight: `wire-trace.ts` holds one pending request, the
	// warm one overwrites it, and the real turn's `message_end` files the real
	// usage against a `max_tokens: 1` record. The ping target is republished from
	// that payload too.
	//
	// Unconditional, because re-entry is a property of the seam and not of the
	// mode. The seat that renews nothing renews nothing for pi either: this kit's
	// ping replays the captured bytes against a ledger that measured whether
	// renewal pays, and pi's estimate is list price with no such measurement.
	// With this stopped, every request reaching the wire is a real turn -- this
	// kit's own ping sends its captured payload directly and never re-enters.
	pi.on("cache_warming_decision", () => ({ action: "stop" }));

	// ---- the request path ------------------------------------------------------

	// This is where retention happens: pi-ai bakes its env-resolved TTL into
	// cache_control before any hook runs, and this session's own mode overrules it
	// here, on this session's payload alone. A subagent's fresh instance boots
	// short and normalizes its own payloads to 5m — whatever the environment says.
	//
	// The rewrite is by reference into the blocks pi built, so it survives `wire`
	// rebuilding the `system` and `tools` arrays behind it (both carry the same
	// `cache_control` objects onward) and does not depend on which of the two
	// handlers pi runs first.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages") return;
		if (!event.payload || typeof event.payload !== "object") return;
		const payload = event.payload as Record<string, unknown>;
		const compat = (ctx.model as { compat?: { supportsLongCacheRetention?: boolean } }).compat;
		// `keepalive` and `long` buy the hour; `short` — every headless seat —
		// wants the bare 5m default.
		normalizeCacheTtl(payload, (mode === "keepalive" || mode === "long") && compat?.supportsLongCacheRetention !== false);
		// The id on the payload, not the one pi holds: another handler may have set
		// it, and handler order says nothing about whether one already did.
		lastModel = typeof payload.model === "string" ? payload.model : ctx.model.id;
		// The level pi built this request from: the same read `prefixInputsOf` makes
		// for the next one, so the two compare as levels, not as wire fields.
		lastReasoning = pi.getThinkingLevel();
		anchorWindow(payload, now());
		lastActivityAt = lastRequestAt;
		armGapPing();
	});

	// The clock reports evidence, not intent. The rewrite above makes our own
	// payload always say 1h in keepalive, so the payload can no longer reveal a
	// silently downgraded cache — but Anthropic's usage accounting can:
	// cacheWrite1h is the slice of cacheWrite written with 1h retention. A
	// keepalive write with none means the provider granted 5m (the failure that
	// cost ~$2 on 2026-08-28, issues/13 Bug A). Report the granted window, warn
	// once, and stop pinging the cache we do not have.
	pi.on("message_end", (event, ctx) => {
		if (mode !== "keepalive" || ctx.model?.api !== "anthropic-messages") return;
		const message = event.message as { role?: unknown; usage?: { input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number } };
		if (message.role !== "assistant" || !message.usage) return;
		// An abort accounts for nothing, and evidence of an answer is the whole
		// point of this handler. Reading it as one would resume pinging a window
		// the provider never confirmed.
		if (accounted(message.usage) === 0) return;
		// The provider answered a real request, so whatever stopped the pings (a
		// transient failure, an exhausted window the user has just reopened) is over.
		pingsHalted = false;
		const { cacheWrite = 0, cacheWrite1h = 0 } = message.usage;
		if (cacheWrite > 0 && cacheWrite1h === 0) {
			retentionDenied = true;
			stopKeepaliveTimer();
			writtenTtl = SHORT_TTL_MS;
			warmUntil = lastRequestAt + SHORT_TTL_MS;
			publish("short");
			if (!retentionWarned) {
				retentionWarned = true;
				if (ctx.hasUI) {
					ctx.ui.notify(
						"session-mode: asked for a 1h cache but the provider wrote 5m — keep-alive pings stopped (check model compat / auth adapter)",
						"warning",
					);
				}
			}
		} else if (cacheWrite1h > 0) {
			retentionDenied = false;
		}
	});

	// ---- lifecycle -------------------------------------------------------------

	pi.on("agent_start", () => {
		agentRunning = true;
		engineWaits = 0;
		stopKeepaliveTimer();
	});

	// Activity inside the seat proves the in-flight work is not hung, so the
	// ceiling counts silence rather than time since the last request.
	pi.on("message_update", () => {
		silentRounds = 0;
	});
	pi.on("tool_execution_update", () => {
		silentRounds = 0;
	});

	// An engine wait begins: the seat will not speak to the provider until the
	// child does, so the keep-alive chain runs as if idle, anchored on the request
	// that wrote the entry rather than on now.
	pi.on("tool_execution_start", (event, ctx) => {
		silentRounds = 0;
		if (!AGENT_WAIT_TOOL_NAMES.includes(event.toolName)) return;
		engineWaits++;
		if (engineWaits !== 1) return;
		const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};
		scheduleKeepalive(notify, Math.max(0, lastRequestAt + KEEPALIVE_PING_MS - now()));
	});

	pi.on("tool_execution_end", (event) => {
		silentRounds = 0;
		if (!AGENT_WAIT_TOOL_NAMES.includes(event.toolName)) return;
		engineWaits = Math.max(0, engineWaits - 1);
		// The turn continues with a real request next; `agent_settled` re-arms.
		if (engineWaits === 0) stopKeepaliveTimer();
	});

	// Joel is at the desk. Not a message this extension's own machinery injected —
	// that is the session talking to itself, and it proves nothing about him.
	pi.on("input", (event) => {
		if (event.source !== "extension") touch();
		return undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		agentRunning = false;
		touch();
		// Only a headless seat can fail this here, and only with no child to wait on.
		if (chainRuns() && !chainAlive()) haltPings("settled");
		// warmUntil is already correct: the run's last request set it. Settling is
		// only when the idle clock, and the keep-alive schedule, start.
		const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};
		scheduleKeepalive(notify);
	});

	pi.on("session_shutdown", (event) => {
		unwatchAgents?.();
		unwatchAgents = undefined;
		// A reload is not gone: it replaces every instance while the seat and the
		// provider's entry go on, and the next instance re-publishes over this window.
		if (event.reason !== "reload") {
			ledgerWithdrawn();
			forgetCacheWindow(sessionId);
			declareSeatWorkflows(sessionId, false);
		}
	});

	pi.on("session_start", async (event, ctx) => {
		uiSession = ctx.hasUI;
		// The main seat has no round cap: nothing aborts a human, and a seat with a
		// child running must not be cut off mid-run. Its bound is the idle shutoff,
		// which counts silence rather than pings (issues/36).
		if (uiSession) gapCap = Number.POSITIVE_INFINITY;
		sessionId = ctx.sessionManager.getSessionId();
		lastActivityAt = now();
		publishRenewal(sessionId, keepUntil);
		// A child of this seat settling is a turn about to happen, so it resets the
		// idle clock rather than being the moment the clock runs out.
		unwatchAgents?.();
		unwatchAgents = watchLiveAgentsOf(sessionId, touch);

		// A persisted choice (resume/reload/fork of the session), if there is one. A restored plain
		// "long" (pre-rename sessions) becomes keepalive: a 1h cache without pings is
		// one of the combinations that no longer exist.
		let restored: { mode: CacheMode; ping: boolean; workflows: boolean; idleMs?: number } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as { mode?: unknown; ping?: unknown; workflows?: unknown; idleMs?: unknown };
			if (!isCacheMode(data?.mode)) continue;
			restored = {
				// Absent on every session persisted before the shutoff existed; those fall
				// back to the window their mode implies.
				idleMs: typeof data.idleMs === "number" && data.idleMs > 0 ? data.idleMs : undefined,
				mode: data.mode === "long" ? "keepalive" : data.mode,
				// Absent in every session persisted before the ping choice existed, and
				// those sessions ran without one.
				ping: data.ping === true,
				// Same for the workflow answer: a session that never gave one ran without
				// the tool, and resuming it must not hand it one.
				workflows: data.workflows === true,
			};
		}

		// Anything headless — including every in-process subagent session, which
		// gets its own fresh instance of this extension — takes the same answer
		// whatever the reason, because there is nobody to ask and the reason does
		// not change how long a turn takes. Checked against `hasUI` alone, so that
		// "a UI-less seat runs the headless policy" is true by construction rather
		// than by every branch remembering to check it (`pi -p --resume` used to
		// inherit a picked keepalive and ping hourly at a seat with no idle time).
		// Never persisted: the cache policy belongs to the run.
		if (!ctx.hasUI) {
			// A subagent's own answer comes from its seat declaration (`lib/seat.ts`),
			// which this cannot overrule; a headless main seat has nobody to ask.
			apply({ mode: HEADLESS_CHOICE.mode, ping: true, workflows: false }, false);
		} else if (restored) {
			restoredIdleMs = restored.idleMs;
			apply(restored, false);
		} else if (event.reason === "startup" || event.reason === "new") {
			await askWorkflows(ctx.ui);
			if (scope.signal.aborted) return;
		} else {
			// A UI seat with no record (a resume or fork of a session from before the
			// question) writes the one it runs on, so every UI seat's file answers
			// for its successor and nothing downstream has to ask.
			apply({ mode, ping: gapPinging, workflows }, true);
		}

		// Every path lands here, because "a seat with a warm entry keeps a chain
		// armed" is a fact about the seat rather than about how it started.
		resumeChain(ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {});
	});
}
