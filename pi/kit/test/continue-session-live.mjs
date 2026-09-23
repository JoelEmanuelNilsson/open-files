/**
 * Handoff v2 on a real model: the clause only Anthropic can prove.
 *
 * Ticket 11 step 7: the continuation's first request reads the system+tools
 * prefix the old session cached (`cache_read > 0`, `cache_creation` ≈ the
 * first message only). That is the guarantee behind map C13's "a handoff
 * must never break a cache", and no scripted provider can vouch for it.
 *
 * The file exists for the same reason `handoff-live.mjs` did: two bugs left
 * the old extension silently dead for months while a hand-built stand-in
 * stayed green. So the whole path runs through pi — pi's own
 * `AgentSessionRuntime` (what `pi` itself runs a seat under, and the only
 * thing that makes `ctx.newSession` real), pi's loader reading the extension
 * files off disk, a real `# Handoff` reply from a real model, the real
 * switch, and the real usage the provider reports on the new session's first
 * request.
 *
 * Loaded: `continue-session.ts` (under test), `agent-engine.ts` (a real
 * tools array — the prefix has to include tools to prove tools are read
 * back), and `wire.ts` (the owned system prompt, and the billing block
 * without which an OAuth request dies on the 400 wall). Sessions are
 * persisted under a temp dir so the switch has files to link and nothing
 * lands in `~/.pi/agent/sessions/`.
 *
 * Three real requests, measured at a few cents. The trailer prints what the
 * run cost. Without Anthropic credentials every scenario skips by name.
 *
 *   node test/continue-session-live.mjs
 */

import "./env.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const ROOT = path.resolve(import.meta.dirname, "..");

const TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "continue-session-live-trace-"));
process.env.PI_WIRE_TRACE_DIR = TRACE_DIR;
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "continue-session-live-sessions-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SESSION_DIR;
delete process.env.PI_HANDOFF_THRESHOLDS;

const { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await import(`${PI}/dist/index.js`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const skipped = [];
const skip = (name) => { skipped.push(name); console.log(`  skip ${name}`); };
let spent = 0;
const startedAt = Date.now();
const trailer = () => {
	// The temp dirs go only on a green run. This file's one failure mode so far
	// is a turn that never came back, and the wire trace is the only record of
	// what the provider did with it — deleting it on the way out left a red run
	// that could not be read afterwards (2026-09-21).
	if (fail === 0) {
		fs.rmSync(TRACE_DIR, { recursive: true, force: true });
		fs.rmSync(SESSION_DIR, { recursive: true, force: true });
	} else {
		console.log(`\nkept for reading: wire trace ${TRACE_DIR}, sessions ${SESSION_DIR}`);
	}
	console.log(`\ncost $${spent.toFixed(4)}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s wall clock`);
	console.log(`\n${pass} passed, ${fail} failed`);
	if (skipped.length > 0) console.log(`${skipped.length} skipped\n  ${skipped.join("\n  ")}`);
	process.exit(fail ? 1 : 0);
};

const SCENARIOS = ["scenario 1: the continuation's first request reads the old session's system+tools prefix"];

const modelRuntime = await ModelRuntime.create({});
// claude-sonnet-5 by id rather than by family word: this file measures cache
// behaviour, so the model must not move when a newer sonnet ships.
const sonnet = modelRuntime.getModel("anthropic", "claude-sonnet-5");
if (!modelRuntime.hasConfiguredAuth("anthropic") || !sonnet) {
	console.log("continue-session-live: no Anthropic credentials on this machine");
	for (const name of SCENARIOS) skip(name);
	trailer();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, ms) {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await sleep(25);
	}
	return true;
}

/** A seat under pi's `AgentSessionRuntime`: a fresh loader per session, `ctx.newSession` real. */
async function liveSeat() {
	const log = [];
	const observer = (pi) => {
		pi.on("session_shutdown", (event, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			log.push({ reason: event.reason, file, bytes: file && fs.existsSync(file) ? fs.readFileSync(file) : undefined });
		});
	};
	const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [`${ROOT}/extensions/agent-engine.ts`, `${ROOT}/extensions/continue-session.ts`, `${ROOT}/extensions/wire.ts`],
			extensionFactories: [observer],
		});
		await loader.reload();
		const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, model: sonnet, thinkingLevel: "off", noTools: "builtin", resourceLoader: loader, sessionManager, modelRuntime, ...(sessionStartEvent ? { sessionStartEvent } : {}) });
		return { session, extensionsResult, services: { cwd, agentDir, modelRuntime, settingsManager: session.settingsManager, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: ROOT, agentDir: getAgentDir(), sessionManager: SessionManager.create(ROOT, SESSION_DIR) });
	const bind = (session) =>
		session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
			},
		});
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return { runtime, log };
}

const usageOf = (message) => message?.usage ?? {};
const assistants = (session) => session.messages.filter((m) => m.role === "assistant");
const textOf = (message) => (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");

// ---------------------------------------------------------------------------
console.log(SCENARIOS[0]);
{
	const seat = await liveSeat();
	const old = seat.runtime.session;
	const oldFile = old.sessionFile;
	// A nonce in the first message, so this run's message prefix is never a
	// previous run's cache entry; the system+tools prefix may well be warm from
	// another seat on this machine, which is exactly the entry under test.
	const nonce = Math.random().toString(36).slice(2, 10);
	const DOC = `# Handoff\n## Intent\nProbe ${nonce}: prove the continuation reads the cached prefix.\n## State\nOne turn done.\n## Next\nReply with the single word CONTINUED.\n## Map\n- none\n## Decisions\n- none\n## Open\n- none`;
	let error;
	try {
		// Worded as "Run <nonce>" it read as a task, and the model sometimes handed it to an `Agent` child: a third turn.
		await old.prompt(`Probe ${nonce} is a marker, not a task: use no tool. Reply with the single word OK and nothing else.`);
		await old.prompt(`Now hand off. Reply with exactly the following text, verbatim, nothing before or after it:\n\n${DOC}`);
	} catch (thrown) {
		error = thrown instanceof Error ? thrown.message : String(thrown);
	}
	const oldTurns = assistants(old);
	for (const m of oldTurns) spent += usageOf(m).cost?.total ?? 0;
	// Each turn as the model left it: its tool calls, or its first words.
	const turnsSaid = oldTurns.map((m) => (m.content ?? []).map((b) => (b.type === "toolCall" ? `${b.name}(${JSON.stringify(b.arguments).slice(0, 80)})` : b.type === "text" ? JSON.stringify(b.text.slice(0, 40)) : b.type)).join(" ")).join(" | ");
	// A tool call in turn 1 is the model delegating; a third turn without one is a result delivered into the seat.
	check("turn 1 answered without a tool", (oldTurns[0]?.content ?? []).every((b) => b.type !== "toolCall"), turnsSaid);
	check("two real turns reached the provider", error === undefined && oldTurns.length === 2 && (usageOf(oldTurns[0]).cacheRead ?? 0) + (usageOf(oldTurns[0]).cacheWrite ?? 0) > 0, error ?? `${oldTurns.length} turns: ${turnsSaid}; turn 1 usage ${JSON.stringify(usageOf(oldTurns[0]))}`);
	const reply = textOf(oldTurns[1]).trim();
	check("the model's reply is a handoff document (first line # Handoff)", reply.split("\n")[0]?.trim() === "# Handoff", reply.slice(0, 80));
	const switched = await until(() => seat.runtime.session !== old && seat.runtime.session.isIdle && assistants(seat.runtime.session).length >= 1, 60_000);
	const fresh = seat.runtime.session;
	const moved = switched && fresh !== old && fresh.sessionFile !== oldFile;
	check("the harness switched to a linked new session and its first turn ran", moved, `${seat.runtime.session === old ? "same session" : "switched"}, ${assistants(fresh).length} assistant messages`);
	const shutdown = seat.log[0];
	check("the old session file is byte-unchanged after the switch", shutdown?.bytes !== undefined && fs.readFileSync(oldFile).equals(shutdown.bytes), shutdown === undefined ? "no session_shutdown was recorded: the switch never ran" : "");
	const first = fresh.messages.find((m) => m.role === "user");
	check("the new session's first message is Continue session `<old file>`. + the model's own document", moved && first?.role === "user" && textOf(first).startsWith(`Continue session \`${oldFile}\`.\n\n# Handoff`), textOf(first).slice(0, 120));
	// Only the new session's turn, never `old`'s. On 2026-09-21 a run where the
	// switch never happened read `old`'s first turn here instead, and the three
	// cache checks below went green on a message they were not written about —
	// a red run reporting the wrong four failures. A check that falls back to a
	// stand-in is not measuring anything.
	const continuation = moved ? assistants(fresh)[0] : undefined;
	const measurable = continuation === undefined ? "no switch: there is no continuation turn to measure" : "";
	spent += usageOf(continuation).cost?.total ?? 0;
	const u = usageOf(continuation);
	const oldPrefix = (usageOf(oldTurns[1]).cacheRead ?? 0) + (usageOf(oldTurns[1]).cacheWrite ?? 0);
	// Sonnet 5's minimum cacheable prefix is 1,024 tokens (ticket 02); the owned
	// system prompt plus five tool schemas is well past it. A read of at least
	// that is the system+tools entry; a read of zero is a broken prefix.
	check(`the first request read the cached prefix (system + tools): cacheRead ${u.cacheRead} ≥ 1,024`, (u.cacheRead ?? 0) >= 1024, measurable || JSON.stringify(u));
	check(`and wrote only the first message: cacheWrite ${u.cacheWrite} + input ${u.input} under 1,500 tokens`, continuation !== undefined && (u.cacheWrite ?? 0) + (u.input ?? 0) < 1500, measurable || JSON.stringify(u));
	check("the read is shorter than the old context: messages started fresh", continuation !== undefined && (u.cacheRead ?? 0) < oldPrefix, measurable || `read ${u.cacheRead}, old context ${oldPrefix}`);
	check("the model answered from the document", /CONTINUED/i.test(textOf(continuation)), measurable || textOf(continuation).slice(0, 80));
	fresh.dispose();
}

trailer();
