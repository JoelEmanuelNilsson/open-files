/**
 * State that has to survive a re-import, checked two ways.
 *
 * pi caches extension factories by cwd, so the moment one seat loads
 * extensions under a different working directory — a child agent in a
 * worktree — this package's files are imported again and every module-level
 * binding in them has a second instance. On 2026-09-05 that turned an Opus
 * seat into a Fable one in silence: one copy of `continue-session.ts` wrote
 * the seat's controls into its map, the other read its own empty one, found
 * nothing and returned (ticket 64).
 *
 * The lint below is the cheap half: in a file that takes part in a session, a
 * container created empty at module scope, or a `let`, is state that will
 * duplicate. It is deliberately narrow. A rule that fired on every module-level
 * `const X = new Set([...])` would ship with eight suppression comments, and a
 * suppression comment is exactly where the next author writes "just a cache".
 *
 * The duplication tests are the expensive half, and the only ones that check
 * the property rather than the syntax: `import(url + "?a")` and
 * `import(url + "?b")` give two live copies of a module in one process, so a
 * write through one has to be visible through the other. They are spent on the
 * two seams whose failure is silent — a duplicate there returns early rather
 * than throwing.
 *
 *     node test/shared-state.mjs
 */

import "./env.mjs";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

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
	if (!SESSION_AWARE.test(source)) return [];
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

/**
 * The two files that may hold module state today, and why each is not the bug.
 * A third entry is a signal the rule drifted wide, not a licence.
 */
const ALLOWED = {
	"extensions/transcript/index.ts": "a cwd-keyed cache of tool definitions; a second copy re-reads them, it never loses a registration",
	"extensions/herdr-agent-state.ts": "vendor-managed, and every handler returns early unless the seat is the TUI, so a second copy stays inert",
};

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
	check("a container behind shared() does not fire", fires("const seats = (): Map<string, string> => shared(SEAM, () => new Map());\n") === 0);
	check("a map built inside a function is per-call, not module state", fires("function of(): Map<string, string> {\n\tconst seats = new Map();\n\treturn seats;\n}\n") === 0);
	check("an indented map in a class body does not fire", fires("class Rows {\n\tseats = new Map();\n}\n") === 0);

	check("a file that takes part in no session is not the rule's business", duplicableState("const seats = new Map();\n").length === 0);
	check("getSessionId() alone makes a file the rule's business", duplicableState("const seats = new Map();\nexport const of = (ctx) => ctx.sessionManager.getSessionId();\n").length === 1);
}

// ---------------------------------------------------------------------------
console.log("\nthe rule, over the kit");
{
	const files = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
			else if (entry.name.endsWith(".ts")) files.push(path.relative(ROOT, full));
		}
	};
	for (const dir of ["lib", "extensions"]) walk(path.join(ROOT, dir));

	const found = new Map();
	for (const file of files) {
		const hits = duplicableState(fs.readFileSync(path.join(ROOT, file), "utf8"));
		if (hits.length > 0) found.set(file, hits);
	}

	const unexpected = [...found.keys()].filter((file) => ALLOWED[file] === undefined);
	check(
		"no session-aware file holds module state outside the two that may",
		unexpected.length === 0,
		unexpected.map((file) => `${file}\n         ${found.get(file).map((hit) => `${hit.line}: ${hit.text}`).join("\n         ")}\n       put it behind shared() from lib/shared.ts`).join("\n       "),
	);

	const stale = Object.keys(ALLOWED).filter((file) => !found.has(file));
	check("every allowlist entry is still earning its place", stale.length === 0, `${stale.join(", ")} no longer holds module state — drop the entry`);
	check("the allowlist is the two files the ticket named, and nothing has been added to it", Object.keys(ALLOWED).length === 2, Object.keys(ALLOWED).join(", "));
	console.log(`  (${files.length} files, ${files.filter((f) => SESSION_AWARE.test(fs.readFileSync(path.join(ROOT, f), "utf8"))).length} of them session-aware)`);
}

// ---------------------------------------------------------------------------
// Two live copies of a module in one process. `?a` and `?b` are ignored by the
// file system and honoured by the module registry, which is the whole trick.
// ---------------------------------------------------------------------------

console.log("\nlib/seat.ts: a child seat declared through one copy is seen by the other");
{
	const a = await import(`${ROOT}/lib/seat.ts?a`);
	const b = await import(`${ROOT}/lib/seat.ts?b`);
	const seat = { name: "worker-1", role: "worker", depth: 1, parentSessionId: "parent-1", workflowChild: false, workflows: false, prompt: { kind: "inherit" } };

	check("the two imports really are two copies of the module", a !== b && a.declareChildSeat !== b.declareChildSeat);
	a.declareChildSeat("child-1", seat);
	check("the copy that did not declare it finds it", b.childSeatOf("child-1")?.name === "worker-1", JSON.stringify(b.childSeatOf("child-1")));
	check("and it is the same object, not a copy of one", b.childSeatOf("child-1") === seat);
	b.forgetChildSeat("child-1");
	check("forgetting it through the other copy forgets it for both", a.childSeatOf("child-1") === undefined);

	// The launcher's workflow answer travels the same seam, and a declared child
	// carries its own copy of it rather than reading its parent's.
	a.declareSeatWorkflows("main-1", true);
	check("a main seat's workflow answer crosses copies", b.seatCarriesWorkflows("main-1") === true && b.toolSeatOf("main-1").workflows === true);
	check("a seat nobody answered for carries none", b.seatCarriesWorkflows("main-2") === false && b.toolSeatOf("main-2").role === "main");
	a.declareChildSeat("child-2", { ...seat, role: "lead", workflows: false });
	check("a child's own answer is what its seat reports", b.seatCarriesWorkflows("child-2") === false && b.toolSeatOf("child-2").role === "lead");
	a.forgetChildSeat("child-2");
	a.declareSeatWorkflows("main-1", false);
	check("and an answer can be taken back at shutdown", b.seatCarriesWorkflows("main-1") === false);
}

// ---------------------------------------------------------------------------
console.log("\nextensions/continue-session.ts: the handoff carry reaches the successor's own copy (ticket 64)");
{
	const MODEL = { provider: "scripted", id: "scripted-2" };
	const DOC = "# Handoff\n## Intent\nFinish the switch.\n## Next\nRun the suite.";

	/** One extension instance, with everything it says to pi recorded. */
	const instance = (module) => {
		const said = { handlers: new Map(), commands: new Map(), models: [], thinking: [], entries: [] };
		module.default({
			on: (event, handler) => said.handlers.set(event, handler),
			registerCommand: (name, spec) => said.commands.set(name, spec),
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: (customType, data) => said.entries.push({ customType, data }),
			setModel: async (model) => { said.models.push(model); return true; },
			setThinkingLevel: (level) => said.thinking.push(level),
			getThinkingLevel: () => "high",
		});
		return said;
	};

	const successor = instance(await import(`${ROOT}/extensions/continue-session.ts?a`));
	const outgoing = instance(await import(`${ROOT}/extensions/continue-session.ts?b`));
	check("the two imports really are two copies of the extension", successor.handlers.get("session_start") !== outgoing.handlers.get("session_start"));

	// The successor's own instance registers its controls, as it does at the
	// session_start pi fires before it hands the switch its fresh context.
	successor.handlers.get("session_start")({}, { sessionManager: { getSessionId: () => "fresh-1" } });

	// The outgoing session's instance writes a handoff document, settles, and
	// runs the continuation — all of it through the other copy.
	const old = {
		sessionManager: { getSessionId: () => "old-1", getSessionFile: () => "/tmp/old-1.jsonl", getEntries: () => [] },
		model: MODEL,
	};
	outgoing.handlers.get("turn_end")({ message: { role: "assistant", content: [{ type: "text", text: DOC }] }, toolResults: [] }, old);
	outgoing.handlers.get("agent_settled")({}, old);

	const fresh = {
		model: MODEL,
		thinkingLevel: "high",
		hasUI: false,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "fresh-1" },
		getSystemPromptOptions: () => ({ cwd: "/" }),
		sendUserMessage: async () => {},
	};
	const said = [];
	const stderr = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk) => { said.push(String(chunk)); return true; };
	await outgoing.commands.get("handoff-continue").handler("", {
		...old,
		newSession: async ({ setup, withSession }) => {
			await setup?.({ getSessionId: () => "fresh-1", appendCustomEntry: () => {} });
			await withSession?.(fresh);
			return { cancelled: false };
		},
	});
	process.stderr.write = stderr;

	check("the outgoing copy's carry reached the successor copy's model control", successor.models.length === 1 && successor.models[0] === MODEL, JSON.stringify(successor.models));
	check("and its thinking-level control", successor.thinking.join(",") === "high", JSON.stringify(successor.thinking));
	check("the successor's copy recorded the seat as carried", successor.entries.at(-1)?.data?.carried === true, JSON.stringify(successor.entries));
	check("the copy that ran the switch never reached its own empty map", outgoing.models.length === 0 && outgoing.thinking.length === 0, JSON.stringify({ models: outgoing.models, thinking: outgoing.thinking }));
	check("nothing was warned about: a carry that works says nothing", said.length === 0, JSON.stringify(said));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
