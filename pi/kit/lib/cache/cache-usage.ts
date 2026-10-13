/** The token counts of one settled response, as pi reports them on `message_end`. */
export interface CacheUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
}

export const accounted = (usage: { input?: number; cacheRead?: number; cacheWrite?: number }): number =>
	(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

export const cachedPrefix = (usage: CacheUsage, before: number | undefined): number | undefined =>
	usage.cacheWrite === 0 ? before : usage.cacheRead + usage.cacheWrite;

export const promptTokens = (usage: CacheUsage): number => usage.input + usage.cacheRead + usage.cacheWrite;
