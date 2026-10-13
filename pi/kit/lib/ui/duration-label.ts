export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 60_000) return `${Math.floor(safe / 1000)}s`;
	let minutes = Math.floor(safe / 60_000);
	let seconds = Math.round((safe % 60_000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
