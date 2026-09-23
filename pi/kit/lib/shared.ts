/**
 * Where a fact that must survive a re-import lives.
 *
 * pi gives every extension file its own module registry, and caches extension
 * factories by cwd: the moment one seat loads extensions under a different
 * working directory — a child agent in a worktree — the cache is cleared and
 * every later load re-imports this package's files. A `Map` held in a module
 * variable is then two maps. One seat writes into one, another reads the
 * other, and the miss is indistinguishable from "nothing was ever written":
 * on 2026-09-05 that turned an Opus seat into a Fable one in silence
 * (ticket 64).
 *
 * So the container goes on the process. Fourteen files hand-wrote the same
 * fifteen lines to put it there; this is those lines, once, so that the safe
 * path is shorter than the unsafe one.
 */

/**
 * The one container this process holds under `key`, built by `make` on first
 * use. Every module instance in the process gets the same object back.
 */
export function shared<T extends object>(key: string | symbol, make: () => T): T {
	const host = globalThis as Record<string | symbol, unknown>;
	const existing = host[key];
	// SAFETY: the key names the shape, and only this package writes these keys.
	// Two copies of the kit that disagree about a shape need a new key rather
	// than a runtime check — `transcript/planner-state.ts` versions its own for
	// exactly that reason.
	if (existing !== undefined) return existing as T;
	const created = make();
	host[key] = created;
	return created;
}
