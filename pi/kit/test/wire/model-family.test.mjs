/**
 * The resolver that makes half of 2026-09-01 unrepeatable: `lib/models/model-family.ts`
 * — an alias names the newest release of its family, so a child cannot run
 * several releases behind while its frontmatter looks right.
 *
 * The other half of that day was a child session spawned without the wire
 * extension, which died on Anthropic's 400 billing wall. That guard is gone
 * with the vendor tool whose `isolated: true` flag was the only way to ask for
 * one: the owned engine builds every child's loader itself
 * (`extensions/agent-engine/index.ts`), and there is no argument that can strip an
 * extension off it. The error class is closed by construction rather than
 * refused at the door.
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });

const { commandLineModelSpec, compactAtFor, familyOf, newestInFamily, newestPerFamily } = await jiti.import(`${KIT_ROOT}/lib/models/model-family.ts`);

const entry = (id) => ({ provider: "anthropic", id });
const codexEntry = (id) => ({ provider: "openai-codex", id });
/** A fixture standing in for pi's catalog: every Claude family and the Codex ids, oldest to newest. */
const FIXTURE = [
	"claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5",
	"claude-fable-5", "claude-fable-5-1",
	"claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
	"claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5",
].map(entry).concat(["gpt-5.3-codex-spark", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"].map(codexEntry));

/** The id `newestInFamily` answers with, or its kind when it answers with no one model. */
const resolve = (spec, catalog = FIXTURE) => {
	const answer = newestInFamily(spec, catalog);
	return answer.kind === "found" ? answer.model.id : answer.kind;
};

// ---------------------------------------------------------------------------
section("model-family: an alias is the newest of its family");
{
	check("every alias lands on the newest release", [["sonnet", "claude-sonnet-5"], ["fable", "claude-fable-5-1"], ["opus", "claude-opus-5"], ["haiku", "claude-haiku-5-5"], ["luna", "gpt-6-luna"], ["sol", "gpt-6-sol"]].every(([alias, id]) => resolve(alias) === id));
	check("haiku resolves to claude-haiku-5-5", resolve("haiku") === "claude-haiku-5-5");
	check("a minor version beats its own major", resolve("fable") === "claude-fable-5-1");
	check("a major beats every minor below it", resolve("opus") === "claude-opus-5" && resolve("luna") === "gpt-6-luna");
	check("a release date is not a version", newestInFamily("haiku", ["claude-haiku-4-5", "claude-haiku-4-5-20251001"].map(entry)).model.id === "claude-haiku-4-5");
	check("case does not matter", resolve("SONNET") === "claude-sonnet-5" && resolve("Claude-Opus-4-6") === "claude-opus-4-6" && resolve("LUNA") === "gpt-6-luna");
	check("surrounding whitespace does not matter", resolve("  fable  ") === "claude-fable-5-1");
	check("the answer is the catalog's own entry, provider and all", newestInFamily("luna", FIXTURE).model === FIXTURE.find((e) => e.id === "gpt-6-luna"));
}

// ---------------------------------------------------------------------------
section("model-family: every provider is searched, and two answering is refused");
{
	// `luna` read through Anthropic alone, then a substring search, answered
	// gpt-5.6-luna — the first id containing the word. Both halves are gone.
	check("a family on a non-Anthropic provider resolves", resolve("luna") === "gpt-6-luna");
	check("no substring answer: a word inside an id is not its family", resolve("lun") === "none" && resolve("gpt") === "none" && resolve("6-luna") === "none");
	check("an id off both shapes is still found when named exactly", resolve("gpt-5.5") === "gpt-5.5" && resolve("gpt-5.3-codex-spark") === "gpt-5.3-codex-spark");
	check("but has no family to fall back to", resolve("gpt-5.4") === "none");
	const both = FIXTURE.concat([{ provider: "openai", id: "gpt-5.6-luna" }, { provider: "openai", id: "gpt-6-luna" }]);
	const ambiguous = newestInFamily("luna", both);
	check("a family two providers carry is ambiguous, never picked", ambiguous.kind === "ambiguous");
	check("and names each provider's newest", ambiguous.candidates?.map((e) => `${e.provider}/${e.id}`).sort().join(",") === "openai-codex/gpt-6-luna,openai/gpt-6-luna", JSON.stringify(ambiguous));
	check("an id two providers list is ambiguous too", newestInFamily("gpt-6-luna", both).kind === "ambiguous");
	check("a provider's own newer release does not settle it", newestInFamily("luna", FIXTURE.concat([{ provider: "openai", id: "gpt-5.6-luna" }])).kind === "ambiguous");
	check("a family one provider carries is not made ambiguous by another's families", resolve("opus", both) === "claude-opus-5");
}

// ---------------------------------------------------------------------------
section("model-family: what it declines to answer");
{
	// A caller that spelled out a release asked for that release. The alias is
	// the way to say "newest", and it is the only way.
	check("an id pi lists is returned as asked", resolve("claude-opus-4-6") === "claude-opus-4-6" && resolve("gpt-5.6-luna") === "gpt-5.6-luna");
	check("a dated pin pi lists is returned as asked", resolve("claude-haiku-4-5-20251001") === "claude-haiku-4-5-20251001");
	check("an id pi does not list falls back to its family", resolve("claude-opus-4-9") === "claude-opus-5" && resolve("gpt-5.9-luna") === "gpt-6-luna");

	check("a family pi does not carry is refused, not guessed", resolve("claude-nonesuch-9") === "none");
	check("an off-pattern spec is refused", resolve("...") === "none");
	check("an empty catalog answers nothing", resolve("sonnet", []) === "none");
}

// ---------------------------------------------------------------------------
section("model-family: the cut that leaves one release per family");
{
	// A seat's model is not a spec this module resolves — pi picks it from
	// `defaultModel`, `--model`, a session header or Ctrl+P, before and after any
	// extension loads. So the answer is given to the catalog instead: what is not
	// in it cannot be picked from any of those directions.
	const ids = (models) => models.map((model) => model.id).join(",");
	check("one id survives per family, the newest of it", ids(newestPerFamily(FIXTURE.filter((e) => e.provider === "anthropic"))) === "claude-sonnet-5,claude-fable-5-1,claude-opus-5,claude-haiku-5-5", ids(newestPerFamily(FIXTURE)));
	check("the same cut reads Codex ids, and drops the ones off the gpt-<n.n>-<family> shape", ids(newestPerFamily(FIXTURE.filter((e) => e.provider === "openai-codex"))) === "gpt-6-luna,gpt-6-sol,gpt-6-astra", ids(newestPerFamily(FIXTURE.filter((e) => e.provider === "openai-codex"))));
	check("a dated pin is dropped — it names a release the undated id already carries", !ids(newestPerFamily(FIXTURE)).includes("20251001"));
	check("an off-pattern id is dropped rather than kept unranked", ids(newestPerFamily([{ id: "claude-opus-5" }, { id: "..." }, { id: "gpt-5.5" }, { id: "gpt-5.3-codex-spark" }])) === "claude-opus-5");
	check("a bare family word is not a release", ids(newestPerFamily([{ id: "opus" }])) === "");
	check("an empty catalog cuts to nothing", newestPerFamily([]).length === 0);
	check("the objects come back as they went in, not copies", newestPerFamily([FIXTURE[3]])[0] === FIXTURE[3]);
	check("and the cut is idempotent — filtering a filtered catalog changes nothing", ids(newestPerFamily(newestPerFamily(FIXTURE))) === ids(newestPerFamily(FIXTURE)));
	// What the filter leaves is what `newestInFamily` then resolves against: the
	// alias still lands on the one id, and a superseded id no longer resolves at all.
	check("an alias resolves inside the cut", resolve("opus", newestPerFamily(FIXTURE.filter((e) => e.provider === "anthropic"))) === "claude-opus-5");

	check("a family word survives a provider prefix and a thinking suffix", familyOf("anthropic/claude-fable-5-1:medium") === "fable");
	check("and reads the same off the id pi lands on", familyOf("claude-fable-5-1") === "fable" && familyOf("fable") === "fable");
	check("a Codex id reads its family off the end", familyOf("openai-codex/gpt-6-luna:high") === "luna" && familyOf("gpt-5.6-luna") === "luna");
	check("an off-pattern spec has no family", familyOf("...") === undefined && familyOf("") === undefined && familyOf("gpt-5.5") === undefined && familyOf("claude-test") === undefined);

	check("every Haiku id compacts at 95k, whatever its shape", ["claude-haiku-4-5", "claude-3-5-haiku-20241022", "anthropic.claude-haiku-4-5-v1:0", "anthropic/Claude-Haiku-5:medium"].every((id) => compactAtFor(id, undefined) === 95000) && compactAtFor("claude-opus-5", 300000) === 300000);

	// `--models` is the Ctrl+P scope, a different flag. A reader that matched on a
	// prefix would read the scope list as the seat's model.
	check("--model is read, as a whole token", commandLineModelSpec(["pi", "--model", "anthropic/claude-opus-5"]) === "anthropic/claude-opus-5");
	check("and in its = form", commandLineModelSpec(["pi", "--model=opus"]) === "opus");
	check("--models is not --model", commandLineModelSpec(["pi", "--models", "claude-*"]) === undefined);
	check("a launcher that names none says so", commandLineModelSpec(["pi", "-p", "hello"]) === undefined);
	check("the first --model wins, as pi's own parser takes it", commandLineModelSpec(["pi", "--model", "opus", "--model", "haiku"]) === "opus");
}

await finish();
