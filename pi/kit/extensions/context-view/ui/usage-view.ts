import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { collectPreviewEntries, type ContextUsageSnapshot, type UsagePreviewEntry } from "../context-usage.ts";
import { ListNavigator, PreviewScroller } from "./list-navigator.ts";
import { normalizeInlineText, normalizePreviewText } from "./preview-text-sanitize.ts";
import {
	BODY_INDENT,
	calculateViewport,
	DEFAULT_TERMINAL_ROWS,
	dimDotLeader,
	fitLine,
	fitToTerminalHeight,
	hintRow,
	isPageBackKey,
	isPageForwardKey,
	isStepBackKey,
	isStepForwardKey,
	normalizeTerminalRows,
	spreadLine,
	STEP_KEY_HINT,
	wrapDescriptionLines,
} from "../../../lib/ui/dialog-layout.ts";
import { FULLSCREEN_OVERLAY_OPTIONS, showViewOverlay } from "../../../lib/ui/view-overlay.ts";
import { DEFAULT_WHEEL_SCROLL_LINES, parseWheelDirection, readWheelScrollLines } from "../../../lib/ui/wheel-scroll.ts";
import { splitSkillPreview } from "./skill-preview.ts";
import { formatEntryTimestamp, formatUsagePercent, formatUsageTokens } from "./usage-format.ts";
import { buildUsageLegendRows, type CategoryLegendRow, type LegendRow, legendTokens } from "./usage-legend.ts";
import {
	buildUsageMap,
	calculateFitMapScale,
	DEFAULT_MAP_COLUMNS,
	DEFAULT_MAP_ROWS,
	type UsageMap,
	type UsageMapCell,
} from "./usage-map.ts";
import {
	BUFFER_CELL,
	categoryColor,
	categoryMarker,
	COMPACTED_CELL,
	FREE_CELL,
	FULL_CELL,
	PARTIAL_CELL,
} from "./usage-palette.ts";
import { BlockNavigator, layoutPreviewBlocks, type PreviewLayout } from "./usage-preview-blocks.ts";

const USAGE_DESCRIPTION = "Estimated context for the next model request. " +
	"Token counts are approximate and may differ from the provider's estimate.";
const INVISIBLE_REASONING_DESCRIPTION =
	"Entry headers read: [DD-MM-YYYY] [assistant] visible + Reasoning ≈invisible (≈total). " +
	"≈ is a provider-reported count; ~ is a rough approximation when no breakdown " +
	"is reported and excluded from category totals. " +
	"Encoded replaces Reasoning when the provider replays encrypted reasoning with its message.";
const USAGE_TAIL_FIXED_LINE_COUNT = 5;
const DETAIL_CATEGORY_HEADER_LINE_COUNT = 1;
const PREVIEW_FIXED_LINE_COUNT = 8;
const BLOCK_FIXED_LINE_COUNT = PREVIEW_FIXED_LINE_COUNT + 2;
const PREVIEW_BLOCK_MAX_LINES = 10;
const PREVIEW_BLOCK_MIN_LINES = 4;
const TWO_BLOCK_FRAME_ROWS = 5;
const BLOCK_GUTTER = "┃";
const CURSOR_COLUMN_WIDTH = 2;
const MAX_LEGEND_VALUE_COLUMN = 32;
const LEGEND_VALUE_GAP = 2;
const LEGEND_LEADER_GAP = 4;
const MAP_SIDE_BY_SIDE_MIN_WIDTH = 52;
const SPACED_MAP_MIN_WIDTH = 72;
const MAP_COLUMN_GAP = 2;
const SPACED_MAP_COLUMN_GAP = 3;
const MAP_KEY_FULL_DESCRIPTION = "Single category block";
const MAP_KEY_PART_DESCRIPTION = "Shared block, largest category shown";
const MAP_KEY_SIZE_LABEL = "Block Size";
const MAP_KEY_DETAILED_SPARE_ROWS = 5;
const MAP_KEY_COMPACT_SPARE_ROWS = 2;

/** Everything the Usage view renders, classified once when the view opens. */
export interface UsageViewInput {
	readonly usage: ContextUsageSnapshot;
	readonly degradedReason?: string;
}

type UsageMapScale = "window" | "fit";

interface LegendColumns {
	readonly value: number;
	readonly tokenWidth: number;
}

interface PreviewBlock {
	readonly lines: readonly string[];
	readonly hiddenLineCount: number;
}

interface PreviewStream {
	readonly wrapWidth: number;
	readonly maxLines: number;
	readonly blocks: readonly PreviewBlock[];
	readonly layout: PreviewLayout;
}

type EntryLines = readonly string[];

interface PreviewContent {
	readonly wrapWidth: number;
	readonly entries: readonly EntryLines[];
}

interface BlockBody {
	readonly width: number;
	readonly lines: readonly string[];
}

/** Open the Usage view as a fullscreen overlay. */
export async function showUsageView(context: ExtensionCommandContext, input: UsageViewInput): Promise<void> {
	await showViewOverlay<void>(
		context,
		(tui, theme, done) => new UsageView(theme, input, done, () => tui.terminal.rows, readWheelScrollLines(tui)),
		FULLSCREEN_OVERLAY_OPTIONS,
	);
}

/** Exported for direct render/input tests; use showUsageView from pi code. */
export class UsageView {
	private readonly theme: Theme;
	private readonly input: UsageViewInput;
	private readonly done: (result: undefined) => void;
	private readonly getTerminalRows: () => number;
	private readonly wheelScrollLines: number;
	private readonly usage: ContextUsageSnapshot;
	private readonly legendRows: readonly LegendRow[];
	private readonly navigator: ListNavigator;
	private readonly previewScroller = new PreviewScroller();
	private readonly blockNavigator = new BlockNavigator();
	private readonly fitMapScale: number | undefined;
	private mapScale: UsageMapScale = "window";
	private currentWidth: number | undefined;
	private previewRow: CategoryLegendRow | undefined;
	private cachedPreviewEntries: readonly UsagePreviewEntry[] | undefined;
	private cachedContent: PreviewContent | undefined;
	private cachedStream: PreviewStream | undefined;
	private openBlockIndex: number | undefined;
	private cachedBlockBody: BlockBody | undefined;
	private cachedWidth: number | undefined;
	private cachedTerminalRows: number | undefined;
	private cachedLines: string[] | undefined;

	public constructor(
		theme: Theme,
		input: UsageViewInput,
		done: (result: undefined) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
		wheelScrollLines: number = DEFAULT_WHEEL_SCROLL_LINES,
	) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.wheelScrollLines = wheelScrollLines;
		this.usage = input.usage;
		this.fitMapScale = calculateFitMapScale(this.usage);
		this.legendRows = buildUsageLegendRows(this.usage);
		const selectableCount = this.legendRows.filter((row) => row.type === "category").length;
		this.navigator = new ListNavigator(this.legendRows.length, 1, selectableCount);
	}

	public handleInput(data: string): void {
		if (this.previewRow !== undefined) {
			if (this.openBlockEntry(this.previewRow) === undefined) this.handlePreviewInput(data);
			else this.handleBlockInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		const wheel = parseWheelDirection(data);
		if (wheel !== undefined) {
			if (this.navigator.moveBy(wheel)) this.clearCache();
			return;
		}
		if (matchesKey(data, "z")) {
			this.toggleMapScale();
		} else if (matchesKey(data, Key.enter)) {
			this.openPreview();
		} else if (isStepBackKey(data)) {
			if (this.navigator.moveBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.navigator.moveBy(1)) this.clearCache();
		} else if (isPageBackKey(data)) {
			if (this.navigator.page(-1)) this.clearCache();
		} else if (isPageForwardKey(data)) {
			if (this.navigator.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.navigator.moveTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.navigator.moveTo(this.legendRows.length - 1)) this.clearCache();
		}
	}

	public render(width: number): string[] {
		this.currentWidth = width;
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === width &&
			this.cachedTerminalRows === terminalRows
		) {
			return this.cachedLines;
		}

		const lines = this.renderActiveMode(width, terminalRows);
		this.cachedWidth = width;
		this.cachedTerminalRows = terminalRows;
		this.cachedLines = lines;
		return lines;
	}

	public invalidate(): void {
		this.clearPreviewContent();
		this.clearCache();
	}

	private renderActiveMode(width: number, terminalRows: number): string[] {
		const row = this.previewRow;
		if (row === undefined) return this.renderDashboard(width, terminalRows);
		const entry = this.openBlockEntry(row);
		if (entry === undefined) return this.renderPreview(width, terminalRows, row);
		return this.renderBlockView(width, terminalRows, row, entry);
	}

	private renderDashboard(width: number, terminalRows: number): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const prefix = [border, "", ...this.headerLines(width), "", ...this.degradedWarningLines(width)];
		const descriptionLines = wrapDescriptionLines(theme, USAGE_DESCRIPTION, "dim", width);
		const availableDashboardRows = Math.max(
			1,
			terminalRows - prefix.length - USAGE_TAIL_FIXED_LINE_COUNT - descriptionLines.length,
		);
		const dashboard = this.dashboardLines(width, availableDashboardRows).slice(0, availableDashboardRows);
		while (dashboard.length < availableDashboardRows) dashboard.push("");
		const tail = [
			"",
			...descriptionLines,
			"",
			fitLine(
				hintRow(theme, this.dashboardHints(width)),
				width,
			),
			"",
			border,
		];
		return fitToTerminalHeight([...prefix, ...dashboard, ...tail], terminalRows, border);
	}

	private headerLines(width: number): string[] {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold("Context Usage"));
		const summary = this.reportedSummary();
		if (width < MAP_SIDE_BY_SIDE_MIN_WIDTH) {
			return [fitLine(title, width), "", fitLine(summary, width)];
		}

		const normalizedModel = normalizeInlineText(this.usage.modelLabel ?? "");
		const separator = theme.fg("dim", " · ");
		const fullMetadata = normalizedModel === ""
			? summary
			: `${theme.fg("muted", normalizedModel)}${separator}${summary}`;
		const zoomLabel = this.zoomLabel(width);
		if (zoomLabel !== undefined) {
			const titleWithZoom = `${title}${separator}${zoomLabel}`;
			if (visibleWidth(titleWithZoom) + 1 + visibleWidth(fullMetadata) <= width) {
				return [spreadLine(titleWithZoom, fullMetadata, width)];
			}
			if (visibleWidth(titleWithZoom) + 1 + visibleWidth(summary) <= width) {
				return [spreadLine(titleWithZoom, summary, width)];
			}
			if (visibleWidth(title) + 1 + visibleWidth(summary) <= width) {
				return [spreadLine(title, summary, width), "", fitLine(zoomLabel, width)];
			}
			return [
				fitLine(title, width),
				"",
				fitLine(zoomLabel, width),
				"",
				fitLine(summary, width),
			];
		}

		if (visibleWidth(title) + 1 + visibleWidth(fullMetadata) <= width) {
			return [spreadLine(title, fullMetadata, width)];
		}
		if (visibleWidth(title) + 1 + visibleWidth(summary) <= width) {
			return [spreadLine(title, summary, width)];
		}
		return [fitLine(title, width), "", fitLine(summary, width)];
	}

	private toggleMapScale(): void {
		if (!this.canToggleMapScale(this.currentWidth)) return;
		this.mapScale = this.mapScale === "window" ? "fit" : "window";
		this.clearCache();
	}

	private canToggleMapScale(width: number | undefined): boolean {
		const contextWindow = this.usage.reported?.contextWindow;
		return width !== undefined &&
			width >= MAP_SIDE_BY_SIDE_MIN_WIDTH &&
			contextWindow !== undefined &&
			this.fitMapScale !== undefined &&
			this.fitMapScale < contextWindow;
	}

	private zoomLabel(width: number): string | undefined {
		const contextWindow = this.usage.reported?.contextWindow;
		if (
			this.mapScale !== "fit" ||
			!this.canToggleMapScale(width) ||
			contextWindow === undefined ||
			this.fitMapScale === undefined
		) return undefined;
		return this.theme.fg(
			"mdHeading",
			`Zoom ${formatUsageTokens(contextWindow)} → ${formatUsageTokens(this.fitMapScale)}`,
		);
	}

	private dashboardHints(width: number): Array<readonly [string, string]> {
		const hints: Array<readonly [string, string]> = [
			[STEP_KEY_HINT, "Navigate"],
			["Enter", "Preview"],
		];
		if (this.canToggleMapScale(width)) hints.push(["Z", "Zoom"]);
		hints.push(["Esc", "Close"]);
		return hints;
	}

	private dashboardLines(width: number, rows: number): string[] {
		const scaleTokens = this.mapScale === "fit" ? this.fitMapScale : undefined;
		const map = buildUsageMap(
			this.usage,
			DEFAULT_MAP_COLUMNS,
			DEFAULT_MAP_ROWS,
			scaleTokens,
		);
		if (map === undefined || width < MAP_SIDE_BY_SIDE_MIN_WIDTH) {
			return this.detailLines(width, rows, undefined).map((line) => fitLine(line, width));
		}

		const spaced = width >= SPACED_MAP_MIN_WIDTH;
		const separator = spaced ? " " : "";
		const mapLines = Array.from({ length: map.rows }, (_, row) => {
			const start = row * map.columns;
			const cells = map.cells.slice(start, start + map.columns);
			return `${BODY_INDENT}${cells.map((cell) => this.mapCell(cell)).join(separator)}`;
		});
		const mapWidth = BODY_INDENT.length + map.columns + (spaced ? map.columns - 1 : 0);
		const gap = spaced ? SPACED_MAP_COLUMN_GAP : MAP_COLUMN_GAP;
		const detailWidth = Math.max(1, width - mapWidth - gap);
		const details = this.detailLines(detailWidth, rows, map);
		const lineCount = Math.max(mapLines.length, details.length);
		return Array.from({ length: lineCount }, (_, index) => {
			const mapLine = mapLines[index] ?? " ".repeat(mapWidth);
			const detail = fitLine(details[index] ?? "", detailWidth);
			return fitLine(`${mapLine}${" ".repeat(gap)}${detail}`, width);
		});
	}

	private detailLines(width: number, rows: number, map: UsageMap | undefined): string[] {
		const theme = this.theme;
		const keyLines = map === undefined ? [] : this.mapKeyLines(map, width, rows);
		const reservedLineCount = DETAIL_CATEGORY_HEADER_LINE_COUNT +
			(keyLines.length === 0 ? 0 : keyLines.length + 1);
		const viewport = calculateViewport(this.legendRows.length, rows, reservedLineCount);
		this.navigator.setVisibleCount(viewport.visibleCount);

		const heading = theme.fg("mdHeading", theme.bold("Category:"));
		const rowWidth = Math.max(1, width - CURSOR_COLUMN_WIDTH);
		const columns = this.legendColumns(rowWidth);
		const visibleRows: string[] = [];
		const start = this.navigator.offset;
		for (let index = start; index < start + this.navigator.windowSize; index++) {
			const row = this.legendRows[index];
			if (row === undefined) break;
			const selected = index === this.navigator.selected;
			const cursor = selected ? theme.fg("accent", "→ ") : "  ";
			visibleRows.push(fitLine(`${cursor}${this.legendLine(row, columns, rowWidth, selected)}`, width));
		}
		const counterLines = viewport.showScroll
			? [fitLine(
				theme.fg("dim", `${BODY_INDENT}(${this.navigator.visibleEnd}/${this.legendRows.length})`),
				width,
			)]
			: [];
		return [
			heading,
			...visibleRows,
			...counterLines,
			...(keyLines.length === 0 ? [] : ["", ...keyLines]),
		].slice(0, rows);
	}

	private mapKeyLines(map: UsageMap, width: number, rows: number): string[] {
		const spare = rows - DETAIL_CATEGORY_HEADER_LINE_COUNT - this.legendRows.length;
		if (spare < MAP_KEY_COMPACT_SPARE_ROWS) return [];
		if (spare < MAP_KEY_DETAILED_SPARE_ROWS) return [this.compactMapKeyLine(map, width)];
		const theme = this.theme;
		const sizeLabel = theme.fg("muted", `${MAP_KEY_SIZE_LABEL}: `);
		return [
			fitLine(theme.fg("mdHeading", theme.bold("Map:")), width),
			fitLine(this.mapKeyEntry("text", FULL_CELL, theme.fg("muted", MAP_KEY_FULL_DESCRIPTION)), width),
			fitLine(this.mapKeyEntry("text", PARTIAL_CELL, theme.fg("muted", MAP_KEY_PART_DESCRIPTION)), width),
			fitLine(this.mapKeyEntry("dim", FREE_CELL, `${sizeLabel}${this.blockSizeText(map, true)}`), width),
		];
	}

	private mapKeyEntry(glyphColor: ThemeColor, glyph: string, text: string): string {
		return `${BODY_INDENT}${this.theme.fg(glyphColor, glyph)}${this.theme.fg("dim", " - ")}${text}`;
	}

	private compactMapKeyLine(map: UsageMap, width: number): string {
		const theme = this.theme;
		const heading = theme.fg("mdHeading", theme.bold("Map:"));
		const separator = theme.fg("dim", " · ");
		const full = `${theme.fg("text", FULL_CELL)}${theme.fg("muted", " One category")}`;
		const partial = `${theme.fg("text", PARTIAL_CELL)}${theme.fg("muted", " Mixed")}`;
		const size = (withPercent: boolean) =>
			`${theme.fg("dim", FREE_CELL)} ${this.blockSizeText(map, withPercent)}`;
		const prefix = `${heading} ${full}${separator}${partial}${separator}`;
		const detailed = `${prefix}${size(true)}`;
		if (visibleWidth(detailed) <= width) return detailed;
		const withoutPercent = `${prefix}${size(false)}`;
		if (visibleWidth(withoutPercent) <= width) return withoutPercent;
		const shortenedFull = `${theme.fg("text", FULL_CELL)}${theme.fg("muted", " One")}`;
		return fitLine(`${heading} ${shortenedFull}${separator}${partial}${separator}${size(false)}`, width);
	}

	private blockSizeText(map: UsageMap, withPercent: boolean): string {
		const percent = withPercent ? formatUsagePercent(1 / (map.columns * map.rows)) : "";
		const tokens = formatUsageTokens(Math.round(map.blockTokens));
		return this.theme.fg(
			this.mapScale === "fit" ? "mdHeading" : "muted",
			percent === "" ? tokens : `${tokens} (${percent})`,
		);
	}

	private reportedSummary(): string {
		const reported = this.usage.reported;
		if (reported === undefined) return this.theme.fg("muted", "Context usage unavailable.");
		const contextWindow = formatUsageTokens(reported.contextWindow);
		if (reported.tokens === undefined) {
			const percent = formatUsagePercent(this.usage.estimatedTokens / reported.contextWindow);
			return this.theme.fg(
				"text",
				`≈${formatUsageTokens(this.usage.estimatedTokens)}/${contextWindow} (${percent})`,
			);
		}
		const percent = reported.percent === undefined ? "" : ` (${formatUsagePercent(reported.percent / 100)})`;
		return this.theme.fg("text", `${formatUsageTokens(reported.tokens)}/${contextWindow}${percent}`);
	}

	private legendColumns(width: number): LegendColumns {
		const rows = this.legendRows;
		const labelWidth = Math.max(1, ...rows.map((row) => this.plainLegendLabel(row).length));
		const tokenWidth = Math.max(1, ...rows.map((row) => formatUsageTokens(legendTokens(row)).length));
		const percentWidth = Math.max(0, ...rows.map((row) => this.plainLegendPercent(legendTokens(row)).length));
		const rightWidth = tokenWidth + (percentWidth > 0 ? LEGEND_VALUE_GAP + percentWidth : 0);
		const idealValue = Math.min(MAX_LEGEND_VALUE_COLUMN, labelWidth + LEGEND_LEADER_GAP);
		return {
			value: Math.max(1, Math.min(idealValue, width - rightWidth)),
			tokenWidth,
		};
	}

	private legendLine(row: LegendRow, columns: LegendColumns, width: number, selected: boolean): string {
		const labelWidth = Math.max(1, columns.value - 1);
		const left = fitLine(this.styledLegendLabel(row, selected), labelWidth);
		const leader = dimDotLeader(this.theme, columns.value - visibleWidth(left));
		const tokens = formatUsageTokens(legendTokens(row));
		const valueColor = selected ? "accent" : row.type === "category" && row.depth > 1 ? "dim" : "muted";
		const tokenPadding = " ".repeat(Math.max(0, columns.tokenWidth - tokens.length));
		const percent = this.plainLegendPercent(legendTokens(row));
		const percentPart = percent === ""
			? ""
			: `${" ".repeat(LEGEND_VALUE_GAP)}${this.theme.fg(selected ? "accent" : "dim", percent)}`;
		return fitLine(
			`${left}${leader}${this.theme.fg(valueColor, tokens)}${tokenPadding}${percentPart}`,
			width,
		);
	}

	private plainLegendLabel(row: LegendRow): string {
		if (row.type === "buffer") return `${BUFFER_CELL} Auto-Compact Buffer`;
		if (row.type === "free") return `${FREE_CELL} Free Space`;
		const indent = "  ".repeat(row.depth);
		return `${indent}${categoryMarker(row.category.id, row.depth)} ${normalizeInlineText(row.category.label)}`;
	}

	private styledLegendLabel(row: LegendRow, selected: boolean): string {
		if (row.type === "buffer") {
			return `${this.theme.fg("dim", BUFFER_CELL)} ${this.theme.fg("text", "Auto-Compact Buffer")}`;
		}
		if (row.type === "free") {
			return `${this.theme.fg("dim", FREE_CELL)} ${this.theme.fg(selected ? "accent" : "text", "Free Space")}`;
		}
		const indent = "  ".repeat(row.depth);
		const color = categoryColor(row.rootId);
		const marker = this.theme.fg(color, categoryMarker(row.category.id, row.depth));
		const labelColor = selected ? "accent" : row.depth === 0 ? "text" : row.depth === 1 ? "muted" : "dim";
		return `${indent}${marker} ${this.theme.fg(labelColor, normalizeInlineText(row.category.label))}`;
	}

	private plainLegendPercent(tokens: number): string {
		const contextWindow = this.usage.reported?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return "";
		return formatUsagePercent(tokens / contextWindow);
	}

	private mapCell(cell: UsageMapCell): string {
		if (cell.fill === "buffer") return this.theme.fg("dim", BUFFER_CELL);
		if (cell.fill === "free") return this.theme.fg("dim", FREE_CELL);
		const glyph = cell.categoryId === "compacted-data"
			? COMPACTED_CELL
			: cell.fill === "full" ? FULL_CELL : PARTIAL_CELL;
		return this.theme.fg(categoryColor(cell.categoryId), glyph);
	}

	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		const reason = normalizeInlineText(this.input.degradedReason);
		return wrapTextWithAnsi(this.theme.fg("warning", `${BODY_INDENT}${reason}`), width);
	}

	private handlePreviewInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.closePreview();
			return;
		}
		const wheel = parseWheelDirection(data);
		if (wheel !== undefined) {
			const moved = wheel < 0 ? this.blockNavigator.stepBack() : this.blockNavigator.stepForward();
			if (moved) this.clearCache();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openBlock();
		} else if (isStepBackKey(data)) {
			if (this.blockNavigator.stepBack()) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.blockNavigator.stepForward()) this.clearCache();
		} else if (isPageBackKey(data)) {
			if (this.blockNavigator.page(-1)) this.clearCache();
		} else if (isPageForwardKey(data)) {
			if (this.blockNavigator.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.blockNavigator.moveToFirst()) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.blockNavigator.moveToLast()) this.clearCache();
		}
	}

	private handleBlockInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.closeBlock();
			return;
		}
		const wheel = parseWheelDirection(data);
		if (wheel !== undefined) {
			if (this.previewScroller.scrollBy(wheel * this.wheelScrollLines)) this.clearCache();
			return;
		}
		if (isStepBackKey(data)) {
			if (this.previewScroller.scrollBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.previewScroller.scrollBy(1)) this.clearCache();
		} else if (isPageBackKey(data)) {
			if (this.previewScroller.page(-1)) this.clearCache();
		} else if (isPageForwardKey(data)) {
			if (this.previewScroller.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.previewScroller.scrollTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.previewScroller.scrollTo(this.previewScroller.maxOffset)) this.clearCache();
		}
	}

	private openPreview(): void {
		const row = this.legendRows[this.navigator.selected];
		if (row === undefined || row.type !== "category") return;
		this.previewRow = row;
		this.cachedPreviewEntries = undefined;
		this.clearPreviewContent();
		this.blockNavigator.reset();
		this.clearCache();
	}

	private closePreview(): void {
		this.previewRow = undefined;
		this.openBlockIndex = undefined;
		this.cachedPreviewEntries = undefined;
		this.clearPreviewContent();
		this.clearCache();
	}

	private openBlock(): void {
		const index = this.blockNavigator.selected;
		const block = this.cachedStream?.blocks[index];
		if (block === undefined || block.hiddenLineCount === 0) return;
		this.openBlockIndex = index;
		this.cachedBlockBody = undefined;
		this.previewScroller.reset();
		this.clearCache();
	}

	private closeBlock(): void {
		this.openBlockIndex = undefined;
		this.cachedBlockBody = undefined;
		this.clearCache();
	}

	private clearPreviewContent(): void {
		this.cachedContent = undefined;
		this.cachedStream = undefined;
		this.cachedBlockBody = undefined;
	}

	private renderPreview(width: number, terminalRows: number, row: CategoryLegendRow): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const descriptionLines = this.previewDescriptionLines(width, row);
		const descriptionLineCount = descriptionLines.length === 0 ? 0 : descriptionLines.length + 1;
		const stream = this.previewStream(width, previewBlockMaxLines(terminalRows, descriptionLineCount), row);
		const viewport = calculateViewport(
			Math.max(1, stream.layout.lines.length),
			terminalRows,
			PREVIEW_FIXED_LINE_COUNT,
			descriptionLineCount,
		);
		this.blockNavigator.setExtent(stream.layout, viewport.visibleCount);

		const lines: string[] = [border, "", this.categoryHeaderLine(row, width), ""];
		lines.push(...this.previewStreamLines(stream, viewport.visibleCount, width));
		if (viewport.showScroll) {
			lines.push(
				fitLine(
					theme.fg("dim", `${BODY_INDENT}(${this.blockNavigator.selected + 1}/${stream.blocks.length})`),
					width,
				),
			);
		}
		if (descriptionLines.length > 0) lines.push("", ...descriptionLines);
		lines.push("");
		lines.push(fitLine(hintRow(theme, previewHints(stream.blocks.length)), width));
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	private renderBlockView(
		width: number,
		terminalRows: number,
		row: CategoryLegendRow,
		entry: UsagePreviewEntry,
	): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const body = this.blockBodyLines(width, row, entry);
		const viewport = calculateViewport(body.length, terminalRows, BLOCK_FIXED_LINE_COUNT);
		this.previewScroller.setExtent(body.length, viewport.visibleCount);

		const lines: string[] = [
			border,
			"",
			this.categoryHeaderLine(row, width),
			"",
			fitLine(`${BODY_INDENT}${this.entryHeader(entry)}`, width),
			"",
		];
		const start = this.previewScroller.offset;
		for (let index = start; index < start + viewport.visibleCount; index++) {
			lines.push(body[index] ?? "");
		}
		if (viewport.showScroll) {
			lines.push(
				fitLine(theme.fg("dim", `${BODY_INDENT}(${this.previewScroller.visibleEnd}/${body.length})`), width),
			);
		}
		lines.push("");
		lines.push(
			fitLine(
				hintRow(theme, [
					[STEP_KEY_HINT, "Scroll"],
					["PgUp/PgDn", "Page"],
					["Esc", "Back"],
				]),
				width,
			),
		);
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	private categoryHeaderLine(row: CategoryLegendRow, width: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold(normalizeInlineText(row.category.label)));
		const percent = this.plainLegendPercent(row.category.tokens);
		const meta = theme.fg(
			"muted",
			`${formatUsageTokens(row.category.tokens)}${percent === "" ? "" : ` · ${percent}`} `,
		);
		return spreadLine(title, meta, width);
	}

	private previewStreamLines(stream: PreviewStream, visibleCount: number, width: number): string[] {
		if (stream.blocks.length === 0) {
			const message = this.theme.fg("muted", `${BODY_INDENT}No content captured for this category.`);
			return Array.from({ length: visibleCount }, (_, index) => index === 0 ? fitLine(message, width) : "");
		}
		const start = this.blockNavigator.offset;
		return Array.from(
			{ length: visibleCount },
			(_, index) => this.previewStreamLine(stream, start + index, width),
		);
	}

	private previewStreamLine(stream: PreviewStream, index: number, width: number): string {
		const ref = stream.layout.lines[index];
		if (ref === undefined) return "";
		const block = stream.blocks[ref.blockIndex];
		if (block === undefined) return "";
		const selected = ref.blockIndex === this.blockNavigator.selected;
		const line = ref.lineIndex < block.lines.length
			? block.lines[ref.lineIndex] ?? ""
			: this.truncationMarker(block.hiddenLineCount, selected);
		const gutter = this.blockGutter(selected, line === "");
		return fitLine(`${gutter}${line}`, width);
	}

	private blockGutter(selected: boolean, blankLine: boolean): string {
		if (!selected) return blankLine ? "" : BODY_INDENT;
		return this.theme.fg("accent", blankLine ? BLOCK_GUTTER : `${BLOCK_GUTTER} `);
	}

	private truncationMarker(hiddenLineCount: number, selected: boolean): string {
		const marker = `${BODY_INDENT}${this.theme.fg("dim", `… +${hiddenLineCount} lines`)}`;
		if (!selected) return marker;
		const separator = this.theme.fg("dim", " · ");
		const action = this.theme.fg("accent", "Enter - View Block");
		return `${marker}${separator}${action}`;
	}

	private previewStream(width: number, maxLines: number, row: CategoryLegendRow): PreviewStream {
		const wrapWidth = previewWrapWidth(width);
		const cached = this.cachedStream;
		if (cached !== undefined && cached.wrapWidth === wrapWidth && cached.maxLines === maxLines) return cached;
		const content = this.previewContent(width, row);
		const blocks = this.previewEntries(row).map((entry, index) => {
			const lines = content[index] ?? [];
			return {
				lines: [this.entryHeader(entry), ...lines.slice(0, maxLines)],
				hiddenLineCount: Math.max(0, lines.length - maxLines),
			};
		});
		this.cachedStream = {
			wrapWidth,
			maxLines,
			blocks,
			layout: layoutPreviewBlocks(blocks.map(blockHeight)),
		};
		return this.cachedStream;
	}

	private previewContent(width: number, row: CategoryLegendRow): readonly EntryLines[] {
		const wrapWidth = previewWrapWidth(width);
		if (this.cachedContent !== undefined && this.cachedContent.wrapWidth === wrapWidth) {
			return this.cachedContent.entries;
		}
		const compactSkills = row.rootId === "user-messages";
		const entries = this.previewEntries(row)
			.map((entry) => this.entryContentLines(entry, wrapWidth, compactSkills));
		this.cachedContent = { wrapWidth, entries };
		return entries;
	}

	private blockBodyLines(width: number, row: CategoryLegendRow, entry: UsagePreviewEntry): readonly string[] {
		if (this.cachedBlockBody !== undefined && this.cachedBlockBody.width === width) {
			return this.cachedBlockBody.lines;
		}
		const wrapWidth = previewWrapWidth(width);
		const content = this.entryContentLines(entry, wrapWidth, row.rootId === "user-messages");
		const lines = content.map((line) => line === "" ? "" : fitLine(`${BODY_INDENT}${line}`, width));
		this.cachedBlockBody = { width, lines };
		return lines;
	}

	private openBlockEntry(row: CategoryLegendRow): UsagePreviewEntry | undefined {
		if (this.openBlockIndex === undefined) return undefined;
		return this.previewEntries(row)[this.openBlockIndex];
	}

	private previewEntries(row: CategoryLegendRow): readonly UsagePreviewEntry[] {
		this.cachedPreviewEntries ??= collectPreviewEntries(row.category);
		return this.cachedPreviewEntries;
	}

	private entryHeader(entry: UsagePreviewEntry): string {
		const theme = this.theme;
		const cells: string[] = [];
		if (entry.timestamp !== undefined) {
			cells.push(theme.fg("dim", `[${formatEntryTimestamp(entry.timestamp)}]`));
		}
		entry.breadcrumb.forEach((cell, index) => {
			const color: ThemeColor = index === 0 ? "mdHeading" : "muted";
			cells.push(
				`${theme.fg("dim", "[")}${theme.fg(color, normalizeInlineText(cell))}${theme.fg("dim", "]")}`,
			);
		});
		cells.push(theme.fg("dim", formatUsageTokens(entry.visibleTokens ?? entry.tokens)));
		if (entry.invisibleReasoning !== undefined) {
			const { tokens, basis, encoded } = entry.invisibleReasoning;
			const marker = basis === "provider-reported" ? "≈" : "~";
			const label = encoded ? "Encoded" : "Reasoning";
			const total = (entry.visibleTokens ?? entry.tokens) + tokens;
			cells.push(
				theme.fg("dim", `+ ${label} ${marker}${formatUsageTokens(tokens)} (${marker}${formatUsageTokens(total)})`),
			);
		}
		return cells.join(" ");
	}

	private previewDescriptionLines(width: number, row: CategoryLegendRow): string[] {
		if (row.rootId !== "agent-thinking-messages") return [];
		const hasInvisibleReasoning = this.previewEntries(row)
			.some((entry) => entry.invisibleReasoning !== undefined);
		return hasInvisibleReasoning
			? wrapDescriptionLines(this.theme, INVISIBLE_REASONING_DESCRIPTION, "dim", width)
			: [];
	}

	private entryContentLines(entry: UsagePreviewEntry, wrapWidth: number, compactSkills: boolean): string[] {
		const lines: string[] = [];
		for (const paragraph of this.entryPreviewText(entry.text, compactSkills).split("\n")) {
			const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
			const paragraphLines = wrapped.length === 0 ? [""] : wrapped;
			for (const line of paragraphLines) lines.push(line === "" ? "" : `${BODY_INDENT}${line}`);
		}
		return lines;
	}

	private entryPreviewText(text: string, compactSkills: boolean): string {
		const sanitized = normalizePreviewText(text);
		if (!compactSkills) return sanitized;
		return splitSkillPreview(sanitized)
			.map((segment) => segment.type === "text" ? segment.text : this.skillBadge(segment.name))
			.join("");
	}

	private skillBadge(name: string): string {
		const label = this.theme.fg("customMessageLabel", this.theme.bold("[skill]"));
		const safeName = normalizeInlineText(name);
		if (safeName === "") return label;
		return `${label} ${this.theme.fg("customMessageText", safeName)}`;
	}

	private clearCache(): void {
		this.cachedWidth = undefined;
		this.cachedTerminalRows = undefined;
		this.cachedLines = undefined;
	}
}

function previewWrapWidth(width: number): number {
	return Math.max(10, width - BODY_INDENT.length * 2 - 1);
}

function previewBlockMaxLines(terminalRows: number, descriptionLineCount: number): number {
	const visibleCount = terminalRows - PREVIEW_FIXED_LINE_COUNT - descriptionLineCount - 1;
	const fitted = Math.floor((visibleCount - TWO_BLOCK_FRAME_ROWS) / 2);
	return Math.max(PREVIEW_BLOCK_MIN_LINES, Math.min(PREVIEW_BLOCK_MAX_LINES, fitted));
}

function previewHints(blockCount: number): Array<readonly [string, string]> {
	if (blockCount === 0) return [["Esc", "Back"]];
	return [[STEP_KEY_HINT, "Navigate"], ["PgUp/PgDn", "Page"], ["Esc", "Back"]];
}

function blockHeight(block: PreviewBlock): number {
	return block.lines.length + (block.hiddenLineCount > 0 ? 1 : 0);
}
