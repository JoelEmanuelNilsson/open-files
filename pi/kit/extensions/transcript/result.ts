/**
 * The second line of a tool row, and the body under it when there is one.
 *
 *     ● Read(lib/split-diff.ts)
 *       ⎿  Read 412 lines
 *
 *     ● Bash(npm test)
 *       ⎿  > pi-kit@0.1.0 test
 *          > node test/run.mjs
 *          suite
 *          … +37 lines (ctrl+o to expand)
 *
 *     ● Bash(cat nope.ts)
 *       ⎿  cat: nope.ts: No such file or directory
 *          Command exited with code 1
 *
 * A fixed five-column gutter, `"  ⎿  "`, then what came back. The gutter is the
 * whole visual hierarchy: everything indented past it belongs to the call above
 * it, so a diff, an error, or a page of output never floats.
 *
 * Every settled call gets this line. That is the readability win, and it is why
 * the row reads as a receipt rather than a label. The number in it is bold and
 * the unit is not, which is the same grammar everywhere: `Read 412 lines`,
 * `Found 7 matches`, `Listed 31 entries`.
 *
 * A call with no honest count shows its own output instead. Which end of that
 * output depends on whether the call is still going, and both ends come out of
 * the one primitive, `outputPreview`:
 *
 * - **Running: the tail.** The last line is where the command has got to, and a
 *   row that showed the first three lines of a build would freeze on its banner
 *   for two minutes. A tail is the only honest live progress.
 * - **Settled: the head.** The answer starts at the top — the first error, the
 *   first row of a table, the thing the command was run to say — and the last
 *   line of a finished command is usually a blank or a summary you already know
 *   from the exit code. Claude Code's `MAX_LINES_TO_SHOW` is the same three
 *   lines with the same `… +N lines (ctrl+o to expand)` under them.
 */

import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { clip, type Paint, type Piece, paintClipped, paintPieces, wrap } from "./line.ts";
import type { Hint } from "./row.ts";
import { type Summary, stripNotice, summaryText } from "./summary.ts";

/** Five columns, U+23BF, then the body. Claude Code's gutter, to the cell. */
export const GUTTER = "  ⎿  ";
export const GUTTER_WIDTH = 5;
export const INDENT = " ".repeat(GUTTER_WIDTH);
/** Trailing lines of a failed call shown while the row is collapsed. */
export const ERROR_LINES = 12;
/**
 * Lines of its own output a settled call shows before the rest is behind a key.
 *
 * Claude Code's `MAX_LINES_TO_SHOW`, at the same three. Three is one more than
 * a header and far less than a screen: enough to see what a command answered,
 * short enough that ten calls in a turn still fit above the editor.
 */
export const PREVIEW_LINES = 3;
/** Columns of body worth showing before the gutter is not worth its own width. */
const MIN_BODY = 8;

/**
 * The keybinding that opens a collapsed tool row, spelled the way it is bound.
 *
 * Read from pi's own registry rather than written down, so a rebound
 * `app.tools.expand` renames every hint in the transcript with it. When there
 * is no registry to ask — a bare render context in a test, a keybinding the
 * user unbound entirely — the hint says nothing rather than naming a key that
 * does nothing.
 */
export function expandKeyText(): string {
	try {
		// The id is spelled out, not cast: pi's own `Keybindings` type is what says
		// this one exists, so renaming it upstream is a compile error here.
		return keyText("app.tools.expand") || "";
	} catch {
		return "";
	}
}

/** `… +37 lines (ctrl+o to expand)`, or the count alone where no key is bound. */
export function moreLinesHint(hidden: number, key = expandKeyText()): string {
	const count = `… +${hidden} line${hidden === 1 ? "" : "s"}`;
	return key ? `${count} (${key} to expand)` : count;
}

/** A command's output with pi's notice off and the blank lines at either end gone. */
export function outputLines(text: string): string[] {
	const all = stripNotice(text).split("\n");
	let last = all.length - 1;
	while (last >= 0 && (all[last] ?? "").trim() === "") last--;
	let first = 0;
	while (first <= last && (all[first] ?? "").trim() === "") first++;
	return all.slice(first, last + 1).map((line) => line.trimEnd());
}

/**
 * The few lines of a command's output a collapsed row shows, and how many are
 * below them.
 *
 * One primitive for both ends of the receipt: `"head"` is what a settled row
 * shows, `"tail"` is what a running one shows.
 *
 * Blank lines never take one of the few rows on offer — three lines of a build
 * log spent on the paragraph break before the error is three lines saying
 * nothing — but they are still counted in what is left, so `+N lines` is the
 * number of lines below the last one on screen and not an estimate.
 */
export function outputPreview(text: string, limit: number, from: "head" | "tail" = "head"): { lines: string[]; hidden: number } {
	const body = outputLines(text);
	const order = from === "head" ? body.map((_, index) => index) : body.map((_, index) => body.length - 1 - index);
	const taken: number[] = [];
	for (const index of order) {
		if (taken.length >= limit) break;
		if ((body[index] ?? "").trim() === "") continue;
		taken.push(index);
	}
	if (taken.length === 0) return { lines: [], hidden: 0 };
	const edge = taken[taken.length - 1] ?? 0;
	const lines = from === "head" ? body.slice(0, edge + 1) : body.slice(edge);
	return { lines: lines.filter((line) => line.trim() !== ""), hidden: from === "head" ? body.length - edge - 1 : edge };
}

export interface ResultFields {
	/** The counted line, when the tool has a contract to count against. */
	summary: Summary | null;
	/** Shown instead of a summary while the call runs: the last line printed. */
	tail?: string;
	/**
	 * Shown instead of a summary once the call settles: the head of its output.
	 *
	 * Already cut to `PREVIEW_LINES` by the caller, or the whole output when the
	 * row is expanded — the row draws what it is handed and counts nothing.
	 */
	preview?: string[];
	/** A dim aside after the tail, for a row that can still be acted on. */
	note?: string;
	/** Lines of output the head line or the preview is not showing. */
	hidden?: number;
	/** The whole output, indented under the gutter. Failures and `ctrl+o`. */
	body?: string[];
	error: boolean;
	/** `· 2.4s`, already formatted, or null under the floor. */
	duration: string | null;
	expanded: boolean;
}

export interface ResultPaints {
	gutter: Paint;
	lead: Paint;
	count: Paint;
	note: Paint;
	warning: Paint;
	output: Paint;
	error: Paint;
	dim: Paint;
}

function summaryPieces(summary: Summary, paints: ResultPaints): Piece[] {
	if (summary.kind === "note") {
		return [{ plain: summary.text, paint: summary.tone === "warning" ? paints.warning : paints.note }];
	}
	const unit = summary.count === 1 ? summary.unit : summary.units;
	return [
		{ plain: `${summary.lead} `, paint: paints.lead },
		{ plain: `${summary.count}${summary.partial ? "+" : ""}`, paint: paints.count },
		{ plain: ` ${unit}`, paint: paints.lead },
	];
}

/**
 * Laid out at render time for the same reason the header is: `renderResult` is
 * handed no width. Cached on a stamp of the fields so a settled row costs one
 * array lookup per frame.
 */
export class ResultRow implements Component {
	private fields: ResultFields = { summary: null, error: false, duration: null, expanded: false };
	private paints: ResultPaints = blankPaints();
	/** `… +37 lines (ctrl+o to expand)`, resolved here so a rebound key restamps the row. */
	private footer = "";
	private stamp = "";
	private cache: { width: number; stamp: string; lines: string[] } | undefined;

	set(fields: ResultFields, paints: ResultPaints): void {
		this.fields = fields;
		this.paints = paints;
		const hidden = fields.hidden ?? 0;
		this.footer = fields.preview && fields.preview.length > 0 && hidden > 0 ? moreLinesHint(hidden) : "";
		this.stamp = [
			fields.summary ? summaryText(fields.summary) : "",
			fields.summary?.kind === "note" ? fields.summary.tone : "",
			fields.tail ?? "",
			fields.preview?.join("\n") ?? "",
			this.footer,
			fields.note ?? "",
			fields.hidden ?? 0,
			// The body is stamped by its length rather than its text: a settled result
			// never changes, and joining half a megabyte of file on every update to
			// prove it costs more than the layout it is guarding.
			fields.body?.length ?? 0,
			fields.error,
			fields.duration ?? "",
			fields.expanded,
		].join("\u0000");
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		const cached = this.cache;
		if (cached && cached.width === width && cached.stamp === this.stamp) return cached.lines;
		const lines = this.layout(width);
		this.cache = { width, stamp: this.stamp, lines };
		return lines;
	}

	private layout(width: number): string[] {
		if (width < GUTTER_WIDTH + MIN_BODY) return [];
		const room = width - GUTTER_WIDTH;
		const head = this.head(room);
		const body = this.body(room);
		if (head.length === 0 && body.length === 0) return [];
		const lines: string[] = [];
		const [first, ...rest] = head;
		if (first !== undefined) lines.push(this.paints.gutter(GUTTER) + first);
		// Everything after the first line sits under the gutter, preview rows and
		// wrapped continuations alike: what is indented past those five columns
		// belongs to the call above it.
		for (const line of rest) lines.push(INDENT + line);
		for (const line of body) lines.push(INDENT + line);
		return lines;
	}

	/**
	 * What sits beside the gutter, and under it: a count, a tail, a head preview
	 * of the output, or the first line of a failure.
	 *
	 * The `+N lines` annotation lives on the first line, because that is the line
	 * the gutter points at. The duration joins it there unless the row has a
	 * footer of its own: our dim `… +N lines` line is the row's annotation, so a
	 * clock belongs on it rather than clipped onto the end of borrowed output.
	 * A preview with nothing hidden has no footer, so there the clock stays put.
	 */
	private head(room: number): string[] {
		const { summary, tail, preview, note, hidden, duration, error, expanded } = this.fields;
		const paints = this.paints;
		const pieces: Piece[] = [];
		let under: string[] = [];
		if (error) {
			const first = this.errorLines()[0];
			if (first !== undefined) pieces.push({ plain: first, paint: paints.error });
		} else if (summary) {
			pieces.push(...summaryPieces(summary, paints));
		} else if (preview && preview.length > 0) {
			// Collapsed, each preview line keeps exactly one row: three lines of
			// output must not become twelve because the pane is narrow. Expanded is
			// the mode that asked for all of it, so there it wraps.
			const rows = expanded ? preview.flatMap((line) => wrap(line, room)) : preview;
			pieces.push({ plain: rows[0] ?? "", paint: paints.output });
			under = rows.slice(1).map((line) => paints.output(clip(line, room)));
		} else if (tail) {
			pieces.push({ plain: tail, paint: paints.output });
		}
		const clockOnFooter = this.footer !== "" && duration !== null;
		if (this.footer) under.push(paints.dim(clip(clockOnFooter ? `${this.footer} · ${duration}` : this.footer, room)));
		// A note stands alone when the row has nothing else to say yet: a command
		// that has printed nothing is still one that can be backgrounded.
		if (pieces.length === 0 && note) return [paintPieces([{ plain: note, paint: paints.dim }])];
		if (pieces.length === 0) return [];

		const suffix: Piece[] = [];
		// A preview counts what it is hiding in its own footer, so the head line
		// would say it twice.
		if (!error && !preview && hidden && hidden > 0) {
			suffix.push({ plain: `  +${hidden} line${hidden === 1 ? "" : "s"}`, paint: paints.dim });
		}
		if (duration && !clockOnFooter) suffix.push({ plain: ` · ${duration}`, paint: paints.dim });

		// The suffix is an annotation, so it only keeps its columns while the line it
		// annotates keeps half the row. On a narrow pane the duration goes and the
		// answer stays. The note is the first thing to go: the count and the
		// duration are facts about the command, the note is an offer.
		const fits = (candidate: Piece[]): number => {
			const width = candidate.reduce((total, piece) => total + visibleWidth(piece.plain), 0);
			return width > 0 && room - width >= Math.max(MIN_BODY, room / 2) ? width : 0;
		};
		const withNote = note ? [...suffix, { plain: ` · ${note}`, paint: paints.dim }] : suffix;
		const chosen = fits(withNote) > 0 ? withNote : fits(suffix) > 0 ? suffix : [];
		const width = fits(chosen);
		const first = paintClipped(pieces, width > 0 ? room - width : room) + (width > 0 ? paintPieces(chosen) : "");
		return [first, ...under];
	}

	/**
	 * Everything under the head line that the head did not draw: a failure's
	 * tail, or the whole output of a counted call once `ctrl+o` asks for it.
	 *
	 * A row showing a preview is already showing its output, so it has no body:
	 * expanding widens the preview instead of printing the same text twice.
	 */
	private body(room: number): string[] {
		const { error, expanded, body, preview } = this.fields;
		if (error) return this.errorLines().slice(1).flatMap((line) => wrap(line, room)).map(this.paints.error);
		if (!expanded || !body || preview) return [];
		return body.flatMap((line) => wrap(line, room)).map(this.paints.output);
	}

	/**
	 * A failure's text, blank lines dropped and the head elided rather than the
	 * tail: a stack trace ends with the reason, and the reason is what you looked
	 * for. The cap counts the tool's own lines, not the rows they wrap onto, so a
	 * narrow pane does not start hiding two-line errors.
	 */
	private errorLines(): string[] {
		const source = (this.fields.body ?? []).filter((line) => line.trim() !== "");
		if (this.fields.expanded || source.length <= ERROR_LINES) return source;
		const hidden = source.length - ERROR_LINES;
		return [`… ${hidden} earlier line${hidden === 1 ? "" : "s"}`, ...source.slice(-ERROR_LINES)];
	}
}

function blankPaints(): ResultPaints {
	const same: Paint = (text) => text;
	return { gutter: same, lead: same, count: same, note: same, warning: same, output: same, error: same, dim: same };
}

export function resultPaints(theme: Theme): ResultPaints {
	return {
		gutter: (text) => theme.fg("dim", text),
		lead: (text) => theme.fg("muted", text),
		count: (text) => theme.bold(theme.fg("text", text)),
		note: (text) => theme.fg("muted", text),
		warning: (text) => theme.fg("warning", text),
		output: (text) => theme.fg("toolOutput", text),
		error: (text) => theme.fg("error", text),
		dim: (text) => theme.fg("dim", text),
	};
}

/**
 * The last line a command printed, which is the line a running command's tail
 * shows.
 *
 * `outputPreview` from the tail end, at one line: the same primitive the
 * settled receipt reads from the head, so the two ends can never drift into
 * two different ideas of what a line of output is.
 *
 * What it says is only *derived* here. How long it stays is `heldHint`'s, in
 * `row.ts`, because that is a fact about the row rather than about the text.
 */
export function lastLine(text: string): Hint {
	const { lines, hidden } = outputPreview(text, 1, "tail");
	return { line: lines[0] ?? "", hidden };
}

/**
 * Puts a component's first line beside the gutter and the rest under it.
 *
 * `edit` draws its own body, and a diff floating at column zero under a header
 * at column two reads as two separate things. This costs five columns of body
 * and buys the hierarchy the gutter exists for, without the tool having to know
 * what a receipt looks like.
 */
export class Gutter implements Component {
	private readonly inner: Component;
	private readonly paint: Paint;
	private readonly head: boolean;

	// Fields rather than parameter properties: node's own TypeScript loader
	// strips types without transforming, and the suite imports this file that way.
	constructor(inner: Component, paint: Paint = (text) => text, head = true) {
		this.inner = inner;
		this.paint = paint;
		this.head = head;
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		if (width <= GUTTER_WIDTH + MIN_BODY) return this.inner.render(width);
		const lines = this.inner.render(width - GUTTER_WIDTH);
		const gutter = this.paint(GUTTER);
		return lines.map((line, index) => (this.head && index === 0 ? gutter : INDENT) + line);
	}
}

/** The same, with every line under the gutter rather than the first beside it. */
export function indented(inner: Component): Component {
	return new Gutter(inner, undefined, false);
}
