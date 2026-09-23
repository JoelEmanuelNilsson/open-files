/**
 * Several agents launched in one message are one line, not one row each.
 *
 *     ● 3 background agents launched (↓ to manage)
 *       ├─ Explore  where the parser lives
 *       ├─ Agent    write the missing tests
 *       └─ Agent    audit the error paths
 *
 * pi draws one component per tool call and an extension cannot add one to the
 * chat container, so the only shape available is the one the transcript's
 * rollup already uses: **one row of the batch speaks for all of them, and every
 * other row draws nothing at all.** A row with `renderShell: "self"` whose
 * renderers produce no lines disappears completely — no spacer, no blank — so
 * the batch costs exactly the lines it prints.
 *
 * The speaker is the first call of the batch and never moves. That differs from
 * `transcript/group.ts`, where the speaker walks to the first call still in
 * flight, and it differs for a reason: a launch returns in milliseconds, so
 * there is no long-running member to hand the screen to, and the tree under the
 * line already names every one of them.
 *
 * **A batch is a run of consecutive `Agent` calls inside one assistant
 * message.** That is a pure function of the message pi is streaming, so no
 * session walk and no bookkeeping: `planAgentLaunches` is handed the message and
 * writes the seats. Anything else between two launches — another tool, prose —
 * ends the run, exactly as it does in the transcript.
 *
 * **A batch dissolves the moment a member is not a background launch.** A
 * blocking `Agent` call returns the agent's whole answer and a failed one is the
 * record of what went wrong; neither is a name in a list. When one appears every
 * member goes back to drawing its own row, which is the same rule the transcript
 * applies to a `write` or a failure inside a read rollup.
 */

import { DEFAULT_AGENT_TYPE } from "../../lib/agent-tool-text.ts";
import { shared } from "../../lib/shared.ts";
import type { RenderContext } from "../transcript/row.ts";

/** What a member row reported about itself once its result landed. */
export interface LaunchOutcome {
	/** The engine's `AgentDetails.status`. Only `background` keeps a batch alive. */
	status: string;
	/** The agent type as the receipt displays it (`Agent`, `explore`). */
	displayName: string;
	/** The 3-5 word description the caller gave the task. */
	description: string;
}

interface LaunchBatch {
	ids: string[];
	/** The speaker is open, so every member draws itself. Carried across replans. */
	expanded: boolean;
}

/**
 * What a launch asked for, read off its arguments the moment they finish
 * streaming. The tree is drawn from this while the call is still out, so a
 * batch grows a row per agent in real time — Claude Code's shape — instead of
 * holding every name back until the last launch returns.
 */
export interface LaunchCall {
	displayName: string;
	description: string;
}

interface LaunchSeat {
	batch: LaunchBatch;
	index: number;
	/** Undefined while the arguments are still streaming. */
	call: LaunchCall | undefined;
}

interface LaunchRegistry {
	seats: Map<string, LaunchSeat>;
	outcomes: Map<string, LaunchOutcome>;
	redraws: Map<string, () => void>;
}

const REGISTRY_KEY = Symbol.for("pi.kit.agent-rows.launches");

/**
 * Cross-row state, on the process rather than in module scope.
 *
 * pi loads every extension file with its own jiti and `moduleCache: false`, so a
 * second file importing this module would otherwise get a second, empty map and
 * every batch would silently fall back to one row per launch.
 */
const registry = (): LaunchRegistry => shared(REGISTRY_KEY, () => ({ seats: new Map(), outcomes: new Map(), redraws: new Map() }));

/** The tool name a launch is registered under. */
export const AGENT_TOOL_NAME = "Agent";

interface Block {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	/** The half-streamed argument string, under each name pi gives it. See `transcript/group.ts`. */
	partialJson?: unknown;
	partialArgs?: unknown;
	n?: unknown;
}

/** A block carrying any of these is still receiving its arguments. */
const STREAMING = ["partialJson", "partialArgs", "n"] as const satisfies readonly (keyof Block)[];

/** What the call asked for, or undefined while that can still change. */
function callOf(block: Block): LaunchCall | undefined {
	const args = block.arguments;
	if (typeof args !== "object" || args === null) return undefined;
	if (STREAMING.some((field) => block[field] !== undefined)) return undefined;
	const { description, subagent_type: type } = args as { description?: unknown; subagent_type?: unknown };
	if (typeof description !== "string" || description === "") return undefined;
	// The engine's default type is badged as `Agent`; every other type is shown by its own name.
	const displayName = typeof type === "string" && type !== "" && type !== DEFAULT_AGENT_TYPE ? type : "Agent";
	return { displayName, description };
}

interface StreamedMessage {
	role?: string;
	content?: unknown;
}

/**
 * Rewrites the seats for the message being streamed.
 *
 * Called on every new tool call in the message, the same cadence
 * `transcript/index.ts` replans at, because pi creates a row the moment a call's
 * arguments start arriving: a batch is one row, then two, then three, and each
 * of those is true when it is drawn.
 *
 * Seats from earlier messages are left alone. Call ids are unique, so a plan for
 * one message can never reach into another's.
 *
 * A row whose part changed is redrawn, because pi creates the row and calls this
 * in either order: the launch that was drawing its own header a moment ago is
 * the one that has to be told it is now a member of a batch.
 */
export function planAgentLaunches(message: StreamedMessage): void {
	if (message.role !== "assistant") return;
	const content = message.content;
	if (!Array.isArray(content)) return;
	const state = registry();
	const touched: string[] = [];
	const before = new Map<string, string>();
	const remember = (id: string) => {
		if (!before.has(id)) {
			before.set(id, partOf(state.seats.get(id)));
			touched.push(id);
		}
	};

	let run: { id: string; call: LaunchCall | undefined }[] = [];
	const flush = () => {
		for (const { id } of run) remember(id);
		if (run.length >= 2) {
			const ids = run.map((entry) => entry.id);
			const previous = state.seats.get(ids[0] ?? "")?.batch;
			const batch: LaunchBatch = { ids, expanded: previous?.expanded === true && grewFrom(previous, ids) };
			run.forEach(({ id, call }, index) => state.seats.set(id, { batch, index, call }));
		} else {
			for (const { id } of run) state.seats.delete(id);
		}
		run = [];
	};

	for (const value of content) {
		const block = (typeof value === "object" && value !== null ? value : {}) as Block;
		if (block.type !== "toolCall") continue;
		if (block.name !== AGENT_TOOL_NAME || typeof block.id !== "string") {
			flush();
			continue;
		}
		run.push({ id: block.id, call: callOf(block) });
	}
	flush();

	// A member whose part changed is redrawn, and so is its speaker: the tree the
	// speaker draws names every member, so a member's arguments landing is a
	// change to the speaker's own lines.
	const wake = new Set<string>();
	for (const id of touched) {
		if (before.get(id) === partOf(state.seats.get(id))) continue;
		wake.add(id);
		const speaker = state.seats.get(id)?.batch.ids[0];
		if (speaker !== undefined) wake.add(speaker);
	}
	for (const id of wake) redraw(id);
}

/** The same batch, in the same seat, asking for the same thing. What a row has to be redrawn over. */
function partOf(seat: LaunchSeat | undefined): string {
	if (!seat) return "";
	const call = seat.call ? `${seat.call.displayName}\u0001${seat.call.description}` : "";
	return `${seat.batch.ids.join(" ")}\u0000${seat.index}\u0000${call}`;
}

/** Whether the new run is the old batch with more launches on the end of it. */
function grewFrom(previous: LaunchBatch, ids: string[]): boolean {
	if (previous.ids.length > ids.length) return false;
	return previous.ids.every((id, index) => ids[index] === id);
}

/** What this launch row draws. `block` is the one row that speaks for the batch. */
export type LaunchRole = "row" | "block" | "hidden";

/**
 * A batch only survives while every member is, or may still become, a background
 * launch. One blocking call or one failure and all of them go back to rows.
 */
function intact(batch: LaunchBatch, outcomes: Map<string, LaunchOutcome>): boolean {
	return batch.ids.every((id) => {
		const outcome = outcomes.get(id);
		return outcome === undefined || outcome.status === "background";
	});
}

export function launchRoleOf(context: RenderContext): LaunchRole {
	const state = registry();
	const seat = state.seats.get(context.toolCallId);
	if (!seat || !intact(seat.batch, state.outcomes)) return "row";
	const { batch, index } = seat;
	if (index !== 0) {
		// `ctrl+o` shows everything, including launches that have not come back:
		// asking for everything means everything.
		if (context.expanded === true) return "row";
		return batch.expanded ? "row" : "hidden";
	}
	// The speaker's flag is the batch's: its line is the only thing on screen, so
	// it is the only thing a click can reach, and opening it means opening all of
	// this.
	openBatch(batch, context.expanded === true);
	if (context.expanded === true) return "row";
	return "block";
}

/**
 * Opens or closes the whole batch when the speaker's own row is toggled.
 *
 * The members are zero lines tall, so no pointer can reach them; the speaker's
 * line is the only thing on screen and opening it has to mean "show me all of
 * this". `transcript/group.ts` carries the same rule for the same reason.
 */
function openBatch(batch: LaunchBatch, expanded: boolean): void {
	if (batch.expanded === expanded) return;
	batch.expanded = expanded;
	const members = batch.ids.slice(1);
	// Redrawing a row runs its renderers synchronously, and this is called from
	// inside the speaker's own render. pi has already been asked for another frame.
	queueMicrotask(() => {
		for (const id of members) redraw(id);
	});
}

/** The facts the block draws, in launch order. Undefined when this row is not a speaker. */
export function launchBatchOf(
	id: string,
): { outcomes: (LaunchOutcome | undefined)[]; calls: (LaunchCall | undefined)[]; settled: boolean } | undefined {
	const state = registry();
	const seat = state.seats.get(id);
	if (!seat || seat.index !== 0) return undefined;
	const outcomes = seat.batch.ids.map((member) => state.outcomes.get(member));
	const calls = seat.batch.ids.map((member) => state.seats.get(member)?.call);
	return { outcomes, calls, settled: outcomes.every((outcome) => outcome !== undefined) };
}

/** Called from the header slot, the one slot every row reaches on every frame. */
export function noteLaunchRow(context: RenderContext): void {
	const id = context.toolCallId;
	if (typeof id !== "string" || typeof context.invalidate !== "function") return;
	registry().redraws.set(id, context.invalidate);
}

/**
 * Called from the result slot when a launch settles.
 *
 * Redraws the speaker, because the line it draws counts what its members turned
 * out to be and a member cannot tell it any other way.
 */
export function noteLaunchOutcome(id: string, outcome: LaunchOutcome): void {
	const state = registry();
	const previous = state.outcomes.get(id);
	if (previous && previous.status === outcome.status && previous.description === outcome.description && previous.displayName === outcome.displayName) return;
	state.outcomes.set(id, outcome);
	const seat = state.seats.get(id);
	if (!seat) return;
	const speaker = seat.batch.ids[0];
	// A member that turned out not to be a background launch dissolves the batch,
	// so every row of it has to be told — including this one, whose call slot drew
	// itself as a hidden member microseconds before its result slot dissolved the
	// batch it was hiding in. Redrawing a row whose part did not change is one
	// extra `updateDisplay` and no repaint, so the wake is deliberately not
	// narrowed further.
	const wake = intact(seat.batch, state.outcomes) ? (speaker === undefined ? [] : [speaker]) : seat.batch.ids;
	queueMicrotask(() => {
		for (const member of wake) redraw(member);
	});
}

function redraw(id: string): void {
	const invalidate = registry().redraws.get(id);
	if (!invalidate) return;
	try {
		invalidate();
	} catch {
		// A row whose component pi has already dropped cannot be redrawn, and that
		// is not a reason to leave the rest of them lying.
	}
}

/**
 * Drops every seat and every callback.
 *
 * pi rebuilds the whole chat when it compacts, forks or walks the tree, and a
 * session shutdown takes the rows with it. Nothing here survives that, and
 * holding the old callbacks would keep a screenful of dropped components alive.
 */
export function forgetAgentLaunches(): void {
	const state = registry();
	const drawn = [...state.seats.keys()];
	state.seats.clear();
	state.outcomes.clear();
	for (const id of drawn) redraw(id);
	state.redraws.clear();
}
