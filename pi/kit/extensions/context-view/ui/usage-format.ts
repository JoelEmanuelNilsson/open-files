/** Entry-header datetime: DD-MM-YYYY HH:MM:SS in local time. */
export function formatEntryTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number) => `${value}`.padStart(2, "0");
	return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}` +
		` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Compact token count: 951, 3.7k, 43.8k, 1M. */
export function formatUsageTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${trimTrailingZero((tokens / 1_000).toFixed(1))}k`;
	return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
}

/** Percentage with one decimal below 10%: 0.4%, 4.2%, 96%. */
export function formatUsagePercent(ratio: number): string {
	const percent = ratio * 100;
	if (percent >= 10) return `${Math.round(percent)}%`;
	return `${trimTrailingZero(percent.toFixed(1))}%`;
}

function trimTrailingZero(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}
