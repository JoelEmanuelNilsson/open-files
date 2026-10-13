/**
 * The kit's import boundaries, checked over every import in `extensions/`,
 * `lib/` and `bin/`.
 *
 * - A file inside `extensions/<name>/` is private to that extension: only
 *   files in the same folder import it. `bin/` tools are consumers outside
 *   every extension. A single-file extension is private whole.
 * - `lib/` is shared code in domain folders (`lib/<domain>/`), and everything
 *   a `lib` module imports from the kit is itself in `lib/`, so `lib` never
 *   reaches into an extension.
 *
 * Tests are exempt: they drive private modules on purpose. A folder with its
 * own `package.json` (a vendored prototype) is its own project, not kit
 * source. `bin/` tools load kit modules by path through jiti, so a template
 * naming `lib/…` or `extensions/…` counts as an import there.
 *
 *   node test/kit/import-boundaries.test.mjs
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Statement-level imports and re-exports, type-only ones included; `import("…")` anywhere. */
const STATIC_IMPORT = /^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
/** A kit module a `bin/` tool loads by path: `${KIT}lib/…`, `${kit}/extensions/…`. */
const BIN_KIT_PATH = /`\$\{\w+\}\/?((?:lib|extensions)\/[\w./-]+)`|["']((?:lib|extensions)\/[\w./-]+\.ts)["']/g;

/** Every kit source file under `dir`, skipping node_modules and any folder that is its own package. */
function sourcesUnder(kit, dir, pattern) {
	const found = [];
	const walk = (full) => {
		for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
			const next = path.join(full, entry.name);
			if (entry.isDirectory()) { if (entry.name !== "node_modules" && !fs.existsSync(path.join(next, "package.json"))) walk(next); }
			else if (pattern.test(entry.name)) found.push(path.relative(kit, next));
		}
	};
	if (fs.existsSync(path.join(kit, dir))) walk(path.join(kit, dir));
	return found;
}

/** Who a kit file belongs to: an extension's name, `lib`, or `bin`. */
function ownerOf(file) {
	const [top, second, ...rest] = file.split("/");
	if (top === "extensions") return `extension ${rest.length > 0 ? second : second.replace(/\.ts$/, "")}`;
	return top;
}

/** Every boundary the kit at `kit` breaks, as readable lines. */
function boundaryViolations(kit) {
	const violations = [];
	const importers = [...sourcesUnder(kit, "extensions", /\.ts$/), ...sourcesUnder(kit, "lib", /\.ts$/), ...sourcesUnder(kit, "bin", /\.m?js$/)];
	for (const file of sourcesUnder(kit, "lib", /\.ts$/)) {
		if (file.split("/").length < 3) violations.push(`${file}: lib modules live in a domain folder, lib/<domain>/`);
	}
	for (const importer of importers) {
		const source = fs.readFileSync(path.join(kit, importer), "utf8");
		const targets = [];
		for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
			for (const match of source.matchAll(re)) {
				const spec = match[1] ?? match[2];
				if (spec.startsWith(".")) targets.push({ spec, file: path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec)) });
			}
		}
		if (importer.startsWith("bin/")) {
			for (const match of source.matchAll(BIN_KIT_PATH)) targets.push({ spec: match[1] ?? match[2], file: match[1] ?? match[2] });
		}
		for (const target of targets) {
			const where = `${importer} imports ${target.spec}`;
			if (target.file.startsWith("..")) { violations.push(`${where}: outside the kit`); continue; }
			if (!fs.existsSync(path.join(kit, target.file))) { violations.push(`${where}: no such file`); continue; }
			const from = ownerOf(importer);
			const to = ownerOf(target.file);
			if (!["extension", "lib", "bin"].some((owner) => to.startsWith(owner))) continue;
			if (from === "lib" && to !== "lib") violations.push(`${where}: lib imports only lib`);
			else if (to.startsWith("extension") && from !== to) violations.push(`${where}: private to ${to}`);
			else if (to === "bin" && from !== "bin") violations.push(`${where}: nothing imports a bin/ tool`);
		}
	}
	return violations;
}

section("the rules catch what they are for");
{
	const kit = fs.mkdtempSync(path.join(os.tmpdir(), "import-boundaries-"));
	const put = (file, text) => {
		fs.mkdirSync(path.dirname(path.join(kit, file)), { recursive: true });
		fs.writeFileSync(path.join(kit, file), text);
	};
	put("lib/ui/rule.ts", 'import { a } from "../../extensions/dock/index.ts";\nexport const b = a;\n');
	put("lib/ui/fine.ts", 'import type { T } from "../agents/types.ts";\nimport { x } from "@earendil-works/pi-tui";\n');
	put("lib/agents/types.ts", "export type T = 1;\n");
	put("lib/flat.ts", "export const c = 1;\n");
	put("extensions/dock/index.ts", 'import { d } from "./private.ts";\nimport { e } from "../chrome/paint.ts";\n');
	put("extensions/dock/private.ts", "export const d = 1;\n");
	put("extensions/chrome/index.ts", 'import { e } from "./paint.ts";\n');
	put("extensions/chrome/paint.ts", "export const e = 1;\n");
	put("extensions/solo.ts", 'import type { T } from "../lib/agents/types.ts";\n');
	put("extensions/chrome/prototype/package.json", "{}\n");
	put("extensions/chrome/prototype/src/x.ts", 'import { d } from "../../../dock/private.ts";\n');
	put("bin/tool.mjs", 'const lib = (p) => jiti.import(`${KIT}${p}`);\nawait jiti.import(`${KIT}lib/ui/fine.ts`);\nawait jiti.import(`${kit}/extensions/dock/private.ts`);\n');
	const found = boundaryViolations(kit);
	const hit = (text) => found.some((line) => line.includes(text));
	check("lib reaching into an extension", hit("lib/ui/rule.ts imports ../../extensions/dock/index.ts: lib imports only lib"), found.join("\n       "));
	check("an extension importing another's private file", hit("extensions/dock/index.ts imports ../chrome/paint.ts: private to extension chrome"));
	check("a bin/ tool importing an extension's private file", hit("bin/tool.mjs imports extensions/dock/private.ts: private to extension dock"));
	check("a lib module outside a domain folder", hit("lib/flat.ts: lib modules live in a domain folder"));
	check("and nothing else: own-folder imports, lib from anywhere, packages and foreign projects pass", found.length === 4, found.join("\n       "));
	fs.rmSync(kit, { recursive: true, force: true });
}

section("the kit keeps them");
{
	const found = boundaryViolations(KIT_ROOT);
	check("no import crosses a boundary", found.length === 0, found.join("\n       "));
	check("and the scan saw the kit", sourcesUnder(KIT_ROOT, "lib", /\.ts$/).length > 20 && sourcesUnder(KIT_ROOT, "extensions", /\.ts$/).length > 50);
}

await finish();
