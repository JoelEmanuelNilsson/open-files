import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { COMMAND_HEADER_CHARS } from "./call-argument.ts";
import { clip, wrap } from "./row-text.ts";
import type { Paint } from "../ui/labelled-rule.ts";
import { CALL_LIGHT, shadeLine, waveEnabled } from "../ui/prism-light.ts";
import { CUT, DOT, type RenderContext, rowState } from "./tool-row.ts";

export const NAME_COLUMN = 2;
const WAVE = waveEnabled();
const MIN_ARGUMENT = 3;

export type CallState = "running" | "done" | "error" | "aborted";

export interface HeaderFields {
	state: CallState;
	name: string;
	argument: string;
	clipEnd: "head" | "tail";
	headerRows?: number;
	link?: string;
	expanded: boolean;
	startedAt?: number;
}

export interface HeaderPaints {
	dot: Paint;
	name: Paint;
	punctuation: Paint;
	argument: Paint;
}

export class CallHeader implements Component {
	private fields: HeaderFields = { state: "running", name: "", argument: "", clipEnd: "tail", expanded: false };
	private paints: HeaderPaints = { dot: (t) => t, name: (t) => t, punctuation: (t) => t, argument: (t) => t };
	private stamp = "";
	private cache: { width: number; stamp: string; lines: string[] } | undefined;

	set(fields: HeaderFields, paints: HeaderPaints): void {
		this.fields = fields;
		this.paints = paints;
		this.stamp = [fields.state, fields.name, fields.argument, fields.clipEnd, fields.headerRows ?? 1, fields.link ?? "", fields.expanded].join("\u0000");
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
		const { state, startedAt } = this.fields;
		if (state !== "running" || startedAt === undefined || !WAVE) return lines;
		try {
			const t = Math.max(0, Date.now() - startedAt) / 1000;
			return lines.map((line) => shadeLine(line, t, "self", { light: CALL_LIGHT }));
		} catch {
			return lines;
		}
	}

	private layout(width: number): string[] {
		if (width < 1) return [];
		const { state, name, argument, clipEnd, headerRows, link, expanded } = this.fields;
		const { dot, name: paintName, punctuation, argument: paintArgument } = this.paints;

		const glyph = state === "aborted" ? CUT : DOT;
		const head = `${glyph} ${name}`;
		if (visibleWidth(head) > width) {
			return [dot(glyph) + " " + paintName(clip(name, Math.max(0, width - NAME_COLUMN)))];
		}

		const painted = dot(glyph) + " " + paintName(name);
		const room = width - visibleWidth(head);
		if (!argument || room < MIN_ARGUMENT) return [painted];

		const budget = room - 2;
		if (expanded) {
			const chunks = wrap(argument, budget);
			const first = chunks[0] ?? "";
			const open = punctuation("(");
			const close = punctuation(")");
			if (chunks.length === 1) return [painted + open + this.linked(paintArgument(first), first, link) + close];
			const indent = " ".repeat(NAME_COLUMN);
			return [
				painted + open + paintArgument(first),
				...chunks.slice(1, -1).map((chunk) => indent + paintArgument(chunk)),
				indent + paintArgument(chunks[chunks.length - 1] ?? "") + close,
			];
		}

		const rows = headerRows ?? 1;
		const bounded = rows > 1 ? clip(argument, COMMAND_HEADER_CHARS, clipEnd) : argument;

		const wrapped = rows > 1 ? this.multiRow(bounded, rows, budget) : undefined;
		if (wrapped) {
			const indent = " ".repeat(visibleWidth(head) + 1);
			return [
				painted + punctuation("(") + paintArgument(wrapped[0] ?? ""),
				...wrapped.slice(1, -1).map((row) => indent + paintArgument(row)),
				indent + paintArgument(wrapped[wrapped.length - 1] ?? "") + punctuation(")"),
			];
		}

		const shown = clip(bounded, budget, clipEnd);
		return [painted + punctuation("(") + this.linked(paintArgument(shown), shown, link) + punctuation(")")];
	}

	private multiRow(argument: string, rows: number, budget: number): string[] | undefined {
		if (budget < MIN_ARGUMENT || visibleWidth(argument) <= budget) return undefined;
		const lines = wrap(argument, budget);
		if (lines.length <= 1) return undefined;
		const kept = lines.slice(0, rows - 1);
		kept.push(clip(lines.slice(rows - 1).join(" "), budget));
		return kept;
	}

	private linked(painted: string, plain: string, link: string | undefined): string {
		if (!link || !plain || !getCapabilities().hyperlinks) return painted;
		return hyperlink(painted, link);
	}
}

/** Dim while it runs, `success` when it lands, `error` when it does not. */
export function dotPaint(theme: Theme, state: CallState): Paint {
	if (state === "error") return (text) => theme.fg("error", text);
	if (state === "running" || state === "aborted") return (text) => theme.fg("dim", text);
	return (text) => theme.fg("success", text);
}

export function headerPaints(theme: Theme, state: CallState): HeaderPaints {
	return {
		dot: dotPaint(theme, state),
		name: (text) => theme.bold(theme.fg("toolTitle", text)),
		punctuation: (text) => theme.fg("muted", text),
		argument: (text) => theme.fg("accent", text),
	};
}

export function stateOf(context: RenderContext): CallState {
	if (context.isError) return "error";
	if (!context.isPartial) return "done";
	return rowState(context).aborted ? "aborted" : "running";
}
