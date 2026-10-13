import type { ContextUsageSnapshot, UsageCategory } from "../context-usage.ts";

/** A selectable legend row for one usage category. */
export interface CategoryLegendRow {
	readonly type: "category";
	readonly category: UsageCategory;
	readonly depth: number;
	readonly rootId: string;
}

/** The non-selectable auto-compact buffer row. */
export interface BufferLegendRow {
	readonly type: "buffer";
	readonly tokens: number;
}

/** The non-selectable free-space row. */
export interface FreeLegendRow {
	readonly type: "free";
	readonly tokens: number;
}

/** One Usage legend row. */
export type LegendRow = CategoryLegendRow | BufferLegendRow | FreeLegendRow;

export function buildUsageLegendRows(usage: ContextUsageSnapshot): LegendRow[] {
	const rows: LegendRow[] = buildCategoryLegendRows(usage.categories);
	const bufferTokens = autoCompactBufferTokens(usage);
	if (bufferTokens > 0) rows.push({ type: "buffer", tokens: bufferTokens });
	const freeTokens = freeSpaceTokens(usage);
	if (freeTokens !== undefined) rows.push({ type: "free", tokens: freeTokens });
	return rows;
}

/** Token estimate carried by category, buffer, or free-space legend rows. */
export function legendTokens(row: LegendRow): number {
	return row.type === "category" ? row.category.tokens : row.tokens;
}

function buildCategoryLegendRows(categories: readonly UsageCategory[]): CategoryLegendRow[] {
	const rows: CategoryLegendRow[] = [];
	for (const category of categories) {
		rows.push({ type: "category", category, depth: 0, rootId: category.id });
		if (category.id !== "tool-output") continue;
		for (const child of category.children ?? []) {
			rows.push({ type: "category", category: child, depth: 1, rootId: category.id });
		}
	}
	return rows;
}

function autoCompactBufferTokens(usage: ContextUsageSnapshot): number {
	const contextWindow = usage.reported?.contextWindow;
	const reserve = usage.autoCompactReserveTokens;
	if (contextWindow === undefined || contextWindow <= 0 || reserve === undefined) return 0;
	return Math.min(reserve, Math.max(0, contextWindow - usage.estimatedTokens));
}

function freeSpaceTokens(usage: ContextUsageSnapshot): number | undefined {
	const contextWindow = usage.reported?.contextWindow;
	if (contextWindow === undefined || contextWindow <= 0) return undefined;
	return Math.max(0, contextWindow - usage.estimatedTokens - autoCompactBufferTokens(usage));
}
