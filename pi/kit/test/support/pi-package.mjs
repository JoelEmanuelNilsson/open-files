/**
 * Where the kit and pi live, for a suite file: pi resolved once, the way the
 * kit's extensions resolve it, so a test patches the same module instance.
 * A test file imports what it needs, e.g.
 * `import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";`,
 * then `const jiti = kitJiti({ moduleCache: false });` and
 * `await jiti.import(`${KIT_ROOT}/lib/…`)`.
 */

import "./suite-env.mjs";
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The kit's root directory (pi/kit), the same from any depth under test/. */
export const KIT_ROOT = path.resolve(import.meta.dirname, "../..");

/** The checkout under test (the kit's repo root) — never assume ~/dotfiles. */
export const REPO_ROOT = path.resolve(KIT_ROOT, "../..");

const LINKED_PI_ROOT = path.join(KIT_ROOT, "node_modules/@earendil-works/pi-coding-agent");

/** The pi-coding-agent package directory: the kit's peer link realpathed, else the global install. */
export const PI_ROOT = existsSync(LINKED_PI_ROOT)
	? realpathSync(LINKED_PI_ROOT)
	: (() => {
			const globalPiRoot = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
			if (!existsSync(globalPiRoot)) throw new Error(`pi-package: pi-coding-agent is at neither ${LINKED_PI_ROOT} nor ${globalPiRoot}; run install.sh to link it`);
			return realpathSync(globalPiRoot);
		})();

/** Imports a module from inside pi's package directory, e.g. `importPi("dist/index.js")`. */
export function importPi(subpath) {
	return import(pathToFileURL(path.join(PI_ROOT, subpath)).href);
}

const { createJiti } = await importPi("node_modules/jiti/lib/jiti.mjs");

/** A jiti loader for kit TypeScript; `moduleCache: false` gives this loader fresh module instances. */
export function kitJiti({ moduleCache = true } = {}) {
	// A fixed filename under test/ keeps bare-specifier resolution and the fs
	// cache (test/node_modules/.cache/jiti) the same from any test depth.
	return createJiti(path.join(KIT_ROOT, "test/kit-jiti.mjs"), {
		interopDefault: true,
		moduleCache,
		fsCache: path.join(KIT_ROOT, "test/node_modules/.cache/jiti"),
	});
}

/** Initialises pi's dark theme without a file watcher and returns pi's `theme` proxy. */
export async function initDarkTheme() {
	const { initTheme, theme } = await importPi("dist/modes/interactive/theme/theme.js");
	initTheme("dark", false);
	return theme;
}
