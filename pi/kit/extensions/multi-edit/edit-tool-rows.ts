import type { AgentToolResult, EditToolDetails, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { configuredMode, DiffView, diffPalette } from "../../lib/transcript/diff-view.ts";
import { toolHeader } from "../../lib/transcript/tool-receipt.ts";
import type { Summary } from "../../lib/transcript/call-summary.ts";
import { indented, ResultRow, resultPaints } from "../../lib/transcript/result-row.ts";
import { type RenderContext, rowState, stopClock, transcriptEnabled } from "../../lib/transcript/tool-row.ts";

function changeSummary(diff: string): Summary {
	let added = 0;
	let removed = 0;
	let files = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("File: ")) files++;
		else if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const count = Math.max(files, 1);
	return { kind: "note", text: `${count} file${count === 1 ? "" : "s"}, +${added} \u2212${removed}`, tone: "muted" };
}

/** The call line: the transcript's header when that extension is on, else `edit path (N)`. */
export function renderEditCall(args: unknown, theme: Theme, context: RenderContext): Component {
	if (transcriptEnabled()) return toolHeader("edit", args, theme, context);

	// SAFETY: render args are untrusted tool arguments; every field is checked by type before use
	const input = (args ?? {}) as {
		path?: string;
		edits?: unknown[];
		files?: Array<{ path?: string; edits?: unknown[] }>;
	};
	const text = theme.fg("toolTitle", theme.bold("edit "));

	const parts: string[] = [];
	if (input.path && input.edits) parts.push(`${input.path} (${input.edits.length})`);
	for (const file of input.files ?? []) {
		parts.push(`${file.path ?? "?"} (${file.edits?.length ?? 0})`);
	}
	return new Text(text + theme.fg("muted", parts.join(", ") || input.path || ""), 0, 0);
}

/** The result: a line counting what changed with the diff under it, or the error or progress text. */
export function renderEditResult(result: AgentToolResult<unknown>, { expanded, isPartial }: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component {
	// SAFETY: details is produced by the edit tool's execute as EditToolDetails
	const details = result.details as EditToolDetails | undefined;
	const duration = stopClock(context);
	const state = rowState(context);
	if (details?.firstChangedLine !== undefined && state.line === undefined) {
		state.line = details.firstChangedLine;
		if (typeof context.invalidate === "function") context.invalidate();
	}
	const text = result.content?.find((part) => part.type === "text");
	const output = text && "text" in text ? text.text : "";

	if (!transcriptEnabled()) {
		if (isPartial) return new Text(theme.fg("dim", "editing…"), 0, 0);
		if (!details?.diff) return new Text(theme.fg("dim", output), 0, 0);
		return new DiffView(details.diff, diffPalette(theme), configuredMode(), expanded);
	}

	const paints = resultPaints(theme);
	if (isPartial || !details?.diff) {
		const row = context.lastComponent instanceof ResultRow ? context.lastComponent : new ResultRow();
		row.set(
			{
				summary: isPartial ? null : { kind: "note", text: output.split("\n")[0] ?? "", tone: "muted" },
				tail: isPartial ? "editing…" : undefined,
				body: isPartial ? undefined : output.split("\n"),
				error: context.isError,
				duration,
				expanded,
			},
			paints,
		);
		return row;
	}

	const counted = new ResultRow();
	counted.set({ summary: changeSummary(details.diff), error: false, duration, expanded }, paints);
	const stacked = new Container();
	stacked.addChild(counted);
	stacked.addChild(indented(new DiffView(details.diff, diffPalette(theme), configuredMode(), expanded)));
	return stacked;
}
