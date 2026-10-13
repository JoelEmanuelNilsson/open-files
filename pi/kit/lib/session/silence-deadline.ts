const DEFAULT_DEADLINE_MS = 15 * 60_000;

export function resolveDeadlineMs(raw: string | undefined): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEADLINE_MS;
}
