/**
 * Marks the child AgentSession that btw spawns for its side thread.
 *
 * The child is created with pi's default resource loader, because provider
 * patches (Claude subscription auth, proxies) live in extensions that hook
 * agent-pipeline events and a session without them gets rejected. The cost is
 * that the child also loads *this* package. Widgets would rebind to a session
 * with no UI, probes would fire, btw would recurse.
 *
 * So: btw sets the flag around session creation, and every pi-kit extension
 * checks it at factory time and stands down. The flag rides on globalThis
 * because the child runs in the same process but gets its own module registry,
 * so a module-level variable would not be shared.
 */

export const SIDE_FLAG = "__piKitSideSession";

export function isSideSession(): boolean {
	return (globalThis as Record<string, unknown>)[SIDE_FLAG] === true;
}

export function markSideSession(active: boolean): void {
	(globalThis as Record<string, unknown>)[SIDE_FLAG] = active;
}
