import type { Skill, SourceInfo } from "@earendil-works/pi-coding-agent";

/** One skill as the dialog sees it: what pi loaded, plus what the user wants. */
export interface SkillRow {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly scope: string;
	readonly muted: boolean;
}

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

export function buildSkillRows(skills: readonly Skill[]): SkillRow[] {
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

function describeScope(sourceInfo: SourceInfo): string {
	if (sourceInfo.origin !== "package") return sourceInfo.scope;
	const segments = sourceInfo.source.split("/").filter((segment) => segment.length > 0);
	return segments.at(-1) ?? sourceInfo.source;
}

export class SkillDraft {
	private readonly rows: readonly SkillRow[];
	private readonly draft: boolean[];
	private query = "";
	private cursor = 0;

	public constructor(rows: readonly SkillRow[]) {
		this.rows = rows;
		this.draft = rows.map((row) => row.muted);
	}

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

	public isMuted(index: number): boolean {
		return this.draft[index] ?? false;
	}

	public isChanged(index: number): boolean {
		return this.draft[index] !== this.rows[index]?.muted;
	}

	public toggleAtCursor(): void {
		const target = this.visible()[this.cursor];
		if (target === undefined) return;
		this.draft[target.index] = !this.draft[target.index];
	}

	public reset(): void {
		for (const [index, row] of this.rows.entries()) this.draft[index] = row.muted;
	}

	public changes(): SkillChange[] {
		return this.rows.flatMap((row, index) =>
			this.draft[index] === row.muted
				? []
				: [{ name: row.name, filePath: row.filePath, muted: this.draft[index] ?? row.muted }],
		);
	}

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
