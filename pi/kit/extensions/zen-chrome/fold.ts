import { fit, type Paint, paintPieces, type Piece, piecesWidth, type RuleEnds } from "../../lib/ui/labelled-rule.ts";

/** What the editor drew this frame, reduced to the facts that decide whether the prompt box folds. */
export interface PromptShape {
	text: string;
	contentRows: number;
	autocompleteRows: number;
	scrolled: boolean;
}

/** Whether the idle prompt box folds: an empty buffer on one content row, with nothing hanging off it. */
export function isPromptFolded(shape: PromptShape): boolean {
	return shape.text === "" && shape.contentRows === 1 && shape.autocompleteRows === 0 && !shape.scrolled;
}

export interface FoldLabels {
	side: Piece[];
	path: Piece[];
	session: Piece[];
	branch: Piece[];
	model: Piece[];
	timer: Piece[];
	tasks: Piece[];
	cache: Piece[];
	context: Piece[];
}

export const FOLD_ENDS: RuleEnds = { left: "╶", right: "╴" };

const DASH = "─";
const MIN_GAP = 2;
const HEAD = 3;
const TAIL = 3;
const MAX_ROWS = 2;

function trimSlot(pieces: Piece[]): Piece[] {
	const last = pieces.at(-1);
	if (last === undefined) return pieces;
	const text = last.text.trimEnd();
	const kept = pieces.slice(0, -1);
	return text === "" ? trimSlot(kept) : [...kept, { ...last, text }];
}

function gap(columns: number, dash: Paint): Piece {
	if (columns <= MIN_GAP) return { text: " ".repeat(columns), paint: dash };
	return { text: ` ${DASH.repeat(columns - 2)} `, paint: dash };
}

function joinPathBranch(path: Piece[], branch: Piece[], session: Piece[]): Piece[] {
	const [first, ...others] = branch;
	if (path.length === 0 || first === undefined) return [...path, ...branch, ...session];
	return [...path, { ...first, text: `-${first.text}`, atomic: true }, ...others, ...session];
}

function packedWidth(slots: Piece[][]): number {
	return slots.reduce((sum, slot) => sum + piecesWidth(slot), 0) + Math.max(0, slots.length - 1) * MIN_GAP;
}

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
			if (slots[next] === path && room > 0) rows.push([fit(path, room)]);
			break;
		}
		rows.push(row);
	}
	return rows.length === 0 ? [spreadRow(width, [], dash)] : rows.map((row) => spreadRow(width, row, dash));
}
