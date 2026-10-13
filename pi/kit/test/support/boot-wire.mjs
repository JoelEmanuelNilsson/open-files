/**
 * Boots the wire extension (extensions/wire/index.ts) into a fake pi, e.g.
 * `const { handlers, commands } = await bootWire(jiti, "?quota");`, then
 * `handlers.get("before_provider_request")({ payload }, ctx)`.
 */

import { KIT_ROOT } from "./pi-package.mjs";
import { fakeExtensionApi } from "./fake-extension-api.mjs";

/**
 * Loads a fresh wire instance through the caller's `jiti` (`tag` is a query that keeps it apart from other instances).
 * `handlers.get(event)` answers the last handler registered for the event: the wire's own, after its session scope's.
 */
export async function bootWire(jiti, tag = "", overrides = {}) {
	const pi = fakeExtensionApi(overrides);
	(await jiti.import(`${KIT_ROOT}/extensions/wire/index.ts${tag}`)).default(pi.api);
	return { handlers: { get: (event) => pi.handlers.get(event)?.at(-1) }, commands: pi.commands };
}
