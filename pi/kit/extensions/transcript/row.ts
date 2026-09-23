/**
 * What every tool row shares: its clock, its cached facts, and the switch that
 * turns the whole look off.
 *
 * pi hands both render slots the same `state` object for the life of a row,
 * which is the sanctioned place for this. `details` is not: the docs are explicit
 * that an override must match the built-in's `details` shape because the UI and
 * session logic read it, so a count stashed there is a contract broken for a
 * convenience.
 *
 * The clock has to be split across the two slots because neither one sees both
 * ends. `renderCall` is the only slot that runs before the tool does, and
 * `renderResult` is the only one that runs when it stops.
 *
 * The hint's minimum display time is here for the same reason: it is a fact
 * about this row over time, and the row's state object is the only thing that
 * lives that long.
 */

import type { Component } from "@earendil-works/pi-tui";
import { transcriptPlannerState } from "./planner-state.ts";
import { formatDuration, type Summary } from "./summary.ts";

/**
 * The state glyph, and the two columns it occupies with its trailing space.
 *
 * Here rather than in `header.ts`, which is where its three colours and their
 * meanings live, because the rollup line wears it too: a line standing in for
 * calls that are still running is a running row, and it keeps the dot the row
 * it replaced would have had. `header.ts` re-exports both.
 */
export const DOT = "●";
/**
 * A call that was still running when the run stopped.
 *
 * The only state that changes the glyph rather than its colour, because it is
 * the only one that has to be told apart from a *dim* dot rather than from a
 * coloured one. Hollow reads as what happened: the row never filled in.
 */
export const CUT = "○";

/**
 * A row that has been folded into the rollup line above it.
 *
 * `ToolExecutionComponent.render` returns nothing at all when its renderers
 * produce no lines, so this is the whole of "collapse": no header, no gutter,
 * no blank line where the row used to be. Both slots return it, because one
 * slot drawing nothing still leaves the other's line behind.
 *
 * `invalidate` is a no-op rather than absent: nothing here caches, but
 * `Component` requires the method, and pi reaches a renderer's component
 * through containers that call it. Stateless, so one shared instance is enough.
 */
export const BLANK: Component = { render: () => [], invalidate: () => {} };

/**
 * The context both render slots are handed.
 *
 * `extensions.md` documents this shape, and `ToolRenderResultOptions` beside it
 * is exported, but `ToolRenderContext` itself is not on the package root. It is
 * restated here rather than reached for with a deep import into `dist/`, which
 * would pin this code to a build layout pi is free to change.
 */
export interface RenderContext {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: unknown;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

/** One line of a running command's output, and how many it is standing in front of. */
export interface Hint {
	line: string;
	hidden: number;
}

/**
 * Whatever a hint is being held on: a row, or the group whose line replaced it.
 *
 * One hold, two owners, because the rule is about the gutter on screen rather
 * than about what is drawing it.
 */
export interface HintHold {
	hint?: { shown: Hint; at: number; timer?: ReturnType<typeof setTimeout> };
}

export interface RowState extends HintHold {
	/** Epoch ms the tool began work, not when its arguments started streaming. */
	startedAt?: number;
	endedAt?: number;
	/** Set by `quiesce`: the run stopped while this call was still in flight. */
	aborted?: boolean;
	/** Computed once, when the result settles. A count is a fact about the call. */
	summary?: Summary | null;
	/** Whether this row's path was there to link. Only ever set once it is true. */
	exists?: boolean;
	/** The line to open the file at, when only the result knew it. */
	line?: number;
	/**
	 * Set before the first render by a view that draws rows outside the main
	 * transcript (`agent-dock/agent-conversation-feed.ts`). The main run settling
	 * says nothing about such a row, so `watch` never registers it for `quiesce`.
	 */
	offTranscript?: true;
}

export function rowState(context: RenderContext): RowState {
	const state = context.state;
	return (typeof state === "object" && state !== null ? state : {}) as RowState;
}

/**
 * Starts the clock the first time pi says execution began.
 *
 * Arguments stream in over several renders before the tool runs, so timing from
 * the first render would count the model's typing.
 */
export function startClock(context: RenderContext): void {
	const state = rowState(context);
	if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
}

/**
 * Remembers a call that has drawn a header and not yet drawn a result.
 *
 * A row that is interrupted never reaches `renderResult`, so nothing on the row
 * itself ever says it stopped: the dot stays dim, which is also what a call in
 * flight looks like. This is the whole of the bookkeeping needed to tell those
 * two apart — a call id, the state object both slots share, and the callback
 * that asks pi to draw the row again.
 *
 * The map is on the process (`planner-state.ts`), not in this module: pi loads
 * every extension file with its own jiti, so `extensions/bash.ts` holds a
 * second copy of this file, and a bash row watched in one copy has to be
 * hollowed out by the `agent_settled` in the other.
 *
 * Called on every header render, which is the only slot a running row reaches.
 */
export function watch(context: RenderContext): void {
	const inFlight = transcriptPlannerState().inFlight;
	if (rowState(context).offTranscript) return;
	if (!context.isPartial || context.isError) {
		inFlight.delete(context.toolCallId);
		return;
	}
	inFlight.set(context.toolCallId, { state: rowState(context), invalidate: context.invalidate });
}

/**
 * Nothing is in flight any more, so anything still drawing as running was cut off.
 *
 * Hooked to `agent_settled` rather than `agent_end`, since an automatic retry
 * or a compaction can follow the latter and a row waiting through one of those
 * has not been abandoned.
 */
export function quiesce(): void {
	const inFlight = transcriptPlannerState().inFlight;
	for (const { state, invalidate } of inFlight.values()) {
		if (state.aborted) continue;
		state.aborted = true;
		try {
			invalidate();
		} catch {
			// A row whose component is already gone cannot be redrawn, and that is
			// not a reason to leave the rest of them lying.
		}
	}
	inFlight.clear();
}

/**
 * How long a hint line is guaranteed to keep the gutter.
 *
 * Claude Code's `useMinDisplayTime`. A command printing a hundred lines a second
 * turns the gutter into a smear: the eye never finishes a line before it is
 * replaced, so none of them is read and the row may as well be blank. Two-thirds
 * of a second is long enough to finish a line and short enough that the gutter
 * still feels attached to the command.
 */
export const HINT_HOLD_MS = 700;

/**
 * The hint to draw now: the newest one, or the one already up if it has not had
 * its time yet.
 *
 * The newest value is never dropped, and never stashed either. pi keeps the last
 * result and re-runs the result slot on `invalidate`, so one redraw booked for
 * the end of the window re-derives whatever the tail says *then* — which is at
 * least as new as anything that could have been saved here now. A command that
 * goes quiet mid-window therefore still ends on its real last line.
 *
 * A settled render never waits. It is the record of what the command printed,
 * and a record that arrives late is a row that changes after it is finished —
 * the exact jump the rest of this extension exists to remove. Settling also ends
 * the hold, so whatever the last hint was waiting to become, this is it.
 */
export function heldHint(hold: HintHold, hint: Hint | undefined, settled: boolean, invalidate: () => void, now = Date.now()): Hint | undefined {
	const held = hold.hint;
	if (settled || hint === undefined) {
		if (held?.timer !== undefined) clearTimeout(held.timer);
		hold.hint = undefined;
		return hint;
	}
	if (held === undefined) {
		hold.hint = { shown: hint, at: now };
		return hint;
	}
	if (held.shown.line === hint.line) {
		// `+2 lines` becoming `+3` is the same line saying more about itself, not a
		// new one. Re-arming the hold on it would keep a line up long past its
		// window every time the command printed under one behind it.
		held.shown = hint;
		return hint;
	}
	const left = HINT_HOLD_MS - (now - held.at);
	if (left <= 0) {
		hold.hint = { shown: hint, at: now };
		return hint;
	}
	if (held.timer === undefined) {
		const timer = setTimeout(() => {
			held.timer = undefined;
			try {
				invalidate();
			} catch {
				// A row whose component pi has already dropped cannot be redrawn.
			}
		}, left);
		// A hint nobody will see is not a reason to keep the process alive.
		timer.unref?.();
		held.timer = timer;
	}
	return held.shown;
}

/**
 * Stops the clock on the first settled render and formats what it read.
 *
 * Null while the call is still running, and null again once it lands under the
 * floor: a call you did not wait for has nothing to say about how long it took.
 */
export function stopClock(context: RenderContext): string | null {
	const state = rowState(context);
	if (context.isPartial) return null;
	if (state.endedAt === undefined) state.endedAt = Date.now();
	if (state.startedAt === undefined) return null;
	return formatDuration(state.endedAt - state.startedAt);
}

/**
 * `PI_TRANSCRIPT=off` puts pi's own rows back.
 *
 * Read here rather than in the extension because `edit` is another extension
 * that shares this look. One switch, one visual system.
 */
export function transcriptEnabled(): boolean {
	return (process.env.PI_TRANSCRIPT ?? "").toLowerCase() !== "off";
}
