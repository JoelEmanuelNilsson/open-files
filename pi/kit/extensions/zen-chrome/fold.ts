/**
 * The folded prompt box: what the idle, empty prompt collapses to.
 *
 * Pure, like chrome.ts, so the decision and the row layout are exercised by
 * the kit tests and by `preview.ts` without booting a TUI.
 */

import { fit, type Paint, paintPieces, type Piece, piecesWidth, type RuleEnds } from "./chrome.ts";

/** What the editor drew this frame, reduced to the facts that decide whether the prompt box folds. */
export interface PromptShape {
	/** The editor buffer. Any text at all, whitespace included, unfolds the box. */
	text: string;
	/** Rows between the top and bottom edge. */
	contentRows: number;
	/** Autocomplete rows hanging below the bottom edge. */
	autocompleteRows: number;
	/** Whether buffer rows are scrolled out of view above or below the box. */
	scrolled: boolean;
}

/** Whether the idle prompt box folds: an empty buffer on one content row, with nothing hanging off it. */
export function isPromptFolded(shape: PromptShape): boolean {
	return shape.text === "" && shape.contentRows === 1 && shape.autocompleteRows === 0 && !shape.scrolled;
}

/**
 * The readings the fold packs in, highest priority first — the order they are
 * given space in, and the order they are drawn left to right.
 */
export interface FoldLabels {
	/** `[SIDE]` while side mode is on, drawn before the cwd in the path's slot so it is never dropped. */
	side: Piece[];
	/** The cwd, which is shortened rather than dropped, and only when it alone does not fit a row. */
	path: Piece[];
	/** ` • name` after the cwd when the session is named; part of the path's slot. */
	session: Piece[];
	/** The git branch, joined to the cwd as `~/code-main`. */
	branch: Piece[];
	/** The model and its effort slider. */
	model: Piece[];
	/** The turn timer: how long the running turn has run, or the last one ran. */
	timer: Piece[];
	/** The background-task count, with the longest-running agent's elapsed time. */
	tasks: Piece[];
	/** The prompt-cache window. */
	cache: Piece[];
	/** The context reading. */
	context: Piece[];
}

/**
 * Half-dashes cap each folded row. A row has no sides for a corner to turn
 * into, so the rule simply stops, in the same light line weight as `─`.
 */
export const FOLD_ENDS: RuleEnds = { left: "╶", right: "╴" };

const DASH = "─";
/** The narrowest gap between two readings: two blank columns, no rule. */
const MIN_GAP = 2;
/** `╶─ ` before the readings. */
const HEAD = 3;
/** ` ─╴` after them: a space, at least one dash, the end. */
const TAIL = 3;
/** The most rows the folded box takes; past this the lowest-priority readings drop. */
const MAX_ROWS = 2;

/** A slot's pieces with the trailing space the bottom rule's labels own dropped, since the fold spaces its own. */
function trimSlot(pieces: Piece[]): Piece[] {
	const last = pieces.at(-1);
	if (last === undefined) return pieces;
	const text = last.text.trimEnd();
	const kept = pieces.slice(0, -1);
	return text === "" ? trimSlot(kept) : [...kept, { ...last, text }];
}

/**
 * The gap between two readings, `columns` wide: a rule between two spaces,
 * which narrows to two bare spaces once the rule has no columns left.
 */
function gap(columns: number, dash: Paint): Piece {
	if (columns <= MIN_GAP) return { text: " ".repeat(columns), paint: dash };
	return { text: ` ${DASH.repeat(columns - 2)} `, paint: dash };
}

/**
 * The cwd and branch as one reading, `~/code-main`, then the session name.
 * The dash rides on the branch, atomic, so a shortened path loses `-main`
 * whole rather than leaving a dangling dash or a clipped branch.
 */
function joinPathBranch(path: Piece[], branch: Piece[], session: Piece[]): Piece[] {
	const [first, ...others] = branch;
	if (path.length === 0 || first === undefined) return [...path, ...branch, ...session];
	return [...path, { ...first, text: `-${first.text}`, atomic: true }, ...others, ...session];
}

/** Columns `slots` take on one row with the narrowest gaps between them. */
function packedWidth(slots: Piece[][]): number {
	return slots.reduce((sum, slot) => sum + piecesWidth(slot), 0) + Math.max(0, slots.length - 1) * MIN_GAP;
}

/**
 * One folded row, exactly `width` columns, its readings spread across it: the
 * spare columns are shared evenly between the gaps, and the remainder goes to
 * the rule at the end, so every gap is as wide as every other. A lone reading
 * has no gap to widen, so the rule after it takes the columns instead.
 */
function spreadRow(width: number, slots: Piece[][], dash: Paint): string {
	if (slots.length === 0) return dash(FOLD_ENDS.left + DASH.repeat(width - 2) + FOLD_ENDS.right);
	const room = width - HEAD - TAIL;
	const gaps = slots.length - 1;
	const spare = room - packedWidth(slots);
	const shown: Piece[] = [];
	slots.forEach((slot, i) => {
		if (i > 0) shown.push(gap(MIN_GAP + Math.floor(spare / gaps), dash));
		shown.push(...slot);
	});
	const fill = width - HEAD - TAIL - piecesWidth(shown) + 1;
	return `${dash(FOLD_ENDS.left + DASH)} ${paintPieces(shown)} ${dash(DASH.repeat(fill) + FOLD_ENDS.right)}`;
}

/**
 * The folded box: one row when every reading fits, otherwise two, each row
 * exactly `width` columns wide.
 *
 *     ╶─ ~/dotfiles-main ─── opus ▱▱▱ ─── 1m 12s ─── 2 tasks ↓ 4m 10s ─── ❄4m ─── 31.4k ─╴
 *
 * The path and branch are one reading, joined by a dash, on one row or two;
 * side mode's `[SIDE]` leads that reading, so it goes wherever the path goes.
 *
 * **Priority is one fixed order: path, branch, model, timer, tasks, cache,
 * context**, which is also the left-to-right order. The rows fill in that
 * order — the first row takes readings until the next one does not fit, the
 * second row takes the rest — and when both rows are full the readings still
 * left drop, lowest priority first. So a reading never shows while one above
 * it is hidden, and widening the bar only ever adds readings.
 *
 * Every reading but the path is all or nothing; the path is shortened only
 * when it alone does not fit a row, and then it is the whole first row. The
 * cut comes from the end, so the branch goes before any of the cwd does.
 */
export function foldRows(width: number, labels: FoldLabels, dash: Paint): string[] {
	if (width <= 0) return [""];
	if (width < 2) return [dash(DASH.repeat(width))];
	const room = width - HEAD - TAIL;
	const path = trimSlot([...labels.side, ...joinPathBranch(trimSlot(labels.path), trimSlot(labels.branch), trimSlot(labels.session))]);
	const rest = [labels.model, labels.timer, labels.tasks, labels.cache, labels.context].map(trimSlot);
	const slots = [path, ...rest].filter((slot) => slot.length > 0);
	if (slots.length === 0) return [spreadRow(width, [], dash)];
	if (packedWidth(slots) <= room) return [spreadRow(width, slots, dash)];

	const rows: Piece[][][] = [];
	let next = 0;
	while (rows.length < MAX_ROWS && next < slots.length) {
		const row: Piece[][] = [];
		while (next < slots.length && packedWidth([...row, slots[next] ?? []]) <= room) row.push(slots[next++] ?? []);
		if (row.length === 0) {
			// A reading wider than a whole row ends the fold here, since what comes after it
			// ranks lower. The path is shortened to fit first; its cut loses the branch
			// before anything else, so nothing may follow it either.
			if (slots[next] === path && room > 0) rows.push([fit(path, room)]);
			break;
		}
		rows.push(row);
	}
	return rows.length === 0 ? [spreadRow(width, [], dash)] : rows.map((row) => spreadRow(width, row, dash));
}
