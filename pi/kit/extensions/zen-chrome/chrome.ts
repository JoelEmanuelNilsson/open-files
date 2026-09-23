/**
 * Pure layout helpers for the editor chrome.
 *
 * Nothing here touches pi state, so the whole visual language of the prompt box
 * can be exercised from `preview.ts` without booting a TUI.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { HOME_GLYPH } from "../../lib/home-glyph.ts";

/** Wraps text in terminal colour codes. */
export type Paint = (text: string) => string;

/** A run of text with its own colour. Widths are always measured before painting. */
export interface Piece {
	text: string;
	paint?: Paint;
	/**
	 * Marks this piece as all-or-nothing. Prose survives being cut short; half a
	 * duration, or half a slider, just reads as a different and wrong value.
	 */
	atomic?: boolean;
}

/**
 * The Koenigsegg ghost, let into the top rule. A blank on any terminal without
 * the font mapping, so nothing else depends on it being there.
 *
 * One column, like every other piece: `bin/build-ghost-font.py` gives the glyph
 * a one-cell advance and `visibleWidth` measures one, so nothing here may
 * declare a width of its own — a piece that claimed two would spend a column
 * the terminal never paints, and the rule would fall short of its corner.
 */
export function insignia(paint: Paint): Piece[] {
	return [{ text: HOME_GLYPH, paint, atomic: true }];
}

const DASH = "─";
const ELLIPSIS = "…";
/** A label shorter than this is noise, so it is dropped instead of truncated. */
const MIN_LABEL = 4;
/** `─ ` before a left label, ` ` after it. */
const LEFT_FRAME = 3;
/** ` ` before a right label, ` ─` after it. */
const RIGHT_FRAME = 3;
/**
 * A space each side of a middle label, plus the one dash each side that keeps it
 * inside the rule rather than welded to its neighbours.
 */
const MIDDLE_FRAME = 4;
/**
 * Dashes between a middle label and the right one, when there are that many to
 * spare. The middle label hangs off the right-hand cluster at a fixed distance
 * instead of floating in the centre: the cluster is what it belongs with, and a
 * centred label would slide sideways every time the branch name changed length.
 */
const MIDDLE_GAP = 5;
/** The two corner glyphs a rule spends before any label. */
const FRAME_COLUMNS = 2;

export function piecesWidth(pieces: Piece[]): number {
	let total = 0;
	for (const piece of pieces) total += visibleWidth(piece.text);
	return total;
}

/** Label pieces painted and concatenated, each in its own colour. */
export function paintPieces(pieces: Piece[]): string {
	let out = "";
	for (const piece of pieces) out += piece.paint ? piece.paint(piece.text) : piece.text;
	return out;
}

/**
 * Shorten a label to `max` columns, cutting inside whichever piece overflows and
 * dropping the rest. Returns `[]` when the result would be too short to read.
 *
 * Atomicity is per piece, not per label: an atomic piece that no longer fits is
 * dropped whole, along with everything after it, and the pieces before it stay.
 * That is what lets `opus ▱▱▱▱▱` narrow to `opus` — a clipped slider would read
 * as a shorter scale at full effort, while the model name alone is simply less.
 * A label whose every piece is atomic is unchanged by this: the first one that
 * does not fit takes the rest with it, which is the whole label.
 */
export function fit(pieces: Piece[], max: number): Piece[] {
	if (max < MIN_LABEL) return [];
	if (piecesWidth(pieces) <= max) return pieces;

	const kept: Piece[] = [];
	let used = 0;
	for (const piece of pieces) {
		const cost = visibleWidth(piece.text);
		if (used + cost <= max) {
			kept.push(piece);
			used += cost;
			continue;
		}
		const remaining = max - used;
		if (!piece.atomic && remaining >= MIN_LABEL)
			kept.push({ ...piece, text: truncateToWidth(piece.text, remaining, ELLIPSIS) });
		break;
	}
	return piecesWidth(kept) >= MIN_LABEL ? kept : [];
}

/** The corner glyphs that cap a rule. */
export interface RuleEnds {
	left: string;
	right: string;
}

export const TOP_ENDS: RuleEnds = { left: "╭", right: "╮" };
export const BOTTOM_ENDS: RuleEnds = { left: "╰", right: "╯" };
/** Left and right edge of a content row. */
export const SIDE = "│";

/**
 * A horizontal rule with labels let into it, capped by rounded corners:
 *
 *     ╭─ ~/code/pi ─────────────────────── claude-opus-5 ▱▱▱▱▱ ─╮
 *
 * When both labels cannot fit, the right one wins and the left is truncated,
 * because the right carries live state (the model, the turn timer) while the
 * left is orientation the user mostly already knows.
 *
 * An optional `middle` label is let into the dashes between them, all or
 * nothing: one that does not fit whole is dropped, and the rule is drawn as if
 * it had never been passed one.
 *
 * An optional `scroll` label (see `scrollIndicator`) ranks below every other
 * label: it only takes dashes the labels leave free, never displaces one, and
 * is dropped when those dashes cannot hold it whole.
 */
export function rule(
	width: number,
	left: Piece[],
	right: Piece[],
	dash: Paint,
	ends: RuleEnds,
	middle: Piece[] = [],
	scroll: Piece[] = [],
): string {
	if (width <= 0) return "";
	if (width < 4)
		return dash(width < 2 ? DASH.repeat(width) : ends.left + DASH.repeat(width - FRAME_COLUMNS) + ends.right);
	return dash(ends.left) + ruleBody(width - FRAME_COLUMNS, left, middle, right, scroll, dash) + dash(ends.right);
}

/**
 * pi's `↑ 12 more` / `↓ 3 more`: how many rows of the buffer are out of view
 * past this edge, or no label when none are.
 */
export function scrollIndicator(direction: "↑" | "↓", hidden: number, paint: Paint): Piece[] {
	return hidden > 0 ? [{ text: `${direction} ${hidden} more`, paint, atomic: true }] : [];
}

/** Columns a label costs with its frame, or 0 when there is no label. */
function cost(label: Piece[], frame: number): number {
	return label.length > 0 ? frame + piecesWidth(label) : 0;
}

/** Columns a middle label costs, with its two spaces and its two minimum dashes. */
function middleCost(middle: Piece[]): number {
	return middle.length > 0 ? MIDDLE_FRAME + piecesWidth(middle) : 0;
}

/** Whether every label fits whole inside a rule body of `body` columns, with a dash to spare. */
function fitsWhole(body: number, left: Piece[], middle: Piece[], right: Piece[]): boolean {
	// With no middle label the rule still owes itself one dash; with one, the two
	// dashes either side of it are already counted in MIDDLE_FRAME.
	const loneDash = middle.length > 0 ? 0 : 1;
	return cost(left, LEFT_FRAME) + middleCost(middle) + cost(right, RIGHT_FRAME) + loneDash <= body;
}

/** The labels the bottom rule carries, the readings named in the order they are given up. */
export interface BottomLabels {
	/** Git branch, on the left. */
	branch: Piece[];
	/** Background agents still running: `2 tasks ↓`, let into the dashes. */
	tasks: Piece[];
	/** How long the current turn has been running. */
	timer: Piece[];
	/** The prompt-cache window: `❄4m` while warm, a bare `❄` once cold. */
	cache: Piece[];
	/** The context reading, `31.4k`, which is the last label standing. */
	context: Piece[];
	/** `↓ 3 more` while buffer rows are out of view below the box; it only ever takes free dashes. */
	scroll: Piece[];
}

/**
 * The bottom rule: the branch on the left, the background-task count let into
 * the dashes, then the turn timer, the cache window and the context reading on
 * the right.
 *
 *     ╰─ main ──────────── 2 tasks ↓ ───── 1m 12s ❄4m 31.4k ─╯
 *
 * **Drop order as the pane narrows: cache, then timer, then tasks, then the
 * branch is squeezed, then the context reading goes and only dashes are left.**
 * A label joins only when everything ahead of it already fits whole, so nothing
 * here is ever half a reading — a clipped duration or a truncated `2 ta…` says
 * less than nothing.
 *
 * That inverts `rule`'s usual right-beats-left precedence, deliberately. The
 * cache window goes first: it is a curiosity about the next request, not this
 * one. The timer is next, the least earned label about the turn itself. The
 * task count outranks it, and outranks squeezing the branch, because an agent
 * still running is work in flight rather than a fact about waiting. The context
 * reading outlives them all: it is the only thing on screen that says
 * compaction is coming.
 */
export function bottomRule(width: number, labels: BottomLabels, dash: Paint): string {
	const body = width - FRAME_COLUMNS;
	const full = [...labels.timer, ...labels.cache, ...labels.context];
	if (labels.cache.length > 0 && fitsWhole(body, labels.branch, labels.tasks, full))
		return rule(width, labels.branch, full, dash, BOTTOM_ENDS, labels.tasks, labels.scroll);
	const timed = [...labels.timer, ...labels.context];
	if (labels.timer.length > 0 && fitsWhole(body, labels.branch, labels.tasks, timed))
		return rule(width, labels.branch, timed, dash, BOTTOM_ENDS, labels.tasks, labels.scroll);
	if (labels.tasks.length > 0 && fitsWhole(body, labels.branch, labels.tasks, labels.context))
		return rule(width, labels.branch, labels.context, dash, BOTTOM_ENDS, labels.tasks, labels.scroll);
	return rule(width, labels.branch, labels.context, dash, BOTTOM_ENDS, [], labels.scroll);
}

function ruleBody(width: number, left: Piece[], middle: Piece[], right: Piece[], scroll: Piece[], dash: Paint): string {
	const dashes = (count: number) => dash(DASH.repeat(count));
	const scrollWidth = piecesWidth(scroll) + 2;
	/**
	 * `count` dashes from body column `start`, with the scroll label let in when
	 * it fits whole with a dash either side: centred on the rule, as pi draws it,
	 * or pushed along the run as far as its labels allow.
	 */
	const run = (start: number, count: number) => {
		if (scroll.length === 0 || scrollWidth + 2 > count) return dashes(count);
		const centred = Math.floor((width - scrollWidth) / 2);
		const at = Math.min(Math.max(centred, start + 1), start + count - 1 - scrollWidth);
		return dashes(at - start) + ` ${paintPieces(scroll)} ` + dashes(start + count - at - scrollWidth);
	};
	/** `gap` is every column between the two labels; a middle label sits inside it. */
	const render = (leftLabel: Piece[], rightLabel: Piece[], gap: number, middleLabel: Piece[] = []) => {
		const headWidth = cost(leftLabel, LEFT_FRAME);
		const head = leftLabel.length > 0 ? `${dashes(1)} ${paintPieces(leftLabel)} ` : "";
		const tail = rightLabel.length > 0 ? ` ${paintPieces(rightLabel)} ${dashes(1)}` : "";
		if (middleLabel.length === 0) return head + run(headWidth, gap) + tail;
		const free = gap - piecesWidth(middleLabel) - 2;
		const rightGap = Math.max(1, Math.min(MIDDLE_GAP, free - 1));
		return head + run(headWidth, free - rightGap) + ` ${paintPieces(middleLabel)} ` + dashes(rightGap) + tail;
	};

	let leftLabel = left;
	let rightLabel = right;
	let leftCost = cost(leftLabel, LEFT_FRAME);
	let rightCost = cost(rightLabel, RIGHT_FRAME);

	// Both labels whole, with the middle one let in when it fits too — it is all
	// or nothing, and the first thing dropped when the rule cannot hold it.
	if (fitsWhole(width, leftLabel, middle, rightLabel))
		return render(leftLabel, rightLabel, width - leftCost - rightCost, middle);
	if (fitsWhole(width, leftLabel, [], rightLabel))
		return render(leftLabel, rightLabel, width - leftCost - rightCost);

	// Squeeze the left label into whatever the right one leaves behind.
	leftLabel = fit(leftLabel, width - rightCost - 1 - LEFT_FRAME);
	leftCost = cost(leftLabel, LEFT_FRAME);
	if (leftCost + rightCost + 1 <= width) return render(leftLabel, rightLabel, width - leftCost - rightCost);

	// Still too tight: the right label alone, truncated if it has to be.
	rightLabel = fit(rightLabel, width - RIGHT_FRAME - 1);
	rightCost = cost(rightLabel, RIGHT_FRAME);
	if (rightCost > 0 && rightCost + 1 <= width) return render([], rightLabel, width - rightCost);

	return run(0, width);
}

/** `true` when a rendered line is an undecorated full-width rule we may overwrite. */
export function isPlainRule(line: string, width: number): boolean {
	if (line.length === 0) return false;
	const bare = stripAnsi(line);
	return bare.length === width && /^─+$/.test(bare);
}

export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface ContextReading {
	/** `31.4k`, or `?` right after a compaction, before the next response reveals the new count. */
	label: string;
	/** Severity of the current fill, for colour selection. */
	level: "normal" | "warning" | "critical";
}

/** `31400` → `31.4k`. Tokens, not percent: the figure that means something on its own. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

/**
 * How full the context is, shown as tokens used. `percent` still sets the
 * colour — it is the distance to compaction — but the label is the count,
 * since that is the number you act on. Both are null right after a compaction.
 */
export function contextReading(tokens: number | null, percent: number | null): ContextReading {
	return {
		label: tokens === null ? "?" : formatTokens(tokens),
		level: percent === null ? "normal" : percent > 90 ? "critical" : percent > 70 ? "warning" : "normal",
	};
}

/** `/Users/joel/code/pi` → `{ghost}/code/pi`, leaving paths outside home alone. */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home || home.length === 0) return cwd;
	if (cwd === home) return HOME_GLYPH;
	const prefix = home.endsWith("/") ? home : `${home}/`;
	return cwd.startsWith(prefix) ? `${HOME_GLYPH}/${cwd.slice(prefix.length)}` : cwd;
}
