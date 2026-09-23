/**
 * The keep-warm ping: replay the last request byte for byte, so Anthropic
 * re-reads the entry it holds rather than writing a second one. Bytes and
 * envelope both come from the request; splitting them cost 26 rejected pings.
 */

import type { Api, Model, ProviderHeaders, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shared } from "./shared.ts";
import type { PrefixKey } from "./warm-prefix.ts";

/** Headers a credential can ride in, whatever their casing (pi-ai's `assertRequestAuth`). */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "cf-aig-authorization"];

/**
 * What pi-ai is handed to build a request it will not send: `onPayload` replaces
 * its whole envelope with the captured one, betas included (pi-ai 0.86 carries
 * them in the payload), so nothing here reaches the wire.
 */
const EMPTY_TRANSCRIPT: TranscriptContext = { messages: [] };

/** How much of a provider's error body reaches a notice or a trace line. */
const DETAIL_CHARS = 240;

/** Where published targets live so every session in the process sees its own. */
const SEAM = "__piKitPingTargets";

/**
 * Why a ping did not refresh the cache.
 *
 * `timeout` is the network rather than a verdict, so the keepalive chain waits
 * it out instead of abandoning an entry that is probably still there.
 * `cancelled` is the caller's session ending mid-ping: no verdict either.
 */
export type PingFailure = "auth" | "status" | "timeout" | "network" | "cancelled";

/** What one ping did, for the wire trace and for the caller's next decision. */
export type PingResult =
	| {
			ok: true;
			/** Milliseconds the whole attempt took — a duration for the trace, not an anchor. */
			ms: number;
			/** Prompt tokens read from cache: the ping's purpose, reported rather than assumed. */
			read: number;
			/**
			 * Prompt tokens written to cache. **Zero is the healthy value** — a
			 * replay that writes did not find the entry it replayed.
			 */
			write: number;
			/** The model that actually served it, which a server-side fallback can change. */
			served: string;
	  }
	| {
			ok: false;
			/** Milliseconds the whole attempt took — a duration for the trace, not an anchor. */
			ms: number;
			reason: PingFailure;
			/** One phrase for a human, for the notice and the trace. */
			detail: string;
			/** The provider's status when it gave one; a ping that streamed is a 200 by construction. */
			status?: number;
	  };

/**
 * Everything one replay ping needs, captured as a unit on an Anthropic request.
 *
 * A unit because the halves come from different hooks: a turn on another
 * provider would otherwise pair this payload with that provider's headers.
 */
export interface PingTarget {
	/** The exact bytes the provider saw. */
	readonly payload: Record<string, unknown>;
	/**
	 * Epoch ms the request went out, which is when the provider's clock started.
	 * A chain rebuilt after a reload has no other anchor for the window it
	 * inherited (issues/43).
	 */
	readonly at: number;
	readonly headers: ProviderHeaders;
	readonly model: Model<Api>;
	/**
	 * Where compat asks for session affinity this reaches the wire, and a ping
	 * that omitted it would route to a backend holding no entry.
	 */
	readonly sessionId: string;
	/**
	 * The prefix this replay refreshes (`lib/warm-prefix.ts`), so a successful
	 * ping can restart the ledger's clock for it. Undefined when the payload has
	 * no cacheable prefix to speak of.
	 */
	readonly prefixKey?: PrefixKey;
	readonly registry: ExtensionContext["modelRegistry"];
	/** Record this ping in the session's wire trace, next to the request it replays. */
	record(result: PingResult): void;
}

/**
 * Publish the request a ping would replay, for this session only.
 *
 * Keyed by session because subagents run in this process: one unkeyed slot
 * would let a child's payload be replayed on the parent's credentials.
 */
export function publishPingTarget(target: PingTarget): void {
	pingTargets().set(target.sessionId, target);
}

/** This session's replayable request, or undefined before its first one. */
export function readPingTarget(sessionId: string): PingTarget | undefined {
	return pingTargets().get(sessionId);
}

/**
 * Drop a session's target, from `session_shutdown`, so the seam holds one entry
 * per live session and nothing can ping a dead seat's cache warm.
 */
export function forgetPingTarget(sessionId: string): void {
	pingTargets().delete(sessionId);
}

/**
 * The header bag for one ping: the request's own, with every credential taken
 * from this ping's resolution instead of the capture — a request-level
 * credential overrides the client's auth, so a captured one is a stale winner.
 */
export function pingHeaders(captured: ProviderHeaders, resolved: ProviderHeaders | undefined): ProviderHeaders {
	const headers: ProviderHeaders = {};
	// Nulls pass through: pi-ai reads null as "suppress the client's default
	// header of this name", so dropping one adds a header the request went without.
	for (const [name, value] of Object.entries(captured)) {
		if (!isCredential(name)) headers[name] = value;
	}
	// A gateway can authenticate by header alone, where stripping and not
	// re-adding would send a ping with no credential at all.
	for (const [name, value] of Object.entries(resolved ?? {})) {
		if (isCredential(name)) headers[name] = value;
	}
	return headers;
}

/**
 * Send one ping and report what happened. Never throws: every way this can fail
 * is a caller decision, so all of them are values. The stream is aborted at the
 * first content event, which is the cost control rather than an error path.
 */
export async function sendPing(target: PingTarget, timeoutMs: number, signal?: AbortSignal): Promise<PingResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	timeout.unref?.();
	// The caller's session ending ends the ping, so its timer never outlives that session.
	const end = () => controller.abort();
	signal?.addEventListener("abort", end, { once: true });
	const startedAt = Date.now();
	const since = (): number => Date.now() - startedAt;
	const cutShort = (): PingResult =>
		signal?.aborted
			? { ok: false, ms: since(), reason: "cancelled", detail: "the session ended" }
			: { ok: false, ms: since(), reason: "timeout", detail: `no response in ${timeoutMs}ms` };
	try {
		if (signal?.aborted) return cutShort();
		// Resolved per ping, never captured: this is what refreshes an OAuth token
		// that aged out while the session sat idle.
		const auth = await target.registry.getApiKeyAndHeaders(target.model);
		if (!auth.ok) return { ok: false, ms: since(), reason: "auth", detail: `cannot authenticate (${auth.error})` };
		const provider = target.registry.getProvider(target.model.provider);
		if (provider === undefined) {
			return { ok: false, ms: since(), reason: "auth", detail: `no provider registered for "${target.model.provider}"` };
		}
		// The two moves `ModelRegistry.applyAuth` makes before a real request: the
		// resolution's base url wins over the model's, its credentials over the bag's.
		const model = auth.baseUrl ? { ...target.model, baseUrl: auth.baseUrl } : target.model;
		const stream = provider.stream(model, EMPTY_TRANSCRIPT, {
			apiKey: auth.apiKey,
			headers: pingHeaders(target.headers, auth.headers),
			env: auth.env,
			sessionId: target.sessionId,
			signal: controller.signal,
			// A ping that has to be retried has already lost the race it exists to
			// win; the caller owns retrying, and it knows about the window.
			maxRetries: 0,
			onPayload: () => target.payload,
		});
		for await (const event of stream) {
			if (event.type === "error") {
				// Our own signal carries the timeout and the session's end: the success path
				// aborts only after it has its answer, and returns before looking here.
				return controller.signal.aborted ? cutShort() : failureOf(event.error.errorMessage, since());
			}
			// pi-ai folds `message_start` in before the first content event, so the
			// event after `start` is the first one that knows what the ping cost.
			if (event.type === "start") continue;
			const message = event.type === "done" ? event.message : event.partial;
			controller.abort();
			return {
				ok: true,
				ms: since(),
				read: message.usage.cacheRead,
				write: message.usage.cacheWrite,
				// A server-side fallback answers on another model, which pi-ai reports
				// beside the one asked for rather than in place of it.
				served: message.responseModel ?? message.model,
			};
		}
		return { ok: false, ms: since(), reason: "network", detail: "the provider streamed nothing" };
	} catch (error) {
		if (controller.signal.aborted) return cutShort();
		return { ok: false, ms: since(), reason: "network", detail: oneLine(error instanceof Error ? error.message : String(error)) };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", end);
	}
}

/**
 * A failed stream, read as a value. pi-ai puts the provider's own status and
 * body in one string, which is why the status can be parsed back out of it.
 */
function failureOf(errorMessage: string | undefined, ms: number): PingResult {
	const detail = oneLine(errorMessage ?? "the provider failed without saying why");
	const status = /^(\d{3})\b/.exec(detail);
	if (status === null) return { ok: false, ms, reason: "network", detail };
	return { ok: false, ms, reason: "status", detail, status: Number(status[1]) };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, DETAIL_CHARS);

const isCredential = (name: string): boolean => CREDENTIAL_HEADERS.includes(name.toLowerCase());

const pingTargets = (): Map<string, PingTarget> => shared(SEAM, () => new Map<string, PingTarget>());
