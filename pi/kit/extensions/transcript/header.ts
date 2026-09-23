/**
 * The first line of a tool row.
 *
 *     ● Read(lib/split-diff.ts)
 *     ● Bash(npm test)
 *     ● Grep(renderCall in kit/)
 *
 * Dot in column 0, name in column 2, argument in parentheses. The thinking rail
 * puts assistant prose in column 2 as well, so the name lines up with the reply
 * that asked for it and the dot sits in the rail's own gutter. One column, two
 * meanings, and nothing on the row is positional beyond that: a tool with a long
 * name pushes its argument right instead of breaking a grid.
 *
 * The dot carries the state and never moves. Dim while the call is in flight,
 * `success` when it settles, `error` when it fails. It does not blink: pi's
 * renderer has no dirty tracking, this terminal runs a CRT shader that tints
 * glyphs by their row, and the background is blurred and translucent, so
 * repainting a glyph 1.7 times a second recomposites the blur for a signal
 * colour already carries.
 *
 * One thing in the transcript does repaint on a timer, and it is not on this
 * row: the clock on a live rollup line, which counts a thing no colour can say.
 * `group.ts` sets out what that costs and how it is kept to a single row.
 *
 * The row is one line for every tool but the shell. A header that can grow is a
 * header you have to read to skip, so the argument is clipped rather than
 * wrapped — except a shell command, which gets two rows and 160 characters
 * (`COMMAND_HEADER_ROWS`, Claude Code's own cap), because a command's tail
 * carries the redirect, the flag and the path, and one clipped line drops
 * exactly the half you would have read second. `ctrl+o` expands any of them and
 * the argument wraps in full.
 */

import { existsSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { COMMAND_HEADER_CHARS, describe, labelFor } from "./describe.ts";
import { lineOf, noteRow, roleOf } from "./group.ts";
import { clip, type Paint, wrap } from "./line.ts";
import { CALL_LIGHT, shadeLine, waveEnabled } from "../zen-chrome/prism.ts";
import { linkTo } from "./link.ts";
import { clausesFor, RollupLine, rollupPaints } from "./rollup.ts";
import { BLANK, CUT, DOT, type RenderContext, type RowState, rowState, startClock, watch } from "./row.ts";
import { formatDuration } from "./summary.ts";

// The glyphs live in `row.ts` because the rollup line wears the dot too. Their
// meaning, and the three colours that carry it, are here.
export { CUT, DOT };
export const NAME_COLUMN = 2;
/** Read once: `PI_ZEN_WAVE` is a startup switch, and this is asked every frame. */
const WAVE = waveEnabled();
/** Below this there is no room for an argument, so the row is just its name. */
const MIN_ARGUMENT = 3;

export type CallState = "running" | "done" | "error" | "aborted";

export interface HeaderFields {
	state: CallState;
	/** The bold name. Already capitalised by `labelFor`. */
	name: string;
	/** What goes in the parentheses. Empty means no parentheses at all. */
	argument: string;
	/** Which end of the argument is dropped when it will not fit. */
	clipEnd: "head" | "tail";
	/** Rows the argument may take. One unless `describe.ts` says otherwise. */
	headerRows?: number;
	/** The URL the argument links to, when the file is there to open. */
	link?: string;
	/** `ctrl+o`: wrap the argument in full instead of clipping it. */
	expanded: boolean;
	/** Epoch ms the tool began work, so a running row can light from its own start. */
	startedAt?: number;
}

export interface HeaderPaints {
	dot: Paint;
	name: Paint;
	punctuation: Paint;
	argument: Paint;
}

/**
 * Laid out at render time, not at renderer time.
 *
 * `renderCall` is handed a theme and a context but no width, so every decision
 * about what fits has to happen in `render(width)`. The cache mirrors pi's own
 * `Text`: keyed on the width and on a stamp of the fields, dropped by
 * `invalidate`. Without it the whole visible scrollback re-lays-out on every
 * frame zen-chrome asks for.
 */
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

	/**
	 * The chrome's light over the header while the call is in flight.
	 *
	 * What the cache holds is the unlit layout: shading repaints the cells of a
	 * line that is already laid out, so the clock stays out of the stamp and a
	 * frame of light never costs a re-layout. A settled row never enters this, so
	 * a still row is the bytes it always was. The resting colour is `"self"` —
	 * each glyph's own colour — so the dot, the name and the argument light
	 * together without this row knowing the palette.
	 */
	private lit(lines: string[]): string[] {
		const { state, startedAt } = this.fields;
		if (state !== "running" || startedAt === undefined || !WAVE) return lines;
		// Cosmetic: light that throws must not take the transcript down with it.
		try {
			const t = Math.max(0, Date.now() - startedAt) / 1000;
			return lines.map((line) => shadeLine(line, t, "self", { light: CALL_LIGHT }));
		} catch {
			return lines;
		}
	}

	private layout(width: number): string[] {
		if (width < 1) return [];
		// The state reaches the layout as `paints.dot`, and as the one glyph that
		// is not the dot: a call that was cut off has to be told apart from a call
		// still running, and both of those are dim.
		const { state, name, argument, clipEnd, headerRows, link, expanded } = this.fields;
		const { dot, name: paintName, punctuation, argument: paintArgument } = this.paints;

		const glyph = state === "aborted" ? CUT : DOT;
		const head = `${glyph} ${name}`;
		if (visibleWidth(head) > width) {
			// Narrower than the name itself. The name is the last thing to go, so it
			// keeps whatever columns there are and the argument is dropped.
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

		// A row that may take two of them is a shell command, and a shell command
		// is capped at 160 characters however wide the pane is: past that the header
		// has stopped identifying the call and started reprinting it. Only the
		// collapsed row is capped — `ctrl+o` above still wraps the whole command.
		const rows = headerRows ?? 1;
		const bounded = rows > 1 ? clip(argument, COMMAND_HEADER_CHARS, clipEnd) : argument;

		const wrapped = rows > 1 ? this.multiRow(bounded, rows, budget) : undefined;
		if (wrapped) {
			// Under the argument start, which is the open parenthesis plus one: a
			// continuation that lined up with the name would read as a second call.
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

	/**
	 * The rows a multi-row argument takes, or undefined when one line is the
	 * whole of it.
	 *
	 * Every row is the same `budget` wide: the first spends a column on the open
	 * parenthesis and the last on the close, and the continuation indent is the
	 * open parenthesis's own column plus one, so the two cancel exactly. What
	 * does not fit in the last row is clipped there, which is the `…` Claude Code
	 * puts at the same place.
	 *
	 * A multi-row argument carries no hyperlink. Only a shell command asks for
	 * more than one row and a command names no single file, so there is nothing
	 * to link — and half a link on each of two rows is two links to one file.
	 */
	private multiRow(argument: string, rows: number, budget: number): string[] | undefined {
		if (budget < MIN_ARGUMENT || visibleWidth(argument) <= budget) return undefined;
		const lines = wrap(argument, budget);
		if (lines.length <= 1) return undefined;
		const kept = lines.slice(0, rows - 1);
		// Everything past the rows on offer is folded back onto the last of them and
		// clipped there, so the `…` sits where the text stops rather than where a
		// word happened to break.
		kept.push(clip(lines.slice(rows - 1).join(" "), budget));
		return kept;
	}

	/**
	 * An OSC-8 hyperlink over the argument, so cmd-click opens the file in nvim.
	 *
	 * The link covers the text that is actually on screen, clipped or not, while
	 * pointing at the whole path. Terminals without OSC-8 drop the escapes and
	 * show the same characters, so the check is only to keep the sequence out of
	 * captured output where nothing will consume it.
	 */
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

/**
 * What the dot says: three states read straight off the row, and a fourth that
 * only `quiesce` can know, since a call that was interrupted looks from here
 * exactly like a call that is still working.
 */
export function stateOf(context: RenderContext): CallState {
	if (context.isError) return "error";
	if (!context.isPartial) return "done";
	return rowState(context).aborted ? "aborted" : "running";
}

/**
 * How long the group has been going, spelled the way a settled row spells it.
 *
 * Read off the group and never off this row. The row speaking for a batch is
 * whichever of its calls is still running, so it changes as results land, and a
 * clock that started again with it would count down instead of up.
 */
function elapsedOn(spoken: { live: boolean; startedAt?: number } | undefined, now = Date.now()): string | null {
	if (!spoken?.live || spoken.startedAt === undefined) return null;
	return formatDuration(now - spoken.startedAt);
}

/** Set once, because `$HOME` does not change while a session runs. */
const HOME = process.env.HOME || process.env.USERPROFILE;

/**
 * The link for a path, with the line the call is about.
 *
 * The file has to be there: a path a call is about to write does not exist at
 * its first render, and linking it would open nothing. That check is the only
 * expensive part, so it is the part that is remembered — and only once it comes
 * back true, since the next frame is where the file appears. The URL itself is
 * rebuilt each time because `edit` learns its line number from the result,
 * after the header has already drawn once.
 */
function linkFor(file: string | undefined, line: number | undefined, state: RowState): string | undefined {
	if (file === undefined) return undefined;
	if (!state.exists) {
		try {
			if (!existsSync(file)) return undefined;
		} catch {
			return undefined;
		}
		state.exists = true;
	}
	return linkTo(file, line);
}

/**
 * The whole call slot for a tool, in one call.
 *
 * Everything it needs is already on the context: the arguments, the working
 * directory, whether the call has settled, whether the row is expanded, and a
 * place to keep the component between frames. Tools outside this extension
 * (`edit`) use it for their headers so the transcript runs one visual
 * system rather than two.
 */
export function toolHeader(tool: string, args: unknown, theme: Theme, context: RenderContext): Component {
	startClock(context);
	watch(context);
	noteRow(context);

	// A row that belongs to a group either speaks for it or draws nothing at all.
	// Deciding it here, in the slot every row reaches, keeps `edit` on the same
	// system: it never collapses, so it never sees anything but its own header.
	const role = roleOf(context);
	if (role === "hidden") return BLANK;
	if (role === "line") {
		const spoken = lineOf(context.toolCallId);
		const live = spoken?.live === true;
		const line = context.lastComponent instanceof RollupLine ? context.lastComponent : new RollupLine();
		line.set(clausesFor(spoken?.tools ?? [], live ? "present" : "past", spoken?.subjects), rollupPaints(theme), live, elapsedOn(spoken), spoken?.hint, spoken?.startedAt);
		return line;
	}

	const callState = stateOf(context);
	const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	// A renderer must not throw: pi falls back to printing the bare tool name, and
	// a row that loses its argument because a caller passed a bare context is a
	// worse bug than one that resolves against the process directory.
	const argument = describe(tool, input, context.cwd || process.cwd(), HOME);
	const state = rowState(context);
	const header = context.lastComponent instanceof CallHeader ? context.lastComponent : new CallHeader();
	header.set(
		{
			state: callState,
			name: labelFor(tool),
			argument: argument.text,
			clipEnd: argument.clip,
			headerRows: argument.headerRows,
			// `argument.line` is what the arguments said; `state.line` is what the
			// result knew and the arguments could not, which is how an `edit` row ends
			// up pointing at the line it changed.
			link: linkFor(argument.file, argument.line ?? state.line, state),
			expanded: context.expanded,
			startedAt: state.startedAt,
		},
		headerPaints(theme, callState),
	);
	return header;
}
