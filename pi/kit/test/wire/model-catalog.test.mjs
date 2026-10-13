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
 *   node test/wire/model-catalog.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, PI_ROOT, REPO_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const jiti = kitJiti({ moduleCache: false });

const ALLOWED = {
	anthropic: ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"],
	"openai-codex": ["gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"],
};

const PROVIDERS = `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/providers`;
const { anthropicProvider } = await import(`${PROVIDERS}/anthropic.js`);
const { openaiCodexProvider } = await import(`${PROVIDERS}/openai-codex.js`);
const extension = await jiti.import(`${KIT_ROOT}/extensions/model-catalog.ts`);
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
	check("stream is the vendor's own code, not the kit's", typeof registered.stream === "function" && sameSource(registered.stream, builtin.stream), String(registered.stream).slice(0, 120));
	check("streamSimple is the vendor's own code, not the kit's", sameSource(registered.streamSimple, builtin.streamSimple));
	check("auth is the vendor's own, method for method", sameSource(registered.auth, builtin.auth), JSON.stringify(Object.keys(registered.auth)));
	for (const key of ["baseUrl", "name", "headers", "refreshModels", "filterModels"]) {
		check(`${key} is passed through untouched`, registered[key] === builtin[key]);
	}
	check("nothing was added to the object beyond what pi-ai defines", Object.keys(registered).sort().join(",") === Object.keys(builtin).sort().join(","));

	const ids = registered.getModels().map((model) => model.id);
	check("the catalog is the releases this machine runs", ids.sort().join(",") === allowed.join(","), ids.join(","));
	const aheadIds = new Set(extension.AHEAD_OF_PI.map((release) => release.id));
	const piOwn = (model) => builtin.getModels().find((candidate) => candidate.id === model.id);
	const withoutResize = (model) => ({ ...model, cost: model.id === "claude-sonnet-5-5" ? { ...model.cost, cacheRead: undefined } : model.cost, inputLimits: { ...model.inputLimits, images: { ...model.inputLimits?.images, resize: undefined } } });
	const withoutLow = (model) => (model.reasoning ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: undefined, minimal: undefined, low: undefined } } : model);
	if (builtin.id === "anthropic") {
		check(
			"and every model pi ships is pi-ai's, but for its image resize, Sonnet's cache read price and the levels under medium",
			registered.getModels().filter((model) => !aheadIds.has(model.id)).every((model) => isDeepStrictEqual(withoutLow(withoutResize(model)), withoutLow(withoutResize(piOwn(model))))),
		);
	} else {
		check("and every model pi ships is pi-ai's, but for the levels under medium", registered.getModels().filter((model) => !aheadIds.has(model.id)).every((model) => isDeepStrictEqual(withoutLow(model), withoutLow(piOwn(model)))));
	}

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
		// The image cap and the levels under medium are the kit's, applied by family; everything else is the sibling's.
		const same = (key) => isDeepStrictEqual(withoutLow(withoutResize(derived))[key], withoutLow(withoutResize(sibling))[key]);
		check(`${release.id} inherits everything but id, name and cost from ${release.from}`, derived !== undefined && inherited.every(same) && Object.keys(derived).length === Object.keys(sibling).length, inherited.filter((key) => derived === undefined || !same(key)).join(","));
		check(`${release.id} carries its own price`, derived?.cost === release.cost && derived.name === release.name);
	}

	check("pi's own list is bigger, which is what the filter is for", builtin.getModels().length > ids.length, String(builtin.getModels().length));
	check("every superseded release is gone", !builtin.getModels().map((m) => m.id).filter((id) => !allowed.includes(id)).some((id) => ids.includes(id)));
	// Read per call rather than captured once: a dynamic provider's list can move
	// under it, and a snapshot taken at load would outlive the truth.
	check("getModels is recomputed per call, not a frozen snapshot", registered.getModels() !== registered.getModels());
}

// ---------------------------------------------------------------------------
console.log("\nmodel-catalog: max runs where pi ships it");
{
	const { clampThinkingLevel, getSupportedThinkingLevels } = await import(`${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/models.js`);
	const served = registrations.flatMap((provider) => provider.getModels());
	for (const id of ["claude-opus-5-5", "gpt-6-luna"]) {
		const model = served.find((candidate) => candidate.id === id);
		check(`${id} asked for max runs at max, unclamped`, model !== undefined && getSupportedThinkingLevels(model).includes("max") && clampThinkingLevel(model, "max") === "max", model && clampThinkingLevel(model, "max"));
	}

	console.log("\nmodel-catalog: no model runs under medium");
	check("every served model reasons", served.every((model) => model.reasoning), served.filter((model) => !model.reasoning).map((model) => model.id).join(","));
	for (const model of served) {
		const levels = getSupportedThinkingLevels(model);
		check(`${model.id} starts at medium (${levels.join(",")})`, levels[0] === "medium" && ["off", "minimal", "low"].every((level) => !levels.includes(level)));
		check(`${model.id} asked for off, minimal or low runs at medium`, ["off", "minimal", "low"].every((level) => clampThinkingLevel(model, level) === "medium"));
	}
	const opus = served.find((model) => model.id === "claude-opus-5-5");
	check("claude-opus-5-5 offers exactly medium, high, xhigh, max", opus !== undefined && getSupportedThinkingLevels(opus).join() === "medium,high,xhigh,max", opus && getSupportedThinkingLevels(opus).join());
	const next = extension.withoutLowThinking({ ...opus, id: "claude-opus-6", thinkingLevelMap: { xhigh: "xhigh" } });
	check("a future release loses low the day pi ships it", clampThinkingLevel(next, "low") === "medium", clampThinkingLevel(next, "low"));
	const plain = { ...opus, id: "no-reasoning", reasoning: false, thinkingLevelMap: undefined };
	check("a model without reasoning keeps its map: off is all it runs", extension.withoutLowThinking(plain) === plain);
}

// ---------------------------------------------------------------------------
console.log("\nmodel-catalog: every Claude image is capped to what its vision tier uses");
{
	// The 413 that killed a worker was 27 screenshots pi kept as 1.2 MB PNGs
	// because its 4.5 MiB default fit them. The cap is what `read`, attachments and
	// tool results encode to, read by pi off `model.inputLimits.images.resize`.
	const anthropic = registrations.find((provider) => provider.id === "anthropic").getModels();
	const resizeOf = (id) => anthropic.find((model) => model.id === id)?.inputLimits?.images?.resize;
	check("every Claude model caps an image at 1 MiB of base64", anthropic.every((model) => model.inputLimits?.images?.resize?.maxBytes === 1024 * 1024));
	for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"]) {
		check(`${id}, a 4.7-or-later model, at 2000 px, the most a request of over 20 images accepts`, resizeOf(id)?.maxWidth === 2000 && resizeOf(id)?.maxHeight === 2000);
	}
	check("pi's JPEG quality is kept", anthropic.every((model) => model.inputLimits?.images?.resize?.jpegQuality === piOwnQuality(model.id)));
	check("and the request size pi declares is untouched", anthropic.every((model) => model.inputLimits?.maxRequestBytes === 33554432));

	// Through pi's own `read`, which is where the 27 screenshots came in: a
	// 1600×900 PNG of 1.5 MB base64 is kept as PNG on pi's model and re-encoded
	// under the cap on the kit's.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-cap-"));
	fs.writeFileSync(path.join(dir, "shot.png"), await screenshotSizedPng());
	const { createReadToolDefinition } = await import(`${PI_ROOT}/dist/index.js`);
	const readImage = async (model) => (await createReadToolDefinition(dir).execute("read-1", { path: "shot.png" }, undefined, undefined, { cwd: dir, model })).content.find((block) => block.type === "image");
	const before = await readImage(anthropicProvider().getModels().find((model) => model.id === "claude-opus-5-5"));
	const after = await readImage(anthropic.find((model) => model.id === "claude-opus-5-5"));
	check("pi's own model keeps the screenshot as a PNG over 1 MiB", before?.mimeType === "image/png" && before.data.length > 1024 * 1024, `${before?.mimeType} ${before?.data.length}`);
	check("the kit's model reads it back under 1 MiB", after !== undefined && after.data.length <= 1024 * 1024, `${after?.mimeType} ${after?.data.length}`);
	fs.rmSync(dir, { recursive: true, force: true });
}

/** A 1600×900 PNG that compresses like a busy screenshot: 2×2 blocks of seeded noise, about 1.1 MB. */
async function screenshotSizedPng() {
	const { loadPhoton } = await import(`${PI_ROOT}/dist/utils/photon.js`);
	const photon = await loadPhoton();
	const width = 1600;
	const height = 900;
	const pixels = new Uint8Array(width * height * 4);
	let seed = 7;
	const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
	for (let y = 0; y < height; y += 2) {
		for (let x = 0; x < width; x += 2) {
			const rgb = [next(), next(), next(), 255];
			for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pixels.set(rgb, ((y + dy) * width + x + dx) * 4);
		}
	}
	const image = new photon.PhotonImage(pixels, width, height);
	try {
		return Buffer.from(image.get_bytes());
	} finally {
		image.free();
	}
}

function piOwnQuality(id) {
	const piId = extension.AHEAD_OF_PI.find((release) => release.id === id)?.from ?? id;
	return anthropicProvider().getModels().find((model) => model.id === piId)?.inputLimits?.images?.resize?.jpegQuality;
}

// ---------------------------------------------------------------------------
console.log("\nmodel-catalog: Sonnet 5.5 is priced at Anthropic's 2026-10-07 cache read");
{
	const sonnet = registrations.find((provider) => provider.id === "anthropic").getModels().find((model) => model.id === "claude-sonnet-5-5");
	check("sonnet-5-5 cacheRead is 0.1", sonnet?.cost.cacheRead === 0.1, JSON.stringify(sonnet?.cost));
	check("and the rest of its price is pi's", sonnet?.cost.input === 2 && sonnet?.cost.output === 10 && sonnet?.cost.cacheWrite === 2.5);
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

await finish();
