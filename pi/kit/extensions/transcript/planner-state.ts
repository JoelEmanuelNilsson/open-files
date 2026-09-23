/**
 * The transcript planner's cross-row state, on the process rather than in a
 * module.
 *
 * pi loads **each extension file with its own jiti and `moduleCache: false`**
 * (`dist/core/extensions/loader.js`), so module-scope state is per extension
 * file, not per process. Two files of this kit therefore hold two copies of
 * every `Map` at the top of `group.ts` — and two of them borrow the transcript's
 * receipt: `extensions/bash.ts` owns the shell's execution and takes its rows
 * from `receipt.ts`, and `extensions/multi-edit.ts` takes the header. Under the old layout the bash copy's `seats` map was empty
 * forever, so `roleOf` answered `"row"` for every bash call: bash never folded,
 * and a group whose speaker was a bash row hid its `read` members with no line
 * to replace them — output silently lost.
 *
 * One registry on `globalThis`, one accessor, and that class of bug is gone by
 * construction: any file that borrows a receipt joins the same planner because
 * there is only one planner to join. `transcript/click.ts` reaches for a global
 * symbol the same way, for the same reason.
 *
 * Everything here is state *across* rows. A row's own facts (its clock, its
 * summary, its held hint) live on the `state` object pi hands both render slots
 * for the life of that row, and a component's layout cache lives on the
 * component. Neither belongs here.
 */

import { shared } from "../../lib/shared.ts";
import type { Group } from "./group.ts";
import type { RowState } from "./row.ts";

/** A row's place in its group. A row with no seat draws itself. */
export interface Seat {
	group: Group;
	/** Its index in `group.ids`, which is what decides whether it speaks. */
	index: number;
}

/** A tool result that has happened but has not been written into the session yet. */
export interface Arrival {
	failed: boolean;
}

/** A row that has drawn a header and not yet drawn a result. */
export interface WatchedRow {
	state: RowState;
	invalidate: () => void;
}

/**
 * Everything the planner knows that outlives a single row.
 *
 * `seats` and `ticker` are reassigned, so they are fields on this object rather
 * than module bindings: a `let` cannot be shared across two copies of a module,
 * and a mutable field can.
 */
export interface TranscriptPlannerState {
	/** Which group each call id belongs to, rebuilt whole by `regroup`. */
	seats: Map<string, Seat>;
	/** How to ask pi to draw a row again, by call id. Set on every header render. */
	redraws: Map<string, () => void>;
	/** Results pi has announced to extensions but not yet written into the session. */
	arrivals: Map<string, Arrival>;
	/** The rows still drawing as running, so `quiesce` can hollow them out. */
	inFlight: Map<string, WatchedRow>;
	/** The one periodic repaint in the extension: the live line's clock. */
	ticker: ReturnType<typeof setInterval> | undefined;
}

/**
 * The key every copy of these modules agrees on.
 *
 * A global symbol, so two jiti realms that share no module cache still share
 * this one object. Versioned in the string: were the shape below ever to change
 * incompatibly, a new key is the way two copies of different vintages fail to
 * find each other instead of corrupting one another.
 */
const PLANNER_STATE = Symbol.for("pi.kit.transcript.state");

/**
 * The one planner state for this process, created on first use.
 *
 * Called on every render, so it stays a property read plus a branch.
 */
export function transcriptPlannerState(): TranscriptPlannerState {
	return shared(PLANNER_STATE, () => ({ seats: new Map(), redraws: new Map(), arrivals: new Map(), inFlight: new Map(), ticker: undefined }));
}
