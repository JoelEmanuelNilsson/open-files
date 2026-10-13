import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** Map cell wholly one category; top-level legend marker. */
export const FULL_CELL = "■";
/** Map cell shared by several categories, colored by the largest. */
export const PARTIAL_CELL = "◧";
/** Map cell and legend marker for compacted data. */
export const COMPACTED_CELL = "▦";
/** Map cell and legend marker for the auto-compact buffer. */
export const BUFFER_CELL = "⛝";
/** Map cell and legend marker for free space. */
export const FREE_CELL = "⛶";
/** Legend marker of a nested breakdown row. */
export const BREAKDOWN_MARKER = "•";

/** Marker distinguishing top-level occupancy, compacted data, and nested breakdowns. */
export function categoryMarker(categoryId: string, depth: number): string {
	if (depth > 0) return BREAKDOWN_MARKER;
	return categoryId === "compacted-data" ? COMPACTED_CELL : FULL_CELL;
}

/** Stable semantic theme color for one category across map cells and legend markers. */
export function categoryColor(categoryId: string | undefined): ThemeColor {
	switch (categoryId) {
		case "system-prompt":
		case "system-tools":
			return "mdHeading";
		case "custom-tools":
			return "accent";
		case "mcp-tools":
			return "mdLink";
		case "context-files":
			return "mdCodeBlock";
		case "skills":
			return "customMessageLabel";
		case "user-messages":
			return "syntaxString";
		case "agent-text-messages":
			return "syntaxFunction";
		case "agent-thinking-messages":
			return "thinkingXhigh";
		case "agent-tool-call-messages":
			return "syntaxKeyword";
		case "tool-output":
			return "toolOutput";
		case "extension-messages":
			return "syntaxType";
		case "compacted-data":
			return "thinkingHigh";
		default:
			return "muted";
	}
}
