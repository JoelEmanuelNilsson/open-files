import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Wraps text in terminal colour codes. */
export type Paint = (text: string) => string;

/** A run of text with its own colour. Widths are always measured before painting. */
export interface Piece {
	text: string;
	paint?: Paint;
	atomic?: boolean;
}

const DASH = "─";
const ELLIPSIS = "…";
const MIN_LABEL = 4;
const LEFT_FRAME = 3;
const RIGHT_FRAME = 3;
const MIDDLE_FRAME = 4;
const MIDDLE_GAP = 5;
/** The two corner glyphs a rule spends before any label. */
export const RULE_CORNER_COLUMNS = 2;

/** Columns a label takes on screen, measured the way the TUI measures them. */
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
		return dash(width < 2 ? DASH.repeat(width) : ends.left + DASH.repeat(width - RULE_CORNER_COLUMNS) + ends.right);
	return dash(ends.left) + ruleBody(width - RULE_CORNER_COLUMNS, left, middle, right, scroll, dash) + dash(ends.right);
}

export function scrollIndicator(direction: "↑" | "↓", hidden: number, paint: Paint): Piece[] {
	return hidden > 0 ? [{ text: `${direction} ${hidden} more`, paint, atomic: true }] : [];
}

function cost(label: Piece[], frame: number): number {
	return label.length > 0 ? frame + piecesWidth(label) : 0;
}

function middleCost(middle: Piece[]): number {
	return middle.length > 0 ? MIDDLE_FRAME + piecesWidth(middle) : 0;
}

/** Whether every label fits whole inside a rule body of `body` columns, with a dash to spare. */
export function ruleFitsWhole(body: number, left: Piece[], middle: Piece[], right: Piece[]): boolean {
	const loneDash = middle.length > 0 ? 0 : 1;
	return cost(left, LEFT_FRAME) + middleCost(middle) + cost(right, RIGHT_FRAME) + loneDash <= body;
}

function ruleBody(width: number, left: Piece[], middle: Piece[], right: Piece[], scroll: Piece[], dash: Paint): string {
	const dashes = (count: number) => dash(DASH.repeat(count));
	const scrollWidth = piecesWidth(scroll) + 2;
	const run = (start: number, count: number) => {
		if (scroll.length === 0 || scrollWidth + 2 > count) return dashes(count);
		const centred = Math.floor((width - scrollWidth) / 2);
		const at = Math.min(Math.max(centred, start + 1), start + count - 1 - scrollWidth);
		return dashes(at - start) + ` ${paintPieces(scroll)} ` + dashes(start + count - at - scrollWidth);
	};
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

	if (ruleFitsWhole(width, leftLabel, middle, rightLabel))
		return render(leftLabel, rightLabel, width - leftCost - rightCost, middle);
	if (ruleFitsWhole(width, leftLabel, [], rightLabel))
		return render(leftLabel, rightLabel, width - leftCost - rightCost);

	leftLabel = fit(leftLabel, width - rightCost - 1 - LEFT_FRAME);
	leftCost = cost(leftLabel, LEFT_FRAME);
	if (leftCost + rightCost + 1 <= width) return render(leftLabel, rightLabel, width - leftCost - rightCost);

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

/** The text with its SGR colour escapes removed. */
export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
