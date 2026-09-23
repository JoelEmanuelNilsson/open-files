/**
 * The line and the tree a batch of launches draws.
 *
 *     ● Launching 3 agents…
 *       ├─ Explore  where the parser lives
 *       └─ Agent    write the missing tests
 *
 *     ● 3 background agents launched (↓ to manage)
 *       ├─ Explore  where the parser lives
 *       ├─ Agent    write the missing tests
 *       └─ Agent    audit the error paths
 *
 * The tree grows in real time. A row appears the moment a call's arguments have
 * finished streaming — its type and description are in them — and is replaced
 * by what the launch reported when it returns. So a batch of three is one row,
 * then two, then three, each true when it is drawn, and the count above them
 * says how many are coming. Claude Code's shape, in this kit's grammar: the dot in column 0 and the words
 * in column 2, exactly where a `● Agent(…)` header would have put them, so the
 * swap from the present tense to the past moves no word. The count is bold and
 * the unit is not, the way every count in this transcript is.
 *
 * The type column is padded to the widest name in the batch. Descriptions are
 * the thing being read down, and a ragged left edge on three of them costs more
 * than the few spaces it saves.
 *
 * `(↓ to manage)` is the only hint on the line, and it points at the tasks modal
 * `agent-dock` opens. It is dropped first when the pane is too narrow, because
 * it is an offer and the count is a fact.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { clip, type Paint, type Piece, paintPieces } from "../transcript/line.ts";
import { DOT } from "../transcript/row.ts";
import type { LaunchCall, LaunchOutcome } from "./agent-launch-group.ts";

/** The column the tool name sits in on a full row, so this line starts where `Agent` would. */
const INDENT = "  ";
const ELLIPSIS = "…";
/** Below this there is no room to say anything true, so nothing is said. */
const MIN_WIDTH = 12;
/** What the offer costs in columns before it is worth dropping. */
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
	/** One entry per launch, in the order pi drew them. Undefined until it settles. */
	outcomes: (LaunchOutcome | undefined)[];
	/** What each launch asked for, in the same order. Undefined while its arguments stream. */
	calls: (LaunchCall | undefined)[];
	/** Every launch has come back, so the line speaks in the past tense. */
	settled: boolean;
}

/**
 * Laid out in `render(width)` and cached there, like every other row in this
 * transcript: neither render slot is handed a width, and zen-chrome asks the TUI
 * for a frame every 33ms while the agent works.
 */
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

		// The tree names every launch that has said what it is for — from its
		// arguments while it is out, from its result once it is back. A launch still
		// streaming its arguments is counted above and not yet named below, so
		// nothing drawn is ever taken back.
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

/** Each launch's name and purpose: what it reported if it is back, what it asked for if not. */
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
