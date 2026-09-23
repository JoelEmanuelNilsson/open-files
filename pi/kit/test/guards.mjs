/**
 * The resolver that makes half of 2026-09-01 unrepeatable: `lib/model-family.ts`
 * — an alias names the newest release of its family, so a child cannot run
 * several releases behind while its frontmatter looks right.
 *
 * The other half of that day was a child session spawned without the wire
 * extension, which died on Anthropic's 400 billing wall. That guard is gone
 * with the vendor tool whose `isolated: true` flag was the only way to ask for
 * one: the owned engine builds every child's loader itself
 * (`extensions/agent-engine.ts`), and there is no argument that can strip an
 * extension off it. The error class is closed by construction rather than
 * refused at the door.
 */

import "./env.mjs";
import { TEST_FILES } from "./files.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const DATA = `${PI}/node_modules/@earendil-works/pi-ai/dist/providers/data`;
const CATALOG = `${DATA}/anthropic.json`;
const CODEX_CATALOG = `${DATA}/openai-codex.json`;

const { commandLineModelSpec, familyOf, newestInFamily, newestPerFamily } = await jiti.import(`${ROOT}/lib/model-family.ts`);
const { withReleasesAheadOfPi } = await jiti.import(`${ROOT}/extensions/model-catalog.ts`);

const entry = (id) => ({ provider: "anthropic", id });
const codexEntry = (id) => ({ provider: "openai-codex", id });
/** A fixture standing in for pi's catalog: every Claude family and the Codex ids, oldest to newest. */
const FIXTURE = [
	"claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5",
	"claude-fable-5", "claude-fable-5-1",
	"claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
	"claude-haiku-4-5", "claude-haiku-4-5-20251001",
].map(entry).concat(["gpt-5.3-codex-spark", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"].map(codexEntry));

/** The id `newestInFamily` answers with, or its kind when it answers with no one model. */
const resolve = (spec, catalog = FIXTURE) => {
	const answer = newestInFamily(spec, catalog);
	return answer.kind === "found" ? answer.model.id : answer.kind;
};

// ---------------------------------------------------------------------------
console.log("model-family: an alias is the newest of its family");
{
	check("every alias lands on the newest release", [["sonnet", "claude-sonnet-5"], ["fable", "claude-fable-5-1"], ["opus", "claude-opus-5"], ["haiku", "claude-haiku-4-5"], ["luna", "gpt-6-luna"], ["sol", "gpt-6-sol"]].every(([alias, id]) => resolve(alias) === id));
	check("a minor version beats its own major", resolve("fable") === "claude-fable-5-1");
	check("a major beats every minor below it", resolve("opus") === "claude-opus-5" && resolve("luna") === "gpt-6-luna");
	check("a release date is not a version", resolve("haiku") === "claude-haiku-4-5");
	check("case does not matter", resolve("SONNET") === "claude-sonnet-5" && resolve("Claude-Opus-4-6") === "claude-opus-4-6" && resolve("LUNA") === "gpt-6-luna");
	check("surrounding whitespace does not matter", resolve("  fable  ") === "claude-fable-5-1");
	check("the answer is the catalog's own entry, provider and all", newestInFamily("luna", FIXTURE).model === FIXTURE.find((e) => e.id === "gpt-6-luna"));
}

// ---------------------------------------------------------------------------
console.log("\nmodel-family: every provider is searched, and two answering is refused");
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
console.log("\nmodel-family: what it declines to answer");
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
console.log("\nmodel-family: pi's own catalog, and the agents pinned against it");
{
	// The fixture above is a reading of pi's catalog, and a reading can go stale
	// on the next pi release. These read the catalog itself, and the frontmatter
	// that depends on it: `model: fable` resolving to claude-fable-5 is how three
	// of four agent types silently dropped a release on 2026-09-20.
	const shipped = Object.keys(JSON.parse(fs.readFileSync(CATALOG, "utf8"))["anthropic-messages"]).map(entry)
		.concat(Object.keys(JSON.parse(fs.readFileSync(CODEX_CATALOG, "utf8"))["openai-codex-responses"]).map(codexEntry));
	check("pi's catalog carries every family the agents and the Agent tool name", ["opus", "luna"].every((alias) => newestInFamily(alias, shipped).kind === "found"), shipped.map((e) => e.id).join(", "));
	check("luna is gpt-6-luna in pi's own catalog", resolve("luna", shipped) === "gpt-6-luna");

	const agentDir = path.join(ROOT, "..", "agents");
	const pinned = fs.readdirSync(agentDir).filter((name) => name.endsWith(".md")).map((name) => ({
		name,
		spec: /^model:[ \t]*(.+)$/m.exec(fs.readFileSync(path.join(agentDir, name), "utf8"))?.[1]?.trim(),
	}));
	check("every agent type pins a model", pinned.length > 0 && pinned.every((agent) => agent.spec !== undefined), JSON.stringify(pinned));
	// Naming the expected ids here would be the hand-kept list this module
	// replaced, so a second, simpler reading of the same catalog is the oracle.
	const segmentsOf = (id) => (id.startsWith("gpt-") ? id.split("-")[1].split(".") : id.split("-").slice(2)).filter((seg) => /^\d+$/.test(seg) && seg.length !== 8).map(Number);
	const dated = (id) => /-\d{8}$/.test(id);
	const beats = (a, b) => segmentsOf(a).some((seg, i) => seg !== (segmentsOf(b)[i] ?? 0) && seg > (segmentsOf(b)[i] ?? 0) && segmentsOf(a).slice(0, i).every((s, j) => s === (segmentsOf(b)[j] ?? 0)));
	const wordOf = (id) => (id.startsWith("gpt-") ? id.split("-").slice(2).join("-") : id.split("-")[1]);
	for (const agent of pinned) {
		const resolved = resolve(agent.spec, shipped);
		check(`${agent.name} (${agent.spec}) resolves`, resolved !== "none" && resolved !== "ambiguous", resolved);
		const newer = shipped.filter((e) => wordOf(e.id) === agent.spec && !dated(e.id) && beats(e.id, resolved));
		check(`${agent.name} lands on the newest ${agent.spec}`, newer.length === 0, `${resolved} is beaten by ${newer.map((e) => e.id).join(", ")}`);
	}
}

// ---------------------------------------------------------------------------
console.log("\nmodel-family: the cut that leaves one release per family");
{
	// A seat's model is not a spec this module resolves — pi picks it from
	// `defaultModel`, `--model`, a session header or Ctrl+P, before and after any
	// extension loads. So the answer is given to the catalog instead: what is not
	// in it cannot be picked from any of those directions.
	const ids = (models) => models.map((model) => model.id).join(",");
	check("one id survives per family, the newest of it", ids(newestPerFamily(FIXTURE.filter((e) => e.provider === "anthropic"))) === "claude-sonnet-5,claude-fable-5-1,claude-opus-5,claude-haiku-4-5", ids(newestPerFamily(FIXTURE)));
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

	// `--models` is the Ctrl+P scope, a different flag. A reader that matched on a
	// prefix would read the scope list as the seat's model.
	check("--model is read, as a whole token", commandLineModelSpec(["pi", "--model", "anthropic/claude-opus-5"]) === "anthropic/claude-opus-5");
	check("and in its = form", commandLineModelSpec(["pi", "--model=opus"]) === "opus");
	check("--models is not --model", commandLineModelSpec(["pi", "--models", "claude-*"]) === undefined);
	check("a launcher that names none says so", commandLineModelSpec(["pi", "-p", "hello"]) === undefined);
	check("the first --model wins, as pi's own parser takes it", commandLineModelSpec(["pi", "--model", "opus", "--model", "haiku"]) === "opus");
}

// ---------------------------------------------------------------------------
console.log("\nthe two releases this repo still types out by hand");
{
	// Everything else in the kit names a family. These two cannot: pi resolves
	// both before any extension loads. So they are checked here and by
	// `install.sh --doctor`, because a pin that is merely remembered is a pin that
	// goes stale — which is the whole of 2026-09-20.
	// The catalog as this process holds it: pi's list plus the releases the kit
	// adds ahead of pi, so a pin on one of those is not reported as gone.
	const shipped = withReleasesAheadOfPi(Object.keys(JSON.parse(fs.readFileSync(CATALOG, "utf8"))["anthropic-messages"]).map(entry));
	const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "settings.json"), "utf8"));
	const allowed = newestPerFamily(shipped).map((entry) => entry.id);
	const codexAllowed = newestPerFamily(Object.keys(JSON.parse(fs.readFileSync(CODEX_CATALOG, "utf8"))["openai-codex-responses"]).map(codexEntry)).map((entry) => entry.id);
	check("pi's defaultProvider is the one whose catalog this reads", settings.defaultProvider === "anthropic", settings.defaultProvider);
	check(`pi's defaultModel (${settings.defaultModel}) survives the catalog cut`, allowed.includes(settings.defaultModel), allowed.join(", "));
	// Every key of `modelThinkingLevels` too: a level filed against a model this
	// process no longer has is a line nothing can ever read.
	const levelled = Object.keys(settings.modelThinkingLevels ?? {}).filter((key) => key.startsWith("anthropic/")).map((key) => key.slice("anthropic/".length));
	check("every Anthropic model the settings name a thinking level for still exists", levelled.every((id) => allowed.includes(id)), levelled.filter((id) => !allowed.includes(id)).join(", "));
	const codexLevelled = Object.keys(settings.modelThinkingLevels ?? {}).filter((key) => key.startsWith("openai-codex/")).map((key) => key.slice("openai-codex/".length));
	check("every Codex model the settings name a thinking level for still exists", codexLevelled.length > 0 && codexLevelled.every((id) => codexAllowed.includes(id)), codexLevelled.filter((id) => !codexAllowed.includes(id)).join(", "));
	check("and no settings key names a provider this reads nothing for", Object.keys(settings.modelThinkingLevels ?? {}).every((key) => key.startsWith("anthropic/") || key.startsWith("openai-codex/")), Object.keys(settings.modelThinkingLevels ?? {}).join(", "));

	const chat = fs.readFileSync(path.join(ROOT, "..", "..", "bin", "chat"), "utf8");
	const spec = /--model "([^"]+)"/.exec(chat)?.[1];
	check("bin/chat still pins its seat with --model \"provider/id:thinking\"", spec !== undefined, chat.slice(0, 200));
	const chatId = spec?.split("/").pop()?.split(":")[0];
	check(`bin/chat's seat (${chatId}) survives the catalog cut`, allowed.includes(chatId), allowed.join(", "));
}

// ---------------------------------------------------------------------------
console.log("\nthe turns that start without a user message");
{
	// pi hands out the prompt options on `before_agent_start`, and that fires on
	// the user path alone. A turn started with `sendMessage(..., triggerTurn:
	// true)` gets none, so on the first turn of a process `wire` has nothing to
	// build a prompt from and refuses the turn rather than borrowing pi's prose
	// (2026-09-06, req_011CenGzjBfwouGRX52Q5PE3). A command handler is the one
	// context pi gives `getSystemPromptOptions()` to, so a command that starts a
	// turn can and must prime the seat first. This roster is how the next author
	// of one is made to read that sentence: adding a trigger fails here.
	const sources = fs.readdirSync(path.join(ROOT, "extensions"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => path.relative(path.join(ROOT, "extensions"), path.join(entry.parentPath, entry.name)))
		.sort();
	const triggers = sources.filter((file) => fs.readFileSync(path.join(ROOT, "extensions", file), "utf8").includes("triggerTurn: true"));
	check(
		"three extensions start a turn on their own, and no others",
		triggers.join(",") === "agent-engine.ts,bash.ts,continue-session.ts",
		triggers.join(","),
	);

	const handoff = fs.readFileSync(path.join(ROOT, "extensions", "continue-session.ts"), "utf8");
	const primed = handoff.indexOf("capturePromptOptions(ctx.sessionManager.getSessionId(), ctx.getSystemPromptOptions())");
	const gate = handoff.indexOf('nudgeText("gated"');
	check("the one that runs inside a command primes the seat before it triggers", primed > 0 && gate > primed, `primed at ${primed}, triggers at ${gate}`);
	// The other two fire from event handlers, which pi gives no accessor: they can
	// only be reached mid-session, where a capture already exists. If that stops
	// being true, the refusal is what says so — loudly, on the request itself.
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log("\nthe suite's own environment");
{
	// A file run on its own — `node test/wire-trace.mjs`, which is how a failure
	// gets debugged — used to inherit the seat's environment and write into
	// `~/.local/state/pi-kit`. Six did, and on 2026-09-21 seven notice lines one
	// of them left there were read as a seat's own. The environment is `env.mjs`
	// now, imported first by each file rather than handed down by the runner; a
	// file that forgets the import is a file that writes into the seat again, so
	// the roster is checked rather than remembered.
	const HARNESS = ["env.mjs", "files.mjs", "run.mjs"];
	/** Run by hand, never by the runner: they paint a frame for a human to look at. */
	const PREVIEWS = ["preview-transcript.mjs", "preview-workflow-ui.mjs"];
	/** The first line of a file that is neither blank nor comment — where the environment import has to be. */
	function firstCodeLine(file) {
		let inBlock = false;
		for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
			const line = raw.trim();
			if (inBlock) { if (line.includes("*/")) inBlock = false; continue; }
			if (line === "" || line.startsWith("//")) continue;
			if (line.startsWith("/*")) { if (!line.includes("*/")) inBlock = true; continue; }
			return line;
		}
		return undefined;
	}

	const files = fs.readdirSync(path.join(ROOT, "test")).filter((name) => name.endsWith(".mjs")).sort();

	const missing = files.filter((name) => !HARNESS.includes(name) && firstCodeLine(path.join(ROOT, "test", name)) !== 'import "./env.mjs";');
	check(`every suite file imports the environment first (${files.length - HARNESS.length} of them)`, missing.length === 0, missing.join(", "));

	const unlisted = files.filter((name) => !HARNESS.includes(name) && !PREVIEWS.includes(name) && !TEST_FILES.includes(`test/${name}`));
	check("and every one of them is in TEST_FILES, so it actually runs", unlisted.length === 0, unlisted.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
