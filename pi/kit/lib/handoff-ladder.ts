/**
 * The handoff ladder: when the model is told to hand off, and in what words.
 * Pure — `extensions/continue-session.ts` wires it to pi's events.
 *
 * Three thresholds, one direction (map C13):
 *
 *   nudge   200k  a plain-text message asks for a handoff, once
 *   gate    220k  a short imperative message, once: now, and start nothing new
 *   stop    250k  the run is aborted, after the handoff is recorded
 *
 * The stop has one branch, ticket 51 §1: a session that reaches it from
 * `idle` crossed every threshold in a single step and was never asked, so it
 * is granted one turn to write its own document — the stop then follows
 * unconditionally. A session that heard the gate and ignored it gets nothing.
 *
 * Each fires exactly once in a session's life. A phase never steps back, and
 * a message is sent only where the phase changes (`ladderStep`), so a model
 * that ignores the nudge hears nothing at all until the gate — Joel ruled the
 * repetition out on 2026-09-05 because the repeats were noise. The
 * consequence is deliberate and load-bearing: the gate is the last word
 * before the stop, so it must carry everything the model needs to act, and
 * the stop is the only remaining safety net.
 *
 * Nothing here is a tool. The message lands at the tail of the context, so
 * the cached prefix is untouched and the turn is the model's own (ticket 11
 * step 1).
 *
 * Every seat runs the same ladder (map C18): a worker or lead is nudged the
 * same way the main seat is and hands off inside its own session. The three
 * numbers are fitted to the model's window (`fitThresholds`), so a 200k
 * window sees the whole ladder before it overflows.
 */

export type Phase = "idle" | "nudged" | "gated" | "stopped";

export interface Thresholds {
	readonly nudge: number;
	readonly gate: number;
	readonly stop: number;
}

/**
 * Context tokens, not a fraction of the window. Cost and quality both degrade
 * with the absolute size — a 1M window does not make 600k of history cheap or
 * useful — so the limits are stated in the unit that hurts. Ticket 06 measured
 * the last 30 sessions and bracketed this number rather than fixing it: 7 of
 * 30 peaked above 150k and 4 of 30 above 250k, so a nudge at 200k sits inside
 * that tail and speaks to something like one session in five. It is a quality
 * rule, ruled by Joel on 2026-09-05, not a price derivation.
 *
 * The gate is 20k after the nudge and the stop 30k after the gate. One step —
 * a subagent's report, a large read, a long tool output — can cross either
 * gap, which is why the stop writes its own record instead of counting on a
 * turn the model may never be given (`generatedHandoff`).
 */
export const DEFAULT_THRESHOLDS: Thresholds = { nudge: 200_000, gate: 220_000, stop: 250_000 };

/**
 * `PI_HANDOFF_THRESHOLDS="10000,20000,30000"` overrides the three limits, for
 * watching a whole cycle in a session too small to reach the real ones.
 * Anything that is not three ascending positive integers is ignored.
 */
export function thresholdsFrom(override: string | undefined): Thresholds {
	if (!override) return DEFAULT_THRESHOLDS;
	const parts = override.split(",").map((s) => Number(s.trim()));
	if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n <= 0)) return DEFAULT_THRESHOLDS;
	const [nudge, gate, stop] = parts as [number, number, number];
	if (!(nudge < gate && gate < stop)) return DEFAULT_THRESHOLDS;
	return { nudge, gate, stop };
}

/**
 * The share of a model's window the ladder may use. The rest is the room for
 * the turn that writes the handoff document at the stop. Below this the
 * thresholds are about quality; a small window makes them about survival,
 * since pi's own overflow recovery is switched off with its compaction.
 */
export const WINDOW_SHARE = 0.85;

/**
 * The thresholds a model can actually reach — the window fit of map C18. A
 * 200k window (Haiku, the Explore agent) never sees 250k — it runs the ladder
 * at 136k / 149.6k / 170k, and only a window of 294k or more sees the three
 * numbers as written. The three numbers
 * scale down together so the stop sits at `WINDOW_SHARE` of the window and
 * the gaps keep their proportions. A window that fits the stop, or an
 * unknown one, leaves them alone.
 */
export function fitThresholds(thresholds: Thresholds, contextWindow: number | null): Thresholds {
	if (contextWindow === null || contextWindow <= 0) return thresholds;
	const ceiling = Math.floor(contextWindow * WINDOW_SHARE);
	if (thresholds.stop <= ceiling) return thresholds;
	const scale = ceiling / thresholds.stop;
	return { nudge: Math.floor(thresholds.nudge * scale), gate: Math.floor(thresholds.gate * scale), stop: ceiling };
}

const ORDER: readonly Phase[] = ["idle", "nudged", "gated", "stopped"];

// ---------------------------------------------------------------------------
// Delivering the nudge
// ---------------------------------------------------------------------------

/**
 * How a nudge reaches the model. The two ways differ in which array the
 * message lands in, and that decides whether the model ever reads it.
 *
 * pi's agent takes a *snapshot* of `agent.state.messages` when a run starts
 * (`createContextSnapshot`) and the loop then appends to that snapshot alone.
 * A custom message appended mid-run (`sendMessage` with `triggerTurn: false`)
 * goes into `agent.state.messages`, which the running loop no longer reads:
 * it is written to the session file, shown in the transcript, and is absent
 * from every provider request until the *next* run. That is exactly how the
 * 2026-09-03 session took three nudges at 152k–156k and never saw one.
 *
 *   "steer"    the run continues (this turn ran tools, so another provider
 *              request is coming). pi's steering queue is drained by the loop
 *              between turns and pushed onto the live context, so the nudge is
 *              at the tail of the very next request. It adds no turn: the
 *              request was going to happen anyway.
 *   "append"   the run is ending (no tool results — the model stopped). There
 *              is no next request in this run; appending puts the nudge in
 *              `agent.state.messages`, so it is at the tail of the snapshot
 *              the next run takes. Steering here would instead force the model
 *              to speak again, and every reply would earn another nudge.
 *
 * Either way the message is appended at the tail, so the cached system+tools
 * prefix is untouched (map C13).
 */
export type NudgeDelivery = "steer" | "append";

/** `"steer"` when the run will make another request in this turn's wake, else `"append"`. */
export function nudgeDelivery(runContinues: boolean): NudgeDelivery {
	return runContinues ? "steer" : "append";
}

/** The phase the context size calls for, never lower than the phase already reached. */
export function phaseFor(tokens: number | null, current: Phase, thresholds: Thresholds): Phase {
	if (tokens === null) return current;
	const wanted: Phase =
		tokens >= thresholds.stop ? "stopped" : tokens >= thresholds.gate ? "gated" : tokens >= thresholds.nudge ? "nudged" : "idle";
	return ORDER.indexOf(wanted) > ORDER.indexOf(current) ? wanted : current;
}

/** One turn's reading of the ladder: where the session now stands, and what to say. */
export interface LadderStep {
	readonly phase: Phase;
	/** The message to send this turn, or `undefined` — the session has already been told. */
	readonly inject: "nudged" | "gated" | undefined;
}

/**
 * The whole cadence, in one answer: a message is sent only where the phase
 * changes, so each of the two lands exactly once (Joel, 2026-09-05). A step
 * that crosses both thresholds at once says the gate and never the nudge; a
 * step that reaches the stop says nothing, because at the stop the harness
 * writes the document itself rather than asking again.
 */
export function ladderStep(tokens: number | null, current: Phase, thresholds: Thresholds): LadderStep {
	const phase = phaseFor(tokens, current, thresholds);
	const inject = phase !== current && (phase === "nudged" || phase === "gated") ? phase : undefined;
	return { phase, inject };
}

// ---------------------------------------------------------------------------
// Measuring the context
// ---------------------------------------------------------------------------

/** The slice of a session entry this module reads. */
export interface EntryShape {
	type: string;
	id: string;
	message?: { role?: string; usage?: UsageShape };
}

/** The slice of an assistant message's usage this module reads. */
export interface UsageShape {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

/**
 * The size of the last request, from the branch: the newest assistant message
 * whose usage is not all zero, whatever its stop reason.
 *
 * pi's `getContextUsage` skips aborted and errored messages. But a provider
 * reports the request's input side (input, cache read, cache write) when the
 * stream opens, before any output — so an aborted turn knows exactly how big
 * the context was, and skipping it hides the largest turn in the session:
 * in a traced test the nudge read 61k for a 100k context. Null past a
 * compaction with no request since, the same rule pi uses, because the last
 * usage before it measures a context that no longer exists.
 */
export function lastRequestTokens(entries: readonly EntryShape[]): number | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "compaction") return null;
		if (e?.type !== "message" || e.message?.role !== "assistant") continue;
		const u = e.message.usage;
		if (!u) continue;
		const total = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		if (total > 0) return total;
	}
	return null;
}

/**
 * The context size the ladder acts on: the larger of pi's figure and the
 * branch's last request. pi's figure counts the tool results that arrived
 * after the last response but hides aborted turns; the last request counts
 * the aborted turn but not what followed it. Neither is an overcount, so the
 * larger is the nearer to the truth.
 */
export function contextTokens(reported: number | null | undefined, lastRequest: number | null): number | null {
	if (reported == null) return lastRequest;
	if (lastRequest === null) return reported;
	return Math.max(reported, lastRequest);
}

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

/** The context size printed for the model and the user: `153k`. */
export const k = (n: number): string => `${Math.round(n / 1000)}k`;

/** The first line of a handoff document; the harness detects it by this line. */
export const HANDOFF_HEADING = "# Handoff";

/** The section headings a handoff document carries, in order. */
export const HANDOFF_SECTIONS = ["## Intent", "## State", "## Next", "## Map", "## Decisions", "## Open"] as const;

/** Joel's wording for the soft limit, verbatim (ticket 11 step 1). */
export const NUDGE_WORDING = "Write a handoff now, or when it suits the ongoing work. Start winding down; write it when relevant without destroying the work in flight.";

/**
 * Joel's wording for the hard limit, verbatim (2026-09-05): three beats and
 * nothing else. It is the last thing the ladder says before the stop, so it
 * explains nothing and repeats nothing the nudge already said.
 */
export const GATE_WORDING = "Do this now. As soon as possible. Don't start new work.";

/**
 * The one turn the jumped case gets (ticket 51 §1). A session that reached
 * the stop from `idle` crossed every threshold in a single step and was never
 * given a turn in which it could write anything; this is that turn, and there
 * is no second one — when it ends, the stop follows whatever it did.
 *
 * The constraint is a sentence, not a mechanism: nothing in pi lets an
 * extension hand the model a turn with the tools taken away, so the words say
 * plainly that anything but the document is wasted rather than pretending it
 * is impossible.
 */
export const LAST_TURN_WORDING = "Write your handoff document now, in this reply, and nothing else. This is your last turn: the run is stopped when it ends, whatever it contains. Do not read, search, spawn or call any tool — there is no turn after this one in which their results could be used.";

/** The message granting the one last turn: the size, the stop, and what the turn is for. */
export function lastTurnText(tokens: number, thresholds: Thresholds): string {
	return `[handoff] Context is at ${k(tokens)} tokens; the stop is ${k(thresholds.stop)}. ${LAST_TURN_WORDING}\n\n${HANDOFF_TEMPLATE}`;
}

/**
 * How to write the document. Sent with both messages, because a session can
 * jump straight past the soft limit in one large turn and the model must
 * never have to guess the shape.
 */
export const HANDOFF_TEMPLATE = `A handoff is a plain assistant message — no tool — whose first line is exactly \`${HANDOFF_HEADING}\`. Write it for the next you, who has none of this context: intent first, then only what is needed to continue. Use these headings:

${HANDOFF_HEADING}
## Intent
What the user wants and why. Their words where the wording matters.
## State
Done, mid-flight, and verified versus assumed.
## Next
The exact next actions, in order.
## Map
Paths, line numbers, commands, URLs that matter — one line each on why.
## Decisions
Rulings made, options rejected, user preferences.
## Open
Unanswered questions.

When the turn that contains it ends, the harness appends what it knows is in flight (live agents, unread results, background tasks, files) and continues in a new session whose first message is your document. The old session file stays as the record. Do not duplicate what already lives in files, commits, diffs or plans — point at them. Preserve exact paths, identifiers, commands and error strings. No secrets.`;

/**
 * The message that lands in the model's context at the nudge or the gate. The
 * first line names the size so the user can read it too; Joel's wording
 * follows; the template rides along.
 */
export function nudgeText(phase: "nudged" | "gated", tokens: number, thresholds: Thresholds): string {
	const head =
		phase === "nudged"
			? `[handoff] Context is at ${k(tokens)} tokens; the soft limit is ${k(thresholds.nudge)}. ${NUDGE_WORDING}`
			: `[handoff] Context is at ${k(tokens)} tokens; the hard limit is ${k(thresholds.gate)}. ${GATE_WORDING}`;
	return `${head}\n\n${HANDOFF_TEMPLATE}`;
}

/**
 * What the user is told when the stop fires. Three facts, in the order a
 * human needs them: that the run is over and why, whether the ladder ever got
 * to ask (a single step can cross every threshold, and then the model was
 * never given a turn in which to write anything), and what is now on disk
 * versus what is gone. Then the two ways forward.
 */
export function stopText(input: { tokens: number; thresholds: Thresholds; previous: Phase; recorded: boolean; lastTurn?: "wrote" | "silent"; seat?: "main" | "child" }): string {
	const { tokens, thresholds, previous, recorded, lastTurn, seat = "main" } = input;
	const asked =
		lastTurn !== undefined
			? `One step crossed every threshold at once; the model was given one turn to write its handoff and ${lastTurn === "wrote" ? "wrote one" : "did not"}.`
			: previous === "gated"
				? `The model was asked at ${k(thresholds.nudge)} and again at ${k(thresholds.gate)}.`
				: previous === "nudged"
					? `The model was asked at ${k(thresholds.nudge)}; one step then crossed the gate and the stop together.`
					: "One step crossed every threshold at once, so the model was never asked.";
	const record =
		!recorded
			? "The harness could not record its own handoff either; this session's file is the whole record."
			: lastTurn === "wrote"
				? "The model's own handoff is recorded in this session."
				: "The harness recorded what it knows — work in flight, files — as a handoff in this session. What only the model knew (the intent, and any decision it never wrote down) is lost.";
	const written = lastTurn === "wrote" ? "" : " with no handoff written";
	// A child seat has no human at it, so it is not offered the two commands only
	// a human types; its parent is told where the record is instead (ticket 51 §3).
	const forward =
		seat === "child"
			? "Nothing further runs in this seat. Its parent is told that this agent stopped at its context limit and where this record is; the work continues by spawning a fresh agent from it."
			: "/handoff-continue continues from that record in a new session; /handoff asks this session for a proper document first.";
	return `handoff: stopped at ${k(tokens)} tokens${written} (stop at ${k(thresholds.stop)}). ${asked} Nothing further runs.\n${record}\n${forward}`;
}
