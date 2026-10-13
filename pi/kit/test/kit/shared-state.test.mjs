/**
 * State that has to survive a re-import, checked two ways.
 *
 * pi caches extension factories by cwd, so the moment one seat loads
 * extensions under a different working directory — a child agent in a
 * worktree — this package's files are imported again and every module-level
 * binding in them has a second instance. On 2026-09-05 that turned an Opus
 * seat into a Fable one in silence: one copy of a module wrote the seat's
 * controls into its map, the other read its own empty one, found nothing and
 * returned (ticket 64).
 *
 * The lint below is the cheap half: in a file that takes part in a session, a
 * container created empty at module scope, or a `let`, is state that will
 * duplicate. It is deliberately narrow. A rule that fired on every module-level
 * `const X = new Set([...])` would ship with eight suppression comments, and a
 * suppression comment is exactly where the next author writes "just a cache".
 *
 * State lifted out of such a file into a helper duplicates all the same, so the
 * rule also reads every module an extension entry imports. There a flagged site
 * may stand only with `// shared-state: <why>` on the line above it — the why
 * is reviewed where the state is, not in a file-wide allowlist — and a marker
 * that no longer sits on a flagged site fails.
 *
 * The duplication tests are the expensive half, and the only ones that check
 * the property rather than the syntax: `import(url + "?a")` and
 * `import(url + "?b")` give two live copies of a module in one process, so a
 * write through one has to be visible through the other. They are spent on the
 * two seams whose failure is silent — a duplicate there returns early rather
 * than throwing.
 *
 *     node test/kit/shared-state.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, PI_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** A file takes part in a session when it handles pi's events or asks who it is. */
const SESSION_AWARE = /pi\.on\(|getSessionId\(\)/;

/**
 * A container created empty is a registry — something fills it later, from
 * somewhere else. One created with its contents is a lookup table, which two
 * copies of hold the same answers. `WeakMap`/`WeakSet` cannot be a session
 * registry: an object key does not survive the trip either.
 */
const EMPTY_CONTAINER = /(?<!Weak)(?:Map|Set)(?:<[^=]*?>)?\(\s*\)|=\s*\[\s*\]/;

const REBINDABLE = /^(?:export\s+)?(?:let|var)\s/;
const DECLARATION = /^(?:export\s+)?(?:const|let|var)\s/;
/** A declaration whose value is a function: what it builds inside is per-call, not module state. */
const FUNCTION_HEAD = /=>|\bfunction\b/;

/**
 * The module-scope state in `source` that a second copy of the file would hold
 * separately, as `{ line, text }`.
 *
 * Text, not an AST: a statement is a line starting in column 0 and everything
 * indented under it. The declared limit of reading it that way is that a
 * container built inside a multi-line function expression at module scope is
 * not seen — {@link FUNCTION_HEAD} skips the whole statement.
 */
function duplicableState(source) {
	return SESSION_AWARE.test(source) ? moduleState(source) : [];
}

/** {@link duplicableState} without the session gate: what a module an extension imports is checked for. */
function moduleState(source) {
	const lines = source.split("\n");
	const starts = lines.flatMap((line, index) => (/^\S/.test(line) ? [index] : []));
	const hits = [];
	for (const [nth, start] of starts.entries()) {
		const head = lines[start];
		if (!DECLARATION.test(head) || FUNCTION_HEAD.test(head)) continue;
		const statement = lines.slice(start, starts[nth + 1] ?? lines.length).join("\n");
		if (REBINDABLE.test(statement) || EMPTY_CONTAINER.test(statement)) hits.push({ line: start + 1, text: head.trim() });
	}
	return hits;
}

/** A flagged site's reason, on the line directly above it. */
const MARKER = /^\s*\/\/ shared-state: \S/;

/**
 * The module state in `source` with no marker above it, and the 1-based lines
 * of markers that sit above no flagged site.
 */
function unmarkedState(source) {
	const lines = source.split("\n");
	const hits = moduleState(source);
	const markers = new Set(hits.filter((hit) => MARKER.test(lines[hit.line - 2] ?? "")).map((hit) => hit.line - 1));
	return {
		unmarked: hits.filter((hit) => !markers.has(hit.line - 1)),
		stale: lines.flatMap((line, index) => (MARKER.test(line) && !markers.has(index + 1) ? [index + 1] : [])),
	};
}

/**
 * Files that may hold module state, each with why it is not the bug. Empty:
 * an entry is a signal the rule drifted wide, not a licence.
 */
const ALLOWED = {};

// ---------------------------------------------------------------------------
console.log("the rule, on fixtures");
{
	const session = 'pi.on("session_start", () => {});\n';
	const fires = (body) => duplicableState(session + body).length;

	check("a registry map fires", fires("const seats = new Map();\n") === 1);
	check("a typed registry map fires", fires("const seats = new Map<string, Set<string>>();\n") === 1);
	check("a registry set fires", fires("const seen = new Set();\n") === 1);
	check("an empty array fires", fires("const rows: string[] = [];\n") === 1);
	check("a module-scope let fires", fires("let current: string | undefined;\n") === 1);
	check("an exported let fires", fires("export let count = 0;\n") === 1);
	check("a map inside a module-scope object literal fires", fires("const state = {\n\tseats: new Map(),\n};\n") === 1);
	check("every line of a file with several is reported", duplicableState(`${session}let a = 1;\nlet b = 2;\n`).length === 2);

	check("a seeded lookup set does not fire", fires('const WRITE_TOOLS = new Set(["edit", "write"]);\n') === 0);
	check("a seeded lookup set across lines does not fire", fires('const MODES = new Set([\n\t"off",\n]);\n') === 0);
	check("a seeded array does not fire", fires('const MODES: Mode[] = ["bell", "off"];\n') === 0);
	check("a seeded array across lines does not fire", fires('const CHOICES = [\n\t"one",\n];\n') === 0);
	check("a WeakMap does not fire", fires("const byNode = new WeakMap();\n") === 0);
	check("a WeakSet does not fire", fires("const seen = new WeakSet();\n") === 0);
	check("a container behind processShared() does not fire", fires("const seats = (): Map<string, string> => processShared(SEAM, () => new Map());\n") === 0);
	check("a map built inside a function is per-call, not module state", fires("function of(): Map<string, string> {\n\tconst seats = new Map();\n\treturn seats;\n}\n") === 0);
	check("an indented map in a class body does not fire", fires("class Rows {\n\tseats = new Map();\n}\n") === 0);

	check("a file that takes part in no session is not the rule's business", duplicableState("const seats = new Map();\n").length === 0);
	check("getSessionId() alone makes a file the rule's business", duplicableState("const seats = new Map();\nexport const of = (ctx) => ctx.sessionManager.getSessionId();\n").length === 1);
}

// ---------------------------------------------------------------------------
console.log("\nshared-state markers, on fixtures");
{
	const marked = unmarkedState("// shared-state: a memo of a pure function\nconst memo = new Map();\nlet other = 0;\n");
	check("a marker on the line above a site accepts that site and no other", marked.unmarked.map((hit) => hit.line).join() === "3" && marked.stale.length === 0, JSON.stringify(marked));
	check("a marker above no flagged site is stale", unmarkedState("// shared-state: a memo\nconst MODES = new Set([\"off\"]);\n").stale.join() === "1");
	check("a marker with no reason is no marker", unmarkedState("// shared-state:\nlet other = 0;\n").unmarked.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\nthe rule, over the kit");
{
	const files = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
			else if (entry.name.endsWith(".ts")) files.push(path.relative(KIT_ROOT, full));
		}
	};
	for (const dir of ["lib", "extensions"]) walk(path.join(KIT_ROOT, dir));

	const found = new Map();
	for (const file of files) {
		const hits = duplicableState(fs.readFileSync(path.join(KIT_ROOT, file), "utf8"));
		if (hits.length > 0) found.set(file, hits);
	}

	const unexpected = [...found.keys()].filter((file) => ALLOWED[file] === undefined);
	check(
		"no session-aware file holds module state outside the allowlist",
		unexpected.length === 0,
		unexpected.map((file) => `${file}\n         ${found.get(file).map((hit) => `${hit.line}: ${hit.text}`).join("\n         ")}\n       put it behind processShared() from lib/process/process-shared-state.ts`).join("\n       "),
	);

	const stale = Object.keys(ALLOWED).filter((file) => !found.has(file));
	check("every allowlist entry is still earning its place", stale.length === 0, `${stale.join(", ")} no longer holds module state — drop the entry`);
	check("the allowlist is empty, and nothing has been added to it", Object.keys(ALLOWED).length === 0, Object.keys(ALLOWED).join(", "));
	console.log(`  (${files.length} files, ${files.filter((f) => SESSION_AWARE.test(fs.readFileSync(path.join(KIT_ROOT, f), "utf8"))).length} of them session-aware)`);

	console.log("\nthe rule, over every module an extension imports");
	// pi loads `extensions/<name>.ts` and `extensions/<name>/index.ts`. esbuild's
	// bundler resolves their static and literal dynamic imports, so a specifier in
	// a comment or string is never mistaken for one; packages stay external.
	const extensions = path.join(KIT_ROOT, "extensions");
	const entries = fs.readdirSync(extensions, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isFile()) return entry.name.endsWith(".ts") ? [path.join(extensions, entry.name)] : [];
		const index = path.join(extensions, entry.name, "index.ts");
		return entry.isDirectory() && fs.existsSync(index) ? [index] : [];
	});
	const { metafile } = createRequire(`${PI_ROOT}/package.json`)("esbuild").buildSync({
		entryPoints: entries,
		absWorkingDir: KIT_ROOT,
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		splitting: true,
		outdir: "out",
		write: false,
		metafile: true,
		logLevel: "error",
	});
	const imported = Object.keys(metafile.inputs).filter((file) => file.endsWith(".ts") && !file.startsWith("../") && !file.includes("node_modules/"));
	check("the import graph reaches past the extension entries", imported.length > entries.length, `${imported.length} modules from ${entries.length} entries`);

	// A session-aware file answers to the allowlist above; a marker in one is stale.
	const unmarkedSites = [];
	const staleMarkers = [];
	const sources = new Map(files.map((file) => [file, fs.readFileSync(path.join(KIT_ROOT, file), "utf8")]));
	for (const file of imported) sources.set(file, sources.get(file) ?? fs.readFileSync(path.join(KIT_ROOT, file), "utf8"));
	const audited = new Set(imported.filter((file) => !SESSION_AWARE.test(sources.get(file))));
	for (const [file, source] of sources) {
		const audit = audited.has(file) ? unmarkedState(source) : { unmarked: [], stale: source.split("\n").flatMap((line, index) => (MARKER.test(line) ? [index + 1] : [])) };
		unmarkedSites.push(...audit.unmarked.map((hit) => `${file}:${hit.line}: ${hit.text}`));
		staleMarkers.push(...audit.stale.map((line) => `${file}:${line}`));
	}
	check(
		"no module an extension imports holds module state without a shared-state marker",
		unmarkedSites.length === 0,
		`${unmarkedSites.join("\n       ")}\n       put it behind processShared() from lib/process/process-shared-state.ts, or say why a second copy is harmless: // shared-state: <why>`,
	);
	check("every shared-state marker still sits on a flagged site", staleMarkers.length === 0, `${staleMarkers.join(", ")}: drop the marker`);
	console.log(`  (${imported.length} modules from ${entries.length} entries, ${audited.size} of them not session-aware)`);
}

// ---------------------------------------------------------------------------
// Two live copies of a module in one process. `?a` and `?b` are ignored by the
// file system and honoured by the module registry, which is the whole trick.
// ---------------------------------------------------------------------------

console.log("\nlib/session/seat-identity.ts: a child seat declared through one copy is seen by the other");
{
	const a = await import(`${KIT_ROOT}/lib/session/seat-identity.ts?a`);
	const b = await import(`${KIT_ROOT}/lib/session/seat-identity.ts?b`);
	const seat = { name: "worker-1", role: "worker", depth: 1, parentSessionId: "parent-1", workflowChild: false, workflows: false, prompt: { kind: "inherit" } };

	check("the two imports really are two copies of the module", a !== b && a.declareChildSeat !== b.declareChildSeat);
	a.declareChildSeat("child-1", seat);
	check("the copy that did not declare it finds it", b.childSeatOf("child-1")?.name === "worker-1", JSON.stringify(b.childSeatOf("child-1")));
	check("and it is the same object, not a copy of one", b.childSeatOf("child-1") === seat);
	b.forgetChildSeat("child-1");
	check("forgetting it through the other copy forgets it for both", a.childSeatOf("child-1") === undefined);

	// A declared child carries its own workflows answer rather than reading its parent's.
	a.declareChildSeat("child-2", { ...seat, role: "lead", workflows: false });
	check("a child's own answer is what its seat reports", b.seatCarriesWorkflows("child-2") === false && b.childSeatOf("child-2").role === "lead");
	a.forgetChildSeat("child-2");
}

await finish();
