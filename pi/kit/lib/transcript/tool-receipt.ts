import { existsSync } from "node:fs";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import { backgroundHint } from "../tools/bash-tool.ts";
import { fileLinkUrl } from "../ui/file-link.ts";
import { describeCallArgument, toolCallLabel } from "./call-argument.ts";
import { CallHeader, headerPaints, stateOf } from "./call-header.ts";
import { lineOf, noteRow, roleOf } from "./tool-rollup.ts";
import { clausesFor, RollupLine, rollupPaints } from "./rollup-line.ts";
import { indented, lastLine, outputLines, outputPreview, PREVIEW_LINES, ResultRow, resultPaints } from "./result-row.ts";
import { heldHint } from "./hint-hold.ts";
import { BLANK, type RenderContext, type RowState, rowState, startClock, stopClock, watchInFlightRow } from "./tool-row.ts";
import { formatBytes, formatCallDuration, stripNotice, type Summary, summarizeToolResult } from "./call-summary.ts";
import { skillReadLabel } from "./skill-read.ts";
import { writeBody } from "./write-receipt.ts";

function elapsedOn(spoken: { live: boolean; startedAt?: number } | undefined, now = Date.now()): string | null {
	if (!spoken?.live || spoken.startedAt === undefined) return null;
	return formatCallDuration(now - spoken.startedAt);
}

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
	return fileLinkUrl(file, line);
}

function skillOf(tool: string, args: Record<string, unknown>, context: RenderContext): string | undefined {
	if (rowState(context).offTranscript) return undefined;
	return skillReadLabel(tool, args, context.cwd || process.cwd());
}

export function toolHeader(tool: string, args: unknown, theme: Theme, context: RenderContext): Component {
	startClock(context);
	watchInFlightRow(context);
	noteRow(context);

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
	// SAFETY: args was checked to be a non-null object; values stay unknown
	const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const state = rowState(context);
	const skill = skillOf(tool, input, context);
	const argument = skill === undefined ? describeCallArgument(tool, input, context.cwd || process.cwd()) : { text: skill, clip: "tail" as const };
	const header = context.lastComponent instanceof CallHeader ? context.lastComponent : new CallHeader();
	header.set(
		{
			state: callState,
			name: skill === undefined ? toolCallLabel(tool) : "Skill",
			argument: argument.text,
			clipEnd: argument.clip,
			headerRows: argument.headerRows,
			link: linkFor("file" in argument ? argument.file : undefined, "line" in argument ? (argument.line ?? state.line) : state.line, state),
			expanded: context.expanded,
			startedAt: state.startedAt,
		},
		headerPaints(theme, callState),
	);
	return header;
}

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

function wasTruncated(result: AgentToolResult<unknown>): boolean {
	const details = result.details;
	if (typeof details !== "object" || details === null) return false;
	// SAFETY: details was checked to be a non-null object; truncation is read optionally
	const truncation = (details as { truncation?: { truncated?: boolean } }).truncation;
	return truncation?.truncated === true;
}

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
		const failed = context.isError;
		const duration = stopClock(context);

		const text = textOf(result);
		const images = imagesIn(result);
		// SAFETY: context.args was checked to be a non-null object; values stay unknown
		const args = (typeof context.args === "object" && context.args !== null ? context.args : {}) as Record<string, unknown>;
		const skill = skillOf(tool, args, context) !== undefined;
		if (settled && state.summary === undefined) {
			state.summary = failed || skill
				? null
				: images.length > 0
					? imageSummary(images, context.showImages)
					: summarizeToolResult(tool, text, args, wasTruncated(result));
		}

		const summary = settled ? (state.summary ?? null) : null;
		const speaks = summary === null && !failed;
		const tail = speaks && !settled ? lastLine(text) : undefined;
		const preview = speaks && settled
			? context.expanded
				? { lines: outputLines(text), hidden: 0 }
				: outputPreview(text, PREVIEW_LINES)
			: undefined;
		const silent: Summary | null = settled && speaks && preview?.lines.length === 0 ? { kind: "note", text: "(no output)", tone: "muted" } : null;
		const body = settled ? stripNotice(text).trimEnd().split("\n") : undefined;

		if (roleOf(context) !== "row") return BLANK;

		if (skill && !failed && !context.expanded) return BLANK;

		const hint = heldHint(state, tail, settled, context.invalidate);

		const row = context.lastComponent instanceof ResultRow ? context.lastComponent : new ResultRow();
		row.set(
			{
				summary: summary ?? silent,
				tail: hint?.line,
				preview: preview?.lines,
				note: !settled && !failed && tool === "bash" ? backgroundHint() : undefined,
				hidden: preview?.hidden ?? hint?.hidden,
				body: body && body.length === 1 && body[0] === "" ? [] : body,
				error: failed,
				duration,
				expanded: context.expanded,
			},
			resultPaints(theme),
		);
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
		renderShell: "self",
		renderCall: renderCall(tool),
		renderResult: renderResult(tool),
	};
}
