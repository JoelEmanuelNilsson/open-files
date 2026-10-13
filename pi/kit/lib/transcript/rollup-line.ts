import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { CALL_LIGHT, shadeLine, waveEnabled } from "../ui/prism-light.ts";
import { clip, type Piece, paintWrapped } from "./row-text.ts";
import type { Paint } from "../ui/labelled-rule.ts";
import { GUTTER, GUTTER_WIDTH } from "./result-row.ts";
import { DOT } from "./tool-row.ts";

const WAVE = waveEnabled();

const INDENT = "  ";
const INDENT_WIDTH = 2;
const ELLIPSIS = "…";
const MIN_ROOM = 8;

export type Tense = "present" | "past";

interface Phrase {
	lead: string;
	doing: string;
	unit: string;
	units: string;
	rank: number;
	nouns?: boolean;
}

const PHRASES: Record<string, Phrase> = {
	read: { lead: "Read", doing: "Reading", unit: "file", units: "files", rank: 1, nouns: true },
	bash: { lead: "Ran", doing: "Running", unit: "shell command", units: "shell commands", rank: 3 },
	powershell: { lead: "Ran", doing: "Running", unit: "shell command", units: "shell commands", rank: 3 },
};

/** Whether a settled, successful call of this tool is allowed to disappear into a count. */
export function collapsible(tool: string): boolean {
	return tool in PHRASES;
}

export interface Clause {
	lead: string;
	count: number;
	unit: string;
	units: string;
}

export function clausesFor(tools: readonly string[], tense: Tense = "past", subjects?: readonly (string | undefined)[]): Clause[] {
	const ranked: { clause: Clause; rank: number }[] = [];
	const seen = new Map<string, Clause>();
	const counted = new Map<string, Set<string>>();
	for (const [index, tool] of tools.entries()) {
		const phrase = PHRASES[tool];
		if (!phrase) continue;
		const lead = tense === "present" ? phrase.doing : phrase.lead;
		if (subjects !== undefined) {
			const subject = subjects[index];
			if (subject === undefined) continue;
			if (phrase.nouns === true) {
				const already = counted.get(lead) ?? new Set<string>();
				counted.set(lead, already);
				if (already.has(subject)) continue;
				already.add(subject);
			}
		}
		const found = seen.get(lead);
		if (found) {
			found.count++;
			continue;
		}
		const clause: Clause = { lead, count: 1, unit: phrase.unit, units: phrase.units };
		seen.set(lead, clause);
		ranked.push({ clause, rank: phrase.rank });
	}
	ranked.sort((a, b) => a.rank - b.rank);
	return ranked.map((entry) => entry.clause);
}

function leadOf(clause: Clause, first: boolean): string {
	return first ? clause.lead : clause.lead.charAt(0).toLowerCase() + clause.lead.slice(1);
}

function unitOf(clause: Clause): string {
	return clause.count === 1 ? clause.unit : clause.units;
}

function clauseText(clause: Clause, first: boolean): string {
	return `${leadOf(clause, first)} ${clause.count} ${unitOf(clause)}`;
}

/** The plain spelling, for tests and for the stamp the cache is keyed on. */
export function rollupText(clauses: readonly Clause[]): string {
	return clauses.map((clause, index) => clauseText(clause, index === 0)).join(", ");
}

export interface RollupPaints {
	word: Paint;
	count: Paint;
	dot: Paint;
	gutter: Paint;
	hint: Paint;
}

function pieces(clauses: readonly Clause[], paints: RollupPaints): Piece[] {
	const out: Piece[] = [];
	clauses.forEach((clause, index) => {
		const first = index === 0;
		const last = index === clauses.length - 1;
		out.push({ plain: `${first ? "" : " "}${leadOf(clause, first)} `, paint: paints.word });
		out.push({ plain: `${clause.count}`, paint: paints.count });
		out.push({ plain: ` ${unitOf(clause)}${last ? "" : ","}`, paint: paints.word });
	});
	return out;
}

export class RollupLine implements Component {
	private clauses: readonly Clause[] = [];
	private live = false;
	private elapsed: string | null = null;
	private hint: string | undefined;
	private startedAt: number | undefined;
	private paints: RollupPaints = { word: (t) => t, count: (t) => t, dot: (t) => t, gutter: (t) => t, hint: (t) => t };
	private stamp = "";
	private cache: { width: number; stamp: string; lines: string[] } | undefined;

	set(clauses: readonly Clause[], paints: RollupPaints, live = false, elapsed: string | null = null, hint?: string, startedAt?: number): void {
		this.clauses = clauses;
		this.live = live;
		this.startedAt = live ? startedAt : undefined;
		this.hint = live ? hint : undefined;
		this.elapsed = live ? elapsed : null;
		this.paints = paints;
		this.stamp = `${live ? "live" : "done"}\u0000${this.elapsed ?? ""}\u0000${this.hint ?? ""}\u0000${rollupText(clauses)}`;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		const cached = this.cache;
		if (cached && cached.width === width && cached.stamp === this.stamp) return this.lit(cached.lines);
		const lines = this.layout(width);
		this.cache = { width, stamp: this.stamp, lines };
		return this.lit(lines);
	}

	private lit(lines: string[]): string[] {
		if (this.startedAt === undefined || !WAVE) return lines;
		try {
			const t = Math.max(0, Date.now() - this.startedAt) / 1000;
			return lines.map((line) => shadeLine(line, t, "self", { light: CALL_LIGHT }));
		} catch {
			return lines;
		}
	}

	private layout(width: number): string[] {
		const room = width - INDENT_WIDTH;
		if (this.clauses.length === 0 || room < MIN_ROOM) return [];
		const said = pieces(this.clauses, this.paints);
		if (this.elapsed) said.push({ plain: ` · ${this.elapsed}`, paint: this.paints.word });
		const last = said[said.length - 1];
		if (this.live && last) said[said.length - 1] = { plain: last.plain + ELLIPSIS, paint: last.paint };
		const lines = paintWrapped(said, room);
		if (!this.live) return lines.map((line) => INDENT + line);
		const drawn = lines.map((line, index) => (index === 0 ? `${this.paints.dot(DOT)} ${line}` : INDENT + line));
		if (this.hint === undefined || width <= GUTTER_WIDTH) return drawn;
		drawn.push(this.paints.gutter(GUTTER) + this.paints.hint(clip(this.hint, width - GUTTER_WIDTH)));
		return drawn;
	}
}

export function rollupPaints(theme: Theme): RollupPaints {
	const word: Paint = (text) => theme.fg("muted", text);
	return {
		word,
		count: (text) => theme.bold(word(text)),
		dot: (text) => theme.fg("dim", text),
		gutter: (text) => theme.fg("dim", text),
		hint: (text) => theme.fg("toolOutput", text),
	};
}
