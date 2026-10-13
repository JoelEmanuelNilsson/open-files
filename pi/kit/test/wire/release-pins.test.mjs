/**
 * The model pins that are read against pi's own catalog rather than a fixture:
 * each agent type's `model:` frontmatter, and the two releases this repo types
 * out by hand (settings.json and bin/chat), so a pi release cannot leave them stale.
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti, PI_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

const DATA = `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/providers/data`;
const CATALOG = `${DATA}/anthropic.json`;
const CODEX_CATALOG = `${DATA}/openai-codex.json`;

/** The model ids in one API's section of a bundled catalog. Read off each entry's `id`: the keys are pi's own (`chat:<id>` since 0.99). */
const shippedIds = (file, api) => Object.values(JSON.parse(fs.readFileSync(file, "utf8"))[api]).map((model) => model.id);

const { newestInFamily, newestPerFamily } = await jiti.import(`${KIT_ROOT}/lib/models/model-family.ts`);
const { withReleasesAheadOfPi } = await jiti.import(`${KIT_ROOT}/extensions/model-catalog.ts`);

const entry = (id) => ({ provider: "anthropic", id });
const codexEntry = (id) => ({ provider: "openai-codex", id });

/** The id `newestInFamily` answers with, or its kind when it answers with no one model. */
const resolve = (spec, catalog) => {
	const answer = newestInFamily(spec, catalog);
	return answer.kind === "found" ? answer.model.id : answer.kind;
};

// ---------------------------------------------------------------------------
section("model-family: pi's own catalog, and the agents pinned against it");
{
	// The fixture above is a reading of pi's catalog, and a reading can go stale
	// on the next pi release. These read the catalog itself, and the frontmatter
	// that depends on it: `model: fable` resolving to claude-fable-5 is how three
	// of four agent types silently dropped a release on 2026-09-20.
	const shipped = shippedIds(CATALOG, "anthropic-messages").map(entry)
		.concat(shippedIds(CODEX_CATALOG, "openai-codex-responses").map(codexEntry));
	check("pi's catalog carries every family the agents and the Agent tool name", ["opus", "luna"].every((alias) => newestInFamily(alias, shipped).kind === "found"), shipped.map((e) => e.id).join(", "));
	check("luna is gpt-6-luna in pi's own catalog", resolve("luna", shipped) === "gpt-6-luna");

	const agentDir = path.join(KIT_ROOT, "..", "agents");
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
section("the two releases this repo still types out by hand");
{
	// Everything else in the kit names a family. These two cannot: pi resolves
	// both before any extension loads. So they are checked here and by
	// `install.sh --doctor`, because a pin that is merely remembered is a pin that
	// goes stale — which is the whole of 2026-09-20.
	// The catalog as this process holds it: pi's list plus the releases the kit
	// adds ahead of pi, so a pin on one of those is not reported as gone.
	const shipped = withReleasesAheadOfPi(shippedIds(CATALOG, "anthropic-messages").map(entry));
	const settings = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "..", "settings.json"), "utf8"));
	const allowed = newestPerFamily(shipped).map((entry) => entry.id);
	const codexAllowed = newestPerFamily(shippedIds(CODEX_CATALOG, "openai-codex-responses").map(codexEntry)).map((entry) => entry.id);
	check("pi's defaultProvider is the one whose catalog this reads", settings.defaultProvider === "anthropic", settings.defaultProvider);
	check(`pi's defaultModel (${settings.defaultModel}) survives the catalog cut`, allowed.includes(settings.defaultModel), allowed.join(", "));
	// Every key of `modelThinkingLevels` too: a level filed against a model this
	// process no longer has is a line nothing can ever read.
	const levelled = Object.keys(settings.modelThinkingLevels ?? {}).filter((key) => key.startsWith("anthropic/")).map((key) => key.slice("anthropic/".length));
	check("every Anthropic model the settings name a thinking level for still exists", levelled.every((id) => allowed.includes(id)), levelled.filter((id) => !allowed.includes(id)).join(", "));
	const codexLevelled = Object.keys(settings.modelThinkingLevels ?? {}).filter((key) => key.startsWith("openai-codex/")).map((key) => key.slice("openai-codex/".length));
	check("every Codex model the settings name a thinking level for still exists", codexLevelled.length > 0 && codexLevelled.every((id) => codexAllowed.includes(id)), codexLevelled.filter((id) => !codexAllowed.includes(id)).join(", "));
	check("and no settings key names a provider this reads nothing for", Object.keys(settings.modelThinkingLevels ?? {}).every((key) => key.startsWith("anthropic/") || key.startsWith("openai-codex/")), Object.keys(settings.modelThinkingLevels ?? {}).join(", "));

	const chat = fs.readFileSync(path.join(KIT_ROOT, "..", "..", "bin", "chat"), "utf8");
	const spec = /--model "([^"]+)"/.exec(chat)?.[1];
	check("bin/chat still pins its seat with --model \"provider/id:thinking\"", spec !== undefined, chat.slice(0, 200));
	const chatId = spec?.split("/").pop()?.split(":")[0];
	check(`bin/chat's seat (${chatId}) survives the catalog cut`, allowed.includes(chatId), allowed.join(", "));
}

await finish();
