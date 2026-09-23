/**
 * Whether a fresh session's first request would read its prefix back from
 * cache, for the model shown. The rule behind the label's light, kept pure so
 * the chrome's timer only gathers facts and this decides.
 *
 * The light answers one question, asked while the model and level are still
 * being chosen: before the seat's first request the prefix is tools+system
 * alone, and the ledger (`lib/warm-prefix.ts`) knows whether a seat with these
 * inputs has one warm. Once the conversation has a message in it the choice is
 * made and the question is behind us, so the light goes out for the rest of the
 * session — the bottom rule's `❄` glyph is what counts the seat's own window
 * down from there. An earlier rule kept lighting the label off that window,
 * which turned a prompt for a decision into a permanent shimmer.
 *
 * A resumed conversation counts as started.
 */

import type { Warmth } from "../../lib/warm-prefix.ts";

/** What the chrome knows at one instant. */
export interface WarmthFacts {
	readonly now: number;
	/** A turn is in flight: the wave has the frame, and the question is about the next request anyway. */
	readonly running: boolean;
	/**
	 * The id the next request would carry and the ledger key for this seat's
	 * inputs, or undefined when the next request is not an Anthropic one.
	 */
	readonly seat: { readonly model: string; readonly reasoning: string; readonly inputsKey: string } | undefined;
	/** The conversation has a message in it. */
	readonly conversationStarted: boolean;
	/** The ledger's word for a seat's inputs; asked only when tools+system is the whole prefix. */
	readonly ledger: (inputsKey: string) => Warmth;
}

/** The answer, and the ledger's word when that is what it rests on. */
export interface Verdict {
	readonly warm: boolean;
	readonly ledger?: Warmth;
}

/** Warm only before the first message, and only on the ledger's word. */
export function warmthOf(facts: WarmthFacts): Verdict {
	if (facts.running || facts.seat === undefined || facts.conversationStarted) return { warm: false };
	const ledger = facts.ledger(facts.seat.inputsKey);
	return { warm: ledger.kind === "warm", ledger };
}
