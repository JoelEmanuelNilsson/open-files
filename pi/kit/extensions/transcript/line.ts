/**
 * The text operations every row in this extension needs, and nothing else.
 *
 * `clip` enforces the one-line invariant: a tool header is exactly one line at
 * every pane width, so the argument is cut rather than wrapped. Which end goes
 * depends on which half identifies the call — the tail of a path, the head of a
 * command — and `describe.ts` decides that per tool.
 *
 * `wrap` is for the one place a row is allowed to grow: the body of a failed
 * call, where the text is the reason you looked.
 *
 * `paintClipped` is how a line made of differently coloured runs still obeys
 * the width it was handed: the colour is carried beside the plain text rather
 * than baked into it, so the arithmetic is done on what the terminal will
 * actually show. Every counted line in the transcript is built this way —
 * `Read 412 lines` and `Read 2 files, ran 7 shell commands` alike — because the
 * bold number in the middle is the whole reason those lines scan.
 *
 * All of it is pure and takes plain text, so `test/transcript.mjs` can hold it
 * to the TUI's one hard contract: no line is ever wider than the width it was
 * handed.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export type Paint = (text: string) => string;

/** The one-character ellipsis. A three-dot `...` spends two columns saying it once. */
const ELLIPSIS = "…";

/**
 * Cuts `text` to `width` columns, dropping the given end.
 *
 * `clip: "tail"` keeps the head of the string, which is what you want for a
 * command. `clip: "head"` keeps the last `width - 1` columns, which is what you
 * want for a path: the filename survives.
 */
export function clip(text: string, width: number, end: "head" | "tail" = "tail"): string {
	if (width <= 0) return "";
	const shown = visibleWidth(text);
	if (shown <= width) return text;
	if (width === 1) return ELLIPSIS;
	const keep = width - 1;
	if (end === "tail") return sliceByColumn(text, 0, keep, true) + ELLIPSIS;
	return ELLIPSIS + sliceByColumn(text, shown - keep, keep, true);
}

/** A run of text and the colour it is drawn in. The text is plain, so it can be measured. */
export interface Piece {
	plain: string;
	paint: Paint;
}

/** Paints a run of segments, clipping the whole run to `width` columns. */
export function paintClipped(pieces: readonly Piece[], width: number): string {
	let used = 0;
	const out: string[] = [];
	for (const piece of pieces) {
		const room = width - used;
		if (room <= 0) break;
		const shown = clip(piece.plain, room);
		out.push(piece.paint(shown));
		used += visibleWidth(shown);
	}
	return out.join("");
}

/** The same, for a run already known to fit. */
export function paintPieces(pieces: readonly Piece[]): string {
	return pieces.map((piece) => piece.paint(piece.plain)).join("");
}

/**
 * Paints a run of segments, wrapping it to `width` columns.
 *
 * For the one line in the transcript that is a sentence rather than a header:
 * a rollup counts several tools, and clipping it drops the last clause, which
 * is the one thing on it you cannot infer. Claude Code wraps this line and
 * clips nothing, and a receipt that has to be guessed at is not a receipt.
 *
 * Words are never split across pieces, so the bold count never lands half in
 * one colour: a piece is broken only when a single word is wider than the whole
 * column.
 */
export function paintWrapped(pieces: readonly Piece[], width: number): string[] {
	if (width < 1) return [];
	const lines: string[] = [];
	let line: string[] = [];
	let used = 0;
	// A space is only drawn once something follows it on the same line, so no
	// line ends in one and no wrap doubles one. Held painted, because the space
	// between two clauses belongs to the piece that offered it.
	let gap: string | undefined;
	const flush = () => {
		if (line.length > 0) lines.push(line.join(""));
		line = [];
		used = 0;
		gap = undefined;
	};
	for (const piece of pieces) {
		for (const token of piece.plain.split(/(\s+)/)) {
			if (token === "") continue;
			if (/^\s+$/.test(token)) {
				if (used > 0) gap = piece.paint(" ");
				continue;
			}
			let word = token;
			// A word wider than the whole column is broken at the column, which is
			// the only place a piece is ever cut mid-word.
			while (visibleWidth(word) > width) {
				flush();
				const head = sliceByColumn(word, 0, width, true);
				lines.push(piece.paint(head));
				word = sliceByColumn(word, visibleWidth(head), visibleWidth(word) - visibleWidth(head));
			}
			const shown = visibleWidth(word);
			if (used > 0 && used + (gap ? 1 : 0) + shown > width) flush();
			if (gap && used > 0) {
				line.push(gap);
				used += 1;
			}
			gap = undefined;
			line.push(piece.paint(word));
			used += shown;
		}
	}
	flush();
	return lines;
}

/** Word wrap with a hard break for tokens longer than the width. Input is plain text. */
export function wrap(text: string, width: number): string[] {
	if (width < 1) return [text];
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			let token = word;
			// A single token wider than the column (a long path, a base64 blob) is
			// broken at the column rather than allowed to overflow it.
			while (visibleWidth(token) > width) {
				if (line) {
					out.push(line);
					line = "";
				}
				out.push(sliceByColumn(token, 0, width, true));
				token = sliceByColumn(token, width, visibleWidth(token) - width);
			}
			if (!line) {
				line = token;
			} else if (visibleWidth(line) + 1 + visibleWidth(token) <= width) {
				line += ` ${token}`;
			} else {
				out.push(line);
				line = token;
			}
		}
		out.push(line);
	}
	return out.length > 0 ? out : [""];
}
