import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { clip, type Piece, paintPieces } from "../../lib/transcript/row-text.ts";
import type { Paint } from "../../lib/ui/labelled-rule.ts";
import { DOT } from "../../lib/transcript/tool-row.ts";
import type { LaunchCall, LaunchOutcome } from "./agent-launch-group.ts";

const INDENT = "  ";
const ELLIPSIS = "…";
const MIN_WIDTH = 12;
const MANAGE_HINT = " (↓ to manage)";

export interface LaunchLinePaints {
	dot: Paint;
	lead: Paint;
	count: Paint;
	tree: Paint;
	type: Paint;
	description: Paint;
	hint: Paint;
}

export function launchLinePaints(theme: Theme, settled: boolean): LaunchLinePaints {
	return {
		dot: (text) => theme.fg(settled ? "success" : "dim", text),
		lead: (text) => theme.fg("muted", text),
		count: (text) => theme.bold(theme.fg("text", text)),
		tree: (text) => theme.fg("dim", text),
		type: (text) => theme.bold(theme.fg("toolTitle", text)),
		description: (text) => theme.fg("muted", text),
		hint: (text) => theme.fg("dim", text),
	};
}

export interface LaunchLineFields {
	outcomes: (LaunchOutcome | undefined)[];
	calls: (LaunchCall | undefined)[];
	settled: boolean;
}

export class LaunchLine implements Component {
	private fields: LaunchLineFields = { outcomes: [], calls: [], settled: false };
	private paints: LaunchLinePaints = blankPaints();
	private stamp = "";
	private cache: { width: number; stamp: string; lines: string[] } | undefined;

	set(fields: LaunchLineFields, paints: LaunchLinePaints): void {
		this.fields = fields;
		this.paints = paints;
		this.stamp = [
			fields.settled,
			named(fields)
				.map((entry) => (entry ? `${entry.displayName}\u0001${entry.description}` : ""))
				.join("\u0002"),
		].join("\u0000");
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		const cached = this.cache;
		if (cached && cached.width === width && cached.stamp === this.stamp) return cached.lines;
		const lines = this.layout(width);
		this.cache = { width, stamp: this.stamp, lines };
		return lines;
	}

	private layout(width: number): string[] {
		if (width < MIN_WIDTH) return [];
		const { outcomes, settled } = this.fields;
		const count = outcomes.length;
		if (count === 0) return [];
		const paints = this.paints;

		const head: Piece[] = settled
			? [
					{ plain: `${count}`, paint: paints.count },
					{ plain: ` background agent${count === 1 ? "" : "s"} launched`, paint: paints.lead },
				]
			: [
					{ plain: "Launching ", paint: paints.lead },
					{ plain: `${count}`, paint: paints.count },
					{ plain: ` agent${count === 1 ? "" : "s"}${ELLIPSIS}`, paint: paints.lead },
				];

		const room = width - visibleWidth(`${DOT} `);
		const headWidth = head.reduce((total, piece) => total + visibleWidth(piece.plain), 0);
		const withHint = settled && room - headWidth >= visibleWidth(MANAGE_HINT) ? [...head, { plain: MANAGE_HINT, paint: paints.hint }] : head;
		const lines = [paints.dot(DOT) + " " + paintPieces(withHint)];

		const entries = named(this.fields).filter((entry): entry is LaunchCall => entry !== undefined);
		if (entries.length === 0) return lines;

		const column = Math.max(...entries.map((entry) => visibleWidth(entry.displayName)));
		entries.forEach((entry, index) => {
			const glyph = index === entries.length - 1 ? "└─ " : "├─ ";
			const name = entry.displayName;
			const pad = " ".repeat(Math.max(0, column - visibleWidth(name)) + 2);
			const used = visibleWidth(INDENT + glyph + name + pad);
			const description = clip(entry.description, Math.max(0, width - used));
			lines.push(paints.tree(INDENT + glyph) + paints.type(name) + pad + paints.description(description));
		});
		return lines;
	}
}

function named(fields: LaunchLineFields): (LaunchCall | undefined)[] {
	return fields.outcomes.map((outcome, index) => {
		if (outcome) return { displayName: outcome.displayName, description: outcome.description };
		return fields.calls[index];
	});
}

function blankPaints(): LaunchLinePaints {
	const same: Paint = (text) => text;
	return { dot: same, lead: same, count: same, tree: same, type: same, description: same, hint: same };
}
