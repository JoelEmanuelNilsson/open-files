import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	type AgentToolResult,
	generateDiffString,
	getLanguageFromPath,
	highlightCode,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { configuredMode, DiffView, diffPalette } from "./diff-view.ts";
import { moreLinesHint } from "./result-row.ts";

/** Lines a collapsed new-file preview shows; Claude Code's MAX_LINES_TO_RENDER. */
export const WRITE_PREVIEW_LINES = 10;

export interface WriteDetails {
	diff?: string;
}

type Execute = ToolDefinition<any, any, any>["execute"];

/** The built-in's execute, with the overwrite diff added to its result. */
export function executeWithOverwriteDiff(inner: Execute): Execute {
	return async (id, params, signal, onUpdate, ctx) => {
		// SAFETY: the write tool's schema requires path and content as strings; path is re-checked with typeof
		const args = params as { path?: string; content?: string };
		const target = typeof args.path === "string" ? (isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path)) : undefined;
		const before = target ? await readFile(target, "utf8").catch(() => undefined) : undefined;
		const result: AgentToolResult<unknown> = await inner(id, params, signal, onUpdate, ctx);
		if (before === undefined || typeof args.content !== "string" || before === args.content) return result;
		const details: WriteDetails = { diff: generateDiffString(before, args.content).diff };
		return { ...result, details };
	};
}

class WritePreview implements Component {
	constructor(
		private readonly content: string,
		private readonly path: string | undefined,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		const all = this.content.replace(/\n$/, "").split("\n");
		const shown = this.expanded ? all : all.slice(0, WRITE_PREVIEW_LINES);
		const hidden = all.length - shown.length;
		const lines = highlightCode(shown.join("\n"), this.path ? getLanguageFromPath(this.path) : undefined).map((line) =>
			truncateToWidth(line, width),
		);
		if (hidden > 0) lines.push(this.theme.fg("dim", truncateToWidth(moreLinesHint(hidden, ""), width)));
		return lines;
	}

	invalidate(): void {}
}

/** The component under a settled write row, or nothing when there is no content to show. */
export function writeBody(
	args: Record<string, unknown>,
	result: AgentToolResult<unknown>,
	theme: Theme,
	expanded: boolean,
): Component | undefined {
	// SAFETY: results from the write tool carry WriteDetails; diff presence is checked before use
	const details = result.details as WriteDetails | undefined;
	if (details?.diff) return new DiffView(details.diff, diffPalette(theme), configuredMode(), expanded);
	const content = typeof args.content === "string" ? args.content : "";
	if (content === "") return undefined;
	return new WritePreview(content, typeof args.path === "string" ? args.path : undefined, theme, expanded);
}
