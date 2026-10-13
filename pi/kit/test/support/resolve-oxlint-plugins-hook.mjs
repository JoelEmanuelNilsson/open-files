/** The anti-slop rules live outside test/, so their `@oxlint/plugins` import resolves here, where the dev tools are installed. */
export function resolve(specifier, context, nextResolve) {
	if (specifier === "@oxlint/plugins") {
		return nextResolve(specifier, { ...context, parentURL: new URL("../package.json", import.meta.url).href });
	}
	return nextResolve(specifier, context);
}
