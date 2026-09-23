/**
 * model-family — the newest release of a model family, read from pi's own
 * catalog rather than from a list anyone maintains.
 *
 * `pi/agents/*.md` pin models by family word (`model: opus`, `model: luna`),
 * and that has to mean "the newest opus" on the day it runs. Until 2026-09-20
 * the answer came from `enabledModels` in pi's settings, a hand-kept allowlist
 * holding one id per family; that list went when `pi/models.json` did, because
 * pi now ships every model this machine uses and a second copy of the catalog
 * only rots.
 *
 * The question it answered is still real. A substring search over the registry
 * answers `opus` with whatever sorts first — `claude-opus-4-5` — and `luna`
 * with `gpt-5.6-luna`, so every spawn ran releases behind while looking
 * correct (issues/40). There is no such fallback any more: a spec this module
 * cannot rank resolves to nothing.
 *
 * Two id shapes carry a family, and nothing else does:
 * `claude-<family>-<n>[-<n>…]` (Anthropic) and `gpt-<n>[.<n>…]-<family>`
 * (OpenAI). Version segments are compared as numbers, the one ordering either
 * vendor's ids have ever followed, and the comparison is total over the ids pi
 * lists — there is no tie to break between two distinct ids of one family.
 *
 * {@link newestPerFamily} gives that answer once, at the source. It is the cut
 * `extensions/model-catalog.ts` applies to pi's own providers, so the catalog
 * this process holds has one id per family per provider and an older release
 * is not a thing any seat can be put on — `--model`, Ctrl+P, `/model`, a
 * resumed session and an engine child all read those providers.
 *
 * Two kinds of id the cut drops, both declared limits rather than defects: a
 * dated pin (`claude-haiku-4-5-20251001`) is the same release with its date
 * appended, and an id off both shapes (`gpt-5.5`, `gpt-5.3-codex-spark`) has
 * no family to rank it in. A caller that wants a release names its family word.
 *
 * {@link newestInFamily} resolves an agent type's `model:` spec across every
 * provider, and refuses rather than picks when two providers carry the family.
 * {@link familyOf} and {@link commandLineModelSpec} give the wire the two facts
 * it needs to say which family the launcher asked for.
 */

/** One entry of pi's model registry, narrowed to what a family search reads. */
export interface CatalogEntry {
	readonly provider: string;
	readonly id: string;
}

/**
 * What a model spec names in the catalog: one model, several providers'
 * models that the spec cannot choose between, or nothing.
 */
export type ModelFamilyAnswer<T extends CatalogEntry> =
	| { readonly kind: "found"; readonly model: T }
	| { readonly kind: "ambiguous"; readonly candidates: readonly T[] }
	| { readonly kind: "none" };

/**
 * The model a spec names, searched across every provider in `catalog`: the id
 * itself when pi lists it, otherwise the newest release sharing its family
 * word (`opus`, `claude-opus-4-6` → `claude-opus-5-5`; `luna` → `gpt-6-luna`).
 *
 * Two providers answering is `ambiguous`, never a pick: `openai/gpt-6-luna`
 * and `openai-codex/gpt-6-luna` are billed and authenticated differently, and
 * which one a seat runs on is the caller's to say with a `provider/` prefix.
 */
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

/**
 * The catalog cut to one model per family: the newest undated release of each,
 * in first-seen order. A dated pin and an id off both family shapes are
 * dropped — neither can be ranked, and an unrankable id in a filtered catalog
 * is an older release nobody can see. Apply it to one provider's list at a time.
 */
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

/**
 * The family word of a model spec: `claude-opus-4-6` → `opus`, `gpt-6-luna` →
 * `luna`, and the bare alias `luna` → `luna`. A provider prefix and a thinking
 * suffix are stripped first, so the spec a launcher writes
 * (`anthropic/claude-fable-5-1:medium`) reads the same as the id pi ends up
 * on. `undefined` off both id shapes (`gpt-5.5`, `claude-test`).
 *
 * Aliases and ids share one reader because they are the same question asked
 * twice, and two readers is how `sonnet` came to mean a different model from
 * `claude-sonnet-5`.
 */
export function familyOf(spec: string): string | undefined {
	const bare = spec.trim().toLowerCase().split("/").pop()?.split(":")[0] ?? "";
	return GPT_MODEL_ID.exec(bare)?.[2] ?? CLAUDE_MODEL_ID.exec(bare)?.[1] ?? (FAMILY_WORD.test(bare) ? bare : undefined);
}

/**
 * The model spec the launcher named on the command line, or `undefined` when it
 * named none and pi's `defaultModel` decides instead.
 *
 * Matched on the whole token, never a prefix: `--models` is a different flag
 * (the Ctrl+P scope), and a reader that accepted either would read the scope
 * list as the seat's model on every `bin/chat`-shaped launcher that grows one.
 */
export function commandLineModelSpec(argv: readonly string[]): string | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--model") return argv[index + 1];
		if (arg.startsWith("--model=")) return arg.slice("--model=".length);
	}
	return undefined;
}

/**
 * The numeric version of a model id — `gpt-5.6-luna` → `[5, 6]`,
 * `claude-opus-5-5` → `[5, 5]` — or `undefined` for a dated pin or an id off
 * both shapes. An eight-digit segment is a release date, not a version: it
 * would otherwise sort `claude-haiku-4-5-20251001` above the release it pins.
 */
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

/** Element-wise numeric order, a missing segment reading as zero: `5` beats `4-8`, `5-1` beats `5`. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}
