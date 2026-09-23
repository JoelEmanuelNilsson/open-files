/**
 * The catalog this process is allowed to have.
 *
 * `extensions/model-catalog.ts` replaces pi's Anthropic and OpenAI Codex
 * providers with the same objects over a filtered `getModels()`, which is the
 * only reason a superseded release cannot be reached by `--model`, `/model`,
 * Ctrl+P, a resumed session or a child seat. Two things have to hold: the
 * vendor's auth and streaming are still the vendor's (a copy would be a second
 * implementation of OAuth), and the ids that come out are the ones this machine runs.
 *
 * The list is pinned against the installed pi on purpose. A pi release that
 * ships a new Claude or GPT shows up here as a diff, which is a decision to make and
 * not a thing to discover mid-session.
 *
 *   node test/model-catalog.mjs
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import os from "node:os";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const ALLOWED = {
	anthropic: ["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5"],
	"openai-codex": ["gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"],
};

const PROVIDERS = `${PI}/node_modules/@earendil-works/pi-ai/dist/providers`;
const { anthropicProvider } = await import(`${PROVIDERS}/anthropic.js`);
const { openaiCodexProvider } = await import(`${PROVIDERS}/openai-codex.js`);
const extension = await jiti.import(`${ROOT}/extensions/model-catalog.ts`);
const registrations = [];
extension.default({ registerProvider: (provider) => registrations.push(provider) });

// ---------------------------------------------------------------------------
console.log("model-catalog: the extension registers each cut provider once, in its factory");
check("pi-ai still exports both built-in provider factories", typeof anthropicProvider === "function" && typeof openaiCodexProvider === "function");
check("exactly two registrations: anthropic and openai-codex", registrations.map((provider) => provider.id).join(",") === "anthropic,openai-codex", registrations.map((provider) => provider.id).join(","));

for (const factory of [anthropicProvider, openaiCodexProvider]) {
	const builtin = factory();
	const registered = registrations.find((provider) => provider.id === builtin.id);
	const allowed = ALLOWED[builtin.id];
	console.log(`\nmodel-catalog: the ${builtin.id} provider pi ends up with`);
	check("under pi's own provider id, so it replaces rather than adds", registered !== undefined);

	// Every call to a provider factory closes over fresh functions, so the
	// vendor's code cannot be recognised by reference across two instances — it is
	// recognised by its source. A reimplemented `auth` is a second OAuth flow and a
	// reimplemented `stream` is a second wire, and either would read differently here.
	const sameSource = (left, right) => {
		if (typeof left === "function") return String(left) === String(right);
		if (left !== null && typeof left === "object") {
			if (right === null || typeof right !== "object") return false;
			const keys = Object.keys(left).sort();
			return keys.join(",") === Object.keys(right).sort().join(",") && keys.every((key) => sameSource(left[key], right[key]));
		}
		return left === right;
	};
	for (const key of ["stream", "streamSimple"]) {
		check(`${key} is the vendor's own code, not the kit's`, typeof registered[key] === "function" && sameSource(registered[key], builtin[key]), String(registered[key]).slice(0, 120));
	}
	check("auth is the vendor's own, method for method", sameSource(registered.auth, builtin.auth), JSON.stringify(Object.keys(registered.auth)));
	for (const key of ["baseUrl", "name", "headers", "refreshModels", "filterModels"]) {
		check(`${key} is passed through untouched`, registered[key] === builtin[key]);
	}
	check("nothing was added to the object beyond what pi-ai defines", Object.keys(registered).sort().join(",") === Object.keys(builtin).sort().join(","));

	const ids = registered.getModels().map((model) => model.id);
	check("the catalog is the releases this machine runs", ids.sort().join(",") === allowed.join(","), ids.join(","));
	const aheadIds = new Set(extension.AHEAD_OF_PI.map((release) => release.id));
	check("and every model pi ships is pi-ai's object, untouched", registered.getModels().filter((model) => !aheadIds.has(model.id)).every((model) => builtin.getModels().includes(model)));

	// A release ahead of pi is pi's sibling entry with three owned fields. The
	// day pi ships the id, the entry is dead weight that could shadow the real
	// definition, so this is the alarm that says to delete it.
	for (const release of builtin.id === "anthropic" ? extension.AHEAD_OF_PI : []) {
		check(`pi does not ship ${release.id} yet — delete its AHEAD_OF_PI entry once it does`, !builtin.getModels().some((model) => model.id === release.id));
		const derived = registered.getModels().find((model) => model.id === release.id);
		const sibling = builtin.getModels().find((model) => model.id === release.from);
		check(`${release.id} is listed, derived from ${release.from}`, derived !== undefined && sibling !== undefined);
		const owned = new Set(["id", "name", "cost"]);
		const inherited = Object.keys(sibling ?? {}).filter((key) => !owned.has(key));
		check(`${release.id} inherits everything but id, name and cost from ${release.from}`, derived !== undefined && inherited.every((key) => derived[key] === sibling[key]) && Object.keys(derived).length === Object.keys(sibling).length, inherited.filter((key) => derived?.[key] !== sibling?.[key]).join(","));
		check(`${release.id} carries its own price`, derived?.cost === release.cost && derived.name === release.name);
	}

	check("pi's own list is bigger, which is what the filter is for", builtin.getModels().length > ids.length, String(builtin.getModels().length));
	check("every superseded release is gone", !builtin.getModels().map((m) => m.id).filter((id) => !allowed.includes(id)).some((id) => ids.includes(id)));
	// Read per call rather than captured once: a dynamic provider's list can move
	// under it, and a snapshot taken at load would outlive the truth.
	check("getModels is recomputed per call, not a frozen snapshot", registered.getModels() !== registered.getModels());
}

// ---------------------------------------------------------------------------
console.log("\nmodel-catalog: the releases pi ships itself, and the merge for those it does not");
{
	// Opus 5.5 was an AHEAD_OF_PI entry until pi 0.87.1 shipped it; Luna never
	// needed one. Both are pi's own objects now, and the cut must keep them.
	const codex = registrations.find((provider) => provider.id === "openai-codex").getModels().map((model) => model.id);
	check("pi ships claude-opus-5-5 itself, so the kit adds no copy of it", anthropicProvider().getModels().some((model) => model.id === "claude-opus-5-5") && !extension.AHEAD_OF_PI.some((release) => release.id === "claude-opus-5-5"));
	check("the Codex cut keeps gpt-6-luna and drops gpt-5.6-luna", codex.includes("gpt-6-luna") && !codex.includes("gpt-5.6-luna"), codex.join(","));
	check("and drops the ids off the gpt-<n.n>-<family> shape", !codex.includes("gpt-5.5") && !codex.includes("gpt-5.3-codex-spark"), codex.join(","));

	// The merge itself: the vendor's definition wins, and a lost sibling means
	// no entry rather than an entry built from the wrong model.
	const shipped = [{ id: "claude-opus-5", name: "pi's", cost: { input: 1 } }, { id: "claude-opus-5-5", name: "pi's 5.5", cost: { input: 2 } }];
	const ahead = [{ id: "claude-opus-5-5", name: "kit's 5.5", from: "claude-opus-5", cost: { input: 3 } }];
	check("an id pi already lists is left as pi defines it", extension.withReleasesAheadOfPi(shipped, ahead).find((m) => m.id === "claude-opus-5-5")?.name === "pi's 5.5");
	const derived = extension.withReleasesAheadOfPi([shipped[0]], ahead);
	check("an id pi does not list is derived from its sibling with the owned id, name and price", derived.length === 2 && derived[1].name === "kit's 5.5" && derived[1].cost === ahead[0].cost && derived[1].id === "claude-opus-5-5");
	check("an entry whose sibling is gone adds nothing", extension.withReleasesAheadOfPi([{ id: "claude-sonnet-5", cost: {} }], ahead).length === 1);
}

// ---------------------------------------------------------------------------
console.log("\nmodel-catalog: the assertion on the wire");
{
	// The filter is the guard; this is the alarm on it. A model the registry
	// cannot find reached the provider around the catalog, which is a defect in
	// the kit. It is an error notice, not a throw: pi catches a handler throw and
	// sends its own payload, so a throw would only strip the owned prompt and the
	// wire invariant from a request that goes out anyway.
	const wire = await jiti.import(`${ROOT}/extensions/wire.ts?catalog`);
	const handlers = new Map();
	wire.default({ on: (event, handler) => handlers.set(event, handler), registerCommand: () => {} });

	const REPO = path.join(os.homedir(), "dotfiles");
	const model = { id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
	const notices = [];
	const seat = (found) => ({
		cwd: REPO,
		model,
		modelRegistry: { isUsingOAuth: () => true, find: () => found, getAvailable: () => (found ? [found] : []) },
		sessionManager: { getSessionId: () => "550e8400-e29b-41d4-a716-4466554401" + (found ? "1" : "2"), getHeader: () => ({}) },
		hasUI: true,
		ui: { setStatus: () => {}, notify: (message, level) => notices.push({ message, level }), theme: { fg: (_c, text) => text } },
	});
	const payload = () => ({
		model: model.id,
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		system: [{ type: "text", text: "vanilla pi prompt" }],
	});
	const drive = (found) => {
		const ctx = seat(found);
		handlers.get("before_agent_start")({ systemPromptOptions: { cwd: REPO, selectedTools: ["bash"], toolSnippets: { bash: "Bash" } } }, ctx);
		return handlers.get("before_provider_request")({ payload: payload() }, ctx);
	};

	const unlisted = drive(undefined);
	const alarm = notices.find((n) => n.message.includes("does not list"));
	check("a model the registry does not list raises an error notice", alarm?.level === "error", JSON.stringify(notices));
	check("and the notice names the model and the filter that should have stopped it", alarm?.message.includes("anthropic/claude-opus-5") && alarm.message.includes("model-catalog.ts"), alarm?.message);
	check("and the request still goes out with the owned four blocks", Array.isArray(unlisted?.system) && unlisted.system.length === 4 && unlisted.system[0].text.startsWith("x-anthropic-billing-header:"), JSON.stringify(unlisted?.system?.length));

	const sent = drive(model);
	check("a model the registry lists goes through", Array.isArray(sent?.system) && sent.system.length === 4, JSON.stringify(sent?.system?.length));
	check("and its model is left exactly as pi resolved it", sent.model === model.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
