import { HOME_GLYPH } from "../../lib/ui/home-glyph.ts";
import { BOTTOM_ENDS, type Paint, type Piece, rule, RULE_CORNER_COLUMNS, ruleFitsWhole } from "../../lib/ui/labelled-rule.ts";

export function insignia(paint: Paint): Piece[] {
	return [{ text: HOME_GLYPH, paint, atomic: true }];
}

/** The labels the bottom rule carries, the readings named in the order they are given up. */
export interface BottomLabels {
	branch: Piece[];
	tasks: Piece[];
	timer: Piece[];
	cache: Piece[];
	context: Piece[];
	scroll: Piece[];
}

export function bottomRule(width: number, labels: BottomLabels, dash: Paint): string {
	const body = width - RULE_CORNER_COLUMNS;
	const full = [...labels.timer, ...labels.cache, ...labels.context];
	if (labels.cache.length > 0 && ruleFitsWhole(body, labels.branch, labels.tasks, full))
		return rule(width, labels.branch, full, dash, BOTTOM_ENDS, labels.tasks, labels.scroll);
	const timed = [...labels.timer, ...labels.context];
	if (labels.timer.length > 0 && ruleFitsWhole(body, labels.branch, labels.tasks, timed))
		return rule(width, labels.branch, timed, dash, BOTTOM_ENDS, labels.tasks, labels.scroll);
	if (labels.tasks.length > 0 && ruleFitsWhole(body, labels.branch, labels.tasks, labels.context))
		return rule(width, labels.branch, labels.context, dash, BOTTOM_ENDS, labels.tasks, labels.scroll);
	return rule(width, labels.branch, labels.context, dash, BOTTOM_ENDS, [], labels.scroll);
}

/** The context reading the bottom rule ends on, and how alarming it is. */
export interface ContextReading {
	label: string;
	level: "normal" | "warning" | "critical";
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

export function contextReading(tokens: number | null, percent: number | null): ContextReading {
	return {
		label: tokens === null ? "?" : formatTokens(tokens),
		level: percent === null ? "normal" : percent > 90 ? "critical" : percent > 70 ? "warning" : "normal",
	};
}

/** `/Users/joel/code/pi` → `{ghost}/code/pi`, leaving paths outside home alone. */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home || home.length === 0) return cwd;
	if (cwd === home) return HOME_GLYPH;
	const prefix = home.endsWith("/") ? home : `${home}/`;
	return cwd.startsWith(prefix) ? `${HOME_GLYPH}/${cwd.slice(prefix.length)}` : cwd;
}
