import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelReleaseAtLeast, newestPerFamily } from "../lib/models/model-family.ts";

interface AheadOfPi {
	readonly id: string;
	readonly name: string;
	readonly from: string;
	readonly cost: Model<"anthropic-messages">["cost"];
}

export const AHEAD_OF_PI: readonly AheadOfPi[] = Object.freeze([]);

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

/** Sonnet 5.5 with Anthropic's 2026-10-07 cache read price, $0.10 per million tokens; pi's catalog still lists $0.20. */
export function withCurrentSonnetPrice(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return model.id === "claude-sonnet-5-5" ? { ...model, cost: { ...model.cost, cacheRead: 0.1 } } : model;
}

const CLAUDE_IMAGE_MAX_BYTES = 1024 * 1024;

export function withClaudeImageResize(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	const edge = modelReleaseAtLeast(model.id, [4, 7]) ? 2000 : 1568;
	const resize = { ...model.inputLimits?.images?.resize, maxWidth: edge, maxHeight: edge, maxBytes: CLAUDE_IMAGE_MAX_BYTES };
	return { ...model, inputLimits: { ...model.inputLimits, images: { ...model.inputLimits?.images, resize } } };
}

export function withoutLowThinking<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	if (!model.reasoning) return model;
	return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null, minimal: null, low: null } };
}

export default function modelCatalog(pi: ExtensionAPI): void {
	const builtins = builtinProviders();
	const anthropic = builtinProvider(builtins, "anthropic");
	pi.registerProvider({
		...anthropic,
		getModels: () => newestPerFamily(withReleasesAheadOfPi(anthropic.getModels().filter(speaksMessages))).map(withCurrentSonnetPrice).map(withClaudeImageResize).map(withoutLowThinking),
	});
	const codex = builtinProvider(builtins, "openai-codex");
	pi.registerProvider({ ...codex, getModels: () => newestPerFamily(codex.getModels()).map(withoutLowThinking) });
}

function builtinProvider(builtins: readonly Provider[], id: string): Provider {
	const provider = builtins.find((candidate) => candidate.id === id);
	if (provider === undefined) throw new Error(`model-catalog: pi-ai ships no built-in "${id}" provider`);
	return provider;
}

function speaksMessages(model: Model<Api>): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}
