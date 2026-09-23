/**
 * The receipt: the two-line render every tool row in this transcript gets.
 *
 * `renderCall` is the header (`● Bash(npm test)`), `renderResult` the gutter
 * line under it (`⎿  41 passed  +12 lines · 2.4s`). Both are pure of the
 * extension instance — they read the row's state off the render context and
 * the module-scope groups — so a tool registered by another extension can wear
 * the same receipt. `extensions/bash.ts` does: it owns the shell's execution
 * and takes its rows from here, which is what keeps one registrar per tool.
 */

import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import { backgroundHint } from "../../lib/bash.ts";
import { roleOf } from "./group.ts";
import { toolHeader } from "./header.ts";
import { indented, lastLine, outputLines, outputPreview, PREVIEW_LINES, ResultRow, resultPaints } from "./result.ts";
import { BLANK, heldHint, type RenderContext, rowState, stopClock } from "./row.ts";
import { formatBytes, stripNotice, type Summary, summarize } from "./summary.ts";
import { writeBody } from "./write.ts";

interface ImageBlock {
	data?: string;
	mimeType?: string;
}

function imagesIn(result: AgentToolResult<unknown>): ImageBlock[] {
	const blocks: ImageBlock[] = [];
	for (const block of result.content) if (block.type === "image") blocks.push(block);
	return blocks;
}

function textOf(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const block of result.content) if (block.type === "text") parts.push(block.text);
	return parts.join("\n");
}

/** pi reports its own truncation in `details`, so a count can admit to being a floor. */
function wasTruncated(result: AgentToolResult<unknown>): boolean {
	const details = result.details;
	if (typeof details !== "object" || details === null) return false;
	const truncation = (details as { truncation?: { truncated?: boolean } }).truncation;
	return truncation?.truncated === true;
}

/**
 * What a result carrying a picture says on its one line.
 *
 * pi draws the picture itself, as a child of the row's own component, so the
 * result slot must not draw it a second time. Where the terminal cannot draw at
 * all — under tmux, `getCapabilities().images` is false — the line naming the
 * format and size is the only thing on screen, and pi's own `imageFallback` is
 * what writes it.
 */
function imageSummary(images: ImageBlock[], showImages: boolean): Summary {
	const first = images[0];
	const mimeType = first?.mimeType ?? "image/unknown";
	if (!getCapabilities().images || !showImages) {
		const size = first?.data && first.mimeType ? (getImageDimensions(first.data, first.mimeType) ?? undefined) : undefined;
		return { kind: "note", text: `Read image ${imageFallback(mimeType, size)}`, tone: "muted" };
	}
	const bytes = images.reduce((total, image) => total + Math.floor(((image.data?.length ?? 0) * 3) / 4), 0);
	return { kind: "note", text: `Read image (${formatBytes(bytes)})`, tone: "muted" };
}

function renderCall(tool: string) {
	return (args: unknown, theme: Theme, context: RenderContext): Component =>
		toolHeader(tool, args, theme, context);
}

function renderResult(tool: string) {
	return (
		result: AgentToolResult<unknown>,
		options: { isPartial: boolean; expanded: boolean },
		theme: Theme,
		context: RenderContext,
	): Component => {
		const state = rowState(context);
		const settled = !options.isPartial;
		// pi hands the result slot `{ content, details }` only, so whether the call
		// failed is on the context and nowhere else.
		const failed = context.isError;
		const duration = stopClock(context);

		const text = textOf(result);
		const images = imagesIn(result);
		const args = (typeof context.args === "object" && context.args !== null ? context.args : {}) as Record<string, unknown>;
		if (settled && state.summary === undefined) {
			state.summary = failed
				? null
				: images.length > 0
					? imageSummary(images, context.showImages)
					: summarize(tool, text, args, wasTruncated(result));
		}

		// A tool with no honest count shows its own output. Running, that is the
		// last line, because a tail is where the command has got to. Settled, it is
		// the first three lines, because the answer starts at the top and the row is
		// now a record rather than a progress meter. `result.ts` writes both out of
		// one primitive, so the two ends can never disagree about what a line is.
		//
		// A command that printed nothing says so: an empty result line reads as a
		// row that is still working.
		const summary = settled ? (state.summary ?? null) : null;
		const speaks = summary === null && !failed;
		const tail = speaks && !settled ? lastLine(text) : undefined;
		// Expanded is the mode that asked for all of it, so the preview stops being a
		// preview: every line, blanks included, and no footer counting what is left.
		const preview = speaks && settled
			? context.expanded
				? { lines: outputLines(text), hidden: 0 }
				: outputPreview(text, PREVIEW_LINES)
			: undefined;
		const silent: Summary | null = settled && speaks && preview?.lines.length === 0 ? { kind: "note", text: "(no output)", tone: "muted" } : null;
		const body = settled ? stripNotice(text).trimEnd().split("\n") : undefined;

		// The summary above is computed before this, and only then is the row
		// allowed to disappear: a collapsed row that is opened again still has to
		// know what it did and how long it took, and the settled render is the
		// only place either is knowable.
		//
		// A folded row draws nothing at all, in either slot. The group's line draws
		// its own gutter, from the newest member's arguments — never from what a
		// member printed, so nothing here is handed up.
		if (roleOf(context) !== "row") return BLANK;

		// A running command's tail is held for its minimum, so a fast one can be read
		// at all. Below the role check on purpose: a folded row is not on screen, and
		// the hold books a redraw to close its window — a repaint nobody could see.
		// `settled` is passed in rather than tested here, so the record of what a
		// command printed cannot be made to arrive late by a call site.
		const hint = heldHint(state, tail, settled, context.invalidate);

		const row = context.lastComponent instanceof ResultRow ? context.lastComponent : new ResultRow();
		row.set(
			{
				summary: summary ?? silent,
				tail: hint?.line,
				preview: preview?.lines,
				// A running command can be sent to the background from the keyboard, and
				// the row is where that is learned. Rows exist only where pi calls
				// renderCall — the TUI, the main seat — so the offer is always real.
				note: !settled && !failed && tool === "bash" ? backgroundHint() : undefined,
				hidden: preview?.hidden ?? hint?.hidden,
				body: body && body.length === 1 && body[0] === "" ? [] : body,
				error: failed,
				duration,
				expanded: context.expanded,
			},
			resultPaints(theme),
		);
		// A write's content is the answer, so it sits under the count the way an
		// edit's diff does. Only once the row can no longer fold: a settled row is
		// the only one whose body stays put.
		const shown = settled && !failed && tool === "write" ? writeBody(args, result, theme, context.expanded) : undefined;
		if (!shown) return row;
		const stacked = new Container();
		stacked.addChild(row);
		stacked.addChild(indented(shown));
		return stacked;
	};
}

/** The receipt's three fields, ready to spread into a tool definition. */
export function receipt(tool: string): Pick<ToolDefinition<any, any, any>, "renderShell" | "renderCall" | "renderResult"> {
	return {
		// pi's default shell is a `Box` with a column of padding, a blank line
		// above and below, and a background some themes make transparent.
		// A two-line receipt inside it is five lines of mostly nothing.
		renderShell: "self",
		renderCall: renderCall(tool),
		renderResult: renderResult(tool),
	};
}
