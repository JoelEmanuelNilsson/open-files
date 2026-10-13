import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notice } from "../../lib/process/human-notice.ts";
import type { SessionScope } from "../../lib/session/session-scope.ts";
import { entryLives, IDLE_WARMING_LIMIT_MS, publishCacheWarm, publishWarmSchedule, readCacheTouch, seatWantsWarming, warmDelayMs } from "../../lib/wire/cache-touch.ts";
import { readLastRequest, replayHeaders } from "../../lib/wire/last-request.ts";

// SAFETY: the warmer replays only messages; the empty transcript has none
const EMPTY_TRANSCRIPT = { messages: [] } as unknown as TranscriptContext;

/** One seat's warmer. */
export interface CacheWarmer {
	arm(ctx: ExtensionContext): void;
	disarm(): void;
}

/** Create the warmer of one wire instance; `recordWarm` files a warm that read the entry in the wire trace. */
export function createCacheWarmer(pi: ExtensionAPI, scope: SessionScope, recordWarm: (sessionId: string, model: string) => void): CacheWarmer {
	let cancelTimer: (() => void) | undefined;
	let running: AbortController | undefined;
	let scheduledFor: string | undefined;

	const disarm = (): void => {
		if (scheduledFor !== undefined) publishWarmSchedule(scheduledFor, undefined);
		scheduledFor = undefined;
		cancelTimer?.();
		cancelTimer = undefined;
		running?.abort();
		running = undefined;
	};

	const allowedNow = (ctx: ExtensionContext): boolean => {
		const mode = pi.getSettings().cacheWarming ?? "streaming";
		return mode === "idle" || (mode === "streaming" && !ctx.isIdle());
	};

	const arm = (ctx: ExtensionContext): void => {
		disarm();
		const sessionId = ctx.sessionManager.getSessionId();
		const touch = readCacheTouch(sessionId);
		if (touch === undefined || ctx.model === undefined || readLastRequest(sessionId, ctx.model) === undefined) return;
		const warmAt = touch.touchedAt + warmDelayMs(touch.ttlMs);
		if (warmAt > touch.startedAt + IDLE_WARMING_LIMIT_MS) {
			publishWarmSchedule(sessionId, undefined);
			return;
		}
		publishWarmSchedule(sessionId, warmAt);
		scheduledFor = sessionId;
		cancelTimer = scope.timeout(Math.max(0, warmAt - Date.now()), () => void warm(ctx, sessionId));
	};

	const warm = async (ctx: ExtensionContext, sessionId: string): Promise<void> => {
		cancelTimer = undefined;
		const stop = (reason?: string): void => {
			publishWarmSchedule(sessionId, undefined);
			if (reason !== undefined) notice(ctx, `cache warming stopped: ${reason}; the next request writes the prefix again`, "warning");
		};
		const request = ctx.model === undefined ? undefined : readLastRequest(sessionId, ctx.model);
		if (request === undefined || !entryLives(readCacheTouch(sessionId), Date.now()) || !allowedNow(ctx) || !seatWantsWarming(sessionId)) return stop();
		const controller = new AbortController();
		running = controller;
		const sentAt = Date.now();
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(request.model);
			if (controller.signal.aborted) return;
			const provider = ctx.modelRegistry.getProvider(request.model.provider);
			if (!auth.ok || provider === undefined) return stop(`no credentials for ${request.model.id}`);
			const stream = provider.stream(auth.baseUrl ? { ...request.model, baseUrl: auth.baseUrl } : request.model, EMPTY_TRANSCRIPT, {
				apiKey: auth.apiKey,
				headers: replayHeaders(request.headers, auth.headers),
				env: auth.env,
				sessionId,
				signal: controller.signal,
				onPayload: () => ({ ...request.payload, max_tokens: 1 }),
			});
			for await (const event of stream) {
				if (controller.signal.aborted) return;
				if (event.type === "error") return stop(`the warm request failed (${event.error.errorMessage ?? "no reason given"})`);
				if (event.type !== "done") continue;
				recordWarm(sessionId, request.model.id);
				publishCacheWarm(sessionId, sentAt);
				pi.appendEntry("cache_warm", { model: request.model.id, usage: event.message.usage });
				arm(ctx);
				return;
			}
			if (!controller.signal.aborted) stop("the warm request ended without a result");
		} catch (error) {
			if (!controller.signal.aborted) stop(`the warm request failed (${error instanceof Error ? error.message : String(error)})`);
		} finally {
			if (running === controller) running = undefined;
		}
	};

	return { arm, disarm };
}
