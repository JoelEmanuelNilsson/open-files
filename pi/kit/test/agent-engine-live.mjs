/**
 * The owned agent engine on a real model: the clause of ticket 19 that no
 * scripted provider can prove.
 *
 *   `SendMessage` to a finished agent resumes it, on a real model, with its
 *   context intact: the resumed run's request carries the first run's
 *   conversation, and the agent answers the second question.
 *
 * `extensions/wire.ts` loads in the parent and in every child because auth
 * here is OAuth and a request without its attribution block dies on the
 * billing wall. Everything else of the kit stays out, so what is measured is
 * the engine's bytes and pi's.
 *
 * Network, and money: three or four calls, a few cents. The trailer prints
 * what the run cost. With no Anthropic credentials the scenario skips by name.
 *
 *   node test/agent-engine-live.mjs
 */

import "./env.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const ROOT = path.resolve(import.meta.dirname, "..");

const TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-engine-live-trace-"));
process.env.PI_WIRE_TRACE_DIR = TRACE_DIR;
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-engine-live-sessions-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SESSION_DIR;
process.env.PI_AGENT_CHILD_EXTENSIONS = `${ROOT}/extensions/agent-engine.ts:${ROOT}/extensions/wire.ts`;

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await import(`${PI}/dist/index.js`);

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
	fs.rmSync(TRACE_DIR, { recursive: true, force: true });
	fs.rmSync(SESSION_DIR, { recursive: true, force: true });
	console.log(`\ncost $${spent.toFixed(4)}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s wall clock`);
	console.log(`\n${pass} passed, ${fail} failed`);
	if (skipped.length > 0) console.log(`${skipped.length} skipped\n  ${skipped.join("\n  ")}`);
	process.exit(fail ? 1 : 0);
};

const SCENARIOS = ["scenario 1: SendMessage resumes a finished agent"];

const modelRuntime = await ModelRuntime.create({});
const sonnet = modelRuntime.getModel("anthropic", "claude-sonnet-5");
if (!modelRuntime.hasConfiguredAuth("anthropic") || !sonnet) {
	console.log("agent-engine-live: no Anthropic credentials on this machine");
	for (const name of SCENARIOS) skip(name);
	trailer();
}

const usageOf = (message) => message?.usage ?? {};
const assistantsIn = (sessionFile) =>
	SessionManager.open(sessionFile)
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
		.map((entry) => entry.message);
const spend = (messages) => {
	for (const message of messages) spent += usageOf(message).cost?.total ?? 0;
};
async function liveSeat() {
	const loader = new DefaultResourceLoader({
		cwd: ROOT,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [`${ROOT}/extensions/agent-engine.ts`, `${ROOT}/extensions/wire.ts`],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: ROOT,
		model: sonnet,
		thinkingLevel: "medium",
		noTools: "builtin",
		resourceLoader: loader,
		sessionManager: SessionManager.create(ROOT, SESSION_DIR),
		modelRuntime,
	});
	await session.bindExtensions({ mode: "print" });
	return session;
}

const records = (session) => session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data);

// ---------------------------------------------------------------------------
// scenario 1: a finished agent, resumed by name, on a real model
// ---------------------------------------------------------------------------
{
	console.log(`\n${SCENARIOS[0]}`);
	const session = await liveSeat();
	const tool = (name) => session.getToolDefinition(name);
	const spawnResult = await tool("Agent").execute("t1", { description: "remember a word", prompt: "The secret word is PELICAN. Reply with the single word OK.", name: "keeper" }, undefined, undefined, undefined);
	check("Agent started keeper in the background", /Name: keeper/.test(spawnResult.content[0].text));
	const first = await tool("TaskOutput").execute("t2", { names: ["keeper"] }, undefined, undefined, undefined);
	check("TaskOutput returned its reply", /<result>[\s\S]*OK/.test(first.content[0].text), first.content[0].text.slice(0, 200));
	const keeper = () => records(session).filter((r) => r.name === "keeper").at(-1);
	check("keeper is completed", keeper()?.status === "completed");
	const sent = await tool("SendMessage").execute("t3", { to: "keeper", message: "What was the secret word? Reply with just the word." }, undefined, undefined, undefined);
	check("SendMessage to the finished agent resumed it", /^keeper resumed from its transcript/.test(sent.content[0].text), sent.content[0].text);
	const second = await tool("TaskOutput").execute("t4", { names: ["keeper"] }, undefined, undefined, undefined);
	check("the resumed run answered from its own earlier context", /PELICAN/.test(second.content[0].text), second.content[0].text.slice(0, 300));
	const record = keeper();
	if (record?.sessionFile) {
		const assistants = assistantsIn(record.sessionFile);
		spend(assistants);
		check("one transcript, two runs: the second request read the first's prefix", assistants.length >= 2 && (usageOf(assistants.at(-1)).cacheRead ?? 0) > 0, JSON.stringify(assistants.map(usageOf)));
	}
	session.dispose();
}

trailer();
