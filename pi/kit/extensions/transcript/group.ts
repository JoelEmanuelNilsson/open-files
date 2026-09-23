/**
 * Which rows collapse into a rollup line, and which one of them draws it.
 *
 * A group is a run of tool rows that are *adjacent on screen*: nothing was
 * printed between them. One row of the group speaks for all of them and every
 * other row draws nothing, which is the only shape pi allows, since an extension
 * cannot add a component to the chat container and a row with `renderShell:
 * "self"` that produces no lines disappears completely — no spacer, no blank.
 *
 * **A group never changes shape.** Its first row draws the line, every other
 * row draws nothing, and the line is two lines tall for the whole run: the
 * sentence, and under it a gutter saying what the newest call is doing.
 *
 *     ● Running 4 shell commands · 5.0s…
 *       ⎿  $ ping -c 25 127.0.0.1 > /dev/null
 *
 * When the run is over, that is replaced in place by the past-tense line over
 * everything the group folded:
 *
 *     Read 3 files, searched for 2 patterns, ran 2 shell commands
 *
 * Both are drawn in the same columns *and over the same counts*, so settling
 * moves no word and changes no number — only the verb, and the gutter, which
 * is a statement about work still going.
 *
 * **The tense is a property of the run, not of the results.** A group is
 * present tense while the model is mid-turn and it is the trailing group of the
 * transcript, whatever has already come back; `agent_settled` is what makes it
 * past. Deciding it per result made the block bounce two lines to one and back
 * on every command of a turn, because the gap between one bash result and the
 * next call is a gap with nothing in flight in it.
 *
 * **A group of one draws the line too.** `Running 1 shell command…` over `$ cmd`
 * says what the row said, in the columns the run will settle in, so a turn of
 * three commands is two lines from the first token to the last.
 *
 * A call folds the moment its result lands, not when the turn ends. That is the
 * whole feel of the thing: a transcript that prints seven rows and then
 * swallows them is a screen that jumps at the end of every turn. pi creates
 * every row of a batch as the arguments stream, long before any of them return,
 * so without this a seven-call turn is seven rows on screen from the first
 * token.
 *
 * Adjacency is read off the session rather than guessed at while the run is in
 * flight. That distinction is the whole reason this is a hundred lines instead
 * of the four hundred a previous attempt cost: `plan` is a pure function of
 * facts that have already happened, and the same function over the same entries
 * is what folds a live turn, what seeds a resumed session, and what puts a
 * compacted one back together. There is no registry to keep in sync, no
 * revision stamps, and nothing to guess.
 *
 * The one fact the session does not have yet is the result that just arrived:
 * pi emits `tool_execution_end` to extensions before it writes the result down,
 * and a parallel batch writes all of its results at once, at the end. So a
 * result is handed here as it happens, and `plan` reads the session plus the
 * handful of results that have not reached it.
 *
 * The rules, each of them a thing that would otherwise be printed between two
 * rows and break the run:
 *
 * - **Prose.** pi adds the whole assistant message to the chat at
 *   `message_start` and appends its tool rows after it, so a message that says
 *   anything always says it *above* its own calls, whatever the order of its
 *   content blocks. A speaking message therefore ends the previous group and
 *   starts a new one. Text only: thinking never breaks a group, hidden or not,
 *   and `speaks()` has the argument.
 * - **A row that stays.** A tool with no rollup phrase (`write`, `edit`,
 *   anything unknown), a call that failed, a result carrying an image
 *   pi will draw anyway, and — once the run is over — a call that never came
 *   back, which is a call that was interrupted: hollow dot, no result, sitting
 *   where it stopped. Each of those keeps its full row, so the run is cut there
 *   rather than summarised around it.
 * - **Anything else in the transcript**: a user message, a compaction summary,
 *   an extension's own entry.
 *
 * A call that has not come back while the run is *live* is none of these. It
 * joins its group like every other member. `live` is the whole of that
 * difference: the same unanswered call is a member while the run goes and a
 * kept row once it stops.
 *
 * Claude Code differs on one of these: it collapses failures too, and leaves
 * the model's prose to explain them. This extension exists because a failed
 * call was invisible in pi's own rows, so hiding one behind `Ran 1 shell
 * command` is the one piece of the grammar not worth copying.
 */

import { describe } from "./describe.ts";
import { type Seat, transcriptPlannerState } from "./planner-state.ts";
import { collapsible } from "./rollup.ts";
import { heldHint, type Hint, type HintHold, type RenderContext, rowState } from "./row.ts";

/** The row of a group that draws its line: the first, always, so the line never moves. */
const SPEAKER = 0;

export interface Group {
	/** The call ids in the group, in the order pi drew them. */
	ids: string[];
	/** The tool each id ran, parallel to `ids`. */
	tools: string[];
	/**
	 * What each call is about, parallel to `ids`, once that can no longer change.
	 *
	 * A read's path, and `undefined` while its arguments are still streaming. It
	 * is what lets `Read N files` count files rather than calls; `subjectOf` has
	 * the rule and `clausesFor` is the only reader.
	 */
	subjects: (string | undefined)[];
	/**
	 * What each call would say under the line, parallel to `ids`: `$ npm test` for
	 * a shell command, the path or pattern for everything else.
	 *
	 * `undefined` while the arguments are still streaming, which is also what
	 * keeps that call out of the counts until it can be named.
	 */
	hints: (string | undefined)[];
	/**
	 * The run this group belongs to is still going, so the line is present tense.
	 *
	 * True only for the trailing group of a live plan. A group the transcript has
	 * already printed past cannot be about work that is still happening, whatever
	 * its calls did.
	 */
	running: boolean;
	/** The 700ms hold on the line's gutter. `heldHint` owns it; see `hintOf`. */
	hint?: HintHold["hint"];
	/** Identity of the run, so a replan can keep what the reader had opened. */
	key: string;
	/**
	 * Epoch ms the group began: the earliest any of its members started work.
	 *
	 * On the group and not on any one row: a batch's members start at different
	 * moments, and a clock over the run has to count from the first of them.
	 *
	 * Only ever lowered, and carried across a replan by `regroup`, so it is set
	 * once per run of adjacent calls and then holds still.
	 */
	startedAt?: number;
	/**
	 * The speaking row is open, so every row in the group draws itself in full.
	 *
	 * It lives on the group rather than on each row because that row speaks for
	 * the group: its line is the only thing on screen, so it is the only thing
	 * that can be clicked, and what it means to click it is "show me all of
	 * this".
	 */
	expanded: boolean;
}

/**
 * What a row draws, in both slots at once.
 *
 * `line` is the rollup line in either tense, and it is drawn by the header slot
 * alone: the line's own gutter comes off the group, so a folded row's result
 * slot never contributes to it.
 */
export type Role = "row" | "line" | "hidden";

/**
 * Where the seats, the redraw callbacks, the arrivals and the ticker live.
 *
 * On the process, not in this module: pi loads every extension file with its
 * own jiti and no module cache, so `extensions/bash.ts` holds a second copy of
 * this file and a second copy of every map in it. `planner-state.ts` has the
 * whole argument. Read per call rather than hoisted, so a reload that rebuilt
 * the registry could never leave a stale reference behind.
 */
function planner() {
	return transcriptPlannerState();
}

/**
 * Remembers how to redraw this row.
 *
 * Called from the header slot, which is the one slot every row reaches on every
 * frame, running or settled. The context of a test harness has no `invalidate`
 * and a renderer must not throw, so the shape is checked rather than assumed.
 */
export function noteRow(context: RenderContext): void {
	const id = context.toolCallId;
	if (typeof id !== "string" || typeof context.invalidate !== "function") return;
	// Kept for every row rather than only the folded ones: the row that is running
	// now is the one that joins a group when its result lands.
	planner().redraws.set(id, context.invalidate);
	began(id, rowState(context).startedAt);
}

/**
 * Folds one row's start time into its group's, earliest wins.
 *
 * This is also the only place that can *start* the clock ticking. A batch of
 * silent commands does not reach the planner again until one of them lands, so
 * the moment a member says when it began is the moment a clock becomes drawable.
 */
function began(id: string, at: number | undefined): void {
	const group = planner().seats.get(id)?.group;
	if (at === undefined || !group) return;
	if (group.startedAt !== undefined && group.startedAt <= at) return;
	group.startedAt = at;
	retime();
}

/**
 * What this row draws: itself, the group's line in one of its two tenses, or
 * nothing.
 *
 * Visibility is decided by the speaker alone. `ctrl+o` sets `expanded` on every
 * row at once, so reading the speaker's flag is the same answer for the whole
 * group; a click sets it on one row, and the row a folded group leaves
 * clickable *is* the speaker. Members keep their own `expanded` for what it
 * means on a visible row — how much of the output to show — and have no say in
 * whether they are visible at all.
 */
export function roleOf(context: RenderContext): Role {
	const seat = planner().seats.get(context.toolCallId);
	if (!seat) return "row";
	const { group, index } = seat;
	if (index !== SPEAKER) {
		// `ctrl+o` shows everything, including calls that have not run: asking for
		// everything means everything.
		if (context.expanded === true) return "row";
		return group.expanded ? "row" : "hidden";
	}
	open(group, context.expanded === true);
	if (context.expanded === true) return "row";
	return "line";
}

/**
 * What the line says under itself while the run goes: the newest call the
 * group can name, by what it was asked to do.
 *
 * Newest first, because the gutter is about where the run has got to. It names
 * the call — `$ command`, a path, a pattern — and never quotes its output: a
 * gutter that switched to the last line printed read as the transcript saying
 * something, when it was a running command's stdout going past. Claude Code's
 * `latestDisplayHint` is built from the tool input for the same reason. A
 * member whose arguments are still streaming cannot be named, so the member
 * before it speaks.
 */
function hintOf(group: Group): string | undefined {
	for (let index = group.ids.length - 1; index >= 0; index--) {
		const said = group.hints[index];
		if (said !== undefined && said !== "") return said;
	}
	return undefined;
}

/**
 * The clauses the speaking row draws, and which tense they are in.
 *
 * Both tenses count the whole group. The tense picks the verb and nothing else,
 * so a landing result never makes a number fall and settling never makes one
 * jump. Counts only ever grow, which is the property that makes the line
 * readable while it is moving.
 *
 * `subjects` is the other half of that property: a clause that counts nouns
 * counts the things named here, and a call that has not named one yet is not
 * counted at all rather than counted and taken back.
 */
export function lineOf(id: string): { tools: string[]; subjects: (string | undefined)[]; live: boolean; startedAt?: number; hint?: string } | undefined {
	const seat = planner().seats.get(id);
	if (!seat) return undefined;
	const { group } = seat;
	const hint = holdHint(group);
	return { tools: group.tools, subjects: group.subjects, live: group.running, startedAt: group.startedAt, hint };
}

/**
 * The gutter line, held for its minimum so a fast command is readable at all.
 *
 * The hold is the row's `heldHint`, kept on the group instead: the line stands
 * for every call in the run, so what it may replace and when is a fact about
 * the run. A settled group takes its hold down with it.
 */
function holdHint(group: Group): string | undefined {
	const speaker = group.ids[SPEAKER] ?? "";
	const said = group.running ? hintOf(group) : undefined;
	const shown: Hint | undefined = said === undefined ? undefined : { line: said, hidden: 0 };
	return heldHint(group, shown, !group.running, () => redraw(speaker))?.line;
}

function open(group: Group, expanded: boolean): void {
	if (group.expanded === expanded) return;
	group.expanded = expanded;
	// This runs inside the speaker's own render, and redrawing a row runs its
	// renderers synchronously. Deferring keeps that out of the frame that is
	// still being built; pi has already been asked for another one.
	const speaker = group.ids[SPEAKER];
	const members = group.ids.filter((id) => id !== speaker);
	queueMicrotask(() => {
		for (const id of members) redraw(id);
	});
}

function redraw(id: string): void {
	const invalidate = planner().redraws.get(id);
	if (!invalidate) return;
	try {
		invalidate();
	} catch {
		// A row whose component pi has already dropped cannot be redrawn, and that
		// is not a reason to leave the rest of them lying.
	}
}

// ---------------------------------------------------------------------------
// The clock. The one periodic repaint in the extension, and the whole of what
// it costs.
//
// `header.ts` argues against blinking and the argument holds: pi's renderer has
// no dirty tracking, this terminal runs a CRT shader that tints glyphs by their
// row, and the background is blurred and translucent, so every repaint
// recomposites the blur. Colour carries the dot's meaning for free, which is why
// the dot is still.
//
// Elapsed time is the one thing colour cannot carry. A silent command prints
// nothing, so without a clock the screen says the same words for a minute and a
// half and there is no way to tell working from hung. So it is paid for at the
// smallest denomination there is: one row — the row drawing a group's line — per
// group that has a clock to draw, once a second, and nothing at all otherwise.
// ---------------------------------------------------------------------------

const TICK_MS = 1000;

/** The rows with a clock on them, which is the only thing worth repainting. */
function ticking(): string[] {
	const out: string[] = [];
	const seen = new Set<Group>();
	for (const { group } of planner().seats.values()) {
		if (seen.has(group)) continue;
		seen.add(group);
		// A settled group has stopped counting, and a group none of whose members
		// has started has nothing to count from. Neither has a reason to repaint.
		if (!group.running || group.startedAt === undefined) continue;
		const id = group.ids[SPEAKER];
		if (id !== undefined) out.push(id);
	}
	return out;
}

/** Runs the tick while any line has a clock, and stops it the instant none has. */
function retime(): void {
	const state = planner();
	if (ticking().length === 0) {
		stopTicking();
		return;
	}
	if (state.ticker !== undefined) return;
	const timer = setInterval(() => {
		const rows = ticking();
		if (rows.length === 0) {
			stopTicking();
			return;
		}
		for (const id of rows) redraw(id);
	}, TICK_MS);
	// A clock nobody is watching is not a reason to keep the process alive.
	timer.unref?.();
	state.ticker = timer;
}

/**
 * Stops the clock.
 *
 * `regroup` does this by itself the moment the last group settles. This is the
 * explicit path for the two ends where there may be no plan left to make: a run
 * that settled, and a session going away.
 */
export function stopTicking(): void {
	const state = planner();
	if (state.ticker === undefined) return;
	clearInterval(state.ticker);
	state.ticker = undefined;
}

/**
 * Replans the whole transcript and redraws only the rows whose part changed.
 *
 * Cheap enough to run on every settle and after every rebuild: it walks the
 * session entries once and touches a row only when its part is new or
 * different. In the steady state that is the rows of the run in flight.
 *
 * Every plan builds new group objects, so an old seat still describes what its
 * row last drew — which is the only way to tell that anything changed. The one
 * thing carried across is whether the reader had opened the run, and it is
 * carried onto a group that has *grown* as well as one that is identical: a
 * batch gains a member every time the model streams another call, and an
 * opened group that closed itself on the next token would be a bug you could
 * not click your way out of.
 */
export function regroup(entries: readonly unknown[], live = false): void {
	const state = planner();
	const seats = state.seats;
	const next = new Map<string, Seat>();
	for (const group of plan(entries, live)) {
		const previous = seats.get(group.ids[0] ?? "")?.group;
		if (previous && grewFrom(previous, group)) {
			if (previous.expanded) group.expanded = true;
			// Same run, so the same clock. A batch gains a member on every streamed
			// call and a plan object per landing result; restarting the count on either
			// is exactly the jump the group owns a start time to avoid.
			group.startedAt = previous.startedAt;
			// The hold is about the gutter on screen, and the same gutter is still on
			// screen: a plan object per streamed token would otherwise mean no hold.
			group.hint = previous.hint;
		}
		group.ids.forEach((id, index) => next.set(id, { group, index }));
	}
	const changed = new Set<string>();
	for (const [id, seat] of seats) if (partOf(next.get(id)) !== partOf(seat)) changed.add(id);
	for (const [id, seat] of next) if (partOf(seats.get(id)) !== partOf(seat)) changed.add(id);
	state.seats = next;
	retime();
	for (const id of changed) redraw(id);
}

/**
 * The same run, with the same calls still in flight, in the same seat, about the
 * same things.
 *
 * The subjects are in the stamp because a read's path arriving is a number on
 * the line going up, and nothing else about the group changes when it does.
 */
function partOf(seat: Seat | undefined): string {
	if (!seat) return "";
	const group = seat.group;
	return `${group.key}\u0000${seat.index}\u0000${group.running}\u0000${group.subjects.join("\u0001")}\u0000${group.hints.join("\u0001")}`;
}

/** Whether `group` is `previous` with more calls on the end of it. */
function grewFrom(previous: Group, group: Group): boolean {
	if (previous.ids.length > group.ids.length) return false;
	return previous.ids.every((id, index) => group.ids[index] === id);
}

/**
 * Drops the callbacks, because the rows they draw are gone.
 *
 * pi rebuilds every component in the chat when it compacts, forks or walks the
 * tree. The new ones register themselves on their first render; holding the old
 * ones would keep a screenful of dropped components alive for a session.
 */
export function forgetRows(): void {
	planner().redraws.clear();
}

/** Puts every row back the way pi drew it. For `PI_TRANSCRIPT_ROLLUP=off` and for tests. */
export function ungroup(): void {
	stopTicking();
	const state = planner();
	const drawn = [...state.seats.keys()];
	for (const { group } of state.seats.values()) heldHint(group, undefined, true, () => {});
	state.seats = new Map();
	state.arrivals.clear();
	for (const id of drawn) redraw(id);
	state.redraws.clear();
}

/**
 * Records a result that has happened but has not been written down yet.
 *
 * pi emits `tool_execution_end` to extensions before the session gets the
 * result message, and a parallel batch holds all of its result messages back
 * until the last call returns. Without this a folded batch would appear in one
 * lump at the end of the batch, which is the thing this file exists to stop.
 */
export function noteResult(id: string, failed: boolean): void {
	if (typeof id !== "string") return;
	planner().arrivals.set(id, { failed });
}

/** Dropped when the next run starts: by then the session has said it all itself. */
export function forgetResults(): void {
	planner().arrivals.clear();
}

// ---------------------------------------------------------------------------
// The planner. Pure, and typed against only what it reads: these are pi's
// session entries, restated loosely so a shape it has never seen is ignored
// rather than thrown over.
// ---------------------------------------------------------------------------

interface Block {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	/** Only worth reading once they have finished streaming. See `subjectOf`. */
	arguments?: unknown;
	/** The half-streamed argument string, under each of the names pi gives it. See `STREAMING`. */
	partialJson?: string;
	partialArgs?: string;
	n?: string;
}

interface Message {
	role?: string;
	content?: Block[] | string;
	stopReason?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface Entry {
	type?: string;
	message?: Message;
}

/**
 * Entry kinds that put something on screen of their own.
 *
 * A model change or a label does not, so it cannot separate two rows, and
 * treating it as a break would split a group over a thing nobody can see.
 */
const PRINTS = new Set(["compaction", "branch_summary", "custom", "custom_message"]);

function entryOf(value: unknown): Entry {
	return (typeof value === "object" && value !== null ? value : {}) as Entry;
}

/**
 * The fields pi keeps a half-streamed argument string in, beside the arguments.
 *
 * Every provider stream in pi accumulates the raw JSON of a call in a sibling
 * field, reparses it into `arguments` on every delta, and deletes the field the
 * moment the call closes — so the field being there *is* the fact that the
 * arguments are still growing. The name differs by provider (`partialJson` on
 * the Anthropic and proxy streams, `partialArgs` on OpenAI completions and
 * Mistral, `n` on OpenAI responses) and a block only ever carries the one
 * belonging to the stream that made it, so all three are checked at once.
 */
const STREAMING = ["partialJson", "partialArgs", "n"] as const satisfies readonly (keyof Block)[];

/**
 * What a call is about, or `undefined` while that can still change.
 *
 * Nothing is counted until it is identified, so nothing can ever be un-counted:
 * this is what `Read N files` counts, and a call with no subject is left out of
 * that count entirely rather than counted as a call and taken back when its path
 * turns out to be one already there. `rollup.ts` carries the argument.
 *
 * Two ways the arguments can still be growing, and both are checked because both
 * happen: pi's RPC client keeps the raw prefix in `arguments` itself until the
 * accumulated JSON parses (`parsePartialToolInput` in `client/transcript.js`
 * returns the string until then), and every provider stream keeps a partial
 * *object* there with the prefix beside it. Reading a prefix as a path is how
 * `Read 2 files` becomes `Read 1 file` a token later.
 *
 * Paths are compared as they were written, so one file named relatively by one
 * call and absolutely by another counts twice. That over-counts, which is a
 * number that grows; resolving them needs a cwd the planner is not given, and
 * getting it wrong would move a number backwards.
 */
function subjectOf(block: Block, id: string): string | undefined {
	const args = argumentsOf(block);
	if (args === undefined) return undefined;
	const path = (args as { path?: unknown }).path;
	// Arguments that landed naming no path cannot be compared against anything, so
	// the call stands for itself under an id no other call can share.
	return typeof path === "string" && path !== "" ? path : id;
}

/** The arguments of a call that has finished streaming them, and nothing before that. */
function argumentsOf(block: Block): Record<string, unknown> | undefined {
	const args = block.arguments;
	if (typeof args !== "object" || args === null) return undefined;
	if (STREAMING.some((field) => block[field] !== undefined)) return undefined;
	return args as Record<string, unknown>;
}

/** Set once: `$HOME` does not change while a session runs. */
const HOME = process.env.HOME || process.env.USERPROFILE;

/**
 * What one call would say under the line: `$ npm test`, or the path or pattern
 * a header would have shown in its parentheses.
 *
 * The same text `describe.ts` writes into a row's header, so the gutter and the
 * row a click puts back name the call the same way. Paths are spelled against
 * the process directory rather than the session's, which the planner is not
 * given — the difference is a path that stays absolute.
 */
function hintFor(tool: string, block: Block): string | undefined {
	const args = argumentsOf(block);
	if (args === undefined) return undefined;
	const text = describe(tool, args, process.cwd(), HOME).text;
	if (text === "") return undefined;
	return tool === "bash" || tool === "powershell" ? `$ ${text}` : text;
}

function blocksOf(message: Message | undefined): Block[] {
	const content = message?.content;
	return Array.isArray(content) ? content : [];
}

/**
 * Whether this assistant message printed words above its own tool rows.
 *
 * Text only. **Thinking never breaks a group**, which is Claude Code's rule too
 * (`collapseReadSearch.ts` skips thinking blocks when grouping) and is the only
 * rule that survives `hideThinkingBlock`. With hidden thinking on — this
 * harness's default — a reasoning model puts a thinking block in front of
 * almost every message, so counting one as prose made almost every message a
 * group of one and the rollup line all but unreachable. It is also the honest
 * answer either way round: what a group claims is that nothing was printed
 * between its rows, and a thinking block that is drawn is one dim line the
 * reader has already decided not to read.
 */
function speaks(message: Message | undefined): boolean {
	return blocksOf(message).some((block) => block.type === "text" && (block.text ?? "").trim() !== "");
}

/**
 * The calls that came back, and the ones whose rows have to stay.
 *
 * A call is kept when it failed, when it returned a picture — pi draws that as
 * a child of the row whether or not the renderers produce a line, so a
 * collapsed row would leave an image floating under no header — or when the
 * assistant message it belongs to was aborted, which is how pi marks every call
 * of an interrupted turn.
 */
function outcomes(entries: readonly unknown[]): { answered: Set<string>; kept: Set<string> } {
	const answered = new Set<string>();
	const kept = new Set<string>();
	for (const [id, arrival] of planner().arrivals) {
		answered.add(id);
		if (arrival.failed) kept.add(id);
	}
	for (const value of entries) {
		const entry = entryOf(value);
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "toolResult") {
			const id = message.toolCallId;
			if (typeof id !== "string") continue;
			answered.add(id);
			if (message.isError === true) kept.add(id);
			if (blocksOf(message).some((block) => block.type === "image")) kept.add(id);
			continue;
		}
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "aborted" && message.stopReason !== "error") continue;
		for (const block of blocksOf(message)) if (block.type === "toolCall" && typeof block.id === "string") kept.add(block.id);
	}
	return { answered, kept };
}

/**
 * The groups a transcript falls into, in document order.
 *
 * `live` says whether the run is still going, which is the difference between a
 * call that has not come back yet and a call that never will. The first joins
 * its group; the second was interrupted, and keeps its row.
 *
 * It is also the whole of the tense, together with position: only the group the
 * entries end on can be about work still happening, so only that one speaks in
 * the present. Every group before it has something printed after it.
 */
export function plan(entries: readonly unknown[], live = false): Group[] {
	const { answered, kept } = outcomes(entries);
	const groups: Group[] = [];
	let ids: string[] = [];
	let tools: string[] = [];
	let subjects: (string | undefined)[] = [];
	let hints: (string | undefined)[] = [];

	const flush = (trailing = false) => {
		if (ids.length > 0) groups.push({ ids, tools, subjects, hints, running: live && trailing, key: ids.join(" "), expanded: false });
		ids = [];
		tools = [];
		subjects = [];
		hints = [];
	};

	for (const value of entries) {
		const entry = entryOf(value);
		if (entry.type !== "message") {
			if (PRINTS.has(entry.type ?? "")) flush();
			continue;
		}
		const message = entry.message;
		// A result is drawn inside the row that asked for it, so it never comes
		// between two rows.
		if (message?.role === "toolResult") continue;
		if (message?.role !== "assistant") {
			flush();
			continue;
		}
		if (speaks(message)) flush();
		for (const block of blocksOf(message)) {
			if (block.type !== "toolCall") continue;
			const id = block.id;
			const tool = block.name;
			if (typeof id !== "string" || typeof tool !== "string") continue;
			// A row that stays is printed between the rows either side of it, so it
			// ends the run rather than being summarised over.
			if (!collapsible(tool) || kept.has(id)) {
				flush();
				continue;
			}
			// Not in flight, since the run is over: this call was interrupted and its
			// row is the record of that.
			if (!answered.has(id) && !live) {
				flush();
				continue;
			}
			ids.push(id);
			tools.push(tool);
			subjects.push(subjectOf(block, id));
			hints.push(hintFor(tool, block));
		}
	}
	flush(true);
	return groups;
}
