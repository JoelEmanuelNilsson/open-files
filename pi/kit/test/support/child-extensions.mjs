/**
 * The `PI_AGENT_CHILD_EXTENSIONS` value for a test that spawns agent children:
 * the extension files a child loads instead of the seat's discovered set.
 * A test sets it before loading the engine, e.g.
 * `process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts", probePath);`.
 * Built here rather than as a template string so a moved or misspelt extension
 * fails at setup, naming the path, instead of as a child that silently lacks it.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { KIT_ROOT } from "./pi-package.mjs";

/** Joins extension paths (kit-relative or absolute) into the `:`-separated child extension list `extensions/agent-engine/index.ts` splits; throws naming every missing path. */
export function childExtensionsList(...extensionPaths) {
	if (extensionPaths.length === 0) throw new Error("childExtensionsList: no extension paths given; an empty list means the seat's discovered set");
	const resolved = extensionPaths.map((entry) => path.resolve(KIT_ROOT, entry));
	// `extensions/agent-engine/index.ts` splits on `:`, so a path containing one would arrive as two.
	const unsplittable = resolved.filter((entry) => entry.includes(":"));
	if (unsplittable.length > 0) throw new Error(`childExtensionsList: paths contain the ':' separator: ${unsplittable.join(", ")}`);
	const missing = resolved.filter((entry) => !existsSync(entry));
	if (missing.length > 0) throw new Error(`childExtensionsList: extension files do not exist: ${missing.join(", ")}`);
	return resolved.join(":");
}
