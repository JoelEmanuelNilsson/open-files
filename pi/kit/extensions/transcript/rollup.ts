/**
 * The one line a run of read-only calls leaves behind, in both of its tenses.
 *
 *     ❯ run 7 shell commands random
 *
 *       Listed 1 directory, ran 6 shell commands
 *
 * The grammar is Claude Code's, checked against 2.1.248 rather than guessed:
 * the tool name column for the indent, a verb per tool, a bold count, a plain
 * unit, clauses joined with commas and only the first one capitalised. Settled,
 * it has no dot and no gutter, because there is no longer a row to stand in
 * for.
 *
 * A line that is *about work still running* is present, carries the dot the row
 * it replaced had, ends in an ellipsis, and keeps a gutter of its own saying
 * where the run has got to — the newest call's command or path, never its
 * output:
 *
 *     ● Running 2 shell commands · 5.0s…
 *       ⎿  $ ping -c 25 127.0.0.1 > /dev/null
 *
 * Two lines while it runs and one when it is over, so a turn of seven commands
 * changes words in place and shrinks once, at the end. `group.ts` decides what
 * the gutter says; this draws it.
 *
 * The clock rides between the last clause and the ellipsis, painted like the
 * words rather than like a count: bold on this line means "a number you asked
 * for", and elapsed time is not one. It is spelled by the same `formatDuration`
 * a settled row's `· 2.4s` uses, so the transcript has one way of saying how long
 * something took, and it is silent under that function's floor — a line that
 * blinks `0.0s` into existence for two frames is the noise this extension exists
 * to remove. `group.ts` owns when it starts, when it ticks, and when it stops.
 *
 * **Both tenses count the same calls: every call in the group.** The tense picks
 * the verb and nothing else, so settling swaps `Running` for `Ran` in the same
 * columns over the same numbers, and no digit on the line ever changes for any
 * other reason. Counts grow as pi streams the batch in and then hold still.
 *
 * An earlier rule counted only the calls in flight, on the theory that a waiting
 * reader wants to know how much is left. It reads fine in a screenshot and jumps
 * on screen: every result that lands takes a number down, clauses disappear
 * one at a time, and the settled line snaps back to the full counts. Ticket 38
 * has the frame-by-frame. Unbounded width was the other argument for it, and
 * that one died when this line learned to wrap — see `RollupLine` below.
 *
 * What a clause counts is the work asked for, never what came back from it. A
 * row that said `Read 412 lines` on its own contributes one file, because the
 * collapsed line is answering "what did that turn do", which is a question about
 * the turn.
 *
 * **A clause that counts nouns dedupes; a clause that counts verbs does not.**
 * `Read 2 files` names things, so one file paged twice with `offset` is one
 * file. `Ran 2 shell commands`, `Searched for 2 patterns` and `Listed 2
 * directories` name acts, and the same act twice happened twice.
 *
 * **Nothing is counted until it is identified, so nothing can ever be
 * un-counted.** A read whose arguments are still streaming has no path yet, so
 * it has no identity, so a noun clause leaves it out entirely. Count it as a
 * call and the path arrives, turns out to be a duplicate, and the number has to
 * be taken back — which is the one thing this line may never do. Ticket 38
 * proposed exactly that (count every call, dedupe the ones that came back) and
 * it is why the rule here is the other way round. The clause reads one short for
 * the fraction of a second the arguments take to land, and then grows. Growth is
 * fine; shrinkage is what is being eliminated.
 *
 * Only tools with a phrase here collapse at all. `write` and `edit` changed
 * something and their rows are the record of what changed — Claude Code
 * keeps those expanded too — and a tool this file has never heard of gets no
 * verb, because inventing one is how a summary starts lying about what ran.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { CALL_LIGHT, shadeLine, waveEnabled } from "../zen-chrome/prism.ts";
import { clip, type Paint, type Piece, paintWrapped } from "./line.ts";
import { GUTTER, GUTTER_WIDTH } from "./result.ts";
import { DOT } from "./row.ts";

/** Read once: `PI_ZEN_WAVE` is a startup switch, and this is asked every frame. */
const WAVE = waveEnabled();

/**
 * The column the tool name sits in on a full row, so a rollup line starts where
 * `Read` would have. It is the rail's column too: everything the assistant did
 * this turn shares one left edge.
 */
const INDENT = "  ";
const INDENT_WIDTH = 2;
/** What a live line ends in, in one column. The same one `clip` uses. */
const ELLIPSIS = "…";
/** Below this there is not enough room to say anything true, so nothing is said. */
const MIN_ROOM = 8;

/**
 * Whether the line is about work that is happening or work that happened.
 *
 * The verb only. Both tenses are about the same calls and print the same
 * numbers, which is what lets a batch settle without moving a word.
 */
export type Tense = "present" | "past";

interface Phrase {
	/** Past tense, capitalised. Lowercased by `clauseText` when it is not first. */
	lead: string;
	/** Present participle, same rules. `Running 2 shell commands…` */
	doing: string;
	unit: string;
	units: string;
	/** Where this clause sits in the sentence. Lower goes first. See `clausesFor`. */
	rank: number;
	/**
	 * The clause counts nouns, so two calls about the same thing are one item.
	 *
	 * The flag rather than the tool name, because the rule is about the grammar of
	 * the clause and not about `read`: whatever noun clause comes next dedupes for
	 * free, and every verb clause keeps counting acts.
	 */
	nouns?: boolean;
}

/**
 * The verb each tool contributes, and the whole definition of which rows
 * collapse.
 *
 * `find` and `ls` share a phrase on purpose: both enumerate paths, Claude Code
 * says `Listed 1 directory` for either, and two clauses that mean the same
 * thing would be two numbers to add up in your head.
 */
const PHRASES: Record<string, Phrase> = {
	grep: { lead: "Searched for", doing: "Searching for", unit: "pattern", units: "patterns", rank: 0 },
	read: { lead: "Read", doing: "Reading", unit: "file", units: "files", rank: 1, nouns: true },
	find: { lead: "Listed", doing: "Listing", unit: "directory", units: "directories", rank: 2 },
	ls: { lead: "Listed", doing: "Listing", unit: "directory", units: "directories", rank: 2 },
	bash: { lead: "Ran", doing: "Running", unit: "shell command", units: "shell commands", rank: 3 },
	powershell: { lead: "Ran", doing: "Running", unit: "shell command", units: "shell commands", rank: 3 },
};

/** Whether a settled, successful call of this tool is allowed to disappear into a count. */
export function collapsible(tool: string): boolean {
	return tool in PHRASES;
}

export interface Clause {
	lead: string;
	count: number;
	unit: string;
	units: string;
}

/**
 * One clause per phrase, in a fixed order: search → read → list → shell.
 *
 * The order is a property of the sentence, not of the batch. Ours used to be the
 * order the tools were first called, argued as "the line reads in the sequence
 * the work happened" — but aggregating by tool has already destroyed the
 * sequence. A group of `read,read,read,bash,read` renders `Read 4 files, ran 1
 * shell command`, which says the shell command came last; it came fourth. All
 * call order can report is which tool happened to be *first*, and it charges the
 * same turn a different shape every time it runs.
 *
 * A fixed shape is learnable, so the eye finds the number it wants without
 * reading the sentence. Claude Code picked the same one.
 *
 * Two tools that share a verb share a clause in either tense, which is why the
 * merge is keyed on the word rather than on the tool.
 *
 * `subjects` says what each call is *about*, parallel to `tools`: `group.ts`
 * fills it once that call's arguments have finished streaming, and leaves the
 * slot `undefined` until then. A call with no subject is counted by no clause,
 * noun or verb — pi seats a row on the first streamed token, and a count that
 * moved then would be counting a call nobody can yet name.
 *
 * Passing no array at all is a different statement from an array of
 * `undefined`s: it is a caller that does not know what its calls were about, so
 * every clause counts calls. That is what a group's tools alone can say, and it
 * is the answer `Ran N shell commands` gives either way.
 */
export function clausesFor(tools: readonly string[], tense: Tense = "past", subjects?: readonly (string | undefined)[]): Clause[] {
	const ranked: { clause: Clause; rank: number }[] = [];
	const seen = new Map<string, Clause>();
	/** What each noun clause has already counted, so it counts each thing once. */
	const counted = new Map<string, Set<string>>();
	for (const [index, tool] of tools.entries()) {
		const phrase = PHRASES[tool];
		if (!phrase) continue;
		const lead = tense === "present" ? phrase.doing : phrase.lead;
		if (subjects !== undefined) {
			const subject = subjects[index];
			// Not identified yet: its arguments are still streaming, so the call is
			// seated but nothing about it can be said. It joins the count the moment
			// they land, which is the same frame its command reaches the gutter.
			if (subject === undefined) continue;
			if (phrase.nouns === true) {
				const already = counted.get(lead) ?? new Set<string>();
				counted.set(lead, already);
				if (already.has(subject)) continue;
				already.add(subject);
			}
		}
		const found = seen.get(lead);
		if (found) {
			found.count++;
			continue;
		}
		const clause: Clause = { lead, count: 1, unit: phrase.unit, units: phrase.units };
		seen.set(lead, clause);
		ranked.push({ clause, rank: phrase.rank });
	}
	ranked.sort((a, b) => a.rank - b.rank);
	return ranked.map((entry) => entry.clause);
}

/** `Listed`, and `listed` when a clause already went before it. */
function leadOf(clause: Clause, first: boolean): string {
	return first ? clause.lead : clause.lead.charAt(0).toLowerCase() + clause.lead.slice(1);
}

function unitOf(clause: Clause): string {
	return clause.count === 1 ? clause.unit : clause.units;
}

/** `Listed 1 directory`, and `listed 1 directory` when something already spoke. */
function clauseText(clause: Clause, first: boolean): string {
	return `${leadOf(clause, first)} ${clause.count} ${unitOf(clause)}`;
}

/** The plain spelling, for tests and for the stamp the cache is keyed on. */
export function rollupText(clauses: readonly Clause[]): string {
	return clauses.map((clause, index) => clauseText(clause, index === 0)).join(", ");
}

export interface RollupPaints {
	word: Paint;
	count: Paint;
	/** The dot the live line borrows from the row it stands in for. */
	dot: Paint;
	/** The `⎿` under a live line, and what it points at. Both as a row draws them. */
	gutter: Paint;
	hint: Paint;
}

/**
 * The line in painted runs, with each comma welded to the word before it.
 *
 * A comma is not a word: a wrap that put one at the start of a line would be a
 * line beginning `, listed 1 directory`. Carrying it on the unit it follows is
 * what makes the whole sentence break only at its spaces.
 */
function pieces(clauses: readonly Clause[], paints: RollupPaints): Piece[] {
	const out: Piece[] = [];
	clauses.forEach((clause, index) => {
		const first = index === 0;
		const last = index === clauses.length - 1;
		out.push({ plain: `${first ? "" : " "}${leadOf(clause, first)} `, paint: paints.word });
		out.push({ plain: `${clause.count}`, paint: paints.count });
		out.push({ plain: ` ${unitOf(clause)}${last ? "" : ","}`, paint: paints.word });
	});
	return out;
}

/**
 * The rollup line, drawn by whichever row of the group is speaking for it.
 *
 * An extension cannot add a component to the chat container, so the line has to
 * come out of a row that is already there. It is the header slot of that row:
 * that keeps it in document order, gives it the blank line pi puts above every
 * row for free, and makes it the thing a click lands on — which is how the
 * group opens again.
 *
 * The two tenses are drawn by the same component on purpose. They are the same
 * line about the same run at two moments, and they land in the same columns:
 * the past-tense line's two-space indent is exactly the width of the live
 * line's dot and its space, so when a run settles the dot goes and no word
 * moves.
 *
 * It is the one line in the transcript that wraps. A header is clipped because
 * a header that can grow is a header you have to read to skip, but this is a
 * sentence with a clause per tool, and clipping it drops the last clause — the
 * one thing on the line that cannot be guessed. Claude Code wraps it to the
 * same indent, and a four-clause turn on an 80-column pane is exactly where
 * that shows.
 *
 * Laid out at render time and cached on a stamp of its text, like every other
 * row in this extension, because no render slot is handed a width.
 *
 * While the run goes, the chrome's light crosses it — the same light as the box
 * outline, because this is the row that stands for the calls in flight. The
 * light is a repaint of the cached layout, never part of the stamp, so a frame
 * of it costs no re-layout; and it needs the run's start to phase from, which
 * is why a live line is handed `startedAt` and not only the clock it prints.
 */
export class RollupLine implements Component {
	private clauses: readonly Clause[] = [];
	private live = false;
	private elapsed: string | null = null;
	private hint: string | undefined;
	private startedAt: number | undefined;
	private paints: RollupPaints = { word: (t) => t, count: (t) => t, dot: (t) => t, gutter: (t) => t, hint: (t) => t };
	private stamp = "";
	private cache: { width: number; stamp: string; lines: string[] } | undefined;

	set(clauses: readonly Clause[], paints: RollupPaints, live = false, elapsed: string | null = null, hint?: string, startedAt?: number): void {
		this.clauses = clauses;
		this.live = live;
		// The light says work is in flight, so a settled line cannot wear it either.
		this.startedAt = live ? startedAt : undefined;
		// The gutter says what is happening now, so a settled line cannot wear one
		// however it is called.
		this.hint = live ? hint : undefined;
		// A clock is a statement about work still going, so the past tense cannot
		// wear one however it is called: dropping it here rather than at the call
		// site is what makes a settled line with a clock on it unwriteable.
		this.elapsed = live ? elapsed : null;
		this.paints = paints;
		this.stamp = `${live ? "live" : "done"}\u0000${this.elapsed ?? ""}\u0000${this.hint ?? ""}\u0000${rollupText(clauses)}`;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		const cached = this.cache;
		if (cached && cached.width === width && cached.stamp === this.stamp) return this.lit(cached.lines);
		const lines = this.layout(width);
		this.cache = { width, stamp: this.stamp, lines };
		return this.lit(lines);
	}

	private lit(lines: string[]): string[] {
		if (this.startedAt === undefined || !WAVE) return lines;
		// Cosmetic: light that throws must not take the transcript down with it.
		try {
			const t = Math.max(0, Date.now() - this.startedAt) / 1000;
			return lines.map((line) => shadeLine(line, t, "self", { light: CALL_LIGHT }));
		} catch {
			return lines;
		}
	}

	private layout(width: number): string[] {
		const room = width - INDENT_WIDTH;
		if (this.clauses.length === 0 || room < MIN_ROOM) return [];
		const said = pieces(this.clauses, this.paints);
		if (this.elapsed) said.push({ plain: ` · ${this.elapsed}`, paint: this.paints.word });
		// The ellipsis joins the last word rather than standing as its own piece, so
		// a wrap can never leave it alone on a line of its own.
		const last = said[said.length - 1];
		if (this.live && last) said[said.length - 1] = { plain: last.plain + ELLIPSIS, paint: last.paint };
		const lines = paintWrapped(said, room);
		if (!this.live) return lines.map((line) => INDENT + line);
		// The dot belongs to the first line; a continuation carries the indent, so
		// the sentence stays in one column whatever it wraps to.
		const drawn = lines.map((line, index) => (index === 0 ? `${this.paints.dot(DOT)} ${line}` : INDENT + line));
		// One line, clipped, exactly as a row's gutter draws a running command's tail:
		// a gutter that could wrap would make the block's height a function of the
		// output it is quoting.
		if (this.hint === undefined || width <= GUTTER_WIDTH) return drawn;
		drawn.push(this.paints.gutter(GUTTER) + this.paints.hint(clip(this.hint, width - GUTTER_WIDTH)));
		return drawn;
	}
}

/**
 * Muted throughout, with the count bold in the same muted colour.
 *
 * The result line puts its count in `text` because it is the answer you asked
 * for. A rollup is a receipt for work you have stopped caring about, so it is
 * quieter than everything around it and the bold is only there to let a number
 * be found without reading the sentence.
 *
 * The dot is dim, which is what every running row's dot is: the line is
 * standing in for calls that have not come back, so it says what they would
 * have said.
 */
export function rollupPaints(theme: Theme): RollupPaints {
	const word: Paint = (text) => theme.fg("muted", text);
	return {
		word,
		count: (text) => theme.bold(word(text)),
		dot: (text) => theme.fg("dim", text),
		// The colours a row's own gutter uses, because that is what this line is
		// standing in for.
		gutter: (text) => theme.fg("dim", text),
		hint: (text) => theme.fg("toolOutput", text),
	};
}
