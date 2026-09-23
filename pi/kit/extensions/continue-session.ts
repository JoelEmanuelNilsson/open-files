/**
 * continue-session — handoff v2 (map C23, ticket 11). The model writes its
 * handoff as a plain message; the harness continues in a linked new session
 * whose first message is that document. No tool, no summariser, no
 * compaction.
 *
 * The cycle, on pi's events:
 *
 *   turn_end        the context size is measured against thresholds fitted
 *                   to the model's window. At the soft limit a plain-text
 *                   nudge in Joel's words lands at the tail of the context;
 *                   at the hard limit a short imperative one does. Each is
 *                   said exactly once, where the phase changes — nothing is
 *                   repeated (Joel, 2026-09-05). At the stop the harness
 *                   writes the handoff itself and aborts the run — except when
 *                   the stop was reached from `idle`, the one case in which
 *                   the model was never asked at all: it is given exactly one
 *                   steered turn to write the document, and the stop follows
 *                   when that turn ends, whatever it contains. The nudge
 *                   is a message, not a tool result, and adds no request of
 *                   its own: the cached prefix is untouched and the turn
 *                   stays the model's own.
 *
 *                   How it is delivered is decided by `nudgeDelivery`, not by
 *                   a fixed flag — a run in flight reads a snapshot of the
 *                   messages, so a mid-run append is invisible to it and must
 *                   be steered instead. See `lib/handoff-ladder.ts`.
 *
 *                   An assistant message whose first line is `# Handoff` is
 *                   the document. It is remembered; nothing else happens in
 *                   that turn.
 *
 *   agent_settled   a document is pending, and pi will not continue on its
 *                   own. Everything the harness knows is in flight — live
 *                   agents, unread results, background tasks, files —
 *                   is gathered into the generated block, and the switch is
 *                   asked for as the `/handoff-continue` command. A command
 *                   is the one place pi hands an extension `ctx.newSession`;
 *                   it runs one macrotask later, so every other extension's
 *                   settle handler has finished with the old session first.
 *
 *   /handoff-continue
 *                   `ctx.newSession({ parentSession, setup, withSession })`:
 *                   pi shuts the old session down (its file is complete and
 *                   is never written again), starts a new file that names
 *                   the old one as its parent, `setup` appends the entries
 *                   the run carries — every agent record rewritten to the
 *                   new owner so the names resolve (ticket 19 q6), and the
 *                   cache-mode choice so the launch question is not asked
 *                   again — and `withSession` sends the first user message:
 *                   "Continue session `<old file>`." + document + block.
 *                   Same system prompt, same tools, so the cached prefix is
 *                   read on that first request and only the message is
 *                   written. The successor is put on the seat's model and
 *                   thinking level before that first message: a new session is
 *                   created on the defaults of both. The new file records what
 *                   it wanted and what it got, next to pi's own record of the
 *                   old seat, and a carry that cannot happen is a warning
 *                   naming both — never silence (ticket 64).
 *
 * Every seat runs this the same way (C18). A child of the owned engine gets
 * `ctx.newSession` from `lib/agent-runtime.ts`, which replaces the child's
 * session in place and keeps its record pointing at the newest file. The
 * engine hands its live runs across the switch (`extensions/agent-engine.ts`),
 * so a worker mid-job is neither stopped nor lost.
 *
 * `/handoff` asks for the document now, in the gate's words, as Joel's own
 * message: that turn is his request, not the ladder's.
 *
 * Stated limits: a prompt the user queued while the document was being
 * written is answered in the old session before the switch; background bash
 * commands are killed at the switch (`extensions/bash.ts` ends them with the
 * session) and the block names their log paths so the next context can read
 * what they wrote.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CallHeader, headerPaints } from "./transcript/header.ts";
import { transcriptEnabled } from "./transcript/row.ts";
import { deliveredAgentTaskIds } from "../lib/agent-notification.ts";
import { announceSessionHandoff } from "../lib/agent-runtime-handover.ts";
import { agentFactsFromEntries, backgroundTasksFromEntries, type CarriedEntry, carriedEntries, continueSessionMessage, filesFromEntries, generatedHandoff, GENERATED_HANDOFF_ENTRY, handoffDocumentOf, HANDOFF_SEAT_ENTRY, markContextStop, renderHandoffBlock, seatCarryWarning, type SeatSnapshot, type SessionEntryShape } from "../lib/continue-session.ts";
import { contextTokens, fitThresholds, k, ladderStep, lastRequestTokens, lastTurnText, nudgeDelivery, nudgeText, type Phase, stopText, type Thresholds, thresholdsFrom } from "../lib/handoff-ladder.ts";
import { notice } from "../lib/notice.ts";
import { childSeatOf } from "../lib/seat.ts";
import { createSessionScope } from "../lib/session-scope.ts";
import { shared } from "../lib/shared.ts";

/** The command the settle handler invokes to reach `ctx.newSession`; typed by hand it does the same. */
export const CONTINUE_COMMAND = "handoff-continue";

/** The custom message type the nudge lands as; the transcript shows it. */
export const NUDGE_MESSAGE_TYPE = "handoff-nudge";

const RECALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-recall.mjs");

/** One seat's model and thinking-level setters and its entry writer, bound to that seat's session. */
interface SeatControls {
	readonly setModel: (model: Model<Api>) => Promise<boolean>;
	readonly setThinkingLevel: (level: ThinkingLevel) => void;
	readonly appendEntry: (customType: string, data: unknown) => void;
}

const SEAT_CONTROLS_SEAM = "__piKitSeatControls";

/**
 * Every live seat's controls, by session id, process-wide on `globalThis`.
 * `pi` is bound to one session and goes stale when that session is replaced,
 * so the switch reaches the successor through its own extension instance,
 * which registered here at its session_start. Keyed by id because children run
 * their own seats in this same process.
 *
 * On `globalThis` and not in a module variable because pi's extension-factory
 * cache is keyed by cwd: the moment any seat loads extensions under a
 * different cwd — a child in a worktree — the cache is cleared and every
 * later load re-imports this file, so a module-level map would hand the old
 * session and its successor two different empty ones. That is exactly how the
 * carry went silent on 2026-09-05 (ticket 64).
 */
const seatControls = (): Map<string, SeatControls> => shared(SEAT_CONTROLS_SEAM, () => new Map<string, SeatControls>());

const seatSnapshot = (model: Model<Api> | undefined, thinking: string): SeatSnapshot => ({ model: model === undefined ? null : `${model.provider}/${model.id}`, thinking });

/**
 * The nudge, as one line of chrome.
 *
 *     ● Handoff(context is at 120k tokens; the soft limit is 100k)
 *
 * The model reads the message whole; the transcript only has to say that the
 * ladder spoke. With no renderer it draws as pi's boxed custom message, the
 * handoff template and all (issues/31, the class fix).
 */
function renderNudge(message: { content?: unknown }, options: { expanded: boolean }, theme: Theme): CallHeader | undefined {
	const content = message.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => String(part.text)).join("\n") : "";
	const first = text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
	if (first === "") return undefined;
	const header = new CallHeader();
	header.set({ state: "done", name: "Handoff", argument: first.replace(/^\[handoff\] */, ""), clipEnd: "tail", expanded: options.expanded }, headerPaints(theme, "done"));
	return header;
}

/** Plain data captured from the old session before it is replaced: nothing here is session-bound. */
interface Continuation {
	readonly oldSessionFile: string | undefined;
	readonly oldSessionId: string;
	/** Task ids whose result notification the old file held when the continuation was decided. */
	readonly answered: ReadonlySet<string>;
	readonly firstMessage: string;
}

export default function continueSession(pi: ExtensionAPI) {
	const scope = createSessionScope(pi);

	const configured = thresholdsFrom(process.env.PI_HANDOFF_THRESHOLDS);
	let phase: Phase = "idle";
	/**
	 * The one turn of ticket 51 §1 has been granted and not yet spent. The
	 * bound is structural rather than a counter: the stop fires once in a
	 * session's life (the phase never steps back), the turn is offered only from
	 * that one firing, and the next `turn_end` — whatever it contains — consumes
	 * this flag and stops the run. One boolean, no recursion.
	 */
	let lastTurnGranted = false;
	/**
	 * The handoff document of this session's latest turn, waiting for the run to
	 * settle, with the results answered when it was written: a result filed by a
	 * later turn of the run, one Esc or an error may kill, is not known answered.
	 */
	let pendingDocument: { readonly text: string; readonly answered: ReadonlySet<string> } | undefined;
	/** What the command switches to; set by the settle handler, consumed by the command. */
	let continuation: Continuation | undefined;
	/** `/handoff`'s message, until the model's context receives it. */
	let ask: { text: string; tokens: number } | undefined;

	const notify = (ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error") => notice(ctx, text, kind);

	/** pi's figure plus the last request, against thresholds fitted to the window. */
	const measure = (ctx: ExtensionContext): { tokens: number | null; thresholds: Thresholds } => {
		const usage = ctx.getContextUsage();
		return {
			tokens: contextTokens(usage?.tokens, lastRequestTokens(ctx.sessionManager.getBranch())),
			thresholds: fitThresholds(configured, usage?.contextWindow ?? null),
		};
	};

	/**
	 * The nudge as a context-only message, delivered the one way the model can
	 * read it before its next provider request: steered into a run that
	 * continues, appended when the run is ending. Neither starts a request that
	 * would not have happened anyway.
	 */
	const nudge = (tokens: number, wording: "nudged" | "gated", thresholds: Thresholds, runContinues: boolean) => {
		const message = { customType: NUDGE_MESSAGE_TYPE, content: nudgeText(wording, tokens, thresholds), display: true };
		if (nudgeDelivery(runContinues) === "steer") pi.sendMessage(message, { deliverAs: "steer" });
		else pi.sendMessage(message, { triggerTurn: false });
	};

	/** Everything the harness knows is in flight, as the block both the document and the stop use. */
	const inFlightBlock = (entries: ReadonlyArray<SessionEntryShape>, sessionId: string) =>
		renderHandoffBlock({
			...agentFactsFromEntries(entries, sessionId),
			backgroundTasks: backgroundTasksFromEntries(entries),
			...filesFromEntries(entries),
		});

	/**
	 * The stop, gracefully: the harness writes the handoff the model never did.
	 * Order is the design — the document is persisted to the session file first,
	 * so it exists even if everything after it fails (on 2026-09-03 a handoff
	 * survived only as a `handoff-lost` entry), then the continuation is prepared
	 * but *not* taken: the run stops and a human decides, which is what the stop
	 * has always meant. `/handoff-continue` picks it up when they do.
	 */
	const stop = (ctx: ExtensionContext, input: { tokens: number; thresholds: Thresholds; previous: Phase; written: string | undefined; granted: boolean }) => {
		const { tokens, thresholds, previous, written, granted } = input;
		const oldSessionFile = ctx.sessionManager.getSessionFile();
		const oldSessionId = ctx.sessionManager.getSessionId();
		// The model's own document when its granted turn produced one: that is the
		// whole value of the turn, and it beats the generated one by a wide margin.
		const document = written ?? generatedHandoff({ tokens, thresholds });
		const byModel = written !== undefined;
		let recorded = true;
		try {
			pi.appendEntry(GENERATED_HANDOFF_ENTRY, { document, tokens, stop: thresholds.stop, byModel });
		} catch {
			recorded = false;
		}
		const entries = ctx.sessionManager.getEntries();
		continuation = {
			oldSessionFile,
			oldSessionId,
			answered: deliveredAgentTaskIds(entries),
			firstMessage: continueSessionMessage({ oldSessionFile: oldSessionFile ?? "(not on disk)", document, block: inFlightBlock(entries, oldSessionId), recallCommand: RECALL }),
		};
		// Until the next run: without the hold a result would start a turn in a full context. It waits for the successor, or for Joel's next prompt.
		scope.holdTurnsForSwitch();
		// C13 — "nothing continues until a human decides" — assumes a human, and a
		// child seat has none. Ruled 2026-09-05 (ticket 51 §3): still no. A child
		// that continued itself would spend a fresh window on a document nobody
		// approved, while the parent that holds the brief — and could write a far
		// better one — sits blocked; and a child that fills the new window stops
		// again, so "continue" is a loop whose only bound would be a counter. So a
		// stopped child is dead, and the honest thing is that its parent learns it
		// from the record instead of reading `aborted`.
		const seat = childSeatOf(oldSessionId) === undefined ? "main" : "child";
		if (seat === "child") markContextStop(oldSessionId, { tokens, stop: thresholds.stop, recorded, byModel });
		ctx.abort();
		notify(ctx, stopText({ tokens, thresholds, previous, recorded, seat, ...(granted ? { lastTurn: byModel ? ("wrote" as const) : ("silent" as const) } : {}) }), "error");
	};

	/**
	 * The jumped case only (ticket 51 §1): the stop was reached from `idle`, so
	 * one step crossed every threshold and the model was never given a turn in
	 * which it could write anything. It gets exactly one, steered so it costs the
	 * request that turn makes and nothing else; a session that heard the gate and
	 * ignored it does not get a third word. False when the scope refuses the
	 * turn (shutting down); the stop then follows at once.
	 */
	const grantLastTurn = (tokens: number, thresholds: Thresholds): boolean => {
		lastTurnGranted = scope.startTurn({ customType: NUDGE_MESSAGE_TYPE, content: lastTurnText(tokens, thresholds), display: true }, { deliverAs: "steer" });
		return lastTurnGranted;
	};

	// Same switch as the transcript's own rows: `PI_TRANSCRIPT=off` gives the
	// nudge back to pi's custom-message box.
	if (transcriptEnabled()) pi.registerMessageRenderer(NUDGE_MESSAGE_TYPE, renderNudge);

	pi.on("turn_end", (event, ctx) => {
		const document = handoffDocumentOf(event.message);
		if (document !== undefined) pendingDocument = { text: document, answered: deliveredAgentTaskIds(ctx.sessionManager.getEntries()) };
		// The granted turn is over. Whatever it did — document, tool call, overflow,
		// error — the handoff and the abort follow unconditionally.
		if (lastTurnGranted) {
			lastTurnGranted = false;
			const written = pendingDocument?.text;
			pendingDocument = undefined;
			const measured = measure(ctx);
			stop(ctx, { tokens: measured.tokens ?? 0, thresholds: measured.thresholds, previous: "idle", written, granted: true });
			return;
		}
		if (document !== undefined) return;
		if (pendingDocument !== undefined) return;
		const { tokens, thresholds } = measure(ctx);
		const previous = phase;
		const step = ladderStep(tokens, phase, thresholds);
		phase = step.phase;
		const size = tokens ?? 0;
		// The phase never steps back, so `previous !== "stopped"` fires the stop
		// exactly once however many turns end above it.
		if (phase === "stopped") {
			if (previous === "stopped") return;
			if (previous === "idle" && grantLastTurn(size, thresholds)) return;
			stop(ctx, { tokens: size, thresholds, previous, written: undefined, granted: false });
			return;
		}
		if (step.inject === undefined) return;
		// Tool results mean the loop has another request to make: the message rides
		// it. No tool results mean the model stopped, and the next request is the
		// next run, whose snapshot picks an appended message up.
		nudge(size, step.inject, thresholds, event.toolResults.length > 0);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (pendingDocument === undefined || continuation !== undefined) return;
		const { text: document, answered } = pendingDocument;
		pendingDocument = undefined;
		const oldSessionFile = ctx.sessionManager.getSessionFile();
		const oldSessionId = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getEntries();
		const block = inFlightBlock(entries, oldSessionId);
		continuation = {
			oldSessionFile,
			oldSessionId,
			answered,
			firstMessage: continueSessionMessage({ oldSessionFile: oldSessionFile ?? "(not on disk)", document, block, recallCommand: RECALL }),
		};
		// From here no scope starts a turn in this session: one pi deferred behind
		// this settle would run after the switch's abort, in the session it leaves.
		scope.holdTurnsForSwitch();
		// One macrotask later: every settle handler in the process has run
		// against a session that still exists. The command is where pi hands an
		// extension `newSession`. A quit in that macrotask clears it with the scope.
		scope.timeout(0, () => pi.sendUserMessage(`/${CONTINUE_COMMAND}`, { expandPromptTemplates: true }));
	});

	/**
	 * The successor continues as the same seat: same model, same thinking level.
	 * Every way this can end is said out loud — the carry is verified against the
	 * fresh session itself, and a seat that changed under Joel without a word is
	 * the bug this exists for (ticket 64).
	 */
	const carrySeat = async (fresh: ExtensionContext, model: Model<Api> | undefined, thinking: ThinkingLevel) => {
		const wanted = seatSnapshot(model, thinking);
		// pi's `finishSessionReplacement` rebinds the extensions, whose `session_start`
		// registers these, before it calls `withSession`; a successor already shut down has none.
		const controls = seatControls().get(fresh.sessionManager.getSessionId());
		const finish = (reason: string | undefined) => {
			const got = seatSnapshot(fresh.model, fresh.thinkingLevel ?? "an unknown level");
			const carried = reason === undefined && got.model === wanted.model && got.thinking === wanted.thinking;
			try {
				// The old session's seat is pi's own last model/thinking change; this is
				// the new session's, and the only place the two can be compared.
				controls?.appendEntry(HANDOFF_SEAT_ENTRY, { side: "continuation", ...got, wanted, carried });
			} catch {
				// The record is a courtesy to the next reader; the switch is not.
			}
			if (!carried) notify(fresh, seatCarryWarning({ wanted, got, reason: reason ?? "the new session did not take them" }), "warning");
		};
		if (model === undefined) return finish("the seat's own model was not known when the handoff ran");
		if (controls === undefined) return finish("the continuation's session registered no model controls");
		if (!(await controls.setModel(model))) return finish("there is no API key for that model");
		controls.setThinkingLevel(thinking);
		finish(undefined);
	};

	pi.registerCommand(CONTINUE_COMMAND, {
		description: "Continue in a linked new session from the handoff document just written",
		handler: async (_args, ctx) => {
			const next = continuation;
			if (next === undefined) {
				notify(ctx, "handoff: nothing to continue from — no handoff document was written this run. /handoff asks for one.", "warning");
				return;
			}
			continuation = undefined;
			// A new session is created on the default model at the default thinking
			// level; a handoff continues as the same seat (C18), so both are carried.
			const seatModel = ctx.model;
			const seatThinking = pi.getThinkingLevel();
			const carried: CarriedEntry[] = [];
			// Read in `setup`, after the old session's last write: a run that settled
			// after the document is carried settled. Limit: the block in the first
			// message still says what was in flight when the document was written.
			const outgoing = ctx.sessionManager;
			const withdrawHandoff = announceSessionHandoff(ctx.sessionManager.getSessionId());
			const result = await ctx.newSession({
				...(next.oldSessionFile !== undefined ? { parentSession: next.oldSessionFile } : {}),
				setup: async (sessionManager) => {
					for (const entry of carriedEntries(outgoing.getEntries(), next.oldSessionId, sessionManager.getSessionId(), next.answered)) {
						sessionManager.appendCustomEntry(entry.customType, entry.data);
						carried.push(entry);
					}
				},
				withSession: async (fresh) => {
					await carrySeat(fresh, seatModel, seatThinking);
					// Not awaited: the first turn belongs to the new session, and the
					// switch is complete once it has been asked for.
					void fresh.sendUserMessage(next.firstMessage).catch((error: unknown) => {
						notify(fresh, `handoff: the continuation's first turn failed to start — ${error instanceof Error ? error.message : String(error)}`, "error");
					});
				},
			}).finally(withdrawHandoff);
			if (result.cancelled) {
				// The old ctx is still live: the switch was refused before teardown.
				notify(ctx, "handoff: an extension cancelled the new session; the document is in this session's transcript and the ladder continues.", "warning");
			}
		},
	});

	pi.registerCommand("handoff", {
		description: "Ask the model to write its handoff now; the session continues from it in a linked new session",
		handler: async (_args, ctx) => {
			const { tokens, thresholds } = measure(ctx);
			ask = { text: nudgeText("gated", tokens ?? 0, thresholds), tokens: tokens ?? 0 };
			// A user message, so the turn runs `before_agent_start` like any other; pi
			// reads `deliverAs` only while a run is in flight, which is when it steers.
			// That steer runs the engine's `input` handler too, so `/handoff` also
			// interrupts a `TaskOutput` wait in flight, as Joel typing would.
			pi.sendUserMessage(ask.text, { deliverAs: "steer" });
		},
	});

	// `sendUserMessage` returns nothing, and pi can refuse the ask (compaction, no
	// model or key) or drop its queued steer (an abort). pi emits `message_start`
	// for a user message only as the run takes it in, idle prompt or injected steer.
	pi.on("message_start", (event, ctx) => {
		if (ask === undefined || event.message.role !== "user") return;
		const content = event.message.content;
		const text = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("");
		if (text !== ask.text) return;
		// Joel asking counts as the soft limit having been said, so the ladder
		// does not say it again; the gate at its own threshold still will.
		if (phase === "idle") phase = "nudged";
		notify(ctx, `handoff: asked for the document at ${k(ask.tokens)}.`, "info");
		ask = undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		seatControls().delete(ctx.sessionManager.getSessionId());
	});

	pi.on("session_start", (_event, ctx) => {
		seatControls().set(ctx.sessionManager.getSessionId(), { setModel: (model) => pi.setModel(model), setThinkingLevel: (level) => pi.setThinkingLevel(level), appendEntry: (customType, data) => pi.appendEntry(customType, data) });
		phase = "idle";
		lastTurnGranted = false;
		pendingDocument = undefined;
		continuation = undefined;
		ask = undefined;
	});
}
