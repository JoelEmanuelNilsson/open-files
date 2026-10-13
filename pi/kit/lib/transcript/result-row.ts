import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { clip, type Piece, paintClipped, paintPieces, wrap } from "./row-text.ts";
import type { Paint } from "../ui/labelled-rule.ts";
import type { Hint } from "./hint-hold.ts";
import { type Summary, stripNotice, summaryText } from "./call-summary.ts";

/** Five columns, U+23BF, then the body. Claude Code's gutter, to the cell. */
export const GUTTER = "  ⎿  ";
export const GUTTER_WIDTH = 5;
export const INDENT = " ".repeat(GUTTER_WIDTH);
/** Trailing lines of a failed call shown while the row is collapsed. */
export const ERROR_LINES = 12;
export const PREVIEW_LINES = 3;
const MIN_BODY = 8;

export function expandKeyText(): string {
	try {
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
	summary: Summary | null;
	tail?: string;
	preview?: string[];
	note?: string;
	hidden?: number;
	body?: string[];
	error: boolean;
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

export class ResultRow implements Component {
	private fields: ResultFields = { summary: null, error: false, duration: null, expanded: false };
	private paints: ResultPaints = blankPaints();
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
		for (const line of rest) lines.push(INDENT + line);
		for (const line of body) lines.push(INDENT + line);
		return lines;
	}

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
			const rows = expanded ? preview.flatMap((line) => wrap(line, room)) : preview;
			pieces.push({ plain: rows[0] ?? "", paint: paints.output });
			under = rows.slice(1).map((line) => paints.output(clip(line, room)));
		} else if (tail) {
			pieces.push({ plain: tail, paint: paints.output });
		}
		const clockOnFooter = this.footer !== "" && duration !== null;
		if (this.footer) under.push(paints.dim(clip(clockOnFooter ? `${this.footer} · ${duration}` : this.footer, room)));
		if (pieces.length === 0 && note) return [paintPieces([{ plain: note, paint: paints.dim }])];
		if (pieces.length === 0) return [];

		const suffix: Piece[] = [];
		if (!error && !preview && hidden && hidden > 0) {
			suffix.push({ plain: `  +${hidden} line${hidden === 1 ? "" : "s"}`, paint: paints.dim });
		}
		if (duration && !clockOnFooter) suffix.push({ plain: ` · ${duration}`, paint: paints.dim });

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

	private body(room: number): string[] {
		const { error, expanded, body, preview } = this.fields;
		if (error) return this.errorLines().slice(1).flatMap((line) => wrap(line, room)).map(this.paints.error);
		if (!expanded || !body || preview) return [];
		return body.flatMap((line) => wrap(line, room)).map(this.paints.output);
	}

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

export function lastLine(text: string): Hint {
	const { lines, hidden } = outputPreview(text, 1, "tail");
	return { line: lines[0] ?? "", hidden };
}

export class Gutter implements Component {
	private readonly inner: Component;
	private readonly paint: Paint;
	private readonly head: boolean;

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
