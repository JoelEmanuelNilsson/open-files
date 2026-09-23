import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = path.resolve(import.meta.dirname, "..");

// Booting `wire` opens a cache trace. Point it at a temp dir so a test run
// cannot litter the real one; `test/wire-trace.mjs` owns the sink's own checks.
const TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-wire-trace-"));
process.env.PI_WIRE_TRACE_DIR = TRACE_DIR;
// The same for everything else the kit keeps under its state root — the
// warm-prefix ledger above all, which a real seat on this machine reads.
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-state-"));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
/** For checks whose oracle is absent on this machine — never a silent pass. */
const skipped = [];
const skip = (name) => { skipped.push(name); console.log(`  skip ${name}`); };
/**
 * A regex over Claude Code's minified bundle, where every identifier is a hole.
 *
 * Claude Code ships minified, and the minifier renames module-scope
 * identifiers on every build. An oracle that pins a name — `Lun`, `l_e`,
 * `RBt` — therefore reports "Claude Code changed" on a release that changed
 * nothing, and because `npm test` chains on `&&` it takes the other nine test
 * files down with it. These patterns pin what Anthropic actually decides:
 * literal values, argument order, field order. The names are holes.
 *
 *   `{}`  — any minified identifier, captured
 *   `{2}` — whatever the 2nd hole captured, again (ties two names together)
 *
 * Everything else in the shape is matched literally.
 */
const minified = (shape) =>
	new RegExp(
		shape
			.split(/(\{\d*\})/)
			.map((part) => {
				if (part === "{}") return "([A-Za-z_$][A-Za-z0-9_$]*)";
				const backreference = /^\{(\d+)\}$/.exec(part);
				return backreference ? `\\${backreference[1]}` : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			})
			.join(""),
	);

function makeApi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const api = {
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: (n, o) => commands.set(n, o),
		registerEntryRenderer: () => {},
		registerShortcut: () => {},
		appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
		on: (e, h) => handlers.set(e, h),
		getThinkingLevel: () => "off",
		sendUserMessage: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	return { api, tools, commands, handlers, entries };
}

const ctx = (cwd, sessionId = "s1") => ({
	cwd,
	hasUI: false,
	mode: "print",
	sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	ui: { notify: () => {}, setWidget: () => {}, theme: {} },
});

// pi runs `prepareArguments` and *then* validates against the advertised
// schema (`prepareToolCallArguments` → `validateToolArguments`), so whatever
// prepare returns must satisfy the schema the model was shown. A harness that
// skips the validator passes tests on a tool the live loop rejects — which is
// exactly how a tool once shipped a prepare step that emitted a shape its own
// schema rejected (2026-09-01). Same order, same library, so that class of bug
// now fails here first.
const { Value } = await jiti.import("typebox/value");
const call = async (tool, args, c) => {
	const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
	if (prepared !== undefined && tool.parameters !== undefined) {
		const converted = Value.Convert(tool.parameters, structuredClone(prepared));
		if (!Value.Check(tool.parameters, converted)) {
			const detail = [...Value.Errors(tool.parameters, converted)]
				.map((error) => `${error.path || "/"}: ${error.message}`)
				.join("; ");
			throw new Error(`Validation failed for tool "${tool.name}": ${detail}`);
		}
	}
	return tool.execute("id", prepared, undefined, undefined, c);
};
const text = (result) => result.content.find((p) => p.type === "text").text;
const expectThrow = async (fn) => {
	try { await fn(); return null; } catch (e) { return e.message; }
};

// ---------------------------------------------------------------------------
console.log("multi-edit");
{
	const { api, tools } = makeApi();
	await (await jiti.import(`${ROOT}/extensions/multi-edit.ts`, { default: true }))(api);
	const edit = tools.get("edit");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-edit-"));
	const c = ctx(dir);
	const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);
	const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");

	write("a.txt", "one\ntwo\nthree\n");
	let r = await call(edit, { path: "a.txt", edits: [
		{ oldText: "one", newText: "ONE" },
		{ oldText: "three", newText: "THREE" },
	] }, c);
	check("multi-edit one file", read("a.txt") === "ONE\ntwo\nTHREE\n", read("a.txt"));
	check("details carry diff + patch", Boolean(r.details.diff && r.details.patch.includes("@@")), JSON.stringify(r.details).slice(0, 120));

	write("dup.txt", "x\nx\n");
	check("ambiguous match rejected", (await expectThrow(() => call(edit, { path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] }, c)))?.includes("matches 2 places"));
	check("ambiguous left untouched", read("dup.txt") === "x\nx\n");

	await call(edit, { path: "dup.txt", edits: [{ oldText: "x", newText: "y", replaceAll: true }] }, c);
	check("replaceAll works", read("dup.txt") === "y\ny\n", read("dup.txt"));

	write("del.txt", "alpha\nbeta\ngamma\n");
	await call(edit, { path: "del.txt", edits: [{ oldText: "beta\n" }] }, c);
	check("missing newText deletes the match", read("del.txt") === "alpha\ngamma\n", JSON.stringify(read("del.txt")));

	write("b.txt", "keep\n");
	write("c.txt", "keep\n");
	const err = await expectThrow(() => call(edit, { files: [
		{ path: "b.txt", edits: [{ oldText: "keep", newText: "changed" }] },
		{ path: "c.txt", edits: [{ oldText: "missing", newText: "x" }] },
	] }, c));
	check("dry run aborts whole batch", Boolean(err?.includes("not found")) && read("b.txt") === "keep\n", `${err} / ${JSON.stringify(read("b.txt"))}`);

	await call(edit, { files: [
		{ path: "b.txt", edits: [{ oldText: "keep", newText: "b!" }] },
		{ path: "c.txt", edits: [{ oldText: "keep", newText: "c!" }] },
	] }, c);
	check("multi-file writes both", read("b.txt") === "b!\n" && read("c.txt") === "c!\n");

	write("crlf.txt", "alpha\r\nbeta\r\n");
	await call(edit, { path: "crlf.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, c);
	check("CRLF preserved", read("crlf.txt") === "alpha\r\nBETA\r\n", JSON.stringify(read("crlf.txt")));

	write("loose.txt", "const x = \u201chi\u201d;   \nend\n");
	await call(edit, { path: "loose.txt", edits: [{ oldText: 'const x = "hi";', newText: "const x = 'hi';" }] }, c);
	check("loose unicode/whitespace fallback", read("loose.txt").startsWith("const x = 'hi';"), JSON.stringify(read("loose.txt")));

	write("legacy.txt", "old\n");
	await call(edit, { path: "legacy.txt", oldText: "old", newText: "new" }, c);
	check("legacy oldText/newText shape", read("legacy.txt") === "new\n", read("legacy.txt"));

	write("mitsu.txt", "m1\n");
	await call(edit, { multi: [{ path: "mitsu.txt", oldText: "m1", newText: "m2" }] }, c);
	check("mitsupi multi[] shape", read("mitsu.txt") === "m2\n", read("mitsu.txt"));

	write("bom.txt", "\ufeffalpha\nbeta\n");
	await call(edit, { path: "bom.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, c);
	check("BOM is invisible to the match and survives the write", read("bom.txt") === "\ufeffALPHA\nbeta\n", JSON.stringify(read("bom.txt")));

	write("q.txt", "a\n");
	check("the two forms cannot be combined", (await expectThrow(() => call(edit, { path: "q.txt", edits: [{ oldText: "a", newText: "b" }], files: [{ path: "q.txt", edits: [{ oldText: "a", newText: "c" }] }] }, c)))?.includes("not both"));
	check("no patch mode", edit.parameters.properties.patch === undefined && !JSON.stringify(edit.promptGuidelines).includes("patch") && !edit.description.includes("patch"));
	check("the nested files[] edit schema carries the same field descriptions", edit.parameters.properties.files.items.properties.edits.items.properties.oldText.description === edit.parameters.properties.edits.items.properties.oldText.description);

	check("no-op edit rejected", (await expectThrow(() => call(edit, { path: "q.txt", edits: [{ oldText: "a", newText: "a" }] }, c)))?.includes("identical"));
	check("missing file rejected", (await expectThrow(() => call(edit, { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }, c)))?.includes("file not found"));

	write("ov.txt", "abcdef\n");
	check("overlapping edits rejected", (await expectThrow(() => call(edit, { path: "ov.txt", edits: [
		{ oldText: "abc", newText: "X" }, { oldText: "bcd", newText: "Y" },
	] }, c)))?.includes("overlap"));

	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("cache-window");
{
	const { ttlFromPayload, cacheLabel, nextRedrawMs, publishCacheWindow, readCacheWindow, forgetCacheWindow, SHORT_TTL_MS, LONG_TTL_MS } = await jiti.import(
		`${ROOT}/lib/cache-window.ts`,
	);
	const short = { type: "ephemeral" };
	const long = { type: "ephemeral", ttl: "1h" };

	check("ttl from the last tool", ttlFromPayload({ tools: [{}, { cache_control: long }] }) === LONG_TTL_MS);
	check("ttl from the system prompt", ttlFromPayload({ system: [{ cache_control: short }] }) === SHORT_TTL_MS);
	check(
		"ttl from the last message block",
		ttlFromPayload({ messages: [{ content: [{ cache_control: short }] }, { content: [{}, { cache_control: long }] }] }) ===
			LONG_TTL_MS,
	);
	// The bug this exists for: mode says long, the model's compat says otherwise,
	// and the payload is the only place that knows.
	check("a payload marked 5m reads as 5m", ttlFromPayload({ tools: [{ cache_control: short }] }) === SHORT_TTL_MS);
	// Anthropic bills to the last breakpoint and requires 1h ones first, so a mixed
	// payload is warm for 5m however long the tools live.
	check(
		"a mixed payload is only as warm as its tail",
		ttlFromPayload({ tools: [{ cache_control: long }], messages: [{ content: [{ cache_control: short }] }] }) ===
			SHORT_TTL_MS,
	);
	check("no cache_control means no write", ttlFromPayload({ tools: [{}], messages: [{ content: [{}] }] }) === undefined);
	check("junk payloads do not throw", ttlFromPayload(null) === undefined && ttlFromPayload({ messages: "x" }) === undefined);

	const now = 1_000_000;
	// One number in every state (issues/48): how long until this prefix is cold.
	// With a chain alive that is the shutoff — the TTL beside it never ran out,
	// because a ping renewed it every time.
	const ttl = { kind: "ttl" };
	check("a live chain shows the shutoff, not the TTL",
		cacheLabel({ mode: "short", warmUntil: now + 252_000, cold: { kind: "shutoff", at: now + 27 * 60_000 } }, now) === "❄27m");
	check("the wide window reads the same clock",
		cacheLabel({ mode: "keepalive", warmUntil: 0, cold: { kind: "shutoff", at: now + 108 * 60_000 } }, now) === "❄1h48m");
	// A held clock has no shutoff date: what is known is one idle window from now,
	// and a child settling only pushes that out.
	check("a held clock is a whole window from any instant",
		cacheLabel({ mode: "short", warmUntil: now + 252_000, cold: { kind: "held", windowMs: 30 * 60_000 } }, now) === "❄30m" &&
		cacheLabel({ mode: "short", warmUntil: now + 252_000, cold: { kind: "held", windowMs: 30 * 60_000 } }, now + 600_000) === "❄30m");
	// No chain armed: the TTL is the whole truth, because nothing renews it.
	check("no chain armed falls back to the TTL", cacheLabel({ mode: "short", warmUntil: now + 252_000, cold: ttl }, now) === "❄4m");
	check("and on the hour window too", cacheLabel({ mode: "long", warmUntil: now + LONG_TTL_MS, cold: ttl }, now) === "❄1h0m");
	check("cold keeps the flake", cacheLabel({ mode: "short", warmUntil: now - 1, cold: ttl }, now) === "❄");
	check("nothing written yet is cold too", cacheLabel({ mode: "keepalive", warmUntil: 0, cold: ttl }, now) === "❄");
	check("nothing published means nothing shown", cacheLabel(undefined, now) === "");
	// Minutes above a minute, seconds only inside the last one, so `0m` is not a
	// form the label has.
	check("the last minute counts in seconds", cacheLabel({ mode: "short", warmUntil: now + 45_000, cold: ttl }, now) === "❄45s");
	check("a second over the minute is a minute", cacheLabel({ mode: "short", warmUntil: now + 61_000, cold: ttl }, now) === "❄1m");
	check("a live chain in its last seconds too",
		cacheLabel({ mode: "keepalive", warmUntil: 0, cold: { kind: "shutoff", at: now + 1_000 } }, now) === "❄1s");

	// Above a minute the number moves once a minute, so the render does too.
	check("the redraw waits for the minute boundary", nextRedrawMs({ mode: "short", warmUntil: now + 252_000, cold: ttl }, now) === 12_000);
	check("a whole number of minutes waits a whole minute",
		nextRedrawMs({ mode: "long", warmUntil: now + LONG_TTL_MS, cold: ttl }, now) === 60_000);
	check("the last minute renders every second", nextRedrawMs({ mode: "short", warmUntil: now + 45_000, cold: ttl }, now) === 1000);
	check("the live chain sets the cadence",
		nextRedrawMs({ mode: "keepalive", warmUntil: 0, cold: { kind: "shutoff", at: now + 90_000 } }, now) === 30_000);
	check("a held number never changes, so nothing is scheduled",
		nextRedrawMs({ mode: "short", warmUntil: now + 252_000, cold: { kind: "held", windowMs: 30 * 60_000 } }, now) === undefined);
	check("cold stops the ticker", nextRedrawMs({ mode: "short", warmUntil: now, cold: ttl }, now) === undefined);
	check("and nothing published never starts one", nextRedrawMs(undefined, now) === undefined);

	// Keyed by session, as ping targets are: subagents run in this process, and one
	// unkeyed slot let a child's request move the main seat's countdown — prevented
	// only by a boolean every writer had to remember to check (issues/45).
	publishCacheWindow("seat-main", { mode: "short", warmUntil: now + 60_000, cold: ttl });
	publishCacheWindow("seat-child", { mode: "keepalive", warmUntil: now + LONG_TTL_MS, cold: ttl });
	check("a child publishing cannot move the main seat's countdown", readCacheWindow("seat-main").warmUntil === now + 60_000);
	check("and every seat reads its own", readCacheWindow("seat-child").mode === "keepalive");
	check("a seat that has published nothing reads nothing", readCacheWindow("seat-absent") === undefined);
	forgetCacheWindow("seat-child");
	check("and a shutdown that is not a reload drops it", readCacheWindow("seat-child") === undefined);
}

// ---------------------------------------------------------------------------
console.log("session-mode");
{
	const { publishPingTarget, forgetPingTarget } = await jiti.import(`${ROOT}/lib/ping.ts`);
	const { seatCarriesWorkflows } = await jiti.import(`${ROOT}/lib/seat.ts`);
	let seats = 0;
	// A harness with the tool-activation surface session-mode gates on, plus a
	// controllable UI so each scenario is one session_start away. `request` and
	// `respond` drive one provider round trip: the payload rewrite on the way
	// out, the usage evidence on the way back.
	const boot = async ({ entries = [], reason = "startup", hasUI = false, workflows, compat, oauth = true } = {}) => {
		const { api, handlers } = makeApi();
		const sessionId = `seat-${++seats}`;
		let active = ["read", "bash", "Agent"];
		let toolSets = 0;
		const persisted = [];
		const notices = [];
		const asked = [];
		api.getActiveTools = () => active;
		api.setActiveTools = (names) => { active = names; toolSets++; };
		api.appendEntry = (type, data) => persisted.push({ type, data });
		await (await jiti.import(`${ROOT}/extensions/session-mode.ts`, { default: true }))(api);
		const c = {
			hasUI,
			sessionManager: { getEntries: () => entries, getSessionId: () => sessionId },
			ui: {
				select: async (title, options) => {
					asked.push({ title, options });
					if (workflows === undefined) return undefined;
					return workflows ? "Yes" : "No";
				},
				// pi's confirm puts "Yes" first, which is the wrong default for this
				// question; a launcher that went back to it must fail here.
				confirm: async () => { throw new Error("confirm is no longer a launcher question"); },
				notify: (message, level) => notices.push({ message, level }),
			},
			model: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", compat },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-oat01-fresh" }), isUsingOAuth: () => oauth, find: (provider, id) => ({ provider, id }) },
		};
		const withModel = (model) => (model ? { ...c, model } : c);
		await handlers.get("session_start")({ reason }, c);
		return {
			sessionId,
			asked,
			get workflows() { return seatCarriesWorkflows(sessionId); },
			get active() { return active; },
			get toolSets() { return toolSets; },
			restart: () => handlers.get("session_start")({ reason }, c),
			persisted,
			notices,
			request: (payload, model) => { handlers.get("before_provider_request")({ payload }, withModel(model)); return payload; },
			warm: () => handlers.get("cache_warming_decision")(
				{ type: "cache_warming_decision", warmCost: 0.001, missCost: 1, continuationProbability: 1, action: "warm" }, c),
			respond: (usage) => handlers.get("message_end")({ message: { role: "assistant", usage } }, c),
			settle: () => handlers.get("agent_settled")({}, c),
			shutdown: () => handlers.get("session_shutdown")({}, c),
		};
	};
	const entry = (data) => ({ type: "custom", customType: "cache-mode", data });
	// The keepalive seat is no longer a row in the launcher; the only way to it is
	// resuming a session file that already says so.
	const bootKeepalive = (opts = {}) => boot({ reason: "resume", hasUI: true, entries: [entry({ mode: "keepalive", ping: false })], ...opts });
	// One breakpoint per section pi marks: last tool, system tail, last user block.
	const payloadOf = () => ({
		tools: [{ name: "read" }, { name: "bash", cache_control: { type: "ephemeral" } }],
		system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
			{ role: "assistant", content: [{ type: "text", text: "yo" }] },
		],
	});
	const hourMarks = (payload) => JSON.stringify(payload).match(/"1h"/g)?.length ?? 0;
	// The launching shell may carry a value (an old session-mode set it); the
	// invariant is that nothing here reads or writes it, in either direction.
	const envBefore = process.env.PI_CACHE_RETENTION;

	let r = await boot();
	// The tool set is the wire's business, decided once per seat (map C4, C17):
	// this launcher decides retention and touches nothing else. `setActiveTools`
	// is one of two doors into pi's `_rebuildSystemPrompt`, which rebuilds the prompt from live disk,
	// so a launcher that opened it would make the cached prefix a function of
	// disk state (issues/25).
	check("the launcher withdraws no tool, ever", r.active.join() === "read,bash,Agent" && r.toolSets === 0);
	await r.restart();
	check("and still none on a later start", r.active.join() === "read,bash,Agent" && r.toolSets === 0);
	// The hour is gone (issues/33): 376 measured request gaps on high-thinking
	// build seats never reached half a 5m window, and the 1h premium is 0.75x the
	// final context on every session. A headless seat buys the cheap window and
	// pings to keep it, rather than paying for retention nothing uses.
	check("a headless session leaves every breakpoint at 5m", hourMarks(r.request(payloadOf())) === 0);
	check("and never persists that choice", r.persisted.length === 0);
	check("a headless resume takes the same answer, not a persisted one",
		hourMarks((await boot({ reason: "resume" })).request(payloadOf())) === 0);
	// `pi -p --resume` of a session picked at a TUI: the persisted keepalive must
	// not put a seat with no idle time on the hourly idle schedule. Headless wins
	// on `hasUI` alone, so no branch can reach that combination.
	check("a headless resume of a keepalive session is still headless",
		hourMarks((await boot({ reason: "resume", entries: [entry({ mode: "keepalive" })] })).request(payloadOf())) === 0);
	// A persisted workflow answer belongs to the seat that gave it: a headless
	// seat has nobody to ask and never inherits one.
	const legacy = await boot({ reason: "resume", entries: [entry({ mode: "keepalive", workflows: true })] });
	check("a resumed entry restores its mode and withdraws nothing", legacy.active.join() === "read,bash,Agent" && legacy.toolSets === 0);
	check("and a headless seat still writes 5m", hourMarks(legacy.request(payloadOf())) === 0);
	check("a headless seat carries no workflows, whatever the entry said", legacy.workflows === false);
	const short = await boot({ hasUI: true });
	check("a short session leaves every breakpoint at 5m", hourMarks(short.request(payloadOf())) === 0);
	// A leaked PI_CACHE_RETENTION=long makes pi-ai bake 1h in before any hook
	// runs; a short session must strip it back down, not just decline to add it.
	const leaked = payloadOf();
	for (const block of [leaked.tools[1], leaked.system[0], leaked.messages[0].content[0]]) block.cache_control.ttl = "1h";
	check("a short session strips a leaked 1h back to 5m", hourMarks(short.request(leaked)) === 0);
	const leakedHeadless = payloadOf();
	for (const block of [leakedHeadless.tools[1], leakedHeadless.system[0], leakedHeadless.messages[0].content[0]]) block.cache_control.ttl = "1h";
	check("a headless session strips a leaked 1h too", hourMarks(r.request(leakedHeadless)) === 0);
	short.respond({ cacheWrite: 100, cacheWrite1h: 0 });
	check("a 5m write in short mode is not a failure", short.notices.length === 0);

	r = await bootKeepalive();
	check("keepalive rewrites every breakpoint to 1h", hourMarks(r.request(payloadOf())) === 3);
	check("retention never touches the env", process.env.PI_CACHE_RETENTION === envBefore);
	check("a second pass is idempotent", hourMarks(r.request(r.request(payloadOf()))) === 3);
	r.respond({ cacheWrite: 100, cacheWrite1h: 100 });
	check("a confirmed 1h write raises no warning", r.notices.length === 0);
	r.respond({ cacheWrite: 100, cacheWrite1h: 0 });
	check("a keepalive write that came back 5m warns", r.notices.length === 1 && r.notices[0].level === "warning");
	r.respond({ cacheWrite: 50, cacheWrite1h: 0 });
	check("the warning fires once", r.notices.length === 1);

	r = await bootKeepalive({ compat: { supportsLongCacheRetention: false } });
	check("a model without long retention keeps 5m", hourMarks(r.request(payloadOf())) === 0);

	// Launch costs a second of Joel's attention, so it buys one answer. Retention
	// is not it: every session picked the cheap desk that stays warm, and the rows
	// that were offered beside it are reachable by resume alone.
	r = await boot({ hasUI: true });
	check("the launcher asks exactly one question", r.asked.length === 1, JSON.stringify(r.asked));
	check("and it is the workflow one", r.asked[0].title.startsWith("Carry the Workflow tool?"), r.asked[0].title);
	// "No" first, so Enter and Escape both decline: pi's confirm puts "Yes" first,
	// and the answer given every day is no.
	check("whose rows are No then Yes", r.asked[0].options.join() === "No,Yes", JSON.stringify(r.asked[0].options));
	check("the default writes at 5m like any short seat", hourMarks(r.request(payloadOf())) === 0);
	check("while a headless seat is the unpinged short one, and persists no ping",
		(await boot()).persisted[0]?.data.ping !== true);

	// The idle window rides with the mode (issues/36), so a resumed session cannot
	// inherit another mode's idea of how long a silence may run.
	// Every answer is persisted, the default included: the handoff continuation
	// carries this entry, and a seat that wrote none made its successor ask the
	// launch question mid-work (2026-09-22).
	check("a default launch persists its answer: workflows off", r.persisted.length === 1 && r.persisted[0].data.workflows === false, JSON.stringify(r.persisted));
	const persistedYes = await boot({ hasUI: true, workflows: true });
	check("saying yes persists one entry: the mode and the ping and the workflow answer and the window and nothing else",
		persistedYes.persisted.length === 1 && Object.keys(persistedYes.persisted[0].data).join() === "mode,ping,workflows,idleMs",
		JSON.stringify(persistedYes.persisted));
	check("which is the pinged 5m desk, carrying the tool, on the 45-minute window",
		persistedYes.persisted[0]?.data.mode === "short" && persistedYes.persisted[0]?.data.ping === true
			&& persistedYes.persisted[0]?.data.workflows === true && persistedYes.persisted[0]?.data.idleMs === 45 * 60 * 1000,
		JSON.stringify(persistedYes.persisted[0]));

	// pi's warm request re-enters this extension through `before_provider_request`,
	// so a second warmer does not merely cost twice: the wire files it as a turn,
	// overwriting the pending record that a real in-flight request is waiting to
	// be measured against, and republishing the ping target from a one-token
	// payload. In pi's `streaming` mode a real request in flight is the only
	// condition it fires under. So every seat stops it -- re-entry is a property
	// of the seam, not of the mode, and a seat that renews nothing of its own
	// renews nothing through pi either.
	check("the default desk stops pi's warmer", r.warm()?.action === "stop");
	check("so does a headless seat", (await boot()).warm()?.action === "stop");
	check("and keepalive, whose own ping is the 55m one", (await bootKeepalive()).warm()?.action === "stop");
	// Stated as the invariant and not as a list of seats: the answer is the same
	// one whatever the seat, so a seat added later cannot reopen the seam by
	// forgetting to appear above.
	check("no seat, whatever it answered, leaves pi's warmer running", (await Promise.all(
		[boot(), boot({ hasUI: true }), bootKeepalive(), boot({ hasUI: true, workflows: true })].map(async (seat) => (await seat).warm()),
	)).every((decision) => decision?.action === "stop"));

	r = await boot({ hasUI: true });
	check("escape falls back to short", hourMarks(r.request(payloadOf())) === 0);
	check("escape persists the default", r.persisted.length === 1 && r.persisted[0].data.workflows === false, JSON.stringify(r.persisted));

	// The handoff round trip, for both answers: what a seat persists is what
	// `carriedEntries` hands the continuation, which pi starts with reason "new".
	// The continuation is the same seat and must never ask again.
	const { carriedEntries } = await jiti.import(`${ROOT}/lib/continue-session.ts`);
	for (const answer of [undefined, false, true]) {
		const parent = await boot({ hasUI: true, workflows: answer });
		const file = parent.persisted.map(({ type, data }) => ({ type: "custom", customType: type, data }));
		const carried = carriedEntries(file, parent.sessionId, "child").map(({ customType, data }) => ({ type: "custom", customType, data }));
		const child = await boot({ reason: "new", hasUI: true, entries: carried });
		check(`a handoff continuation of a seat that answered ${answer === undefined ? "escape" : answer ? "yes" : "no"} is not asked again`, child.asked.length === 0, JSON.stringify(child.asked));
		check("and carries the same answer", child.workflows === (answer === true));
	}
	// A UI seat restored without a record writes one, so its own successor inherits too.
	const unrecorded = await boot({ reason: "fork", hasUI: true });
	check("a UI seat with no record writes the answer it runs on", unrecorded.asked.length === 0 && unrecorded.persisted.length === 1 && unrecorded.persisted[0].data.workflows === false, JSON.stringify(unrecorded.persisted));

	// What the one launch question buys (C17): the `Workflow` tool is off unless
	// Joel says yes, and the answer is fixed before the first request, because
	// turning a tool on mid-session rewrites the whole cached prefix.
	check("no answer means no workflows", r.workflows === false);
	const withWorkflows = await boot({ hasUI: true, workflows: true });
	check("saying yes puts the tool on the seat", withWorkflows.workflows === true);
	check("and persists the answer with the cache choice", withWorkflows.persisted[0]?.data.workflows === true, JSON.stringify(withWorkflows.persisted[0]));
	const resumedWorkflows = await boot({ reason: "resume", hasUI: true, entries: [entry({ mode: "short", ping: true, workflows: true })] });
	check("a resumed session gets the answer it was launched with, unasked", resumedWorkflows.workflows === true && resumedWorkflows.asked.length === 0);
	const resumedWithout = await boot({ reason: "resume", hasUI: true, entries: [entry({ mode: "short", ping: true })] });
	check("a session from before the question restores without workflows", resumedWithout.workflows === false);
	withWorkflows.shutdown();
	check("and a shutdown takes the answer with it", withWorkflows.workflows === false);

	r = await boot({ reason: "resume", hasUI: true, entries: [entry({ mode: "long" })] });
	check("a pre-rename long entry becomes keepalive", hourMarks(r.request(payloadOf())) === 3);

	// The subagent shape: a fresh headless instance in the same process, alive
	// at the same time as a keepalive parent. Neither instance can move the
	// other's retention, in either direction — that is the whole point of
	// per-session instances.
	const parent = await boot({ hasUI: true });
	const child = await boot();
	check("a child instance writes its own 5m", hourMarks(child.request(payloadOf())) === 0);
	check("and the short parent still writes 5m", hourMarks(parent.request(payloadOf())) === 0);
	check("a keepalive parent is unmoved by the child too",
		hourMarks((await bootKeepalive()).request(payloadOf())) === 3);

	// ---- the ping envelope --------------------------------------------------
	// The ping does not build one. It hands the payload back to pi-ai and lets the
	// same code that sends a real request send this one, so a payload field can no
	// longer outrun the header that licenses it — which is what a hand-built
	// envelope did for thirteen sessions: `fallbacks` comes from `model.compat` and
	// so does the beta header that permits it, and the rebuilt ping carried only
	// the first. 26 pings, every one `400 Extra inputs are not permitted`.
	//
	// That claim is checked where it can be measured rather than asserted:
	// `test/ping.mjs` runs the real pi-ai module over a loopback socket and reads
	// the bytes and headers that arrive. Here, only the one pure function.
	{
		const { pingHeaders } = await jiti.import(`${ROOT}/lib/ping.ts`);
		const captured = { "user-agent": "claude-cli/2.1.248 (external, cli)", Authorization: "Bearer stale-from-an-hour-ago", "x-app": null };
		const bag = pingHeaders(captured, undefined);
		check("a captured credential never survives, whatever its casing", bag.Authorization === undefined);
		check("everything else about the request is kept", bag["user-agent"] === captured["user-agent"]);
		check("including a null, which is how a request suppresses a client default", "x-app" in bag && bag["x-app"] === null);
		const gateway = pingHeaders(captured, { authorization: "Bearer gateway", "x-api-key": null });
		check("a provider that authenticates by header still gets to", gateway.authorization === "Bearer gateway");
		check("and its own suppressions come with it", gateway["x-api-key"] === null);
		check("but only its credentials — the envelope is the request's", Object.keys(gateway).length === 4);
	}

	// A ping only refreshes the cache if it replays the bytes that wrote it, and
	// those bytes are `wire`'s: pi chains before_provider_request in loader order
	// and takes the last return value. So the pair runs together here, in that
	// order, and the ping body is compared against what the chain produced.
	// One publisher is the fix; this is the pin that keeps it one.
	{
		// Every kit source, not just the top-level files: half the extensions are
		// directories, and a registration hidden in one is exactly the drift that
		// would put a stranger's rewrite behind wire's and break the replay again.
		// Limit stated: this sees the kit, not the packages beside it.
		// pi-web-search does not register the hook today.
		const sources = [];
		const walk = (dir) => {
			for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, item.name);
				if (item.isDirectory()) walk(full);
				else if (item.name.endsWith(".ts")) sources.push(full);
			}
		};
		walk(`${ROOT}/extensions`);
		check("the walk sees the directory extensions too", sources.length > fs.readdirSync(`${ROOT}/extensions`).length);
		const registrars = (hook) =>
			sources
				.filter((file) => fs.readFileSync(file, "utf8").includes(`pi.on("${hook}"`))
				.map((file) => path.relative(`${ROOT}/extensions`, file))
				.sort()
				.join();
		check("only two extensions touch the outgoing payload at all",
			registrars("before_provider_request") === "session-mode.ts,wire.ts", registrars("before_provider_request"));
		// The headers have the same hazard and needed the same pin. pi mutates one
		// shared bag in extension order and ignores return values, so `wire`'s
		// snapshot is the final envelope only while `wire` is the last to touch it.
		// A ping replays a snapshot; a handler sorting after `wire` would be invisible
		// to it, which is the payload bug over again on the other half of the request.
		check("and one owns the envelope", registrars("before_provider_headers") === "wire.ts", registrars("before_provider_headers"));
	}

	// Timers and the provider are the two edges of a ping; both are stubbed so a
	// session can idle in microseconds. Everything between them is the real
	// extension. A fired timer removes itself, so "is one armed?" is a question
	// about the future rather than about the timer that just went off.
	{
		const { readCacheWindow, cacheLabel } = await jiti.import(`${ROOT}/lib/cache-window.ts`);
		const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const watchdogBefore = process.env.PI_WATCHDOG_MS;
		let scheduled = [];
		let sent = [];
		let reply = { read: 18_282 };
		globalThis.setTimeout = (fn, ms) => {
			const t = { ms, unref() {} };
			t.fn = async () => { scheduled = scheduled.filter((x) => x !== t); return fn(); };
			scheduled.push(t);
			return t;
		};
		globalThis.clearTimeout = (t) => { scheduled = scheduled.filter((x) => x !== t); };

		// The provider, standing in for pi-ai's anthropic module and answering the
		// way it does: `onPayload` decides the bytes, `start` precedes the first
		// content event, and a rejection arrives as an `error` event carrying the
		// provider's status and body in one string. The real event stream class, so
		// the queueing and the early break are the shipped ones.
		const provider = {
			id: "anthropic",
			stream: (model, context, options) => {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					const body = await options.onPayload({ built: "by pi-ai, and always thrown away" }, model);
					sent.push({ model, context, headers: options.headers, apiKey: options.apiKey, sessionId: options.sessionId, body });
					const partial = { model: model.id, usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } };
					reply.before?.();
					if (reply.hang) {
						await new Promise((resolve) => {
							if (options.signal.aborted) resolve();
							else options.signal.addEventListener("abort", resolve);
						});
						stream.push({ type: "error", reason: "aborted", error: { ...partial, errorMessage: "Request was aborted" } });
						return stream.end();
					}
					if (reply.error) {
						stream.push({ type: "error", reason: "error", error: { ...partial, errorMessage: reply.error } });
						return stream.end();
					}
					// Optional, exactly as pi-ai calls it: the ping does not ask: a stream
					// that reached `start` was a 200, and a constant is not a measurement.
					await options.onResponse?.({ status: 200, headers: {} }, model);
					stream.push({ type: "start", partial });
					partial.model = reply.served ?? model.id;
					partial.usage.cacheRead = reply.read ?? 0;
					partial.usage.cacheWrite = reply.write ?? 0;
					stream.push({ type: "text_start", contentIndex: 0, partial });
				})();
				return stream;
			},
		};
		const { CLAUDE_CODE_USER_AGENT: PINNED_USER_AGENT } = await jiti.import(`${ROOT}/lib/claude-code.ts`);
		const KEEPALIVE_MS = 55 * 60 * 1000;
		const GAP_MS = 4.5 * 60 * 1000;
		// The main seat's cadence: 4:40, against a headless seat's 4:30.
		const MAIN_GAP_MS = 4 * 60 * 1000 + 40 * 1000;
		const SIX_MINUTES = 6 * 60 * 1000;
		const RETRY_MS = 15 * 1000;
		const KEEPALIVE_TIMEOUT_MS = 60 * 1000;
		// A gap ping re-arms against its own send time, so its delay is at most the
		// seat's cadence and within a tick of it. The lower bound is above both ping
		// timeouts (15s and 60s), so an in-flight `sendPing` cannot be mistaken for an
		// armed ping.
		const armed = (kind) =>
			scheduled.find((t) => (kind === "keepalive" ? t.ms === KEEPALIVE_MS : t.ms > KEEPALIVE_TIMEOUT_MS && t.ms <= MAIN_GAP_MS));
		const fire = async (kind) => { await armed(kind).fn(); return sent[sent.length - 1]; };

		// session-mode and wire, in the order pi's loader gives them, driving one
		// context. Two handler maps because pi keeps one per extension.
		const bootPair = async ({ hasUI = false, auth, entries = [], reason = "startup", sessionId = `pair-${++seats}` } = {}) => {
			const sm = makeApi();
			const wr = makeApi();
			let active = ["read", "bash", "Agent"];
			sm.api.getActiveTools = () => active;
			sm.api.setActiveTools = (names) => { active = names; };
			const notices = [];
			await (await jiti.import(`${ROOT}/extensions/session-mode.ts`, { default: true }))(sm.api);
			await (await jiti.import(`${ROOT}/extensions/wire.ts`, { default: true }))(wr.api);
			const resolve = auth ?? (() => ({ ok: true, apiKey: "sk-ant-oat01-fresh" }));
			const c = {
				hasUI,
				cwd: process.cwd(),
				mode: hasUI ? "tui" : "print",
				sessionManager: { getEntries: () => entries, getSessionId: () => sessionId, getHeader: () => ({}) },
				ui: {
					// Escape at the one launch question: the default seat, no workflows.
					select: async () => undefined,
					notify: (message, level) => notices.push({ message, level }),
					setStatus: () => {},
					theme: { fg: (_key, text) => text },
				},
				model: { id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
				modelRegistry: {
					getApiKeyAndHeaders: async () => resolve(),
					getProvider: (id) => (id === "anthropic" ? provider : undefined),
					isUsingOAuth: () => true,
					find: (providerId, id) => ({ provider: providerId, id }),
				},
			};
			const each = (event, payload, model) => {
				const ctx = model ? { ...c, model } : c;
				let current = payload;
				for (const ext of [sm, wr]) {
					const handler = ext.handlers.get(event);
					const next = handler?.({ ...(event === "before_provider_request" ? { payload: current } : { headers: current }) }, ctx);
					if (event === "before_provider_request" && next !== undefined) current = next;
				}
				return current;
			};
			await sm.handlers.get("session_start")({ reason }, c);
			// A live seat captures its prompt options at turn start and only then builds
			// a request. Without that, `wire` sends a declared refusal instead of a
			// prompt and says so — correct, and not what these checks are about.
			wr.handlers.get("before_agent_start")({ systemPromptOptions: { cwd: process.cwd() } }, c);
			const start = () => sm.handlers.get("agent_start")({}, c);
			// A headless seat exists to run its task, so it boots into its first turn;
			// its chain pings only while that turn or a child of it is live.
			if (!hasUI) start();
			return {
				sessionId,
				start,
				notices,
				sm,
				c,
				request: (payload, model) => each("before_provider_request", payload, model),
				headers: (bag, model) => each("before_provider_headers", bag, model),
				input: (source) => sm.handlers.get("input")({ text: "hi", source }, c),
				entries: sm.entries,
				settle: () => sm.handlers.get("agent_settled")({}, c),
				respond: (usage) => {
					sm.handlers.get("message_end")({ message: { role: "assistant", usage } }, c);
					wr.handlers.get("message_end")({ message: { role: "assistant", usage } }, c);
				},
				shutdown: (shutdownReason = "quit") => {
					sm.handlers.get("session_shutdown")({ reason: shutdownReason }, c);
					wr.handlers.get("session_shutdown")({ reason: shutdownReason }, c);
				},
				trace: () => fs.readFileSync(path.join(TRACE_DIR, `${sessionId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
			};
		};

		// Keepalive left the launcher; a session file that says so is the way in.
		const bootKeepalivePair = (opts = {}) =>
			bootPair({ hasUI: true, reason: "resume", entries: [entry({ mode: "keepalive", ping: false })], ...opts });

		try {
			// ---- the interactive keepalive chain, unchanged ---------------------
			let rotations = 0;
			const k = await bootKeepalivePair({ auth: () => ({ ok: true, apiKey: `sk-ant-oat01-${++rotations}` }) });
			// wire owns the envelope too, so the ping goes out under the identity the
			// request went out under, not under whatever pi's stale default was.
			k.headers({ "user-agent": "pi/0.84.3" });
			const onWire = k.request(payloadOf());
			k.settle();
			check("settling arms a keep-alive ping", armed("keepalive") !== undefined);

			let ping = await fire("keepalive");
			check("the ping goes out on the model the request went out on", ping.model.id === "claude-opus-5" && ping.model.provider === "anthropic");
			// The bug this pins: session-mode sorts before wire in the loader's
			// readdir order, so its own `event.payload` was pi's raw system array and
			// pi's unpoliced tools — a guaranteed miss, and a full-price write.
			check("the ping replays what the provider saw, not what pi built", JSON.stringify(ping.body) === JSON.stringify(onWire));
			check("and replays it by identity: pi-ai's own payload is discarded", ping.body === onWire);
			// Four blocks against pi's one. This pair never fires `before_agent_start`,
			// so wire runs its degraded branch and block 2 is pi's own text rather than
			// the owned prompt — which is the harder case, not the easier one: even with
			// nothing to rebuild from, the array a ping replays is wire's, not pi's.
			check("which is wire's system array, attribution and identity in front",
				ping.body.system.length === 4 && ping.body.system[0].text.startsWith("x-anthropic-billing-header:"));
			check("the ping carries a credential at all", ping.apiKey === "sk-ant-oat01-1");
			check("and hands it to pi-ai, never to the header bag", ping.headers.authorization === undefined);
			check("and the claude code identity the request went out with", ping.headers["user-agent"] === PINNED_USER_AGENT);
			// Nothing but the captured bytes decides the request: since pi-ai 0.86 the
			// betas ride in the payload, so a replay needs no context of its own and a
			// synthesised one could only license fields the captured bytes do not have.
			check("the ping hands pi-ai an empty transcript, so only the payload speaks", ping.context.messages.length === 0 && ping.context.tools === undefined);
			check("and the session id, which is what routes an affinity provider", ping.sessionId === k.sessionId);
			check("a good ping arms the next one", armed("keepalive") !== undefined);

			ping = await fire("keepalive");
			check("every ping re-resolves auth, so a rotated token is picked up", ping.apiKey === "sk-ant-oat01-2");

			// A turn on another provider must not pair its envelope with this payload.
			const codex = { id: "gpt-5.6-luna", provider: "openai-codex", api: "openai-completions", baseUrl: "https://chatgpt.com/backend-api/codex" };
			k.headers({ authorization: "Bearer codex-token", "chatgpt-account-id": "acct" }, codex);
			k.request({ messages: [] }, codex);
			ping = await fire("keepalive");
			check("another provider's turn cannot poison the ping",
				ping.model.provider === "anthropic" && ping.headers["chatgpt-account-id"] === undefined);
			check("and cannot poison its payload", JSON.stringify(ping.body) === JSON.stringify(onWire));

			const noticesBefore = k.notices.length;
			reply = { error: '400 {"type":"error","error":{"message":"fallbacks: Extra inputs are not permitted"}}' };
			await fire("keepalive");
			check("a rejected ping warns", k.notices.length === noticesBefore + 1 && k.notices[noticesBefore].level === "warning");
			// Thirteen sessions of `rejected (400)` said nothing about why. pi-ai hands
			// back the provider's own status and body in one string; the notice and the
			// trace both get it.
			check("and says what the provider said, not just that it said no",
				k.notices[noticesBefore].message.includes("fallbacks: Extra inputs are not permitted"), k.notices[noticesBefore].message);
			check("a rejected ping stops the chain", armed("keepalive") === undefined);
			check("and the bar stops promising a window nothing renews", readCacheWindow(k.sessionId).mode === "short");
			k.settle();
			check("settling alone does not re-arm a halted chain", armed("keepalive") === undefined);

			reply = { read: 18_282 };
			k.respond({ cacheWrite: 100, cacheWrite1h: 100 });
			k.settle();
			check("a request the provider answers re-arms it", armed("keepalive") !== undefined);

			// ---- the engine-wait gate (ticket 05 H6, ticket 10) --------------------
			// A running turn disarms the chain; a `TaskOutput` inside that turn re-arms
			// it, anchored on the request that wrote the entry, because the seat will
			// not speak to the provider again until the child does. The wait ending
			// disarms it again: the turn's next request is what refreshes the cache.
			const smHandlers = k.sm.handlers;
			smHandlers.get("agent_start")({}, k.c);
			check("a running turn disarms the keep-alive", armed("keepalive") === undefined);
			smHandlers.get("tool_execution_start")({ toolCallId: "w1", toolName: "TaskOutput" }, k.c);
			const duringWait = scheduled.find((t) => t.ms > KEEPALIVE_TIMEOUT_MS && t.ms <= KEEPALIVE_MS);
			check("an engine wait re-arms it inside the turn, within the interval", duringWait !== undefined, JSON.stringify(scheduled.map((t) => t.ms)));
			smHandlers.get("tool_execution_start")({ toolCallId: "r1", toolName: "read" }, k.c);
			check("an ordinary tool is not a wait", scheduled.filter((t) => t.ms > KEEPALIVE_TIMEOUT_MS && t.ms <= KEEPALIVE_MS).length === 1);
			smHandlers.get("tool_execution_end")({ toolCallId: "w1", toolName: "TaskOutput" }, k.c);
			check("the wait ending disarms it; the turn's next request takes over", scheduled.filter((t) => t.ms > KEEPALIVE_TIMEOUT_MS && t.ms <= KEEPALIVE_MS).length === 0);
			k.settle();
			k.shutdown();

			// Unpinged short is no longer a row in the launcher, but it is still a
			// seat: a session file written before the row was dropped carries
			// `ping: false`, and a resume restores it rather than re-asking.
			scheduled = [];
			const shortSeat = await bootPair({ hasUI: true, entries: [entry({ mode: "short", ping: false })] });
			shortSeat.request(payloadOf());
			shortSeat.settle();
			check("a resumed short seat with the pings off never pings", scheduled.length === 0);
			shortSeat.shutdown();

			// ---- the main seat's gap chain (issues/33) --------------------------
			// The outcome the ticket names: six minutes of silence, and the next
			// request still reads the prefix instead of rewriting it. The ping goes out
			// inside the 5m window and re-anchors it from its own send time.
			scheduled = [];
			sent = [];
			const deskClock = Date.now;
			let deskAt = deskClock();
			Date.now = () => deskAt;
			try {
				const main = await bootPair({ hasUI: true });
				const mainWire = main.request(payloadOf());
				check("the default seat arms a gap ping at 4:40, not the headless 4:30", armed()?.ms === MAIN_GAP_MS, JSON.stringify(scheduled.map((t) => t.ms)));
				check("and asks for no hour to get it", hourMarks(mainWire) === 0);
				deskAt += MAIN_GAP_MS;
				ping = await fire();
				check("the ping replays the bytes that wrote the desk", ping.body === mainWire);
				deskAt += SIX_MINUTES - MAIN_GAP_MS;
				check("so six minutes after the last request the desk is still warm",
					readCacheWindow(main.sessionId).warmUntil > deskAt, JSON.stringify({ warmUntil: readCacheWindow(main.sessionId).warmUntil, now: deskAt }));
				main.shutdown();
				check("and shutdown disarms it, the same as headless", scheduled.length === 0);

				// ---- a reload keeps the desk warm (issues/43) -----------------------
				// Editing an extension replaces every instance while the seat, its
				// conversation and the provider's entry go on. Arming only from a real
				// request left that window with nothing renewing it: one reload 30s
				// before a ping was due cost a 33k-token rewrite.
				scheduled = [];
				sent = [];
				const edited = await bootPair({ hasUI: true });
				const editedWire = edited.request(payloadOf());
				edited.shutdown("reload");
				check("a reload disarms the old instance", scheduled.length === 0);
				deskAt += 20_000;
				const reloaded = await bootPair({
					hasUI: true,
					reason: "reload",
					sessionId: edited.sessionId,
					entries: [entry({ mode: "short", ping: true })],
				});
				check("and the new one picks the chain up where it was left",
					armed()?.ms === MAIN_GAP_MS - 20_000, JSON.stringify(scheduled.map((t) => t.ms)));
				deskAt += MAIN_GAP_MS - 20_000;
				ping = await fire();
				check("replaying the bytes the request before the reload wrote", ping.body === editedWire);
				deskAt += SIX_MINUTES - MAIN_GAP_MS;
				check("so six minutes across a reload the desk is still warm",
					readCacheWindow(reloaded.sessionId).warmUntil > deskAt, JSON.stringify({ warmUntil: readCacheWindow(reloaded.sessionId).warmUntil, now: deskAt }));
				reloaded.shutdown();

				// The anchor a reload resumes from is the last *refresh*, not the last
				// request: a ping restarted the provider's clock, and a reload after
				// the request's own TTL but inside the ping's found the desk warm.
				scheduled = [];
				sent = [];
				const pinged = await bootPair({ hasUI: true });
				pinged.request(payloadOf());
				deskAt += MAIN_GAP_MS;
				await fire();
				deskAt += SIX_MINUTES - MAIN_GAP_MS;
				pinged.shutdown("reload");
				const afterPing = await bootPair({
					hasUI: true,
					reason: "reload",
					sessionId: pinged.sessionId,
					entries: [entry({ mode: "short", ping: true })],
				});
				check("a reload inside the last ping's window resumes the chain",
					armed()?.ms === MAIN_GAP_MS - (SIX_MINUTES - MAIN_GAP_MS), JSON.stringify(scheduled.map((t) => t.ms)));
				check("and the desk reads warm", readCacheWindow(afterPing.sessionId).warmUntil > deskAt);
				afterPing.shutdown();

				// A window that closed while the seat was down is not worth a ping: a
				// replay against a dead entry is a full-price write, not a refresh.
				scheduled = [];
				const stale = await bootPair({ hasUI: true });
				stale.request(payloadOf());
				stale.shutdown("reload");
				deskAt += SIX_MINUTES;
				const late = await bootPair({
					hasUI: true,
					reason: "reload",
					sessionId: stale.sessionId,
					entries: [entry({ mode: "short", ping: true })],
				});
				check("a reload past the window arms nothing", scheduled.length === 0, JSON.stringify(scheduled.map((t) => t.ms)));
				check("and says the desk is cold rather than promising a window", readCacheWindow(late.sessionId).warmUntil <= deskAt);
				late.shutdown();

				// The same six minutes on the unpinged desk: cold, and the next request
				// pays the full-prefix rewrite this mode exists to avoid. That desk is
				// why the row is gone -- but a resumed seat can still be sitting at it.
				scheduled = [];
				const unpinged = await bootPair({ hasUI: true, entries: [entry({ mode: "short", ping: false })] });
				unpinged.request(payloadOf());
				check("a resumed unpinged seat arms nothing", scheduled.length === 0);
				deskAt += SIX_MINUTES;
				check("and its desk is cold at six minutes", readCacheWindow(unpinged.sessionId).warmUntil <= deskAt);
				unpinged.shutdown();

				// Escape is the default too, and a resume takes the choice from the
				// session file rather than from having a UI.
				scheduled = [];
				const escaped = await bootPair({ hasUI: true });
				escaped.request(payloadOf());
				check("escape takes the pinged desk", armed()?.ms === MAIN_GAP_MS);
				escaped.shutdown();

				scheduled = [];
				const resumed = await bootPair({ hasUI: true, entries: [entry({ mode: "short", workflows: false, ping: true })] });
				resumed.request(payloadOf());
				check("a resumed session restores the ping", armed()?.ms === MAIN_GAP_MS);
				resumed.shutdown();

				scheduled = [];
				const legacy = await bootPair({ hasUI: true, entries: [entry({ mode: "short" })] });
				legacy.request(payloadOf());
				check("a session saved before the ping existed resumes without one", scheduled.length === 0);
				legacy.shutdown();

				// ---- the idle shutoff (issues/36) -------------------------------
				// The bet a ping makes is that the session gets a next turn. When Joel
				// closes the laptop the bet has lost, and every read after that is
				// charged for nothing. So the main seat's bound is silence, not a ping
				// budget: 45 minutes with nothing running and nobody typing.
				const { markAgentLive, markAgentSettled } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
				const FORTY_FIVE_MINUTES = 45 * 60 * 1000;
				scheduled = [];
				sent = [];
				const walkaway = await bootPair({ hasUI: true });
				walkaway.request(payloadOf());
				let idleBefore = sent.length;
				deskAt += MAIN_GAP_MS;
				await fire();
				check("a seat Joel left five minutes ago still pings", sent.length - idleBefore === 1 && armed() !== undefined);
				// The ping refreshed the cache clock, as it always does. The shutoff
				// clock is the one that moved: it counts the silence, and a ping is not
				// a sign of life.
				check("and the bar says how long it has left",
					cacheLabel(readCacheWindow(walkaway.sessionId), deskAt) === "❄40m", cacheLabel(readCacheWindow(walkaway.sessionId), deskAt));
				deskAt += FORTY_FIVE_MINUTES;
				idleBefore = sent.length;
				await fire();
				check("past the window with nothing running it stops", sent.length === idleBefore && armed() === undefined);
				check("and the session file says why",
					walkaway.entries.at(-1)?.customType === "cache-pings-off" && walkaway.entries.at(-1)?.data.reason === "idle",
					JSON.stringify(walkaway.entries.at(-1)));
				check("the bar drops the countdown and says the chain is off",
					cacheLabel(readCacheWindow(walkaway.sessionId), deskAt) === "❄", cacheLabel(readCacheWindow(walkaway.sessionId), deskAt));
				// One rewrite when he comes back is the whole cost of being wrong.
				walkaway.request(payloadOf());
				check("and a real request starts the chain over", armed()?.ms === MAIN_GAP_MS);
				walkaway.shutdown();

				// Condition (1) is the load-bearing half: a two-hour workflow with a
				// silent Joel is the one case where the rewrite is expensive and certain.
				scheduled = [];
				sent = [];
				const working = await bootPair({ hasUI: true });
				working.request(payloadOf());
				markAgentLive(working.sessionId, "child-1");
				deskAt += FORTY_FIVE_MINUTES + MAIN_GAP_MS;
				idleBefore = sent.length;
				await fire();
				check("a child running past the window keeps the chain alive", sent.length - idleBefore === 1 && armed() !== undefined);
				check("and no shutoff clock runs while it holds", readCacheWindow(working.sessionId).cold.kind === "held");
				// Settling is a turn about to happen, so it restarts the clock rather
				// than being the moment it runs out.
				markAgentSettled(working.sessionId, "child-1");
				deskAt += MAIN_GAP_MS;
				idleBefore = sent.length;
				await fire();
				check("the child settling resets the clock rather than ending it", sent.length - idleBefore === 1 && armed() !== undefined);
				deskAt += FORTY_FIVE_MINUTES;
				await fire();
				check("and forty-five minutes after that settle, it stops", armed() === undefined);
				working.shutdown();

				// Joel typing is the reset that matters. Our own injected messages are
				// the session talking to itself and prove nothing about him.
				scheduled = [];
				const typing = await bootPair({ hasUI: true });
				typing.request(payloadOf());
				deskAt += FORTY_FIVE_MINUTES - MAIN_GAP_MS;
				typing.input("user");
				deskAt += MAIN_GAP_MS;
				await fire();
				check("a message from Joel buys the full window back", armed() !== undefined);
				deskAt += FORTY_FIVE_MINUTES - MAIN_GAP_MS;
				typing.input("extension");
				deskAt += MAIN_GAP_MS;
				await fire();
				check("an injected message does not", armed() === undefined);
				typing.shutdown();

				// The keep-alive chain takes the same shutoff on the wider window.
				scheduled = [];
				sent = [];
				const resting = await bootKeepalivePair();
				resting.request(payloadOf());
				resting.settle();
				check("the wide window shows its own shutoff clock",
					cacheLabel(readCacheWindow(resting.sessionId), deskAt) === "❄2h0m", cacheLabel(readCacheWindow(resting.sessionId), deskAt));
				deskAt += KEEPALIVE_MS;
				idleBefore = sent.length;
				await fire("keepalive");
				check("an hour of silence is not two", sent.length - idleBefore === 1 && armed("keepalive") !== undefined);
				deskAt += 2 * 60 * 60 * 1000;
				idleBefore = sent.length;
				await fire("keepalive");
				check("two hours of it stops the keep-alive too", sent.length === idleBefore && armed("keepalive") === undefined);
				check("and that reason reaches the session file as well",
					resting.entries.at(-1)?.customType === "cache-pings-off" && resting.entries.at(-1)?.data.mode === "keepalive",
					JSON.stringify(resting.entries.at(-1)));
				resting.shutdown();

				// A resumed session takes its window from the record, not from a
				// default: restoring keepalive's two hours onto a 45m clock would stop
				// a workflow's cache 75 minutes early.
				scheduled = [];
				const carried = await bootPair({
					hasUI: true,
					entries: [entry({ mode: "short", ping: true, idleMs: 2 * 60 * 60 * 1000 })],
				});
				carried.request(payloadOf());
				deskAt += FORTY_FIVE_MINUTES + MAIN_GAP_MS;
				await fire();
				check("a resumed session gets the window it was saved with", armed() !== undefined);
				carried.shutdown();
			} finally {
				Date.now = deskClock;
			}

			// ---- the headless gap chain -----------------------------------------
			scheduled = [];
			sent = [];
			const h = await bootPair();
			check("a headless seat arms nothing before its first request", scheduled.length === 0);
			const headlessWire = h.request(payloadOf());
			check("a request arms a gap ping inside the 5m window", armed()?.ms === GAP_MS);
			check("and it is the only timer the seat holds", scheduled.length === 1);

			ping = await fire();
			check("the gap ping replays the wire payload byte for byte", JSON.stringify(ping.body) === JSON.stringify(headlessWire));
			check("a headless seat never asks for the hour", hourMarks(headlessWire) === 0);
			check("a good gap ping arms the next one on the same cadence", armed() !== undefined && armed().ms <= GAP_MS && armed().ms > GAP_MS - 2000);
			check("the ping is recorded in the wire trace against the request it replays",
				(() => { const p = h.trace().filter((l) => l.t === "ping"); return p.length === 1 && p[0].ok === true && p[0].n === 1; })(),
				JSON.stringify(h.trace().filter((l) => l.t === "ping")));
			// What the ping cost, recorded the day it happened. A replay that reads is
			// doing its job; the same-day evidence is the whole reason to ask pi-ai for
			// the answer instead of reverse-engineering it off a bill a week later.
			check("and it records what the replay actually cost",
				(() => { const p = h.trace().filter((l) => l.t === "ping").at(-1); return p.read === 18_282 && p.write === 0 && p.miss === undefined && p.served === "claude-opus-5"; })(),
				JSON.stringify(h.trace().filter((l) => l.t === "ping").at(-1)));

			// A ping that writes is a ping that missed: the bytes it replayed were not
			// the bytes the provider held. Nothing else in this harness can see that on
			// the day it happens.
			reply = { read: 0, write: 18_282, served: "claude-opus-4-8" };
			await fire();
			check("a ping that wrote instead of read says so, and names who served it",
				(() => { const p = h.trace().filter((l) => l.t === "ping").at(-1); return p.ok === true && p.miss === true && p.write === 18_282 && p.served === "claude-opus-4-8"; })(),
				JSON.stringify(h.trace().filter((l) => l.t === "ping").at(-1)));
			reply = { read: 18_282 };

			// A real request means the window is fresh and the budget starts over.
			h.request(payloadOf());
			check("a real request re-arms the gap ping from scratch", armed()?.ms === GAP_MS && scheduled.length === 1);

			// In flight, a request is certain to follow, so every round pays. The
			// 29-minute `bash sleep` that outlived the old five rounds is this case.
			const { markAgentLive, markAgentSettled } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
			const hTool = (phase, toolName = "bash") => h.sm.handlers.get(`tool_execution_${phase}`)({ toolCallId: toolName, toolName }, h.c);
			hTool("start");
			let before = sent.length;
			for (let i = 0; i < 7; i++) await fire();
			check("a headless seat keeps pinging past the old five-round cap while a tool call is in flight",
				sent.length - before === 7 && armed() !== undefined, `sent ${sent.length - before}`);
			// The ceiling counts silence, so output from the tool starts it over, and a
			// tool silent past the 30m bash kill budget is a hang, not work.
			hTool("update");
			before = sent.length;
			for (let i = 0; i < 30 && armed() !== undefined; i++) await fire();
			check("a silent in-flight seat stops at the ceiling the bash kill budget sets", sent.length - before === 8, `sent ${sent.length - before}`);
			check("and the session file says why", h.entries.at(-1)?.data.reason === "silent past the in-flight bound", JSON.stringify(h.entries.at(-1)));
			hTool("end");
			h.request(payloadOf());
			check("a real request buys the budget back", armed() !== undefined);

			// Settled with nothing to wait on: the seat has reported, and a resume is
			// rare enough that it pays its one rewrite rather than everyone pinging.
			before = sent.length;
			h.settle();
			check("a headless seat stops pinging the moment it settles with no live children",
				armed() === undefined && sent.length === before, JSON.stringify(scheduled.map((t) => t.ms)));
			check("and the session file says why", h.entries.at(-1)?.data.reason === "settled", JSON.stringify(h.entries.at(-1)));
			h.start();
			h.request(payloadOf());
			check("a real request after settling re-arms the chain", armed()?.ms === GAP_MS);
			before = sent.length;
			await fire();
			check("and it pings again", sent.length - before === 1 && armed() !== undefined);

			// Settled with a child still running: the child's result starts the next
			// turn, so the chain runs with no ceiling until the child settles.
			markAgentLive(h.sessionId, "child-1");
			h.settle();
			check("a headless seat with a live child keeps its chain when its turn ends", armed() !== undefined);
			before = sent.length;
			for (let i = 0; i < 12 && armed() !== undefined; i++) await fire();
			check("and pings past the ceiling while the child runs", sent.length - before === 12 && armed() !== undefined, `sent ${sent.length - before}`);
			markAgentSettled(h.sessionId, "child-1");
			before = sent.length;
			await fire();
			check("once the child settles and no turn has started, the next round stops the chain", sent.length === before && armed() === undefined);

			// An engine wait is a turn blocked on a child: no ceiling either, and the
			// watchdog exempts the same tools (ticket 10).
			h.start();
			h.request(payloadOf());
			hTool("start", "TaskOutput");
			before = sent.length;
			for (let i = 0; i < 12 && armed() !== undefined; i++) await fire();
			check("inside an engine wait a headless seat keeps pinging past the ceiling", sent.length - before === 12, `sent ${sent.length - before}`);
			hTool("end", "TaskOutput");
			h.shutdown();

			// Every child writes 5m (ticket 29 §3 removed the fork, the one seat that
			// mirrored its parent's hour): a declared child seat changes nothing here.
			{
				const { declareChildSeat, forgetChildSeat } = await jiti.import(`${ROOT}/lib/seat.ts`);
				const childId = `pair-${seats + 1}`;
				declareChildSeat(childId, { name: "worker-1", role: "worker", depth: 1, parentSessionId: "parent", prompt: { kind: "inherit" } });
				scheduled = [];
				const child = await bootPair();
				check("a headless child writes 5m whatever its parent chose", child.sessionId === childId && hourMarks(child.request(payloadOf())) === 0, `${child.sessionId} ${hourMarks(child.request(payloadOf()))}`);
				check("and still gap-pings like any headless seat", armed() !== undefined);
				child.shutdown();
				forgetChildSeat(childId);
			}

			// The ceiling is the longer of the bash kill budget and the watchdog
			// deadline, so an hour's deadline stretches it to cover an hour.
			scheduled = [];
			process.env.PI_WATCHDOG_MS = String(60 * 60 * 1000);
			const tight = await bootPair();
			tight.request(payloadOf());
			before = sent.length;
			for (let i = 0; i < 30 && armed() !== undefined; i++) await fire();
			check("the ceiling moves with the watchdog deadline when that is the longer bound", sent.length - before === 15, `sent ${sent.length - before}`);
			tight.shutdown();
			process.env.PI_WATCHDOG_MS = watchdogBefore;
			if (watchdogBefore === undefined) delete process.env.PI_WATCHDOG_MS;

			// One retry, then silence. The next real request pays one bounded miss.
			scheduled = [];
			sent = [];
			const flaky = await bootPair();
			flaky.request(payloadOf());
			reply = { error: '429 {"type":"error","error":{"message":"rate limited"}}' };
			await fire();
			// Measured from the first attempt's send, not from its failure, so the retry
			// is inside the window however slowly the first attempt died.
			check("a failed gap ping retries once, soon", scheduled.length === 1 && scheduled[0].ms <= RETRY_MS && scheduled[0].ms > RETRY_MS - 2000);
			reply = { read: 18_282 };
			await scheduled[0].fn();
			check("a successful retry resumes the 4:30 cadence", armed() !== undefined);
			check("a headless seat says nothing to a UI it does not have", flaky.notices.length === 0);
			check("both attempts reach the trace, failure and all",
				(() => { const p = flaky.trace().filter((l) => l.t === "ping"); return p.length === 2 && p[0].ok === false && p[0].reason === "status" && p[0].status === 429 && p[1].ok === true; })(),
				JSON.stringify(flaky.trace().filter((l) => l.t === "ping")));

			reply = { error: '429 {"type":"error","error":{"message":"rate limited"}}' };
			await fire();
			await scheduled[0].fn();
			check("two failures in a row stop the chain", scheduled.length === 0);
			flaky.request(payloadOf());
			check("and a real request restarts it", armed()?.ms === GAP_MS);
			flaky.shutdown();

			// Shutdown is the one hard stop: never warm a dead seat's cache.
			scheduled = [];
			const dying = await bootPair();
			dying.request(payloadOf());
			dying.shutdown();
			check("shutdown disarms the gap ping", scheduled.length === 0);
			forgetPingTarget(dying.sessionId);

			// An in-flight ping must not outlive the session either.
			scheduled = [];
			sent = [];
			reply = { read: 18_282 };
			const racing = await bootPair();
			racing.request(payloadOf());
			const inFlight = armed().fn();
			racing.shutdown();
			await inFlight;
			check("a ping in flight at shutdown does not re-arm", scheduled.length === 0);

			// The race that costs a rewrite: a ping issued for round N is still in
			// flight when request N+1 lands. Without a generation, the stale ping's
			// failure path calls scheduleGapPing, which disarms the timer the fresh
			// request just armed, and its retry failing leaves the seat with no ping at
			// all — silent until the window expires.
			scheduled = [];
			sent = [];
			const stale = await bootPair();
			stale.request(payloadOf());
			reply = { error: '429 {"type":"error","error":{"message":"rate limited"}}' };
			const midFlight = armed().fn();
			const freshWire = stale.request(payloadOf());
			// `scheduled` also holds the in-flight sendPing's own abort timer here.
			check("the fresh request arms its own round", armed()?.ms === GAP_MS);
			await midFlight;
			check("a stale ping cannot disarm the round a newer request armed", armed()?.ms === GAP_MS, JSON.stringify(scheduled.map((t) => t.ms)));
			check("and does not schedule a retry against a window that is already fresh", scheduled.length === 1);
			check("the stale ping is still filed against the request it replayed, not the newest",
				(() => { const p = stale.trace().filter((l) => l.t === "ping"); return p.length === 1 && p[0].n === 1; })(),
				JSON.stringify(stale.trace().filter((l) => l.t === "ping")));
			// And the succeeding stale ping cannot re-anchor the fresh round either.
			reply = { read: 18_282 };
			stale.request(freshWire);
			const secondFlight = armed().fn();
			stale.request(payloadOf());
			await secondFlight;
			check("nor can a stale ping that succeeded", armed()?.ms === GAP_MS && scheduled.length === 1);
			stale.shutdown();

			// Nothing published means nothing to replay: a seat whose first request
			// never reached the wire must not invent one.
			scheduled = [];
			sent = [];
			const bare = await bootPair();
			forgetPingTarget(bare.sessionId);
			bare.request(payloadOf());
			forgetPingTarget(bare.sessionId);
			const sentBefore = sent.length;
			await fire();
			check("no target means no ping", sent.length === sentBefore && scheduled.length === 0);
			bare.shutdown();

			// A slow ping bought its window when it *started*, so the next one must
			// come sooner, not GAP_MS after the answer.
			scheduled = [];
			const slow = await bootPair();
			slow.request(payloadOf());
			const realNow = Date.now;
			let clock = realNow();
			Date.now = () => clock;
			reply = { read: 18_282, before: () => { clock += 40_000; } };
			try {
				await fire();
				check("a slow ping shortens the next gap by what it cost", armed()?.ms === GAP_MS - 40_000);
			} finally {
				Date.now = realNow;
				reply = { read: 18_282 };
			}
			slow.shutdown();

			// The timeout is the network, not a verdict; keepalive waits it out
			// rather than abandoning an entry that is probably still there.
			scheduled = [];
			// A request that answers only to the abort signal — including one that was
			// already aborted before it was issued, which is how a real stream behaves.
			reply = { hang: true };
			const stalled = await bootKeepalivePair();
			stalled.request(payloadOf());
			stalled.settle();
			const inflight = armed("keepalive").fn();
			scheduled.find((t) => t.ms === KEEPALIVE_TIMEOUT_MS).fn();
			await inflight;
			check("a timed-out keep-alive ping keeps the chain alive", armed("keepalive") !== undefined);
			check("and says nothing about it", stalled.notices.length === 0);
			stalled.shutdown();

			// A gap ping has 30s of margin, not an hour, so it gives up in 15s — and
			// the retry it schedules is measured from the first attempt's send, which
			// is what keeps it inside the window however slowly that attempt died.
			scheduled = [];
			const hung = await bootPair();
			hung.request(payloadOf());
			const hungClock = Date.now;
			let hungAt = hungClock();
			Date.now = () => hungAt;
			try {
				const hanging = armed().fn();
				const gapTimeout = scheduled.find((t) => t.ms === 15_000);
				check("a gap ping gives up in 15s, not 60", gapTimeout !== undefined, JSON.stringify(scheduled.map((t) => t.ms)));
				hungAt += 15_000; // it hung for the whole timeout
				gapTimeout.fn();
				await hanging;
				check("a hung gap ping retries at once rather than 15s past the window",
					scheduled.length === 1 && scheduled[0].ms === 0, JSON.stringify(scheduled.map((t) => t.ms)));
			} finally {
				Date.now = hungClock;
			}
			check("and the timeout is recorded as one",
				hung.trace().filter((l) => l.t === "ping").at(-1).reason === "timeout");
			hung.shutdown();
			reply = { read: 18_282 };
		} finally {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
			if (watchdogBefore === undefined) delete process.env.PI_WATCHDOG_MS;
			else process.env.PI_WATCHDOG_MS = watchdogBefore;
		}
	}
}

// ---------------------------------------------------------------------------
console.log("skill-mentions");
{
	const mod = await jiti.import(`${ROOT}/extensions/skill-mentions.ts`);
	const { catalogue, mentionsIn, skillBlock, suggest, SKILL_MESSAGE } = mod;

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-skill-"));
	const skillFile = (name, body) => {
		const file = path.join(dir, `${name}.md`);
		fs.writeFileSync(file, `---\nname: ${name}\ndescription: does ${name}\n---\n\n${body}\n`);
		return file;
	};
	const tddPath = skillFile("tdd", "# TDD\n\nRed, green, refactor.");
	const commitPath = skillFile("commit", "# Commit\n\nWrite the message.");
	const command = (name, file, scope = "user") => ({
		name: `skill:${name}`,
		description: `does ${name}`,
		source: "skill",
		sourceInfo: { path: file, baseDir: dir, scope, source: "test", origin: "top-level" },
	});
	const commands = [
		{ name: "btw", description: "side chat", source: "extension", sourceInfo: { path: "/x", scope: "user" } },
		command("tdd", tddPath),
		command("commit", commitPath, "project"),
	];

	const skills = catalogue({ getCommands: () => commands });
	check("catalogue keeps skills only", skills.size === 2 && skills.has("tdd") && !skills.has("btw"));
	check("catalogue carries path and baseDir", skills.get("tdd").path === tddPath && skills.get("tdd").baseDir === dir);

	const known = new Set(skills.keys());
	check("mention mid-sentence", JSON.stringify(mentionsIn("now please $tdd this module", known)) === '["tdd"]');
	check("mention on a later line", JSON.stringify(mentionsIn("one\ntwo\n$commit", known)) === '["commit"]');
	check("two mentions keep order", JSON.stringify(mentionsIn("$commit then $tdd", known)) === '["commit","tdd"]');
	check("repeat mention collapses", JSON.stringify(mentionsIn("$tdd and $tdd", known)) === '["tdd"]');
	check("env vars never match", mentionsIn("echo $PATH $HOME $1", known).length === 0);
	check("unknown names pass through", mentionsIn("$nope", known).length === 0);
	check("backslash escapes", mentionsIn("\\$tdd", known).length === 0);
	check("mid-token dollars are not mentions", mentionsIn("price is 3$tdd", known).length === 0);

	const block = skillBlock(skills.get("tdd"));
	check("block matches pi's own framing", block.startsWith(`<skill name="tdd" location="${tddPath}">`) && block.endsWith("</skill>"));
	check("block strips frontmatter", !block.includes("description: does tdd") && block.includes("Red, green, refactor."));
	check("block states the base dir", block.includes(`References are relative to ${dir}.`));

	const list = [...skills.values()];
	check("empty query lists all, sorted", suggest(list, "").map((i) => i.value).join(",") === "$commit,$tdd");
	check("query filters", suggest(list, "td")[0].value === "$tdd");
	check("non-user scope is labelled", suggest(list, "commit")[0].description.includes("[project]"));

	// Provider: `$` triggers anywhere, completion replaces the token and adds a space.
	const base = {
		triggerCharacters: ["@", "#"],
		getSuggestions: async () => ({ items: [{ value: "base", label: "base" }], prefix: "" }),
		applyCompletion: () => ({ lines: ["base"], cursorLine: 0, cursorCol: 4 }),
		shouldTriggerFileCompletion: () => true,
	};
	let provider;
	let skillRenderer;
	const api = {
		on: (event, handler) => handlers.set(event, handler),
		registerMessageRenderer: (_type, renderer) => { skillRenderer = renderer; },
		registerEntryRenderer: () => {},
		getCommands: () => commands,
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	const handlers = new Map();
	const sent = [];
	const notices = [];
	await (await jiti.import(`${ROOT}/extensions/skill-mentions.ts`, { default: true }))(api);

	const branch = [];
	const sctx = {
		cwd: dir,
		mode: "tui",
		sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
		ui: {
			notify: (message, level) => notices.push({ message, level }),
			addAutocompleteProvider: (factory) => { provider = factory(base); },
		},
	};
	await handlers.get("session_start")({}, sctx);

	check("provider adds $ to triggers", provider.triggerCharacters.includes("$") && provider.triggerCharacters.includes("@"));
	let s = await provider.getSuggestions(["write a test with $td"], 0, 21, { signal: new AbortController().signal });
	check("suggests mid-line", s.prefix === "$td" && s.items[0].value === "$tdd");
	s = await provider.getSuggestions(["$"], 0, 1, { signal: new AbortController().signal });
	check("a bare $ opens the list", s.items.length === 2);
	s = await provider.getSuggestions(["nothing here"], 0, 12, { signal: new AbortController().signal });
	check("delegates when no $ token", s.items[0].value === "base");
	const applied = provider.applyCompletion(["write a test with $td"], 0, 21, { value: "$tdd", label: "$tdd" }, "$td");
	check("completion replaces the token", applied.lines[0] === "write a test with $tdd " && applied.cursorCol === 23, applied.lines[0]);

	const input = handlers.get("input");
	await input({ text: "$commit and $tdd please", source: "interactive" }, sctx);
	check("one message per mention", sent.length === 2 && sent.every((s) => s.message.customType === SKILL_MESSAGE));
	check("idle delivery joins this turn", sent.every((s) => s.options.deliverAs === "nextTurn"));
	check("message carries the skill block", sent[0].message.content.includes("<skill name=\"commit\""));
	check("details carry the path", sent[1].message.details.path === tddPath);

	await input({ text: "$tdd again", source: "interactive" }, sctx);
	check("a loaded skill is not re-sent", sent.length === 2);
	check("and says so", notices.at(-1).message.includes("already loaded"));

	await handlers.get("session_compact")({}, sctx);
	await input({ text: "$tdd", source: "interactive" }, sctx);
	check("compaction makes it loadable again", sent.length === 3);

	await input({ text: "$tdd", source: "extension" }, sctx);
	check("extension messages are left alone", sent.length === 3);
	await input({ text: "/skill:tdd with $commit", source: "interactive" }, sctx);
	check("slash commands are left alone", sent.length === 3);

	await input({ text: "$commit", source: "interactive", streamingBehavior: "steer" }, sctx);
	check("steering keeps the delivery mode", sent.at(-1).options.deliverAs === "steer");

	// A resumed session rebuilds what the branch already carries.
	const resumed = [
		{ type: "custom_message", customType: SKILL_MESSAGE, details: { path: tddPath } },
		{ type: "compaction" },
		{ type: "custom_message", customType: SKILL_MESSAGE, details: { path: commitPath } },
	];
	const rctx = { ...sctx, sessionManager: { getSessionId: () => "s2", getBranch: () => resumed } };
	await handlers.get("session_start")({}, rctx);
	const before = sent.length;
	await input({ text: "$commit and $tdd", source: "interactive" }, rctx);
	check("replay skips what survived compaction", sent.length === before + 1 && sent.at(-1).message.details.name === "tdd");

	// The row a loaded skill leaves behind. pi's own component is a padded Box
	// under a Spacer: three blank lines above one line of text and two below.
	// This is the receipt every tool call already wears — one line, no padding.
	const skillTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t };
	const skillMessage = { customType: SKILL_MESSAGE, content: skillBlock(skills.get("tdd")) };
	const rowOf = (expanded) => skillRenderer(skillMessage, { expanded, outputPad: 1 }, skillTheme).render(60);
	check("a loaded skill is one row", rowOf(false).length === 1, JSON.stringify(rowOf(false)));
	check("in the transcript's grammar", rowOf(false)[0] === "● Skill(tdd)", JSON.stringify(rowOf(false)[0]));
	const opened = rowOf(true);
	check(
		"and ctrl+o puts its text under the gutter",
		opened.length > 2 && opened[1].startsWith("  ⎿  ") && opened.slice(2).every((l) => l.startsWith("     ")),
		JSON.stringify(opened),
	);
	check("a message that is not a skill block draws nothing", skillRenderer({ customType: SKILL_MESSAGE, content: "plain text" }, { expanded: false }, skillTheme) === undefined);
}

// ---------------------------------------------------------------------------
console.log("owned-prompt / claude-code / wire");
{
	const owned = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const { buildOwnedSystemPrompt, validatePromptOptions, KNOWN_OPTION_KEYS, SCAN_GUIDELINE, BASH_FILE_OPS_GUIDELINE, OWNED_IDENTITY, PROMPT_UNAVAILABLE, formatOwnedSkills, SKILLS_OPEN } = owned;
	const cc = await jiti.import(`${ROOT}/lib/claude-code.ts`);
	const {
		buildAttributionHeader,
		claudeCodeHeaders,
		firstUserTextOf,
		isFirstParty,
		sessionIdFromPath,
		subagentIdentity,
		CLAUDE_CODE_TOOL_NAMES,
		claudeCodeToolName,
		CLAUDE_CODE_VERSION,
		LAST_VERIFIED_VERSION,
		CLAUDE_CODE_IDENTITY,
		CLAUDE_CODE_USER_AGENT,
	} = cc;
	// buildSystemPrompt is not re-exported from pi's index; reach into dist.
	const piDist = path.dirname(jiti.esmResolve("@earendil-works/pi-coding-agent").replace("file://", ""));
	const pi = await import(path.join(piDist, "core/system-prompt.js"));
	const piSkills = await import(path.join(piDist, "core/skills.js"));
	const measure = await jiti.import(`${ROOT}/extensions/context-view/measure.ts`);

	const APPEND = "<COMMUNICATION>\nsay less\n</COMMUNICATION>";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-owned-"));
	const agentsPath = path.join(dir, "AGENTS.md");
	fs.writeFileSync(agentsPath, "Solve the system, not the result.");
	const linkPath = path.join(dir, "linked-AGENTS.md");
	fs.symlinkSync(agentsPath, linkPath);

	const options = {
		cwd: dir,
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		// A tool's own rules and an extension's own section, the two inputs pi 0.86
		// added: material the owned builder must carry rather than quietly drop.
		toolGuidelines: { edit: ["Read a file before editing it"], grep: ["A rule for a tool this seat does not carry"] },
		sections: { handoff: "Hand off with a document." },
		promptGuidelines: ["Trust but verify subagent results"],
		appendSystemPrompt: APPEND,
		contextFiles: [{ path: agentsPath, content: "Solve the system, not the result." }],
		skills: [
			{
				name: "tdd",
				description: "Red-green-refactor",
				filePath: path.join(dir, "tdd/SKILL.md"),
				baseDir: dir,
				sourceInfo: { type: "user" },
				disableModelInvocation: false,
			},
			// Muted with /skills: pi's formatter drops it, so the parity transform
			// below only balances if the owned formatter drops it too.
			{
				name: "herdr",
				description: "Control the terminal multiplexer",
				filePath: path.join(dir, "herdr/SKILL.md"),
				baseDir: dir,
				sourceInfo: { type: "user" },
				disableModelInvocation: true,
			},
		],
	};

	// The drift guard reborn: the owned builder must equal the installed pi's,
	// section content by section content, under exactly the deviations named in
	// `lib/owned-prompt.ts`'s header and marked below. pi 0.86 assembles its prompt as tagged, separately replaceable
	// sections, so that is where the comparison is made — against pi's own bytes
	// rather than a copy of ours, so a silent divergence cannot be absorbed by
	// updating a fixture.
	const ours = buildOwnedSystemPrompt(options);
	// What an OAuth request sends: the same build, with pi-ai's tool casing.
	const oauthOurs = buildOwnedSystemPrompt(options, claudeCodeToolName);
	const sections = pi.buildSystemPromptSections(options);
	const contentOf = (name) => (name === "preamble" ? sections[name] : sections[name].slice(name.length + 3, -(name.length + 4)));
	check(
		"pi still builds the sections the owned builder maps, in this order",
		Object.keys(sections).join(",") === "preamble,tools,rules,docs,addendum,project_context,skills,cwd,handoff",
		Object.keys(sections).join(","),
	);
	check(
		"and wraps every section but the preamble in a tag of its own name",
		Object.entries(sections).every(([name, text]) => name === "preamble" || text === `<${name}>\n${contentOf(name)}\n</${name}>`),
	);
	check("pi still emits its docs block, which ours drops entirely", contentOf("docs").startsWith("Pi documentation ("), contentOf("docs").slice(0, 80));
	// The list *and* the sentence that only makes sense standing under it.
	check(
		"pi still lists its tools with the sentence under them, which ours drops",
		contentOf("tools").includes("- read: Read file contents") && contentOf("tools").includes("In addition to the tools above"),
		contentOf("tools"),
	);
	const PI_BASH_GUIDELINE = "- Use bash for file operations like ls, rg, find";
	// Named deviation — the identity paragraph (issues/34): pi's stock one is
	// replaced by the user's own. Pinned as a byte-exact replace of pi's text,
	// so if pi rewrites its opening this fails and gets mapped deliberately.
	const PI_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
	check("pi still opens with its stock identity paragraph", contentOf("preamble") === PI_IDENTITY, contentOf("preamble"));
	// Named deviation — the conciseness bullet: pi's standing one is dropped,
	// verbosity lives in APPEND_SYSTEM.md's COMMUNICATION block, one home per fact.
	const PI_CONCISE_GUIDELINE = "\n- Be concise in your responses";
	check("pi still emits its standing conciseness bullet", contentOf("rules").includes(PI_CONCISE_GUIDELINE));
	// Tool guidelines arrive keyed by tool since pi 0.86; both builders fold them
	// into the same list, so a tool's rules reaching the wire is pinned here.
	check("pi still folds a tool's own guidelines into its rules", contentOf("rules").includes("\n- Read a file before editing it"), contentOf("rules"));
	// Named deviation — the skills catalogue: pi's XML block becomes the owned
	// lean list — root stated once, one `name: description` line per skill.
	const vendorSkillsBlock = piSkills.formatSkillsForPrompt(options.skills);
	check("pi still formats skills as XML", vendorSkillsBlock.includes("<available_skills>") && contentOf("skills") === vendorSkillsBlock.trim());
	check("pi still keeps a muted skill out of its own catalogue", !vendorSkillsBlock.includes("herdr"));
	check("the owned catalogue keeps a muted skill out too", !formatOwnedSkills(options.skills).includes("herdr"), formatOwnedSkills(options.skills));
	check("a catalogue of nothing but muted skills is no catalogue", formatOwnedSkills(options.skills.filter((s) => s.disableModelInvocation)) === "");
	// Which seats get a catalogue at all. pi picks the tool that will open the
	// SKILL.md out of `["read", "bash"]` and names it in its own text; this
	// builder names no tool, so it only has to agree on the set. The bash-only
	// seat is the case that distinguishes the two rules, and the one the drift
	// guard's fixture cannot reach -- it always carries `read`.
	const catalogued = (selectedTools) => buildOwnedSystemPrompt({ ...options, selectedTools }).includes(SKILLS_OPEN);
	const piCatalogued = (selectedTools) => pi.buildSystemPromptSections({ ...options, selectedTools }).skills !== undefined;
	for (const seat of [["read", "bash"], ["read"], ["bash"], ["edit", "write"], []]) {
		check(`the catalogue reaches [${seat}] exactly when pi's does`, catalogued(seat) === piCatalogued(seat), `ours ${catalogued(seat)}, pi ${piCatalogued(seat)}`);
	}
	check("a bash-only seat is told its skills exist", catalogued(["bash"]));
	check("and a seat that can open no file is not", !catalogued(["edit", "write"]));
	const PI_FILE_PATHS_GUIDELINE = "- Show file paths clearly when working with files";
	check("pi still emits the file-paths bullet ours follows", contentOf("rules").includes(PI_FILE_PATHS_GUIDELINE));
	// Named deviation — the cwd: it is not in the body at all. It is the
	// one line that differs between two otherwise identical seats, so the wire
	// sends it as its own block after the cache breakpoint.
	check("pi still carries the cwd as a section of the body, which ours drops", contentOf("cwd") === dir.replace(/\\/g, "/"), contentOf("cwd"));
	// An extension's own section is nobody's to rewrite: it is emitted in pi's
	// framing, after everything this builder assembles.
	check("pi carries an extension's section verbatim, last", contentOf("handoff") === options.sections.handoff);
	const expected =
		OWNED_IDENTITY +
		`\n\nGuidelines:\n${contentOf("rules").replace(PI_BASH_GUIDELINE, `- ${BASH_FILE_OPS_GUIDELINE}\n- ${SCAN_GUIDELINE}`).replace(PI_CONCISE_GUIDELINE, "")}` +
		`\n\n${contentOf("addendum")}` +
		`\n\n<project_context>\n\n${contentOf("project_context")}\n\n</project_context>\n` +
		formatOwnedSkills(options.skills) +
		`\n\n${sections.handoff}`;
	check("owned prompt is pi's sections, minus the docs block, the tools list, the conciseness bullet and the cwd, with the owned file-ops bullet, the scan guideline, the owned identity and the owned skills catalogue", ours === expected, ours.slice(0, 400));
	check("owned prompt never mentions pi docs", !ours.includes("Pi documentation"));
	check("owned prompt carries no tools list", !ours.includes("Available tools:") && !ours.includes("In addition to the tools above"));
	check("owned prompt keeps the identity line and the guidelines", ours.startsWith(OWNED_IDENTITY) && ours.includes("\n\nGuidelines:\n- "));

	// The broad-scan rule (issues/29) reaches every seat, wherever the seat's
	// tool set puts the rest of the list, and reaches it once.
	const guidelinesOf = (prompt) => {
		const start = prompt.indexOf("\n\nGuidelines:");
		const end = prompt.indexOf("\n\n", start + 2);
		return end === -1 ? prompt.slice(start) : prompt.slice(start, end);
	};
	const bashSeat = buildOwnedSystemPrompt({ cwd: dir, selectedTools: ["read", "bash", "edit", "write"] });
	const exploreSeat = buildOwnedSystemPrompt({ cwd: dir, selectedTools: ["read", "grep", "find", "ls"] });
	check("a bash seat is told where a scan may start", guidelinesOf(bashSeat).includes(`\n- ${SCAN_GUIDELINE}`), guidelinesOf(bashSeat));
	check("so is an Explore-shaped seat, which has the scan tools", guidelinesOf(exploreSeat).includes(`\n- ${SCAN_GUIDELINE}`), guidelinesOf(exploreSeat));
	check(
		"and exactly once, even when a tool declares the same line",
		bashSeat.split(SCAN_GUIDELINE).length === 2 &&
			buildOwnedSystemPrompt({ cwd: dir, selectedTools: ["read", "bash"], promptGuidelines: [SCAN_GUIDELINE] }).split(SCAN_GUIDELINE).length === 2,
	);

	// customPrompt branch carries pi's own sections — the caller's prompt, the
	// addendum, the context files, the skills and any extension section — once
	// the two named deviations are taken out: the skills catalogue, and the
	// Guidelines section pi skips on this branch (issues/50 §4).
	const customOptions = { ...options, customPrompt: "You are a subagent." };
	const custom = buildOwnedSystemPrompt(customOptions);
	const customSections = pi.buildSystemPromptSections(customOptions);
	const customContentOf = (name) => customSections[name].slice(name.length + 3, -(name.length + 4));
	check(
		"pi builds no tools, rules or docs section on the customPrompt branch",
		Object.keys(customSections).join(",") === "preamble,addendum,project_context,skills,cwd,handoff",
		Object.keys(customSections).join(","),
	);
	check(
		"customPrompt branch matches pi exactly, skills catalogue and guidelines aside",
		custom.replace(guidelinesOf(custom), "") ===
			customSections.preamble +
				`\n\n${customContentOf("addendum")}` +
				`\n\n<project_context>\n\n${customContentOf("project_context")}\n\n</project_context>\n` +
				formatOwnedSkills(options.skills) +
				`\n\n${customSections.handoff}`,
		custom.replace(guidelinesOf(custom), ""),
	);
	// pi returns a forced prompt as the whole prompt and assembles nothing, and it
	// decides that on presence, not on truth. The empty prompt is the case the two
	// tests differ on, so it is the one pinned.
	check(
		"a forced prompt is the whole prompt, assembled with nothing",
		buildOwnedSystemPrompt({ ...options, forceSystemPrompt: "You are something else entirely." }) === "You are something else entirely.",
	);
	check(
		"and a forced empty prompt is empty, not the owned one",
		buildOwnedSystemPrompt({ ...options, forceSystemPrompt: "" }) === "",
		buildOwnedSystemPrompt({ ...options, forceSystemPrompt: "" }).slice(0, 80),
	);
	check(
		"a seat running an agent definition's own body is told the tool's rules",
		guidelinesOf(custom).includes("\n- Trust but verify subagent results") && guidelinesOf(custom).includes(`\n- ${SCAN_GUIDELINE}`),
		guidelinesOf(custom),
	);

	// The Guidelines name tools the way the request will. pi-ai renames a tool to
	// Claude Code's casing on an Anthropic OAuth request, so prose that says
	// `read` would point at a tool the model was never offered.
	const piAiDist = path.dirname(jiti.esmResolve("@earendil-works/pi-ai").replace("file://", ""));
	const anthropicSource = fs.readFileSync(path.join(piAiDist, "api/anthropic-messages.js"), "utf8");
	const table = anthropicSource.slice(anthropicSource.indexOf("const claudeCodeTools = ["));
	const renameTable = [...table.slice(0, table.indexOf("];")).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
	check("CLAUDE_CODE_TOOL_NAMES is pi-ai's rename table", renameTable.join(",") === CLAUDE_CODE_TOOL_NAMES.join(","), renameTable.join(","));
	check(
		"pi-ai still applies it to tool definitions exactly on an OAuth request",
		anthropicSource.includes("name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name"),
	);

	// The live guideline strings: pi's own for read/write/bash, the kit's for edit.
	const { api: editApi, tools: editTools } = makeApi();
	await (await jiti.import(`${ROOT}/extensions/multi-edit.ts`, { default: true }))(editApi);
	const liveGuidelines = [
		...(await import(path.join(piDist, "core/tools/read.js"))).readToolSystemPromptContribution.guidelines,
		...(await import(path.join(piDist, "core/tools/write.js"))).writeToolSystemPromptContribution.guidelines,
		...(await import(path.join(piDist, "core/tools/bash.js"))).bashToolSystemPromptContribution.guidelines,
		...editTools.get("edit").promptGuidelines,
	];
	const seatTools = ["read", "bash", "edit", "write"];
	const withGuidelines = { ...options, customPrompt: undefined, selectedTools: seatTools, promptGuidelines: liveGuidelines };
	const oauthGuidelines = guidelinesOf(buildOwnedSystemPrompt(withGuidelines, claudeCodeToolName));
	const misnamed = [...oauthGuidelines.matchAll(/[A-Za-z]+/g)]
		.map((match) => match[0])
		.filter((word) => seatTools.includes(word.toLowerCase()) && word !== claudeCodeToolName(word));
	check("every tool the Guidelines name is spelled the way the wire spells it", misnamed.length === 0, `${misnamed.join(", ")}\n${oauthGuidelines}`);
	check(
		"and a request with no rename keeps the seat's own names",
		guidelinesOf(buildOwnedSystemPrompt(withGuidelines)).includes("- Use read to examine files"),
		guidelinesOf(buildOwnedSystemPrompt(withGuidelines)),
	);

	// The options schema is pinned against the installed pi package: a new
	// field pi adds would be silently dropped from the wire, so it must show
	// up here first.
	const dts = fs.readFileSync(path.join(piDist, "core/system-prompt.d.ts"), "utf8");
	const ifaceStart = dts.indexOf("interface BuildSystemPromptOptions");
	const iface = dts.slice(ifaceStart, dts.indexOf("\n}", ifaceStart));
	const declaredKeys = [...iface.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]);
	check(
		"KNOWN_OPTION_KEYS matches pi's BuildSystemPromptOptions",
		declaredKeys.length === KNOWN_OPTION_KEYS.length && declaredKeys.every((k) => KNOWN_OPTION_KEYS.includes(k)),
		`pi declares: ${declaredKeys.join(", ")}`,
	);
	check("clean options validate clean", validatePromptOptions(options).length === 0);
	check("an unmapped field is called out", validatePromptOptions({ ...options, newThing: 1 }).some((p) => p.includes("newThing")));

	// pi dedupes context files by path string, so a symlink is loaded twice.
	const doubledOptions = {
		cwd: dir,
		contextFiles: [
			{ path: linkPath, content: "Solve the system, not the result." },
			{ path: agentsPath, content: "Solve the system, not the result." },
		],
	};
	const doubled = buildOwnedSystemPrompt(doubledOptions);
	check("content dedupe keeps one copy", doubled.split("Solve the system, not the result.").length === 2);
	check("content dedupe keeps the first path", doubled.includes(`path="${linkPath}"`) && !doubled.includes(`path="${agentsPath}"`));

	// The purity invariant (issues/25): the builder makes no syscall, so the
	// same options yield the same bytes no matter what disk does between
	// builds. Each state below changed the realpath-keyed build (issues/21).
	fs.rmSync(agentsPath); // 1: symlink target deleted — linkPath dangles
	const afterDangling = buildOwnedSystemPrompt(doubledOptions);
	fs.rmSync(linkPath); // 2: both paths gone
	const afterGone = buildOwnedSystemPrompt(doubledOptions);
	fs.writeFileSync(path.join(dir, "moved-AGENTS.md"), "Solve the system, not the result."); // 3: target moved
	const afterMoved = buildOwnedSystemPrompt(doubledOptions);
	fs.writeFileSync(linkPath, "Solve the system, not the result."); // 4: symlink replaced by a real copy
	const afterCopy = buildOwnedSystemPrompt(doubledOptions);
	check(
		"the prompt is a pure function of its options (disk mutated four ways)",
		afterDangling === doubled && afterGone === doubled && afterMoved === doubled && afterCopy === doubled,
	);
	// Restore the fixture for the rest of the block.
	fs.rmSync(linkPath);
	fs.rmSync(path.join(dir, "moved-AGENTS.md"));
	fs.writeFileSync(agentsPath, "Solve the system, not the result.");
	fs.symlinkSync(agentsPath, linkPath);

	// The dedupe keys on bytes, not names: distinct content never collapses.
	const distinct = buildOwnedSystemPrompt({
		cwd: dir,
		contextFiles: [
			{ path: path.join(dir, "one.md"), content: "one policy" },
			{ path: path.join(dir, "two.md"), content: "another policy" },
		],
	});
	check("different content from different paths both emit", distinct.includes("one policy") && distinct.includes("another policy"));

	// --- Claude Code's wire identity ---------------------------------------
	// Pinned to one release's shape, byte for byte. A refactor that changes one
	// character of this line fails here, before it can reach the wire. The
	// version is not part of that shape — it comes off the installed binary — so
	// it is a hole, and what is asserted is how the line composes around it.
	//
	// The three hash digits are the real assertion: they can only come out right
	// if salt, sampled characters and version compose as upstream composes them.
	// They are recomputed here from a second transcription of those three facts,
	// never read back out of the harness, or the pin would pin the
	// implementation. The transcription itself is held to the digits read off
	// 2.1.276 by hand, which no release can move:
	//
	//   printf '%s' '59cf53e54c78t b2.1.276' | shasum -a 256 | cut -c1-3   # 936
	//   printf '%s' '59cf53e54c78'"000"'2.1.276' | shasum -a 256 | cut -c1-3  # 8be
	//
	// `t b` is characters 4, 7 and 20 of PIN below; `000` is the empty-message
	// case, where every sampled character falls back to "0".
	const ccHash = (sampled, version) => createHash("sha256").update(`59cf53e54c78${sampled}${version}`).digest("hex").slice(0, 3);
	check(
		"the transcribed hash reproduces the digits read off 2.1.276 by hand",
		ccHash("t b", LAST_VERIFIED_VERSION) === "936" && ccHash("000", LAST_VERIFIED_VERSION) === "8be",
	);
	const PIN = "pin the attribution block";
	const V = CLAUDE_CODE_VERSION;
	const pinnedMessages = [{ role: "user", content: PIN }];
	const pinnedFacts = { firstUserText: PIN, firstParty: true };
	check(
		"attribution block matches the pinned wire shape",
		buildAttributionHeader(pinnedFacts) === `x-anthropic-billing-header: cc_version=${V}.${ccHash("t b", V)}; cc_entrypoint=cli; cch=00000;`,
		buildAttributionHeader(pinnedFacts),
	);
	check(
		"attribution survives an empty conversation",
		buildAttributionHeader({ firstUserText: "", firstParty: true }) ===
			`x-anthropic-billing-header: cc_version=${V}.${ccHash("000", V)}; cc_entrypoint=cli; cch=00000;`,
	);
	check(
		"a non-first-party request drops cch, prev-req and prompt-id",
		buildAttributionHeader({
			...pinnedFacts,
			firstParty: false,
			previousRequestId: "req_abc",
			promptId: "550e8400-e29b-41d4-a716-446655440000",
		}) === `x-anthropic-billing-header: cc_version=${V}.${ccHash("t b", V)}; cc_entrypoint=cli;`,
	);
	check(
		"the optional fields keep Claude Code's field order",
		buildAttributionHeader({
			...pinnedFacts,
			subagent: { agentId: "550e8400-e29b-41d4-a716-446655440000", parentAgentId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
			previousRequestId: "req_011CQ4x",
			promptId: "550e8400-e29b-41d4-a716-446655440000",
			turnOrigin: "human",
		}) ===
			`x-anthropic-billing-header: cc_version=${V}.${ccHash("t b", V)}; cc_entrypoint=cli; cch=00000; cc_is_subagent=true; cc_prev_req=req_011CQ4x; cc_prompt_id=550e8400-e29b-41d4-a716-446655440000; cc_turn_origin=human;`,
	);
	check(
		"a malformed turn origin is dropped, not sent",
		!buildAttributionHeader({ ...pinnedFacts, turnOrigin: "Human Turn" }).includes("cc_turn_origin"),
	);
	check(
		"a non-first-party request drops the turn origin too",
		!buildAttributionHeader({ ...pinnedFacts, firstParty: false, turnOrigin: "human" }).includes("cc_turn_origin"),
	);
	check(
		"a malformed request id is dropped, not sent",
		!buildAttributionHeader({ ...pinnedFacts, previousRequestId: "nope-not-a-request-id" }).includes("cc_prev_req"),
	);
	check(
		"a malformed prompt id is dropped, not sent",
		!buildAttributionHeader({ ...pinnedFacts, promptId: "not-a-uuid" }).includes("cc_prompt_id"),
	);

	// The hash samples the first user message the way upstream reads it: the
	// first text block of block content, not every block joined.
	check("first user text reads a string message", firstUserTextOf(pinnedMessages) === PIN);
	check(
		"first user text reads the FIRST text block only",
		firstUserTextOf([{ role: "user", content: [{ type: "text", text: PIN }, { type: "text", text: "second" }] }]) === PIN,
	);
	check("first user text skips non-user messages", firstUserTextOf([{ role: "assistant", content: "x" }, { role: "user", content: PIN }]) === PIN);
	check("first user text of an empty conversation is empty", firstUserTextOf([]) === "");

	check("first-party by default", isFirstParty(undefined) && isFirstParty("https://api.anthropic.com"));
	check("a proxied base url is not first-party", !isFirstParty("https://proxy.example.com/v1") && !isFirstParty("not a url"));

	// A half-declared subagent is unrepresentable.
	check("a subagent needs both ids", subagentIdentity("550e8400-e29b-41d4-a716-446655440000", undefined) === undefined);
	check("a subagent needs well-formed ids", subagentIdentity("550e8400-e29b-41d4-a716-446655440000", "parent") === undefined);
	check(
		"a parent session id is read out of its file path",
		sessionIdFromPath("/s/2026-08-28T17-59-47-975Z_01a04987-2207-720a-92a1-36eebcb0d389.jsonl") === "01a04987-2207-720a-92a1-36eebcb0d389",
	);
	check("an id-less path yields no parent", sessionIdFromPath("/s/session.jsonl") === undefined && sessionIdFromPath(undefined) === undefined);

	check(
		"a main session sends only the two always-on headers",
		JSON.stringify(claudeCodeHeaders({ sessionId: "s1" })) ===
			JSON.stringify({ "user-agent": CLAUDE_CODE_USER_AGENT, "X-Claude-Code-Session-Id": "s1" }),
	);
	check("the user-agent carries the one resolved version", CLAUDE_CODE_USER_AGENT === `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`);

	// --- The oracle: the installed Claude Code binary -----------------------
	// Constants are verified against the release itself, never against a
	// third-party copy of it.
	//
	// Two properties are structural here, and both were bugs once:
	//
	//   - **A rename is not a change.** Claude Code ships minified and the
	//     bundler renames every module-scope identifier per release, so these
	//     match through `minified` with the names as holes. Pinning `Lun` or
	//     `RBt` made the suite red on releases that changed nothing.
	//   - **The same names report either way.** Whether or not a binary is
	//     installed, this block emits one result per oracle — checked, or
	//     skipped by name. A single blanket skip would make the number of checks
	//     a property of the machine rather than of the code.
	//
	// Every oracle here is structural, and every one is a hard failure: the
	// version number is read off this same binary at load, so it cannot fall
	// behind, and what is left can only go red when Anthropic changes the shape
	// of the wire — which is a real bug in this harness's mimicry and needs a
	// human to re-read the binary.
	const claudeLink = path.join(os.homedir(), ".local/bin/claude");
	const binary = fs.existsSync(claudeLink) ? fs.realpathSync(claudeLink) : undefined;
	const strings =
		binary === undefined ? "" : execFileSync("strings", ["-n", "6", binary], { maxBuffer: 512 * 1024 * 1024, encoding: "latin1" });

	// The salt's name is a hole, and the hash shape below reuses whatever name
	// this build gave it — so the two facts can never drift apart.
	const salt = minified('{}="59cf53e54c78"').exec(strings);
	// Shapes are built by these, so the near-miss checks are the same patterns
	// with one fact altered rather than a second transcription of them.
	// Parameters and locals are holes too: 2.1.258 renamed `t`/`u` to `n`/`d`
	// without touching the hash, and a pin on a local name is a pin on nothing.
	const hashShape = (samples, saltName) =>
		`function {}({},{}){let {}=[${samples}].map(({})=>{2}[{5}]||"0").join(""),{}=\`\${${saltName}}\${{4}}\${{3}}\`;` +
		'return {}("sha256").update({6}).digest("hex").slice(0,3)}';
	// Six interpolations since 2.1.277, which appended `cc_turn_origin` after
	// `cc_prompt_id`.
	const attribution = "x-anthropic-billing-header: cc_version=${{}}; cc_entrypoint=${{}};${{}}${{}}${{}}${{}}${{}}${{}}`";
	const fieldsSwapped = attribution.replace("cc_version", "cc_swap").replace("cc_entrypoint", "cc_version").replace("cc_swap", "cc_entrypoint");
	const oneSlotMore = `${attribution.slice(0, -1)}\${{}}\``;

	const oracles = [
		["the identity line is still what Claude Code sends", () => strings.includes(`"${CLAUDE_CODE_IDENTITY}"`)],
		["the billing salt is unchanged", () => salt !== null],
		["the version hash still samples chars 4, 7, 20", () => salt !== null && minified(hashShape("4,7,20", salt[1])).test(strings)],
		["the attribution line's field order is unchanged", () => minified(attribution).test(strings)],
		// A pattern that matches anything is the same hole as a pattern pinned to
		// a minified name: it stops reporting. Each shape must reject a near miss.
		[
			"the shapes discriminate — a near miss is rejected",
			() =>
				salt !== null &&
				!minified(hashShape("4,7,21", salt[1])).test(strings) &&
				!minified(hashShape("4,7,20", "notTheSalt")).test(strings) &&
				!minified(fieldsSwapped).test(strings) &&
				!minified(oneSlotMore).test(strings) &&
				!minified("function {}(){return {}.getStore()?.payload}").test(strings),
		],
		["cc_is_subagent still means agentType subagent off the main session", () => strings.includes(' cc_is_subagent=true;"')],
		["the session-id header name is unchanged", () => strings.includes('"X-Claude-Code-Session-Id"')],
		[
			"the agent-id header names are unchanged",
			() => strings.includes('"x-claude-code-agent-id"') && strings.includes('"x-claude-code-parent-agent-id"'),
		],
		[
			"the user-agent is still claude-cli/<version> (external, <entrypoint>…)",
			() => strings.includes("`claude-cli/${") && minified('(external, ${{}.CLAUDE_CODE_ENTRYPOINT??"cli"}').test(strings),
		],
		["cc_workload still comes from the cron-only store", () => minified("function {}(){return {}.getStore()?.workload}").test(strings)],
		["cc_turn_origin still takes a lowercase word on a first-party turn", () => minified("` cc_turn_origin=${{}};`").test(strings)],
	];

	const SOURCED = "oracle: the wire version is the installed Claude Code's";
	if (binary === undefined) {
		skip(`${SOURCED} (no binary installed)`);
		for (const [name] of oracles) skip(`oracle: ${name} (no binary installed)`);
	} else {
		// Not a pin: this fails only if the resolver in `lib/claude-code.ts` stops
		// reading the installed version, which is this repo's bug, not Anthropic's.
		check(SOURCED, path.basename(binary) === CLAUDE_CODE_VERSION, `installed ${path.basename(binary)}, on the wire ${CLAUDE_CODE_VERSION}`);
		for (const [name, ok] of oracles) check(`oracle: ${name}`, ok());
	}

	// --- The extension end to end ------------------------------------------
	const wireMod = await jiti.import(`${ROOT}/extensions/wire.ts`);
	const seat = await jiti.import(`${ROOT}/lib/seat.ts`);
	check(
		"a --system-prompt process can identify no subagent",
		seat.cliSuppliesSystemPrompt(["pi", "--system-prompt", "x"]) &&
			seat.cliSuppliesSystemPrompt(["pi", "--system-prompt=x"]) &&
			!seat.cliSuppliesSystemPrompt(["pi", "--append-system-prompt", "x"]),
	);
	const handlers = new Map();
	const commands = new Map();
	wireMod.default({
		on: (e, h) => handlers.set(e, h),
		registerCommand: (n, o) => commands.set(n, o),
	});
	const WIRE_CWD = "/tmp/wire-seat";
	const mainSession = {
		getSessionId: () => "550e8400-e29b-41d4-a716-446655440000",
		getHeader: () => ({ id: "550e8400-e29b-41d4-a716-446655440000" }),
	};
	const ctx = {
		cwd: WIRE_CWD,
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) },
		sessionManager: mainSession,
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c, s) => s } },
	};
	const payload = {
		messages: pinnedMessages,
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral", ttl: "1h" } },
			{ type: "text", text: "vanilla pi prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
		],
		tools: [{ name: "Read", input_schema: {} }],
	};

	// Before any options capture. pi's prompt is not a fallback: a request that
	// says "I am Claude Code" and carries another product's prose is what the
	// provider refuses as a third-party app (req_011CedeAuH5mq3X7m9d1d52r,
	// req_011CenGzjBfwouGRX52Q5PE3), so the seat declares the absence instead.
	const refusalNotices = [];
	const degraded = handlers.get("before_provider_request")({ payload }, { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: (m, level) => refusalNotices.push({ m, level }) } });
	check("with no capture the array is still four blocks", degraded.system.length === 4, JSON.stringify(degraded.system.map((b) => b.text.slice(0, 30))));
	check("attribution first, identity second, whatever else is true", degraded.system[0].text.startsWith("x-anthropic-billing-header:") && degraded.system[1].text === "You are Claude Code, Anthropic's official CLI for Claude.");
	check("pi's prompt is never the third block", !degraded.system.some((b) => b.text.includes("vanilla pi prompt")));
	check("the third block declares the seat has no prompt", degraded.system[2].text === PROMPT_UNAVAILABLE);
	check("the identity block is still sent exactly once", degraded.system.filter((b) => b.text.includes("You are Claude Code")).length === 1);
	check("the cache breakpoint still lands on the third block", degraded.system[2].cache_control?.ttl === "1h");
	// The refusal alone, and once: the same request also carries the family line
	// (this fixture's seat is on claude-test while the settings name another family).
	check("and the human is told, at error level", refusalNotices.filter((n) => n.level === "error").length === 1 && refusalNotices.some((n) => n.level === "error" && n.m.includes("no system prompt")), JSON.stringify(refusalNotices));
	// Telling him is the one thing on this path that is not pure construction, so
	// it is the one thing that could hand the request back to pi — on exactly the
	// path where pi's payload is the shape the provider refuses.
	const throughDeadUi = handlers.get("before_provider_request")({ payload }, { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: () => { throw new Error("this frame is unmounted"); } } });
	check("a ui that throws while being told costs the notice, never the wire", throughDeadUi?.system.length === 4 && throughDeadUi.system[2].text === PROMPT_UNAVAILABLE, JSON.stringify(throughDeadUi?.system.map((b) => b.text.slice(0, 30))));

	handlers.get("before_agent_start")({ systemPromptOptions: options }, ctx);
	const rewritten = handlers.get("before_provider_request")({ payload }, ctx);
	check(
		"first block is the attribution",
		rewritten.system[0].text.startsWith(
			`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${ccHash("t b", CLAUDE_CODE_VERSION)}; cc_entrypoint=cli; cch=00000;`,
		),
	);
	check("attribution block carries no cache_control", rewritten.system[0].cache_control === undefined);
	check("second block is the Claude Code identity", rewritten.system[1].text === "You are Claude Code, Anthropic's official CLI for Claude.");
	check("the identity block is sent once", rewritten.system.filter((b) => b.text.includes("You are Claude Code")).length === 1);
	check("third block is the owned prompt", rewritten.system.length === 4 && rewritten.system[2].text === oauthOurs, rewritten.system[2].text.slice(0, 200));
	check("cache_control is carried onto the owned block", rewritten.system[2].cache_control?.ttl === "1h");
	// Past the breakpoint on purpose: two seats on the same model and tools in
	// different directories share one tools+system entry, and this block is the
	// only thing that tells them apart. Read off the seat's own cwd, so a child
	// in a worktree still sends the parent's cached body.
	check("the cwd is the fourth block, uncached", rewritten.system[3].text === `Current working directory: ${WIRE_CWD}` && rewritten.system[3].cache_control === undefined, JSON.stringify(rewritten.system[3]));
	check("the owned prompt carries no cwd of its own", !rewritten.system[2].text.includes("Current working directory"));
	const elsewhere = handlers.get("before_provider_request")({ payload }, { ...ctx, cwd: "/tmp/other-seat" });
	check("a seat in another directory sends the same cached block", elsewhere.system[2].text === rewritten.system[2].text && elsewhere.system[3].text === "Current working directory: /tmp/other-seat");
	check("messages pass through untouched", rewritten.messages === payload.messages);
	// tools are owned here now (the standing cut and bash's real budget) —
	// test/tool-policy.mjs owns the policy's own checks.
	check("a payload with no bash keeps every tool it arrived with", JSON.stringify(rewritten.tools) === JSON.stringify(payload.tools));

	const again = handlers.get("before_provider_request")({ payload: rewritten }, ctx);
	check("a second pass is byte-identical", JSON.stringify(again.system) === JSON.stringify(rewritten.system));

	// Instruments run beside the request, never in its path: pi answers a throw in
	// this handler by sending the payload it already had — pi's prompt, no
	// attribution, no identity. Today's trace, dump and ping each go dead rather
	// than throw; this pins the guarantee for the one that some day does not, by
	// breaking the seat under the instruments after the owned bytes are built.
	{
		const notices = [];
		let reads = 0;
		const brokenCtx = {
			...ctx,
			hasUI: true,
			sessionManager: { getSessionId: () => "6ba7b810-9dad-11d1-80b4-00c04fd430bb", getHeader: () => ({}) },
			ui: { ...ctx.ui, notify: (m, level) => notices.push({ m, level }) },
			// Answers the auth question the payload is built from, then fails — the
			// shape of any instrument that dies after the wire is decided.
			get modelRegistry() {
				if (++reads > 1) throw new Error("the registry went away");
				return { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) };
			},
		};
		const broken = new Map();
		(await jiti.import(`${ROOT}/extensions/wire.ts?broken-instrument`)).default({ on: (e, h) => broken.set(e, h), registerCommand: () => {} });
		broken.get("before_agent_start")({ systemPromptOptions: options }, brokenCtx);
		const sent = broken.get("before_provider_request")({ payload }, brokenCtx);
		check("an instrument that throws still sends the owned four blocks", sent?.system.length === 4 && sent.system[0].text.startsWith("x-anthropic-billing-header:") && sent.system[2].text === oauthOurs, JSON.stringify(sent?.system.map((b) => b.text.slice(0, 30))));
		check("with its tools", JSON.stringify(sent.tools) === JSON.stringify(payload.tools));
		check("and the failure is named, at warning level, without costing the turn", notices.some((n) => n.m.includes("the instrument did not") && n.level === "warning"), JSON.stringify(notices));
	}

	const keyed = handlers.get("before_provider_request")({ payload }, { ...ctx, modelRegistry: { isUsingOAuth: () => false, find: (provider, id) => ({ provider, id }) } });
	check("api-key requests get the owned prompt and its cwd, nothing else", keyed.system.length === 2 && keyed.system[0].text === ours && keyed.system[1].text === `Current working directory: ${WIRE_CWD}`);

	check(
		"a payload on any other api passes through",
		handlers.get("before_provider_request")({ payload }, { ...ctx, model: { id: "gpt", api: "openai-responses" } }) === undefined,
	);
	check("/prompt command is registered", commands.has("prompt"));

	// A main session declares no subagent facts, and one user turn carries one
	// prompt id across every request of that turn.
	const attributionOf = (blocks) => blocks[0].text;
	check("a main session sends no subagent field", !attributionOf(rewritten.system).includes("cc_is_subagent"));
	const promptId = /cc_prompt_id=([0-9a-f-]+);/.exec(attributionOf(rewritten.system))?.[1];
	check("a prompt id is always present", promptId !== undefined);
	check(
		"the prompt id is stable across the requests of one turn",
		/cc_prompt_id=([0-9a-f-]+);/.exec(attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system))?.[1] === promptId,
	);
	handlers.get("before_agent_start")({ systemPromptOptions: options }, ctx);
	check(
		"a new turn gets a new prompt id",
		/cc_prompt_id=([0-9a-f-]+);/.exec(attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system))?.[1] !== promptId,
	);

	// The previous response's request id rides the next request, and only a
	// well-formed one does.
	check("no previous request id on the first request", !attributionOf(rewritten.system).includes("cc_prev_req"));
	handlers.get("after_provider_response")({ status: 200, headers: { "request-id": "req_011CQ4xPinned" } }, ctx);
	check(
		"the previous request id rides the next request",
		attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system).includes("cc_prev_req=req_011CQ4xPinned;"),
	);
	handlers.get("after_provider_response")({ status: 200, headers: { "request-id": "garbage id" } }, ctx);
	check(
		"a malformed request id never reaches the wire",
		!attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system).includes("cc_prev_req"),
	);

	// Headers: the user-agent override and the session id, OAuth only.
	const headers = { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" };
	handlers.get("before_provider_headers")({ headers }, ctx);
	check("the stale pi-ai user-agent is overridden", headers["user-agent"] === CLAUDE_CODE_USER_AGENT);
	check("the session id header is sent", headers["X-Claude-Code-Session-Id"] === "550e8400-e29b-41d4-a716-446655440000");
	check("pi's own headers are left alone", headers["anthropic-beta"] === "claude-code-20250219,oauth-2025-04-20");
	const keyedHeaders = {};
	handlers.get("before_provider_headers")({ headers: keyedHeaders }, { ...ctx, modelRegistry: { isUsingOAuth: () => false } });
	check("api-key requests get no Claude Code headers", Object.keys(keyedHeaders).length === 0);

	// A subagent session: parentSession AND customPrompt. All three subagent
	// facts appear together or not at all.
	const subCtx = {
		...ctx,
		sessionManager: {
			getSessionId: () => "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
			getHeader: () => ({ parentSession: "/s/2026-08-28T17-59-47-975Z_01a04987-2207-720a-92a1-36eebcb0d389.jsonl" }),
		},
	};
	const subMod = await jiti.import(`${ROOT}/extensions/wire.ts?sub`);
	const subHandlers = new Map();
	subMod.default({ on: (e, h) => subHandlers.set(e, h), registerCommand: () => {} });
	subHandlers.get("before_agent_start")({ systemPromptOptions: { ...options, customPrompt: "You are a subagent." } }, subCtx);
	const subWire = subHandlers.get("before_provider_request")({ payload }, subCtx);
	check("a subagent declares itself", attributionOf(subWire.system).includes(" cc_is_subagent=true;"));
	const subHeaders = {};
	subHandlers.get("before_provider_headers")({ headers: subHeaders }, subCtx);
	check(
		"a subagent sends both agent-id headers",
		subHeaders["x-claude-code-agent-id"] === "6ba7b810-9dad-11d1-80b4-00c04fd430c8" &&
			subHeaders["x-claude-code-parent-agent-id"] === "01a04987-2207-720a-92a1-36eebcb0d389",
	);
	const orphanCtx = { ...subCtx, sessionManager: { getSessionId: () => "6ba7b810-9dad-11d1-80b4-00c04fd430c8", getHeader: () => ({}) } };
	const orphanHeaders = {};
	subHandlers.get("before_provider_headers")({ headers: orphanHeaders }, orphanCtx);
	check(
		"a subagent with no traceable parent declares nothing",
		!attributionOf(subHandlers.get("before_provider_request")({ payload }, orphanCtx).system).includes("cc_is_subagent") &&
			orphanHeaders["x-claude-code-agent-id"] === undefined,
	);

	// A ChatGPT-subscription seat: the same owned words and the same tool cut, in
	// the Responses API's shape, and nothing that belongs to Claude Code.
	{
		const luna = { id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex" };
		const notices = [];
		const codexCtx = { ...ctx, model: luna, hasUI: true, ui: { ...ctx.ui, notify: (m, level) => notices.push({ m, level }) } };
		const codexTool = (name) => ({ type: "function", name, description: `${name} tool`, parameters: {}, strict: null });
		const codexPayload = {
			model: "gpt-6-luna",
			instructions: "vanilla pi prompt",
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
			tools: ["write", "grep", "Workflow", "bash", "StructuredOutput", "find", "Agent", "ls", "read"].map(codexTool),
			prompt_cache_key: "550e8400-e29b-41d4-a716-446655440000",
		};
		handlers.get("before_agent_start")({ systemPromptOptions: options }, codexCtx);
		const codexHeaders = { authorization: "Bearer codex-token", "chatgpt-account-id": "acct" };
		handlers.get("before_provider_headers")({ headers: codexHeaders }, codexCtx);
		check("no claude code header is added to a codex request", JSON.stringify(Object.keys(codexHeaders)) === JSON.stringify(["authorization", "chatgpt-account-id"]));
		const sent = handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		check("a codex request carries the owned prompt and its cwd as its instructions", sent?.instructions === `${ours}\n\nCurrent working directory: ${WIRE_CWD}`, sent?.instructions?.slice(0, 200));
		check("pi's prompt is not in it", !sent.instructions.includes("vanilla pi prompt"));
		check("nothing Claude Code rides a codex request", !sent.instructions.includes("You are Claude Code") && !sent.instructions.includes("x-anthropic-billing-header") && sent.system === undefined);
		check("the seat's cut and canonical order apply to codex tools", JSON.stringify(sent.tools.map((t) => t.name)) === JSON.stringify(["Agent", "bash", "read", "write"]), JSON.stringify(sent.tools.map((t) => t.name)));
		check("and each kept tool goes out as pi built it", JSON.stringify(sent.tools[1]) === JSON.stringify(codexTool("bash")));
		check("the conversation and the cache key pass through untouched", sent.input === codexPayload.input && sent.prompt_cache_key === codexPayload.prompt_cache_key && sent.model === "gpt-6-luna");
		check("a second pass is byte-identical", JSON.stringify(handlers.get("before_provider_request")({ payload: sent }, codexCtx)) === JSON.stringify(sent));
		check("a codex request raises no notice", notices.length === 0, JSON.stringify(notices));

		const dumped = [];
		await commands.get("prompt").handler("", { ...codexCtx, ui: { ...ctx.ui, notify: (m) => dumped.push(m) } });
		const dumpPath = /dumped to (\S+)$/.exec(dumped[0] ?? "")?.[1];
		const dump = dumpPath === undefined ? "" : fs.readFileSync(dumpPath, "utf8");
		check("/prompt records the codex request", dumped[0]?.includes("(gpt-6-luna,") && dump.includes("Current working directory: /tmp/wire-seat") && dump.includes('"input_text"'), dumped[0]);
		check("with the tools that went out, not the ones pi built", dump.includes('"name": "Agent"') && !dump.includes('"name": "grep"'));
		check("rendered as a codex request: api, instructions, input", dump.includes("- api: openai-codex-responses") && dump.includes("## instructions (") && dump.includes("## input (1,") && !dump.includes("## system blocks") && !dump.includes("not an OAuth request"));
		check("with the headers pi handed over, the credential redacted", dump.includes("- chatgpt-account-id: acct") && dump.includes("- authorization: (redacted)") && !dump.includes("codex-token"));
		check("and the request's other fields", /## request fields[\s\S]*"prompt_cache_key": "550e8400/.test(dump) && !/## request fields[^#]*"instructions"/.test(dump));

		// A typed child's body is the custom prompt: it arrives once, in place of
		// pi's, and pi's copy of it in the vanilla instructions is gone with the rest.
		const typedSession = { getSessionId: () => "7c9e6679-7425-40de-944b-e07fc1f90ae7", getHeader: () => ({ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }) };
		const typedCtx = { ...codexCtx, sessionManager: typedSession };
		handlers.get("before_agent_start")({ systemPromptOptions: { ...options, customPrompt: "You are the explore agent. BODY-MARK" } }, typedCtx);
		const typed = handlers.get("before_provider_request")({ payload: { ...codexPayload, instructions: "vanilla pi prompt\nYou are the explore agent. BODY-MARK" } }, typedCtx);
		check("a typed child's body reaches a codex seat exactly once", typed.instructions.split("BODY-MARK").length === 2 && typed.instructions.startsWith("You are the explore agent. BODY-MARK") && !typed.instructions.includes("vanilla pi prompt"), typed.instructions.slice(0, 120));

		const reported = [];
		const quotaCtx = { ...codexCtx, ui: { ...ctx.ui, notify: (m) => reported.push(m) } };
		const resetAt = Math.floor(Date.now() / 1000) + 16_503;
		handlers.get("after_provider_response")({
			status: 200,
			headers: { "x-codex-primary-used-percent": "12.5", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(resetAt), "x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080" },
		}, codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("/quota reports the codex windows the response sent", reported.some((m) => /Codex quota 5h 13% · 7d 40% \(5h resets /.test(m)), JSON.stringify(reported));
		handlers.get("after_provider_response")({ status: 200, headers: { "content-type": "text/event-stream" } }, codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("a codex response with no quota headers leaves the last reading standing", reported.at(-1)?.includes("Codex quota 5h 13%"), reported.at(-1));
		check("and never becomes an anthropic reading", !reported.at(-1)?.split("\n").some((line) => line.startsWith("Quota ")), reported.at(-1));

		// Over WebSocket the response hook never fires. The newest answer then has
		// no numbers, and /quota says so instead of repeating the last SSE ones.
		const codexAnswer = (stopReason) => ({ message: { role: "assistant", api: "openai-codex-responses", stopReason, usage: { input: 1, output: 1 } } });
		handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		handlers.get("message_end")(codexAnswer("stop"), codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("a codex answer with no response headers is declared unreported, not shown stale", reported.at(-1) === "Codex quota: not reported over WebSocket (pi-ai drops the codex.rate_limits event; only an SSE response carries it to extensions)", reported.at(-1));
		handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		handlers.get("after_provider_response")({ status: 200, headers: { "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300" } }, codexCtx);
		handlers.get("message_end")(codexAnswer("stop"), codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("an SSE answer after it reads again", reported.at(-1) === "Codex quota 5h 20%", reported.at(-1));
		handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		handlers.get("message_end")(codexAnswer("error"), codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("a request that failed answered nothing, so the last word stands", reported.at(-1) === "Codex quota 5h 20%", reported.at(-1));
	}

	// The whole point of matching pi's framing: /context injections still parses it.
	const items = measure.analyzeSystemPrompt(ours, {
		cwd: dir,
		appendSystemPrompt: APPEND,
		contextFilePaths: [agentsPath],
		skills: [{ name: "tdd", description: "Red-green-refactor", filePath: path.join(dir, "tdd/SKILL.md") }],
	});
	const contextItem = items.find((item) => item.id === `context-file:${agentsPath}`);
	check("measure.ts still finds the context file", contextItem?.text === "Solve the system, not the result.", JSON.stringify(contextItem?.text));
	check("measure.ts labels the appended prompt", items.some((item) => item.kind === "append-prompt"));
	check("measure.ts finds the skills block", items.some((item) => item.kind === "skills"));

	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Every seat's system prompt is built once and published under its session id,
// so a child can be handed its parent's exact bytes (map C10) and read the
// parent's tools+system cache entry instead of writing its own (map C4). These
// pin the publishing, the inheritance, and the two branches with no parent to
// inherit from.
console.log("prompt inheritance between sessions");
{
	const { buildOwnedSystemPrompt, SKILLS_OPEN } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const { ownedSessionPrompt, inheritedSessionPrompt, publishedOwnedPrompt, forgetOwnedPrompt } = await jiti.import(`${ROOT}/lib/inherited-prompt.ts`);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-inherit-"));
	const agentsPath = path.join(dir, "AGENTS.md");
	fs.writeFileSync(agentsPath, "Solve the system, not the result.");
	const parentOptions = {
		cwd: dir,
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		appendSystemPrompt: "<COMMUNICATION>\nsay less\n</COMMUNICATION>",
		contextFiles: [{ path: agentsPath, content: "Solve the system, not the result." }],
		skills: [{ name: "tdd", description: "Red-green-refactor", filePath: path.join(dir, "tdd/SKILL.md") }],
	};
	const countOf = (prompt, needle) => prompt.split(needle).length - 1;

	const parentOwned = ownedSessionPrompt(parentOptions, { sessionId: "parent", parentSessionId: undefined });
	check("a main session's prompt is the owned one", parentOwned === buildOwnedSystemPrompt(parentOptions));
	check("and is published under its own id, as the bytes that went out", publishedOwnedPrompt("parent") === parentOwned);
	check("pi's docs block is on no seat", !parentOwned.includes("Pi documentation"));

	// A worker with no prompt body of its own: the parent's bytes, verbatim.
	const childOptions = { ...parentOptions, contextFiles: [], appendSystemPrompt: undefined, skills: [] };
	const childOwned = inheritedSessionPrompt(childOptions, { sessionId: "child", parentSessionId: "parent" });
	check("an inheriting child gets the parent's exact bytes", childOwned === parentOwned);
	check("not a rebuild of them — nothing appended, nothing dropped", countOf(childOwned, SKILLS_OPEN) === 1 && countOf(childOwned, "<project_context>") === 1 && countOf(childOwned, "<COMMUNICATION>") === 1);
	check("and it republishes them, so a grandchild inherits the same bytes", inheritedSessionPrompt(childOptions, { sessionId: "grand", parentSessionId: "child" }) === parentOwned);

	// The branches with no parent to inherit from: a skeleton built from the
	// child's own options. 100% owned text, less parental flavour.
	const orphan = inheritedSessionPrompt(childOptions, { sessionId: "orphan", parentSessionId: undefined });
	check("an unparented child gets an owned skeleton", orphan.startsWith("You are Joel's personal agent") && !orphan.includes("Pi documentation"));
	check("an unpublished parent falls back rather than leaking", inheritedSessionPrompt(childOptions, { sessionId: "missing", parentSessionId: "never-published" }) === orphan);
	forgetOwnedPrompt("parent");
	check("a shut-down parent stops being inheritable", inheritedSessionPrompt(childOptions, { sessionId: "late", parentSessionId: "parent" }) === orphan);
	check("and its published bytes go with it", publishedOwnedPrompt("parent") === undefined);

	// A child whose wire spells the tools differently from its parent's cannot take
	// the parent's bytes: they would name tools its request does not carry.
	const { claudeCodeToolName: ccName } = await jiti.import(`${ROOT}/lib/claude-code.ts`);
	const oauthParent = ownedSessionPrompt(parentOptions, { sessionId: "oauth-parent", parentSessionId: undefined }, ccName);
	check("an oauth parent's prompt names tools in Claude Code's casing", oauthParent.includes("Use Bash") && oauthParent !== buildOwnedSystemPrompt(parentOptions));
	const codexChild = inheritedSessionPrompt(childOptions, { sessionId: "codex-child", parentSessionId: "oauth-parent" });
	check("a codex child of it gets the parent's prompt in its own tool names", codexChild === buildOwnedSystemPrompt(parentOptions) && !codexChild.includes("Use Bash"), codexChild.slice(0, 120));
	check("an oauth grandchild under the codex child gets the oauth bytes back", inheritedSessionPrompt(childOptions, { sessionId: "oauth-grand", parentSessionId: "codex-child" }, ccName) === oauthParent);
	check("a child on the parent's own spelling still takes its bytes verbatim", inheritedSessionPrompt(childOptions, { sessionId: "oauth-child", parentSessionId: "oauth-parent" }, ccName) === oauthParent);
	for (const id of ["oauth-parent", "codex-child", "oauth-grand", "oauth-child"]) forgetOwnedPrompt(id);

	// A typed child with a body of its own is not an inheriting child at all:
	// its body is an ordinary custom prompt and takes pi's own branch.
	const typed = { ...childOptions, customPrompt: "You are an explorer. Paths and lines, not prose." };
	const typedOwned = ownedSessionPrompt(typed, { sessionId: "typed", parentSessionId: "child" });
	check("a child with its own body is built from it, not from its parent", typedOwned === buildOwnedSystemPrompt(typed) && typedOwned.startsWith("You are an explorer."));

	// --- end to end through the extension ----------------------------------
	// Two wire instances, as the process really runs them: the parent's
	// publishes, the child's inherits, across module registries.
	const PARENT_ID = "550e8400-e29b-41d4-a716-446655440000";
	const CHILD_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
	const { declareChildSeat, forgetChildSeat } = await jiti.import(`${ROOT}/lib/seat.ts`);
	const boot = async (tag) => {
		const handlers = new Map();
		const mod = await jiti.import(`${ROOT}/extensions/wire.ts?${tag}`);
		mod.default({ on: (e, h) => handlers.set(e, h), registerCommand: () => {} });
		return handlers;
	};
	const sessionCtx = (sessionId, header, cwd = dir) => ({
		cwd,
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) },
		sessionManager: { getSessionId: () => sessionId, getHeader: () => header },
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c, s) => s } },
	});
	const payload = { messages: [{ role: "user", content: "go" }], system: [{ type: "text", text: "vanilla", cache_control: { type: "ephemeral", ttl: "1h" } }], tools: [] };
	// The cached block, by its breakpoint rather than by its position: the cwd
	// block sits after it and is the one block a child does not inherit.
	const promptBlockOf = (rewritten) => rewritten.system.find((block) => block.cache_control).text;

	const parentWire = await boot("inherit-parent");
	parentWire.get("before_agent_start")({ systemPromptOptions: parentOptions }, sessionCtx(PARENT_ID, { id: PARENT_ID }));
	const parentBlock = promptBlockOf(parentWire.get("before_provider_request")({ payload }, sessionCtx(PARENT_ID, { id: PARENT_ID })));

	declareChildSeat(CHILD_ID, { name: "w1", role: "worker", depth: 1, parentSessionId: PARENT_ID, prompt: { kind: "inherit" } });
	// In a worktree of its own, which is the case this arrangement exists for.
	const WORKTREE = path.join(dir, "worktree");
	const childCtx = sessionCtx(CHILD_ID, { parentSession: `/s/2026-08-29T00-00-00-000Z_${PARENT_ID}.jsonl` }, WORKTREE);
	const childWire = await boot("inherit-child");
	childWire.get("before_agent_start")({ systemPromptOptions: childOptions }, childCtx);
	const childBlock = promptBlockOf(childWire.get("before_provider_request")({ payload }, childCtx));
	check("live: the child's block carries no pi prose", !childBlock.includes("Pi documentation"));
	check("live: the child's block is the parent's cached bytes, byte for byte", childBlock === parentBlock, childBlock.slice(0, 120));
	check(
		"live: and it says where it actually runs, past the breakpoint",
		childWire.get("before_provider_request")({ payload }, childCtx).system.at(-1).text === `Current working directory: ${WORKTREE}`,
	);
	check("live: the child still declares itself a subagent", childWire.get("before_provider_request")({ payload }, childCtx).system[0].text.includes("cc_is_subagent=true"));

	{
		const CODEX_CHILD_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c9";
		declareChildSeat(CODEX_CHILD_ID, { name: "l1", role: "worker", depth: 1, parentSessionId: PARENT_ID, prompt: { kind: "inherit" } });
		const lunaCtx = {
			...sessionCtx(CODEX_CHILD_ID, { parentSession: `/s/2026-08-29T00-00-00-000Z_${PARENT_ID}.jsonl` }, WORKTREE),
			model: { id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses" },
		};
		const lunaWire = await boot("inherit-luna");
		lunaWire.get("before_agent_start")({ systemPromptOptions: childOptions }, lunaCtx);
		const lunaSent = lunaWire.get("before_provider_request")({ payload: { model: "gpt-6-luna", instructions: "vanilla", input: [], tools: [] } }, lunaCtx);
		check("live: the oauth parent's block names Claude Code's tools", parentBlock.includes("Use Bash"));
		check("live: a codex child of it gets that prompt in its own wire's tool names", lunaSent.instructions === `${buildOwnedSystemPrompt(parentOptions)}\n\nCurrent working directory: ${WORKTREE}` && !lunaSent.instructions.includes("Use Bash"), lunaSent.instructions.slice(0, 160));
		forgetChildSeat(CODEX_CHILD_ID);
	}

	parentWire.get("session_shutdown")({}, sessionCtx(PARENT_ID, { id: PARENT_ID }));
	const afterParentGone = promptBlockOf(childWire.get("before_provider_request")({ payload }, childCtx));
	check("live: a child spawned after its parent shut down still owns its text", !afterParentGone.includes("Pi documentation"));
	forgetChildSeat(CHILD_ID);

	// The capture belongs to the seat, not to a module instance. A reload replaces
	// every instance while the conversation goes on, and a seat that lost its
	// options there would refuse the next turn that starts without a user message.
	const { PROMPT_UNAVAILABLE: NO_PROMPT } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const RELOAD_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430aa";
	const reloadCtx = sessionCtx(RELOAD_ID, { id: RELOAD_ID });
	const before = await boot("reload-before");
	before.get("before_agent_start")({ systemPromptOptions: parentOptions }, reloadCtx);
	before.get("session_shutdown")({ reason: "reload" }, reloadCtx);
	const after = await boot("reload-after");
	check("live: a reload keeps the seat's prompt options", promptBlockOf(after.get("before_provider_request")({ payload }, reloadCtx)) === parentBlock);
	after.get("session_shutdown")({ reason: "quit" }, reloadCtx);
	const next = await boot("reload-gone");
	check("live: quitting drops them, and the next seat declares it has no prompt", promptBlockOf(next.get("before_provider_request")({ payload }, reloadCtx)) === NO_PROMPT);

	fs.rmSync(dir, { recursive: true, force: true });
}

fs.rmSync(TRACE_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log("watchdog");
{
	const W = await jiti.import(`${ROOT}/extensions/watchdog.ts`);

	/** Deterministic time. `advance` fires due timers in order, moving `now` to each. */
	const fakeClock = () => {
		let now = 0;
		const timers = [];
		return {
			now: () => now,
			schedule: (delayMs, fire) => {
				const timer = { at: now + delayMs, fire, dead: false };
				timers.push(timer);
				return () => { timer.dead = true; };
			},
			live: () => timers.filter((t) => !t.dead).length,
			advance(ms) {
				const target = now + ms;
				for (;;) {
					const due = timers.filter((t) => !t.dead && t.at <= target).sort((a, b) => a.at - b.at)[0];
					if (!due) break;
					due.dead = true;
					now = due.at;
					due.fire();
				}
				now = target;
			},
		};
	};

	// 900ms stands in for 15 minutes; warn lands at 300.
	const DEADLINE = 900;
	const build = (mode = "abort") => {
		const clock = fakeClock();
		const acted = [];
		const dog = new W.Watchdog({
			deadlineMs: DEADLINE, mode,
			now: clock.now, schedule: clock.schedule,
			act: (a) => acted.push(a),
		});
		return { clock, acted, dog };
	};

	// -- arming ---------------------------------------------------------------
	{
		const { clock, acted, dog } = build();
		check("idle holds no timer", dog.timerCount === 0 && clock.live() === 0);
		dog.start();
		check("running holds exactly one", dog.timerCount === 1);
		clock.advance(DEADLINE * 2);
		check("idle-armed session with no events aborts", acted.filter((a) => a.kind === "abort").length === 1, JSON.stringify(acted));
		check("and releases its timer", dog.timerCount === 0);
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.stop();
		clock.advance(DEADLINE * 3);
		check("stop() disarms — a finished agent is never aborted", acted.length === 0);
		check("and leaves no live timer", clock.live() === 0);
	}

	// -- the observed failure: a tool that starts and never ends ---------------
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("t1", "grep");
		clock.advance(DEADLINE - 1);
		// Warnings escalate rather than latch: they are custom entries, which pi
		// keeps out of LLM context, so the liveness trail is free.
		check("a hung tool warns before the deadline", acted.length > 0 && acted.every((a) => a.kind === "warn"), JSON.stringify(acted));
		check("and keeps warning as the silence grows", acted.length === 2 && acted[1].silentMs > acted[0].silentMs, JSON.stringify(acted));
		check("and names the tool", acted[0].toolName === "grep");
		clock.advance(2);
		const abort = acted.find((a) => a.kind === "abort");
		check("then aborts at the deadline", Boolean(abort));
		check("blaming the hung tool", abort.toolName === "grep");
		check("with the measured silence", abort.silentMs >= DEADLINE, String(abort?.silentMs));
		clock.advance(DEADLINE * 3);
		check("and aborts exactly once", acted.filter((a) => a.kind === "abort").length === 1);
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("t1", "grep");
		clock.advance(DEADLINE - 10);
		dog.toolEnd("t1");
		clock.advance(DEADLINE - 10);
		check("a tool that returns resets the clock", acted.every((a) => a.kind !== "abort"), JSON.stringify(acted));
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("slow", "web_search");
		dog.toolStart("fast", "read");
		clock.advance(DEADLINE - 100);
		dog.toolEnd("fast");
		clock.advance(DEADLINE - 100);
		check("a sibling finishing counts as progress for the batch", !acted.some((a) => a.kind === "abort"));
		clock.advance(200);
		check("but the batch still dies on the survivor", acted.at(-1).kind === "abort" && acted.at(-1).toolName === "web_search", JSON.stringify(acted.at(-1)));
	}

	// -- the latent failure: a stalled stream, no tool in flight ---------------
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.touch();
		clock.advance(DEADLINE + 1);
		const abort = acted.find((a) => a.kind === "abort");
		check("a stalled model stream aborts too", Boolean(abort));
		check("and is reported as stream silence, not a tool", abort.toolName === undefined);
		check("the reason says so", W.abortReason(abort, DEADLINE).includes("the model stream"));
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		for (let i = 0; i < 400; i++) { clock.advance(2); dog.touch(); }
		check("streaming deltas keep it alive", acted.length === 0);
		check("and never churn timers — one live, whatever the token rate", dog.timerCount === 1 && clock.live() === 1, String(clock.live()));
	}

	// -- waits this session does not own --------------------------------------
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("a1", "get_subagent_result");
		clock.advance(DEADLINE * 20);
		check("waiting on a child never aborts the parent", acted.length === 0, JSON.stringify(acted));
		dog.toolEnd("a1");
		clock.advance(DEADLINE + 1);
		check("but the deadline runs again once the wait returns", acted.some((a) => a.kind === "abort"));
	}
	for (const name of ["Agent", "SubagentWorkflow", "steer_subagent"]) {
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("x", name);
		clock.advance(DEADLINE * 5);
		check(`${name} is bounded elsewhere, not here`, acted.length === 0);
	}
	{
		// The kit's own bash defaults and clamps its timeout and moves a long
		// command to the background: a silent bash is a quiet command, not a wedge.
		const { clock, acted, dog } = build("warn");
		dog.start();
		dog.toolStart("x", "bash");
		clock.advance(DEADLINE * 5);
		check("bash is bounded by itself — no warning, no abort", acted.length === 0, JSON.stringify(acted));
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("wait", "get_subagent_result");
		dog.toolStart("hung", "grep");
		clock.advance(DEADLINE * 3);
		check("one exempt tool shields the whole batch", acted.length === 0, JSON.stringify(acted));
		dog.toolEnd("wait");
		clock.advance(DEADLINE + 1);
		check("and the hung sibling is blamed once the shield lifts", acted.at(-1).kind === "abort" && acted.at(-1).toolName === "grep");
	}

	// -- warn mode: a human is watching ---------------------------------------
	{
		const { clock, acted, dog } = build("warn");
		dog.start();
		dog.toolStart("t", "web_search");
		clock.advance(DEADLINE * 6);
		check("warn mode never aborts", acted.every((a) => a.kind === "warn"), JSON.stringify(acted.map((a) => a.kind)));
		check("and keeps saying it is still hung", acted.length >= 4, String(acted.length));
		check("each warning reports the growing silence", acted.at(-1).silentMs > acted[0].silentMs);
	}

	// -- what the reader is told ----------------------------------------------
	{
		check("humanMs: seconds under 90", W.humanMs(42_000) === "42s");
		check("humanMs: minutes above", W.humanMs(900_000) === "15m" && W.humanMs(2_552_421) === "43m");
		const reason = W.abortReason({ kind: "abort", toolName: "grep", silentMs: 902_000 }, 900_000);
		check("the abort reason names the watchdog", reason.startsWith("watchdog:"));
		check("names the tool", reason.includes("`grep`"));
		check("gives the silence and the deadline", reason.includes("15m"));
		check("warns the answer above it is partial", reason.includes("partial"));
		check("and points at the trigger", reason.includes("$HOME"));
		check("the warning is one line", !W.warnMessage({ kind: "warn", toolName: "grep", silentMs: 300_000 }, 900_000).includes("\n"));
		check("in abort mode it says when the abort comes", W.warnMessage({ kind: "warn", toolName: "grep", silentMs: 300_000 }, 900_000, "abort").includes("aborts at 15m"));
		check("in warn mode it names no deadline — none is coming — and says what to do", (() => { const m = W.warnMessage({ kind: "warn", toolName: undefined, silentMs: 1_200_000 }, 900_000, "warn"); return !m.includes("15m") && m.includes("Esc") && m.includes("model stream"); })());

		// Real oracle, not a copy of the pattern list: pi auto-retries an errored
		// turn whose text looks transient. A watchdog abort is the opposite of
		// transient — retrying re-runs the tool that hung. If pi-ai ever adds a
		// pattern this wording trips, this check is how we find out.
		const { isRetryableAssistantError } = await import("@earendil-works/pi-ai/compat");
		const retryable = (text) => isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: text });
		check("the oracle is live", retryable("connection error") === true && retryable("bad request") === false);
		check("a watchdog abort never reads as a transient error", retryable(reason) === false, reason);
		check("...whatever it is blaming", ["bash", "grep", "web_search", undefined].every((t) => !retryable(W.abortReason({ kind: "abort", toolName: t, silentMs: 900_000 }, 900_000))));
	}

	// -- configuration ---------------------------------------------------------
	{
		check("a TUI session warns — a human can see a hang and press Esc", W.resolveMode("tui", undefined) === "warn");
		check("an unattended session aborts", W.resolveMode("print", undefined) === "abort" && W.resolveMode("rpc", undefined) === "abort");
		check("PI_WATCHDOG_MODE overrides both ways", W.resolveMode("tui", "abort") === "abort" && W.resolveMode("print", "warn") === "warn");
		check("and can turn it off", W.resolveMode("print", "off") === "off");
		check("garbage in PI_WATCHDOG_MODE is ignored", W.resolveMode("print", "maybe") === "abort");
		// The deadline lives in `lib/`, not here: `session-mode` caps its keep-warm
		// pings against the same span, and a copied constant would let one drift.
		const { resolveDeadlineMs } = await jiti.import(`${ROOT}/lib/silence-deadline.ts`);
		check("default deadline is 15 minutes", resolveDeadlineMs(undefined) === 900_000);
		check("PI_WATCHDOG_MS overrides it", resolveDeadlineMs("60000") === 60_000);
		check("a nonsense deadline falls back", resolveDeadlineMs("soon") === 900_000 && resolveDeadlineMs("-5") === 900_000);
	}

	// -- wiring: the abort reaches the session and the parent ------------------
	{
		const wire = async (mode, env) => {
			const handlers = new Map();
			const entries = [];
			const notices = [];
			let aborts = 0;
			const renderers = new Map();
			const api = {
				on: (e, h) => handlers.set(e, h),
				appendEntry: (type, data) => entries.push({ type, data }),
				registerEntryRenderer: (type, render) => renderers.set(type, render),
			};
			let idle = false;
			const c = { mode, isIdle: () => idle, abort: () => { aborts++; }, ui: { notify: (m, l) => notices.push([m, l]) } };
			const setIdle = (v) => { idle = v; };
			const saved = { ...process.env };
			Object.assign(process.env, env);
			try {
				const mod = await jiti.import(`${ROOT}/extensions/watchdog.ts?${mode}${JSON.stringify(env)}`);
				mod.default(api);
			} finally {
				for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
			}
			return { handlers, entries, notices, renderers, c, setIdle, aborts: () => aborts };
		};

		const w = await wire("print", { PI_WATCHDOG_MS: "40" });
		check("the extension binds the events that mean liveness",
			["agent_start", "agent_settled", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].every((e) => w.handlers.has(e)),
			[...w.handlers.keys()].join(","));

		w.handlers.get("agent_start")({}, w.c);
		w.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, w.c);
		await new Promise((r) => setTimeout(r, 120));
		check("a real hung tool aborts its own session", w.aborts() === 1, String(w.aborts()));
		check("and records why, where the abort cannot erase it", w.entries.some((e) => e.type === "watchdog" && e.data.text.includes("grep")), JSON.stringify(w.entries));

		// The entry has to survive rendering: a throwing renderer is only found the
		// day something goes wrong, which is the day it must not.
		const render = w.renderers.get("watchdog");
		const theme = { fg: (_c, s) => s };
		const drawn = render({ type: "custom", customType: "watchdog", data: w.entries[0].data }, {}, theme);
		check("the recorded entry renders", typeof drawn?.render === "function", String(drawn));
		check("and survives an entry with no data", typeof render({ type: "custom", customType: "watchdog" }, {}, theme)?.render === "function");

		// The parent reads finalTurnError -> errorMessage. Rewrite it or it says
		// "This operation was aborted", which names neither cause nor culprit.
		const aborted = { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" };
		const rewritten = w.handlers.get("message_end")({ message: aborted }, w.c);
		check("the aborted turn's error names the watchdog", rewritten?.message.errorMessage.startsWith("watchdog:"), JSON.stringify(rewritten));
		check("and keeps the role, or pi drops the replacement", rewritten.message.role === "assistant");
		check("leaving the rest of the message intact", rewritten.message.stopReason === "error" && Array.isArray(rewritten.message.content));
		check("the reason is consumed once", w.handlers.get("message_end")({ message: { ...aborted } }, w.c) === undefined);

		// The shape that would otherwise settle the child as "completed": a parent
		// reports a failure only for stopReason "error".
		const w2 = await wire("print", { PI_WATCHDOG_MS: "40" });
		w2.handlers.get("agent_start")({}, w2.c);
		w2.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, w2.c);
		await new Promise((r) => setTimeout(r, 120));
		const softAbort = w2.handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted" } }, w2.c);
		check("a stopReason:aborted turn is caught too", softAbort?.message.errorMessage.startsWith("watchdog:"), JSON.stringify(softAbort));
		check("and normalised to error, or the parent reads it as completed", softAbort.message.stopReason === "error");
		check("isFailedAssistant covers both shapes and nothing else",
			W.isFailedAssistant({ role: "assistant", stopReason: "error" })
			&& W.isFailedAssistant({ role: "assistant", stopReason: "aborted" })
			&& !W.isFailedAssistant({ role: "assistant", stopReason: "stop" })
			&& !W.isFailedAssistant({ role: "user", stopReason: "error" })
			&& !W.isFailedAssistant(null) && !W.isFailedAssistant(undefined));

		const clean = await wire("print", { PI_WATCHDOG_MS: "40" });
		clean.handlers.get("agent_start")({}, clean.c);
		check("a healthy turn's message is never rewritten", clean.handlers.get("message_end")({ message: { role: "assistant", stopReason: "stop" } }, clean.c) === undefined);
		check("nor an unrelated provider error", clean.handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } }, clean.c) === undefined);
		check("nor a human pressing Esc", clean.handlers.get("message_end")({ message: { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" } }, clean.c) === undefined);
		clean.handlers.get("agent_settled")({}, clean.c);
		await new Promise((r) => setTimeout(r, 120));
		check("a settled turn is never aborted after the fact", clean.aborts() === 0);

		// agent_end fires once per agent run, and a retry produces several inside
		// one turn. Disarming on it would leave the retried turn unwatched.
		const retried = await wire("print", { PI_WATCHDOG_MS: "40" });
		retried.handlers.get("agent_start")({}, retried.c);
		retried.handlers.get("agent_end")({ messages: [] }, retried.c);
		retried.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, retried.c);
		await new Promise((r) => setTimeout(r, 120));
		check("a retried turn stays watched past agent_end", retried.aborts() === 1, String(retried.aborts()));

		// Belt and braces for a settle event that never arrives: isIdle() is the
		// real bit, so a quietly-finished run is disarmed, not aborted.
		const lost = await wire("print", { PI_WATCHDOG_MS: "40" });
		lost.handlers.get("agent_start")({}, lost.c);
		lost.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, lost.c);
		lost.setIdle(true);
		await new Promise((r) => setTimeout(r, 150));
		check("an idle session is never aborted, even if its settle went missing", lost.aborts() === 0 && lost.entries.length === 0, JSON.stringify(lost.entries));

		const tui = await wire("tui", { PI_WATCHDOG_MS: "40" });
		tui.handlers.get("agent_start")({}, tui.c);
		tui.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, tui.c);
		await new Promise((r) => setTimeout(r, 150));
		check("a TUI session is told, not killed", tui.aborts() === 0 && tui.notices.length > 0, `${tui.aborts()} aborts, ${tui.notices.length} notices`);
		check("the notice is a warning", tui.notices.every(([, level]) => level === "warning"));
		check("told once per warning — the toast, with no transcript entry doubling it", tui.entries.length === 0, JSON.stringify(tui.entries));
		check("and the toast names no deadline", tui.notices.every(([m]) => !m.includes("deadline")), JSON.stringify(tui.notices));

		const off = await wire("print", { PI_WATCHDOG_MODE: "off", PI_WATCHDOG_MS: "40" });
		off.handlers.get("agent_start")({}, off.c);
		off.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, off.c);
		await new Promise((r) => setTimeout(r, 120));
		check("off means off — no timer, no abort, no entry", off.aborts() === 0 && off.entries.length === 0);
	}
}

// ---------------------------------------------------------------------------
// Two numbers, two meanings. `passed`/`failed` are the verdict; `skipped` names
// the checks whose oracle is absent on this machine, printed separately so the
// *count* of checks this suite contains stays a property of the code rather
// than of the machine it ran on.
console.log(`\n${pass} passed, ${fail} failed`);
if (skipped.length > 0) console.log(`${skipped.length} skipped\n  ${skipped.join("\n  ")}`);
process.exit(fail ? 1 : 0);
