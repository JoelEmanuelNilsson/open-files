import type { Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { newestPerFamily } from "../lib/model-family.ts";

/**
 * A release Anthropic ships that pi's catalog has not caught up with. It is
 * built from the sibling pi does ship (`from`), so compat, the thinking-level
 * map, prompt-cache lifetimes and input limits stay the vendor's; only the id,
 * the name and the price are owned. Prices are the platform docs' base input,
 * output, cache hit and 5-minute cache write, in USD per million tokens.
 */
interface AheadOfPi {
	readonly id: string;
	readonly name: string;
	readonly from: string;
	readonly cost: Model<"anthropic-messages">["cost"];
}

/**
 * Each entry leaves when pi lists its id: the vendor's definition wins by
 * construction below, and `test/model-catalog.mjs` fails until the entry is
 * deleted, so a stale copy cannot shadow the real one.
 */
export const AHEAD_OF_PI: readonly AheadOfPi[] = [];

/**
 * pi's Anthropic catalog with every {@link AHEAD_OF_PI} release pi does not
 * list yet appended, derived from its sibling. An id pi lists is left as pi
 * defines it; an entry whose sibling is gone is skipped, and the test says so.
 */
export function withReleasesAheadOfPi(models: readonly Model<"anthropic-messages">[], ahead: readonly AheadOfPi[] = AHEAD_OF_PI): Model<"anthropic-messages">[] {
	const out = [...models];
	for (const release of ahead) {
		if (out.some((model) => model.id === release.id)) continue;
		const sibling = out.find((model) => model.id === release.from);
		if (sibling === undefined) continue;
		out.push({ ...sibling, id: release.id, name: release.name, cost: release.cost });
	}
	return out;
}

/**
 * Cuts every superseded Anthropic and OpenAI Codex release out of this process,
 * by registering pi's own provider for each with a filtered catalog in place of
 * the built-in one.
 *
 * pi ships each provider's whole catalog in-process, so `claude-opus-4-5` is one
 * Ctrl+P away from any seat, and a `defaultModel`, a `--model`, a resumed
 * session header or an agent type's frontmatter written weeks ago can put a
 * seat on it silently. Until 2026-09-22 `extensions/wire.ts` only said so,
 * after the request had gone out.
 *
 * A witness is the wrong strength for this one: there is no reason to run a
 * release Anthropic has replaced, so the fix is that the process does not have
 * one. Every read of a model goes through the provider's `getModels()` —
 * `getModel`, `getAvailable`, the runtime snapshot Ctrl+P paints and the
 * registry a child seat shares — so a filter there is the whole catalog, and a
 * spec naming a dropped id resolves to nothing rather than to an old model.
 *
 * The provider object is pi's own, spread: auth, OAuth and streaming stay the
 * vendor's code, and a native registration with no `models.json` entry for
 * "anthropic" becomes the composition base untouched. Registering in the
 * factory puts it in the runtime before the session's model is resolved.
 *
 * Consequence, by choice: a dated pin (`claude-haiku-4-5-20251001`) is gone
 * too. It names a release the undated id already carries, and pinning a date
 * only matters for reproducing an old response, which is not what this machine
 * does. For Codex the same cut drops ids off the `gpt-<n.n>-<family>` shape
 * (`gpt-5.5`, `gpt-5.3-codex-spark`), and the native registration replaces
 * the pi.dev remote-catalog overlay pi wraps its built-in Codex provider in:
 * a Codex release reaches this process with a pi release, like a Claude one.
 */
export default function modelCatalog(pi: ExtensionAPI): void {
	const anthropic = anthropicProvider();
	pi.registerProvider({ ...anthropic, getModels: () => newestPerFamily(withReleasesAheadOfPi(anthropic.getModels())) });
	const codex = openaiCodexProvider();
	pi.registerProvider({ ...codex, getModels: () => newestPerFamily(codex.getModels()) });
}
