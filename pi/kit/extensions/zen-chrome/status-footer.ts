import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { AGENT_TASK_STATUS_KEY } from "../../lib/agents/agent-task-count.ts";
import { fitDockRows } from "./dock-layout-rows.ts";

const MUTED_STATUSES = new Set(["claude-oauth-ready"]);

const RULE_STATUSES = new Set([AGENT_TASK_STATUS_KEY]);

/** Status text on one line: newlines in it would break the single-line footer. */
export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** The status footer component, for `ctx.ui.setFooter`. */
export function createStatusFooter(tui: TUI, theme: Theme, data: ReadonlyFooterDataProvider): Component & { dispose(): void } {
	const fit = fitDockRows(tui, () => footer);
	const footer = {
		dispose: data.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render(width: number): string[] {
			const shown = Array.from(data.getExtensionStatuses().entries())
				.filter(([key]) => !MUTED_STATUSES.has(key) && !RULE_STATUSES.has(key))
				.sort(([a], [b]) => a.localeCompare(b));
			if (shown.length === 0) {
				fit(0);
				return [];
			}
			fit(1);
			const line = shown.map(([, text]) => sanitizeStatusText(text)).join(" ");
			return [truncateToWidth(line, width, theme.fg("dim", "..."))];
		},
	};
	return footer;
}
