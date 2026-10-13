import { LONG_TTL_MS, SHORT_TTL_MS } from "./cache-window.ts";

function ttlOf(block: unknown): number | undefined {
	// SAFETY: block is untrusted; cache_control.ttl is type-checked below
	const control = (block as { cache_control?: { ttl?: unknown } } | null)?.cache_control;
	if (!control) return undefined;
	return control.ttl === "1h" ? LONG_TTL_MS : SHORT_TTL_MS;
}

function ttlIn(blocks: unknown): number | undefined {
	if (!Array.isArray(blocks)) return undefined;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const ttl = ttlOf(blocks[i]);
		if (ttl !== undefined) return ttl;
	}
	return undefined;
}

export function ttlFromPayload(payload: unknown): number | undefined {
	// SAFETY: payload is an Anthropic request body; each field is checked before use
	const body = payload as { tools?: unknown; system?: unknown; messages?: unknown } | null;
	if (!body) return undefined;

	const messages = Array.isArray(body.messages) ? body.messages : [];
	// SAFETY: messages is an array; the last entry's content is only read via optional chaining and ttlIn checks it
	const found = [
		ttlIn(body.tools),
		ttlIn(body.system),
		ttlIn((messages[messages.length - 1] as { content?: unknown } | undefined)?.content),
	].filter((ttl): ttl is number => ttl !== undefined);

	return found.length > 0 ? Math.min(...found) : undefined;
}
