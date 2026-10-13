export function processShared<T extends object>(key: string | symbol, make: () => T): T {
	// SAFETY: globalThis is only used as a keyed bag of process-shared slots
	const host = globalThis as Record<string | symbol, unknown>;
	const existing = host[key];
	if (existing !== undefined) {
		// SAFETY: the slot for key is only ever written by this function with make()'s T
		return existing as T;
	}
	const created = make();
	host[key] = created;
	return created;
}
