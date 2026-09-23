/**
 * What `/skills` knows: one row per skill pi loaded, a draft of which ones the
 * model may reach for, and the filter and cursor that sit over them.
 *
 * Pure — no pi access, no filesystem. The view renders this and the command
 * applies it; both are testable because neither decision lives in them.
 */

import type { Skill, SourceInfo } from "@earendil-works/pi-coding-agent";

/** One skill as the dialog sees it: what pi loaded, plus what the user wants. */
export interface SkillRow {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	/** Where this skill came from: `user`, `project`, or the package that ships it. */
	readonly scope: string;
	/** Muted on disk, as pi loaded it. */
	readonly muted: boolean;
}

/** A row plus its position in the unfiltered list, so drafts survive filtering. */
interface IndexedRow {
	readonly row: SkillRow;
	readonly index: number;
}

/** One file the apply pass must rewrite. */
export interface SkillChange {
	readonly name: string;
	readonly filePath: string;
	readonly muted: boolean;
}

/**
 * Build the dialog's rows from the skills pi handed over.
 *
 * Sorted by name rather than by load order: the list is read as an alphabet,
 * and pi's order is discovery order, which changes when a directory does.
 */
export function buildRows(skills: readonly Skill[]): SkillRow[] {
	return skills
		.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			scope: describeScope(skill.sourceInfo),
			muted: skill.disableModelInvocation,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Where a skill came from, in one word, for the row's right-hand column.
 *
 * A packaged skill is named by its package, because `user` would be true and
 * useless — every package this harness loads is installed under the user
 * scope, so the scope word cannot tell two of them apart. A path-like package
 * name is shortened to its last segment (`~/dotfiles/pi/kit` becomes `kit`),
 * which is the part that differs.
 */
function describeScope(sourceInfo: SourceInfo): string {
	if (sourceInfo.origin !== "package") return sourceInfo.scope;
	const segments = sourceInfo.source.split("/").filter((segment) => segment.length > 0);
	return segments.at(-1) ?? sourceInfo.source;
}

/**
 * The dialog's mutable state: the draft, the filter, and the cursor.
 *
 * Drafts are keyed by unfiltered index, so typing a filter, toggling, and
 * clearing the filter keeps every earlier toggle. The alternative — dropping
 * drafts that scroll out of view — is the bug that makes a filter unsafe to
 * use, and a filter nobody trusts is a filter nobody uses.
 */
export class SkillDraft {
	private readonly rows: readonly SkillRow[];
	private readonly draft: boolean[];
	private query = "";
	private cursor = 0;

	public constructor(rows: readonly SkillRow[]) {
		this.rows = rows;
		this.draft = rows.map((row) => row.muted);
	}

	/** Rows matching the current filter, in display order. */
	public visible(): IndexedRow[] {
		const needle = this.query.trim().toLowerCase();
		const all = this.rows.map((row, index) => ({ row, index }));
		if (needle.length === 0) return all;
		return all.filter(({ row }) =>
			row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle),
		);
	}

	public getQuery(): string {
		return this.query;
	}

	/** Replace the filter, clamping the cursor into whatever still matches. */
	public setQuery(query: string): void {
		this.query = query;
		this.cursor = clamp(this.cursor, this.visible().length);
	}

	public getCursor(): number {
		return this.cursor;
	}

	public moveCursor(delta: number): void {
		this.cursor = clamp(this.cursor + delta, this.visible().length);
	}

	public setCursor(position: number): void {
		this.cursor = clamp(position, this.visible().length);
	}

	/** Whether this row is muted in the draft (not necessarily on disk yet). */
	public isMuted(index: number): boolean {
		return this.draft[index] ?? false;
	}

	/** Whether this row's draft differs from disk. */
	public isChanged(index: number): boolean {
		return this.draft[index] !== this.rows[index]?.muted;
	}

	/** Flip the row under the cursor. No-op when the filter matches nothing. */
	public toggleAtCursor(): void {
		const target = this.visible()[this.cursor];
		if (target === undefined) return;
		this.draft[target.index] = !this.draft[target.index];
	}

	/** Discard every draft edit and return to what is on disk. */
	public reset(): void {
		for (const [index, row] of this.rows.entries()) this.draft[index] = row.muted;
	}

	/** Every row whose draft differs from disk, in list order. */
	public changes(): SkillChange[] {
		return this.rows.flatMap((row, index) =>
			this.draft[index] === row.muted
				? []
				: [{ name: row.name, filePath: row.filePath, muted: this.draft[index] ?? row.muted }],
		);
	}

	/** How many skills the model can reach for in the draft. */
	public activeCount(): number {
		return this.draft.filter((muted) => !muted).length;
	}

	public total(): number {
		return this.rows.length;
	}
}

function clamp(value: number, length: number): number {
	if (length === 0) return 0;
	return Math.max(0, Math.min(length - 1, value));
}
