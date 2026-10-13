/** How long Anthropic's prompt cache holds an entry: `{type: "ephemeral"}` is 5m, `ttl: "1h"` the hour. */

export const SHORT_TTL_MS = 5 * 60 * 1000;
export const LONG_TTL_MS = 60 * 60 * 1000;
