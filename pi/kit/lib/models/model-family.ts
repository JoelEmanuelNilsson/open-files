/** One entry of pi's model registry, narrowed to what a family search reads. */
export interface CatalogEntry {
	readonly provider: string;
	readonly id: string;
}

export type ModelFamilyAnswer<T extends CatalogEntry> =
	| { readonly kind: "found"; readonly model: T }
	| { readonly kind: "ambiguous"; readonly candidates: readonly T[] }
	| { readonly kind: "none" };

export function newestInFamily<T extends CatalogEntry>(spec: string, catalog: readonly T[]): ModelFamilyAnswer<T> {
	const wanted = spec.trim().toLowerCase();
	const exact = catalog.filter((entry) => entry.id.toLowerCase() === wanted);
	if (exact.length > 0) return oneOrAmbiguous(exact);
	const family = familyOf(wanted);
	if (family === undefined) return { kind: "none" };
	const newestPerProvider = new Map<string, { model: T; version: readonly number[] }>();
	for (const entry of catalog) {
		const id = entry.id.toLowerCase();
		if (familyOf(id) !== family) continue;
		const version = versionOf(id);
		if (version === undefined) continue;
		const held = newestPerProvider.get(entry.provider);
		if (held === undefined || compareVersions(version, held.version) > 0) newestPerProvider.set(entry.provider, { model: entry, version });
	}
	return oneOrAmbiguous([...newestPerProvider.values()].map((held) => held.model));
}

function oneOrAmbiguous<T extends CatalogEntry>(matches: readonly T[]): ModelFamilyAnswer<T> {
	if (matches.length === 0) return { kind: "none" };
	return matches.length === 1 ? { kind: "found", model: matches[0] } : { kind: "ambiguous", candidates: matches };
}

export function newestPerFamily<T extends { readonly id: string }>(models: readonly T[]): readonly T[] {
	const best = new Map<string, { model: T; version: readonly number[] }>();
	for (const model of models) {
		const id = model.id.toLowerCase();
		const family = familyOf(id);
		const version = versionOf(id);
		if (family === undefined || version === undefined) continue;
		const held = best.get(family);
		if (held === undefined || compareVersions(version, held.version) > 0) best.set(family, { model, version });
	}
	return [...best.values()].map((entry) => entry.model);
}

const CLAUDE_MODEL_ID = /^claude-([a-z]+)-(.+)$/;
const GPT_MODEL_ID = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;
const FAMILY_WORD = /^[a-z]+$/;

export function familyOf(spec: string): string | undefined {
	const bare = spec.trim().toLowerCase().split("/").pop()?.split(":")[0] ?? "";
	return GPT_MODEL_ID.exec(bare)?.[2] ?? CLAUDE_MODEL_ID.exec(bare)?.[1] ?? (FAMILY_WORD.test(bare) ? bare : undefined);
}

export function commandLineModelSpec(argv: readonly string[]): string | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--model") return argv[index + 1];
		if (arg.startsWith("--model=")) return arg.slice("--model=".length);
	}
	return undefined;
}

/** Whether a model id's release is `floor` or newer (`claude-sonnet-5` against `[4, 7]` → true); false for an id with no version. */
export function modelReleaseAtLeast(id: string, floor: readonly number[]): boolean {
	const version = versionOf(id.toLowerCase());
	return version !== undefined && compareVersions(version, floor) >= 0;
}

function versionOf(id: string): readonly number[] | undefined {
	const gpt = GPT_MODEL_ID.exec(id);
	if (gpt !== null) return gpt[1].split(".").map(Number);
	const tail = CLAUDE_MODEL_ID.exec(id)?.[2];
	if (tail === undefined) return undefined;
	const version: number[] = [];
	for (const segment of tail.split("-")) {
		if (!/^\d+$/.test(segment)) return undefined;
		if (segment.length === 8) return undefined;
		version.push(Number(segment));
	}
	return version;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** Haiku bills a whole request at 5x once its input passes 100k, so every Haiku child compacts here. */
export const HAIKU_COMPACT_AT = 95000;

/** Where a child on `modelId` compacts: Haiku's fixed threshold, else the type's `compact_at`, else never. */
export function compactAtFor(modelId: string, typeCompactAt: number | undefined): number | undefined {
	return modelId.toLowerCase().includes("haiku") ? HAIKU_COMPACT_AT : typeCompactAt;
}
