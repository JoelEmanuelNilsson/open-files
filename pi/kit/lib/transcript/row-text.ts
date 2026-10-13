import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Paint } from "../ui/labelled-rule.ts";

const ELLIPSIS = "…";

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

export function paintWrapped(pieces: readonly Piece[], width: number): string[] {
	if (width < 1) return [];
	const lines: string[] = [];
	let line: string[] = [];
	let used = 0;
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
