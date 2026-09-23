/**
 * The owned agent engine, offline.
 *
 * Every session here is a real pi `AgentSession` driven by a scripted
 * provider — `pi.registerProvider` with a `streamSimple` that replays a
 * script of assistant messages — so the loop that spawns, waits, resumes and
 * stops is pi's own, and nothing is stubbed between the tool the model calls
 * and the child session that answers. What the scripted provider records is
 * the `Context` pi-ai was handed: system, tools and messages.
 *
 * The parts with no session in them — reading types off disk, rendering the
 * tool text, the registry's latest-wins rule, the wait's early return — are
 * pinned through their own exports first, because a scripted session proves
 * the wiring and hides the arithmetic.
 *
 * The live half — a finished agent resumed by a real model — is
 * `agent-engine-live.mjs`.
 */

import "./env.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

// A private agent dir: the type files under test, no auth, no real sessions
// dir polluted. Set before pi loads anything that reads it.
const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-engine-home-"));
fs.mkdirSync(path.join(AGENT_DIR, "agents"));
fs.writeFileSync(path.join(AGENT_DIR, "agents", "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "agents", "lead.md"), "---\nname: lead\ndescription: Coordinates a chunk end to end.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "agents", "explore.md"), "---\nname: explore\ndescription: Find things.\n---\nYou are an explorer. Paths and lines, not prose.\n");
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(AGENT_DIR, "sessions");
// Children under test load the engine and nothing else.
process.env.PI_AGENT_CHILD_EXTENSIONS = `${ROOT}/extensions/agent-engine.ts`;

const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await import(`${PI}/dist/index.js`);
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const trailer = () => {
	fs.rmSync(AGENT_DIR, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
};

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

/**
 * One provider for the whole process, answering from a script keyed by the
 * last user text it sees, so a parent and every child it spawns share it and
 * each gets the lines written for it. `requests` records every `Context`
 * pi-ai was handed: system, tools and messages — the fork's whole contract.
 */
const script = new Map();
const requests = [];
const scriptFor = (userText, steps) => script.set(userText, [...steps]);
const lastUserText = (context) => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const t = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		// A drained notification rides after the prompt as a user message; the script keys on what Joel typed.
		if (t.includes("<task-notification>")) continue;
		return t;
	}
	return "";
};
const text = (t) => ({ type: "text", text: t });
const call = (name, args, id = `call_${Math.random().toString(16).slice(2, 8)}`) => ({ type: "toolCall", id, name, arguments: args });

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	// Like the real provider: an abort ends the stream at once with an aborted message.
	let aborted = false;
	options?.signal?.addEventListener("abort", () => {
		if (aborted) return;
		aborted = true;
		const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() };
		stream.push({ type: "error", reason: "aborted", error: { ...partial, errorMessage: "Request was aborted" } });
		stream.end();
	}, { once: true });
	requests.push({ model: model.id, reasoning: options?.reasoning, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), messages: context.messages });
	const key = [...script.keys()].filter((k) => lastUserText(context).includes(k)).sort((a, b) => b.length - a.length)[0];
	const steps = key === undefined ? undefined : script.get(key);
	const step = steps?.shift() ?? [text(`(no script for: ${lastUserText(context).slice(0, 60)})`)];
	const content = Array.isArray(step) ? step : step.content;
	const delay = Array.isArray(step) ? 5 : step.delay;
	const stopReason = content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
	// Like a real provider, the billed total grows with the context, so the sum
	// over a run and the last message's own reading are visibly different — which
	// is the whole of issues/31 (d).
	const input = 10 * (context.messages.length + 1);
	const usage = { input, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: input + 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
	const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
	setTimeout(() => {
		if (aborted) return;
		stream.push({ type: "start", partial: { ...message, content: [] } });
		content.forEach((block, i) => {
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex: i, partial: message });
				stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: message });
				stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: message });
			} else {
				stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
				stream.push({ type: "toolcall_delta", contentIndex: i, delta: JSON.stringify(block.arguments), partial: message });
				stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message });
			}
		});
		stream.push({ type: "done", reason: stopReason, message });
		stream.end();
	}, delay);
	return stream;
}

const SCRIPTED_MODEL = { id: "scripted-1", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
const scriptedProvider = (pi) => {
	pi.registerProvider("scripted", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: [SCRIPTED_MODEL] });
};

const modelRuntime = await ModelRuntime.create({});

/**
 * A main seat with the engine loaded, on the scripted model. `events` records
 * every `subagents:*` emission; `custom` every custom message the seat's
 * conversation received; `tools` every tool result the model was handed.
 *
 * It keeps pi's built-in tools, like a real seat does, because the tools array
 * is what C4 is about: a main seat built without them would make "the child's
 * array equals the parent's" a comparison between two different harnesses.
 */
async function mainSeat({ persisted = true, extraExtensions = [], extraFactories = [], cwd = ROOT } = {}) {
	const events = [];
	const observer = (pi) => {
		for (const channel of ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed", "subagents:resumed"]) {
			pi.events.on(channel, (payload) => events.push({ channel, ...payload }));
		}
	};
	const bus = createEventBus();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		eventBus: bus,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [`${ROOT}/extensions/agent-engine.ts`, ...extraExtensions],
		extensionFactories: [scriptedProvider, observer, ...extraFactories],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		thinkingLevel: "off",
		resourceLoader: loader,
		sessionManager: persisted ? SessionManager.create(cwd) : SessionManager.inMemory(cwd),
		modelRuntime,
	});
	await session.bindExtensions({ mode: "print" });
	await session.setModel(modelRuntime.getModel("scripted", "scripted-1"));
	const toolResults = () => session.messages.filter((m) => m.role === "toolResult");
	const customs = () => session.messages.filter((m) => m.role === "custom");
	const tool = (name) => session.getToolDefinition(name);
	return { session, events, toolResults, customs, tool, bus };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Idle with nothing in flight, delivery included. A settle now opens a turn of
 * its own (ticket 09), so a test that prompts straight after one would be
 * prompting a busy seat.
 */
async function quiet(seat) {
	await until(() => seat.session.isStreaming, 300);
	await seat.session.waitForIdle();
}
/** Poll until `condition()` holds or `ms` elapses. */
async function until(condition, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await sleep(10);
	}
	return true;
}

// ---------------------------------------------------------------------------
// Agent types on disk
// ---------------------------------------------------------------------------
{
	const { parseAgentTypeFile, loadAgentTypes, renderAgentTypeList, AGENT_TYPE_LIST_OPEN } = await jiti.import(`${ROOT}/lib/agent-types.ts`);
	console.log("\nagent types on disk");
	const folded = parseAgentTypeFile(
		["---", "# a comment", "name: explore", "description: >-", "  Fast read-only search.", "  Paths and lines, not prose.", "tools: read, bash", "model: haiku", "effort: medium", "---", "", "You search.", ""].join("\n"),
		"/x/explore.md",
	);
	check("folded description joins with spaces", folded.description === "Fast read-only search. Paths and lines, not prose.", folded.description);
	check("effort is read as thinking", folded.thinking === "medium");
	check("model is read", folded.model === "haiku");
	check("body is the prompt, trimmed", folded.prompt === "You search.");
	check("tools key is ignored (C4)", !("tools" in folded));
	const thinking = parseAgentTypeFile("---\nname: lead\nthinking: medium\n---\nOwn it.", "/x/lead.md");
	check("pi's thinking key works too", thinking.thinking === "medium" && thinking.prompt === "Own it.");
	check("no body is an empty prompt", parseAgentTypeFile("---\nname: worker\ndescription: One job.\n---\n", "/x/w.md").prompt === "");
	check("enabled: false disables the type", parseAgentTypeFile("---\nenabled: false\n---\nnope", "/x/plan.md") === undefined);
	check("no name is a problem, not a type", parseAgentTypeFile("---\ndescription: x\n---\n", "/x/anon.md").reason === "frontmatter has no name");
	check("no frontmatter is a problem", parseAgentTypeFile("just prose", "/x/p.md").reason === "no frontmatter block");
	// Ticket 29 §4: a level that does not exist is a problem the seat can see,
	// not a silent `undefined` that quietly takes pi's default.
	check("a level outside low..max is a problem, naming the ones that exist", parseAgentTypeFile("---\nname: a\nthinking: enormous\n---\n", "/x/a.md").reason === 'thinking: "enormous" — only "low", "medium", "high", "xhigh", "max" exist');
	check("off and minimal are not agent levels", ["off", "minimal"].every((level) => parseAgentTypeFile(`---\nname: a\nthinking: ${level}\n---\n`, "/x/a.md").reason !== undefined));
	// Every level, low to max, on any model: what a model lacks is clamped at spawn, not refused here.
	for (const model of ["model: opus", "model: luna", ""]) {
		for (const level of ["low", "medium", "high", "xhigh", "max"]) {
			check(`${level} parses on ${model || "an inherited model"}`, parseAgentTypeFile(`---\nname: a\n${model}\nthinking: ${level}\n---\n`, "/x/a.md").thinking === level);
		}
	}
	check("quoted scalars are unquoted", parseAgentTypeFile('---\nname: "quoted name"\n---\n', "/x/q.md").name === "quoted name");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-types-"));
	fs.writeFileSync(path.join(dir, "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
	fs.writeFileSync(path.join(dir, "explore.md"), "---\nname: explore\ndescription: Find things.\nmodel: haiku\nthinking: medium\n---\nSearch.\n");
	fs.writeFileSync(path.join(dir, "Plan.md"), "---\nenabled: false\n---\n");
	fs.writeFileSync(path.join(dir, "broken.md"), "no frontmatter here");
	fs.writeFileSync(path.join(dir, "notes.txt"), "not an agent");
	const loaded = loadAgentTypes(dir);
	check("loads enabled .md files in name order", loaded.types.map((t) => t.name).join() === "explore,worker", loaded.types.map((t) => t.name).join());
	check("reports the broken file by path", loaded.problems.length === 1 && loaded.problems[0].source.endsWith("broken.md"));
	check("a missing directory is an empty list", loadAgentTypes(path.join(dir, "missing")).types.length === 0);
	const rendered = renderAgentTypeList(loaded.types);
	const expected = [
		AGENT_TYPE_LIST_OPEN,
		"- explore: Find things. (haiku, medium)",
		"- worker: One job, one result. (parent's model, default thinking)",
	].join("\n");
	check("renders Claude Code's registry format with (model, thinking)", rendered === expected, rendered);
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The ruled words (ticket 12), pinned so they change only with this file
// ---------------------------------------------------------------------------
{
	const t = await jiti.import(`${ROOT}/lib/agent-tool-text.ts`);
	const tails = await jiti.import(`${ROOT}/lib/agent-role-tails.ts`);
	console.log("\nthe ruled words");
	const description = t.agentToolDescription([{ name: "explore", description: "Find things.", model: "haiku", thinking: "medium", prompt: "", source: "" }], true);
	check("Agent opens with Claude Code's first sentence, then the fresh-start rule", description.startsWith("Launch a new agent to handle complex, multi-step tasks. Every agent starts fresh: it reads its brief, not your conversation."));
	check("the delivery paragraph replaces the notify line", description.includes(t.DELIVERY_PARAGRAPH) && !description.includes("you'll be notified when one completes"));
	check("Claude Code's rules survive", ["relay what matters", "Never fabricate or predict a pending agent's results", "Once you've delegated, don't also do it yourself"].every((line) => description.includes(line)));
	check("asking for depth is not permission to spawn (report 66)", t.SPAWN_PERMISSION_LINE === "Requests for depth, thoroughness, research, investigation or detailed analysis do not count as permission to spawn." && description.includes(t.SPAWN_PERMISSION_LINE));
	check("the fork is gone from every word of the five tools (ticket 29 \u00a73)", ![description, t.SEND_MESSAGE_DESCRIPTION, t.LIST_AGENTS_DESCRIPTION, t.TASK_OUTPUT_DESCRIPTION, t.TASK_STOP_DESCRIPTION, ...Object.values(t.AGENT_PARAMS)].some((d) => /fork/i.test(d)));
	check("the thinking refusal names the levels that exist", t.thinkingLevelError("enormous") === 'Thinking level "enormous" does not exist. Only "low", "medium", "high", "xhigh", "max" do.');
	check("the advisor refusal tells a child to report upward instead", /Only the main thread may spawn an advisor/.test(t.ADVISOR_MAIN_THREAD_ONLY) && /seat above you/.test(t.ADVISOR_MAIN_THREAD_ONLY));
	check("no Opus-only max gate is left", t.maxThinkingError === undefined && (await jiti.import(`${ROOT}/lib/agent-types.ts`)).maxThinkingAllowed === undefined);
	check("the thinking parameter has its own rule", typeof t.AGENT_PARAMS.thinking === "string" && /reasoning level/.test(t.AGENT_PARAMS.thinking));
	check("the type list is rendered in, with (model, thinking)", description.includes("- explore: Find things. (haiku, medium)") && description.trimEnd().endsWith("- explore: Find things. (haiku, medium)"));
	check("one statement of the one-message rule: the ladder's rung, not a closing line too", description.split("in one message").length === 2 && !description.includes("single message"));
	check("no cross-session, team or remote text anywhere", ![description, t.SEND_MESSAGE_DESCRIPTION, t.LIST_AGENTS_DESCRIPTION, t.TASK_STOP_DESCRIPTION].some((d) => /cross-session|teammate|Remote Control|cloud|@team/i.test(d)));
	// Ticket 09, ruled: `wake` is gone, and the four clauses of the rule that replaced it are the words the seat reads.
	check("the delivery paragraph is ticket 09's, and `wake` is not a parameter", t.DELIVERY_PARAGRAPH === "Agents run in the background and deliver their results to you in full, unasked — a worker or a lead the moment it lands, explorers together once the last of them has landed. Never fetch a delivered result; `TaskOutput` is only for blocking on an agent you need before you can continue." && t.WAKE_PARAM_DESCRIPTION === undefined && t.AGENT_PARAMS.wake === undefined);
	check("every delivered result closes with act-on-this-or-stop", t.DELIVERED_RESULT_INSTRUCTION === "Act on this or stop. Don't summarise it back, don't re-read what the child read, don't re-verify what it reports as verified. Ending your turn silently is allowed and expected.");
	check("the depth error is ticket 12's", t.DEPTH_LIMIT_ERROR === "Agent depth limit (4) reached. Do the task yourself.");
	check("TaskOutput is not deprecated and names the yield", !t.TASK_OUTPUT_DESCRIPTION.includes("DEPRECATED") && t.TASK_OUTPUT_DESCRIPTION.includes('("interrupted by Joel")'));
	// Every rule once, and never on a tool the reading seat might not carry: `edit`/`write` say nothing about delegating.
	check("no edit/write rule exists any more; the delegation line is on Agent", t.EDIT_WRITE_RULE === undefined && t.withEditWriteRule === undefined && description.includes(t.DELEGATION_LINE));
	check("the delegation line carries the why and the edit-job rule", t.DELEGATION_LINE.startsWith("Everything you read and every test output you see stays in this conversation forever") && t.DELEGATION_LINE.includes("any edit job that needs files read or tests run around it"));
	check("subagent_type prose defers to the schema enum", t.AGENT_PARAMS.subagent_type === "The agent type. Default: worker.");
	check("TaskOutput timeout: 10 minutes default, 2 hours max", t.TASK_OUTPUT_DEFAULT_TIMEOUT_MS === 600000 && t.TASK_OUTPUT_MAX_TIMEOUT_MS === 7200000);
	check("the model enum is opus and luna, nothing else", t.AGENT_MODEL_ALIASES.join() === "opus,luna");
	check("the model rule offers luna for routine work and read-only search, opus for the rest", /luna — routine, repetitive work and read-only search/.test(t.AGENT_MODEL_RULE) && /opus — everything else/.test(t.AGENT_MODEL_RULE) && !/haiku|sonnet/i.test(t.AGENT_MODEL_RULE));
	check("the model rule no longer restricts thinking", !/max/.test(t.AGENT_MODEL_RULE));
	check("the wait tools are Agent and TaskOutput", t.AGENT_WAIT_TOOL_NAMES.join() === "Agent,TaskOutput");
	const worker = tails.renderRoleTail({ role: "worker", name: "w1", depth: 2, liveCount: 3, files: { kind: "shared" } });
	check("the worker tail, verbatim", worker === "<sub_agent_context>\nYou are a **worker** named `w1`, depth 2 of 4. 3 agents are live. Your parent reads only your final reply \u2014 put everything that matters in it. Don't wait for or poll agents you didn't start.\nOnly your last message is delivered. Put the whole report in it. A message that refers to an earlier message \u2014 \"as above\", \"see the report\" \u2014 delivers nothing.\nYou share this directory with other agents. Edit only the files your job needs. Never revert or reformat someone else's change. If you must touch a file outside your job, say so in your report.\n</sub_agent_context>", worker);
	const lead = tails.renderRoleTail({ role: "lead", name: "boss", depth: 1, liveCount: 1, files: { kind: "worktree", branch: "agent/boss", path: "/tmp/x" }, workflowChild: true });
	check("the lead tail adds the lead line, the worktree line, and the workflow-child line in order", lead.includes("You are a **lead** named `boss`") && lead.indexOf("Own this end to end. Delegate the work to your own workers; don't implement it yourself. Report to your parent once, when it's done.") < lead.indexOf("You work in your own copy of the repo on branch `agent/boss`. Commit there. Your report must name the branch and the files you changed.") && lead.endsWith("Your final message IS the return value of a function call in a program. Return raw data \u2014 no preamble, no summary of what you did.\n</sub_agent_context>"));
	check("the fork is gone from the role tails", tails.renderForkDirective === undefined && tails.FORK_DIRECTIVE === undefined);
	// Ticket 57: the child cannot read "your final reply" as "your final thought".
	check("a lead is told the same thing about its last message", lead.includes(tails.LAST_MESSAGE_LINE) && tails.LAST_MESSAGE_LINE.startsWith("Only your last message is delivered.") && tails.LAST_MESSAGE_LINE.endsWith("delivers nothing."), tails.LAST_MESSAGE_LINE);
}

// ---------------------------------------------------------------------------
// The registry fold: latest wins, owner-scoped, lost runs
// ---------------------------------------------------------------------------
{
	const { readAgentRegistry, AgentRegistry, AGENT_RECORD_ENTRY, resetAgentNameCounters } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	resetAgentNameCounters();
	console.log("\nthe registry");
	const rec = (over) => ({ name: "w", taskId: "a1", ownerSessionId: "me", type: "worker", description: "d", status: "queued", depth: 1, sessionFile: undefined, sessionId: "c", cwd: "/", branch: undefined, model: "m", result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, ...over });
	const entry = (data) => ({ type: "custom", customType: AGENT_RECORD_ENTRY, data });
	const read = readAgentRegistry([entry(rec()), entry(rec({ status: "running" })), entry(rec({ status: "completed", result: "done" })), entry(rec({ name: "other", ownerSessionId: "someone-else", status: "completed" })), entry(rec({ name: "cut", taskId: "a2", status: "running" })), { type: "message" }, entry({ junk: true })], "me");
	check("latest entry per name wins", read.get("w")?.status === "completed" && read.get("w").result === "done");
	check("another session's records are not mine", !read.has("other"));
	check("a run the process ended under reads as lost", read.get("cut")?.status === "lost");
	check("junk is skipped, not half-read", read.size === 2);
	const persisted = [];
	const registry = new AgentRegistry((r) => persisted.push(r), read.values());
	check("nextName counts per type", registry.nextName("worker") === "worker-1" && registry.nextName("w") === "w-1" && registry.nextName("cut") === "cut-1");
	// The 2026-09-03 collision: one counter per registry gave two seats on
	// different branches of the tree the same `worker-1`.
	const sibling = new AgentRegistry(() => {});
	check("a second registry in the process never reissues a name", sibling.nextName("worker") === "worker-2" && registry.nextName("worker") === "worker-3", `${sibling.nextName}`);
	sibling.put(rec({ name: "worker-9", taskId: "a9x" }));
	check("a name the caller chose is never auto-issued afterwards", registry.nextName("worker") === "worker-10");
	check("names read back from a session file raise the counter too", new AgentRegistry(() => {}, [rec({ name: "lead-4", taskId: "b1" })]).nextName("lead") === "lead-5");
	registry.put(rec({ name: "w", taskId: "a9", status: "queued" }));
	check("reusing a name starts a new run under it; the old run stays by task id", registry.byName("w").taskId === "a9" && registry.byTaskId("a1")?.status === "completed" && persisted.length === 1);
	check("live() lists queued and running only", registry.live().map((r) => r.name).join() === "w");
}

// ---------------------------------------------------------------------------
// Spawn a worker: background by default, result delivered the moment it lands
// ---------------------------------------------------------------------------
{
	console.log("\nspawn a worker");
	const seat = await mainSeat();
	scriptFor("start a worker", [[call("Agent", { description: "count files", prompt: "Count the files.", subagent_type: "worker", name: "counter" })], [text("started it")]]);
	scriptFor("Count the files.", [[text("There are 42 files.")]]);
	await seat.session.prompt("start a worker");
	await seat.session.waitForIdle();
	const launch = seat.toolResults()[0];
	check("Agent returns at once with the name and task id", launch !== undefined && /Name: counter\nTask ID: a[0-9a-f]{12}\n/.test(launch.content[0].text), launch?.content[0]?.text);
	check("the tool result's details are the rows' contract", launch?.details?.status === "background" && launch.details.subagentType === "worker" && launch.details.description === "count files" && typeof launch.details.agentId === "string", JSON.stringify(launch?.details));
	const settled = await until(() => seat.events.some((e) => e.channel === "subagents:completed"));
	check("the child ran to completion in the background", settled);
	const [created, started, completed] = seat.events;
	check("events: created, started, completed — same id, type, description", created?.channel === "subagents:created" && started?.channel === "subagents:started" && completed?.channel === "subagents:completed" && created.id === completed.id && created.type === "worker" && created.description === "count files", JSON.stringify(seat.events.map((e) => e.channel)));
	check("completed carries the whole result, a status field and usage.cost.total", completed?.result === "There are 42 files." && completed.status === "completed" && typeof completed.usage?.cost?.total === "number");
	// Ticket 09, ruled 2026-09-04: a worker's result needs a decision, so it does
	// not sit in the dock waiting for Joel to type — it opens a turn of its own.
	const delivered = await until(() => seat.customs().length > 0, 5000);
	await seat.session.waitForIdle();
	const notice = seat.customs()[0];
	check("a worker delivers on its own the moment it lands, with no prompt from Joel", delivered && notice?.customType === "subagent-notification" && notice.content.includes("<task-notification>") && notice.content.includes("<result>There are 42 files.</result>"), notice?.content?.slice(0, 200));
	check("its details are the rows' notice shape", notice?.details?.status === "completed" && notice.details.description === "count files" && notice.details.resultPreview === "There are 42 files.");
	check("and it closes with the act-on-this-or-stop line", notice?.content.trimEnd().endsWith("Act on this or stop. Don't summarise it back, don't re-read what the child read, don't re-verify what it reports as verified. Ending your turn silently is allowed and expected."), notice?.content?.slice(-120));
	check("the model was handed it in a turn Joel did not start", requests.some((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("<task-notification>"))));
	const childRequest = requests.find((r) => lastUserText({ messages: r.messages }).includes("Count the files."));
	check("the child's first user message opens with the worker tail", childRequest !== undefined && lastUserText({ messages: childRequest.messages }).startsWith("<sub_agent_context>\nYou are a **worker** named `counter`, depth 1 of 4. 1 agents are live."), childRequest && lastUserText({ messages: childRequest.messages }).slice(0, 120));
	check("and carries the shared-directory line", childRequest !== undefined && lastUserText({ messages: childRequest.messages }).includes("You share this directory with other agents."));
	check("the child holds the same five tools", childRequest !== undefined && ["Agent", "SendMessage", "ListAgents", "TaskOutput", "TaskStop"].every((n) => childRequest.tools.some((t) => t.name === n)));
	// C4, the whole of it: the tools array is the front of the cache key, so a
	// child that differs by one description writes its own tools+system entry
	// instead of reading its parent's. Byte-identical, not merely overlapping.
	const parentRequest = requests.find((r) => lastUserText({ messages: r.messages }) === "start a worker");
	check("the child's tools array is byte-identical to the parent's (C4)", parentRequest !== undefined && childRequest !== undefined && JSON.stringify(childRequest.tools) === JSON.stringify(parentRequest.tools), (() => {
		const a = JSON.stringify(parentRequest?.tools ?? []);
		const b = JSON.stringify(childRequest?.tools ?? []);
		let i = 0;
		while (i < a.length && a[i] === b[i]) i++;
		return `parent [${(parentRequest?.tools ?? []).map((t) => t.name).join()}] child [${(childRequest?.tools ?? []).map((t) => t.name).join()}] diverges at ${i}`;
	})());

	// Delivered once (C7): a later turn finds nothing left to drain.
	scriptFor("what did it say", [[text("42 files.")]]);
	await seat.session.prompt("what did it say");
	await seat.session.waitForIdle();
	check("a result already delivered is not delivered again by the next turn", seat.customs().length === 1, String(seat.customs().length));
	const entries = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record");
	check("the registry is in the session file, latest status last", entries.length >= 3 && entries[entries.length - 1].data.status === "completed" && entries[entries.length - 1].data.readBy === "conversation", entries.map((e) => e.data.status).join());
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// The four lifecycle payloads the dock reads
//
// `agent-dock` and `agent-rows` were written against these keys (C1). The
// model is one of them: without it the dock's model column is blank, which is
// exactly what a reader saw after the vendor lookup it used to come from was
// deleted. A key more or a key fewer here is a contract change nobody asked for.
// ---------------------------------------------------------------------------
{
	console.log("\nthe lifecycle payloads the dock reads");
	const seat = await mainSeat();
	scriptFor("watch it think", [[call("Agent", { description: "think slowly", prompt: "Think slowly.", subagent_type: "worker", name: "thinker" })], [text("started it")]]);
	scriptFor("Think slowly.", [{ content: [text("Done thinking.")], delay: 800 }]);
	await seat.session.prompt("watch it think");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:started"));
	const started = seat.events.find((e) => e.channel === "subagents:started");
	check("a started event names the model the child runs on — the dock's blank column", started.model === "scripted/scripted-1", started.model);
	check("with the name, type and description the registry holds", started.name === "thinker" && started.type === "worker" && started.description === "think slowly", JSON.stringify({ name: started.name, type: started.type, description: started.description }));

	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 8000);
	const done = seat.events.find((e) => e.channel === "subagents:completed");
	check("a settled event carries the duration the dock row prints instead of `done`", typeof done.durationMs === "number" && done.durationMs > 0, done.durationMs);
	check("it still names the model, so a settled row is not blank either", done.model === "scripted/scripted-1", done.model);
	check("and it charged for the run it watched", done.usage.cost.total > 0);

	const keysOf = (channel) => Object.keys(seat.events.find((e) => e.channel === channel)).filter((key) => key !== "channel").sort().join(",");
	const BASE = "description,durationMs,id,model,name,status,toolUses,type,usage,workflowChild".split(",").sort().join(",");
	check("subagents:created keeps its ten fields", keysOf("subagents:created") === BASE, keysOf("subagents:created"));
	check("subagents:started keeps the same ten", keysOf("subagents:started") === BASE, keysOf("subagents:started"));
	// Ticket 59: without this on the wire the dock cannot tell a workflow's agent
	// from one the seat launched, and a twenty-item run puts twenty-one rows in a
	// list of "agents this seat is waiting on".
	check("every payload says whether the agent belongs to a workflow", seat.events.every((e) => typeof e.workflowChild === "boolean"));
	check("and a plain `Agent` child says it does not", started.workflowChild === false, String(started.workflowChild));
	check("subagents:completed adds the result and nothing else", keysOf("subagents:completed") === `${BASE},result`.split(",").sort().join(","), keysOf("subagents:completed"));
	check("no payload ever grew an `outcome`: the dock reads `status`", seat.events.every((e) => e.outcome === undefined));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// What the dock can see of a child while it runs
//
// Joel, 2026-09-05: "I can only see that we say it is running." The two facts
// that fixes it are here: the seat publishes the child's live session, so the
// box can draw its tool calls and talk to it, and the run emits its tool count
// and the moment of its last step, which otherwise reach the record only when
// the child settles — a running row would count zero tools forever.
// ---------------------------------------------------------------------------
{
	console.log("\nthe live view of a running child");
	const { agentRuntimeOf } = await jiti.import(`${ROOT}/lib/agent-runtime-seam.ts`);
	const { AGENT_PROGRESS_CHANNEL } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const seat = await mainSeat();
	const progress = [];
	seat.bus.on(AGENT_PROGRESS_CHANNEL, (payload) => progress.push(payload));
	scriptFor("watch it work", [[call("Agent", { description: "grind away", prompt: "Grind away.", name: "grinder" })], [text("started it")]]);
	scriptFor("Grind away.", [{ delay: 200, content: [call("ListAgents", {})] }, { delay: 400, content: [text("Ground.")] }]);
	await seat.session.prompt("watch it work");
	await seat.session.waitForIdle();
	const runtime = agentRuntimeOf(seat.session.sessionManager.getSessionId());
	check("the seat publishes its runtime for the dock to read", runtime !== undefined);
	await until(() => seat.events.some((e) => e.channel === "subagents:started"));
	const taskId = seat.events.find((e) => e.channel === "subagents:started").id;
	const child = runtime?.liveRun(taskId);
	check("a running child hands over a live session", child !== undefined && typeof child.subscribe === "function" && typeof child.getToolDefinition === "function" && Array.isArray(child.messages), String(child === undefined));
	check("with the conversation the box draws from", child?.messages.some((m) => m.role === "user"), JSON.stringify(child?.messages.map((m) => m.role)));

	await until(() => progress.some((p) => p.toolUses > 0), 8000);
	const step = progress.find((p) => p.toolUses > 0);
	check("progress names the task and the agent the dock would send to", step?.id === taskId && step.name === "grinder", JSON.stringify(step));
	check("and carries the tool count the record does not have yet", step.toolUses === 1, JSON.stringify(step));
	check("with the moment of that step, so a row can say how stale it is", typeof step.lastActivityAt === "number" && Math.abs(Date.now() - step.lastActivityAt) < 60_000, String(step.lastActivityAt));
	const record = () => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === "grinder").map((e) => e.data).at(-1);
	check("which the record itself still says nothing about", record()?.toolUses === 0, String(record()?.toolUses));

	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 8000);
	check("the settled run is no longer live to the dock", runtime?.liveRun(taskId) === undefined);
	check("and the record has the count the progress events were tracking", record()?.toolUses === 1, String(record()?.toolUses));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// The wait board: settled, timeout, interrupted — with a fake clock
// ---------------------------------------------------------------------------
{
	const { boundReport, MAX_REPORT_CHARS } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	console.log("\nthe report a child hands back is bounded");
	const short = "done: fixed it\nfiles: a.ts\nverified: green";
	check("a report written to its shape is untouched", boundReport(short, "/s/child.jsonl") === short && boundReport(undefined, "/s/child.jsonl") === undefined);
	const runaway = boundReport("x".repeat(MAX_REPORT_CHARS * 3), "/s/child.jsonl");
	check("a runaway one is cut, so no single delivery can jump the handoff ladder's last gap", runaway.length < MAX_REPORT_CHARS + 300 && MAX_REPORT_CHARS === 20_000);
	check("and it says how much was cut and where the whole of it still is", runaway.includes(`${MAX_REPORT_CHARS * 3} characters`) && runaway.includes("`/s/child.jsonl`"));
	check("a child with no session file on disk still gets an honest pointer", boundReport("y".repeat(MAX_REPORT_CHARS + 1), undefined).includes("the agent's own session"));
}

// ---------------------------------------------------------------------------
{
	const { AgentWaitBoard, interruptedWaitText } = await jiti.import(`${ROOT}/lib/agent-wait.ts`);
	console.log("\nthe wait board");
	const timers = [];
	const clock = { setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } };
	const board = new AgentWaitBoard(clock);
	check("a condition already true returns without a timer", (await board.wait(() => true, 1000)).kind === "settled" && timers.length === 0);
	let done = false;
	const waiting = board.wait(() => done, 1000);
	check("a pending wait arms one timer", timers.length === 1 && board.size === 1);
	board.notify();
	check("notify with the condition still false keeps waiting", board.size === 1);
	done = true;
	board.notify();
	check("notify with the condition true settles it and clears the timer", (await waiting).kind === "settled" && timers.length === 0 && board.size === 0);
	const timing = board.wait(() => false, 500);
	timers[0].fn();
	check("the clock running out is a timeout", (await timing).kind === "timeout");
	const typed = board.wait(() => false, 500);
	board.interrupt("Joel");
	const outcome = await typed;
	check("Joel typing interrupts every wait, agents untouched", outcome.kind === "interrupted" && outcome.by === "Joel" && timers.length === 0);
	const controller = new AbortController();
	const aborted = board.wait(() => false, 500, controller.signal);
	controller.abort();
	check("an aborted turn ends the wait too", (await aborted).kind === "interrupted");
	check("the ruled wording", interruptedWaitText("Joel", 1, 3) === "interrupted by Joel — 1 of 3 done");
}

// ---------------------------------------------------------------------------
// TaskOutput: the explicit wait, the full reply once, and the yield to Joel
// ---------------------------------------------------------------------------
{
	console.log("\nTaskOutput");
	const seat = await mainSeat();
	scriptFor("start and wait", [
		[call("Agent", { description: "slow job", prompt: "Take your time.", name: "slow" })],
		[call("TaskOutput", { names: ["slow"] })],
		[text("got it")],
	]);
	scriptFor("Take your time.", [{ delay: 400, content: [text("Slow result, in full.")] }]);
	await seat.session.prompt("start and wait");
	await seat.session.waitForIdle();
	const [, waited] = seat.toolResults();
	check("TaskOutput blocks until the agent settles and returns the whole reply", waited?.content[0].text.includes("<result>Slow result, in full.</result>"), waited?.content[0]?.text?.slice(0, 200));
	check("its details are the notice shape, so the row can draw it", waited?.details?.status === "completed" && waited.details.name === "slow");
	check("delivered once: no notification is queued for the next turn as well", seat.customs().length === 0);

	scriptFor("wait again", [[call("TaskOutput", { names: ["slow"] })], [text("nothing new")]]);
	await seat.session.prompt("wait again");
	await seat.session.waitForIdle();
	const again = seat.toolResults()[2];
	// It says *how* it reached a reader and where the whole of it still is — never
	// that the conversation contains text the harness has not seen there.
	check("a reply already read is not returned again, and TaskOutput says by which path", again?.content[0].text.startsWith("Nothing unread.") && /\nslow · completed · returned to you by TaskOutput at \d\d:\d\d:\d\d \(\d+s ago\) · whole result: \S+\.jsonl$/.test(again?.content[0].text ?? ""), again?.content[0]?.text);
	check("the next turn carried no notification either", seat.customs().length === 0);

	scriptFor("check an unknown name", [[call("TaskOutput", { names: ["nobody"], block: false })], [text("ok")]]);
	await seat.session.prompt("check an unknown name");
	await seat.session.waitForIdle();
	check("an unknown name is named, not waited on", seat.toolResults()[3]?.content[0].text.startsWith("Unknown agents: nobody"));

	// Joel types while the seat is blocked in TaskOutput: the wait returns, the
	// child keeps running, and its result delivers itself when it lands.
	scriptFor("start and wait long", [
		[call("Agent", { description: "long job", prompt: "Take even longer.", name: "long" })],
		[call("TaskOutput", { names: ["long"] })],
		[text("carrying on")],
		[text("steered reply")],
	]);
	scriptFor("Take even longer.", [{ delay: 1500, content: [text("Long result.")] }]);
	const turn = seat.session.prompt("start and wait long");
	await until(() => seat.toolResults().length === 5 && seat.session.isStreaming, 3000);
	await sleep(50);
	const typedAt = Date.now();
	await seat.session.prompt("hello from Joel", { streamingBehavior: "steer" });
	await until(() => seat.toolResults().length === 6, 3000);
	const interrupted = seat.toolResults()[5];
	check("TaskOutput returns early when Joel types", interrupted?.content[0].text.startsWith("interrupted by Joel — 0 of 1 done") && Date.now() - typedAt < 1000, interrupted?.content[0]?.text);
	await turn;
	await seat.session.waitForIdle();
	check("Joel's message still reached the model as a steer", seat.session.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("hello from Joel")));
	check("the child kept running", seat.events.filter((e) => e.channel === "subagents:completed").length === 1 && seat.session.messages.every((m) => m.role !== "custom" || !m.content.includes("Long result.")));
	const arrived = await until(() => seat.customs().some((m) => m.content.includes("<result>Long result.</result>")), 5000);
	await seat.session.waitForIdle();
	check("and its result arrived on its own, with nobody typing", arrived, seat.customs().map((m) => m.content.slice(0, 60)).join(" | "));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A delivery must never eat the wait's result (the 2026-09-03 "Nothing to report")
// ---------------------------------------------------------------------------
{
	console.log("\nTaskOutput vs the delivery");
	const seat = await mainSeat();
	scriptFor("wait on a waker", [
		[call("Agent", { description: "waking job", prompt: "Wake me when done.", name: "waker" })],
		[call("TaskOutput", { names: ["waker"] })],
		[text("read it")],
	]);
	scriptFor("Wake me when done.", [{ delay: 400, content: [text("Waker result.")] }]);
	await seat.session.prompt("wait on a waker");
	await seat.session.waitForIdle();
	const waitedOnWaker = seat.toolResults()[1];
	check("a settle's result is returned by the TaskOutput that was waiting for it", waitedOnWaker?.content[0].text.includes("<result>Waker result.</result>"), waitedOnWaker?.content[0]?.text?.slice(0, 200));
	check("TaskOutput never reports nothing while a matching result is unread", !/Nothing to report/.test(waitedOnWaker?.content[0].text ?? ""), waitedOnWaker?.content[0]?.text?.slice(0, 200));
	check("and the settle did not also deliver it to the conversation (C7: once)", seat.customs().length === 0);

	// The same race with no names: the wait claims every name.
	scriptFor("wait on anything", [[call("Agent", { description: "second waking job", prompt: "Wake me too.", name: "waker2" })], [call("TaskOutput", {})], [text("read that too")]]);
	scriptFor("Wake me too.", [{ delay: 400, content: [text("Second waker result.")] }]);
	await seat.session.prompt("wait on anything");
	await seat.session.waitForIdle();
	const waitedOnAny = seat.toolResults().at(-1);
	check("a nameless TaskOutput gets the result the delivery would have taken", waitedOnAny?.content[0].text.includes("<result>Second waker result.</result>"), waitedOnAny?.content[0]?.text?.slice(0, 200));
	check("still delivered once", seat.customs().length === 0);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A result is marked read only where its text is handed back (C7)
//
// The 2026-09-03 shape was a result consumed by a path that never printed it:
// `TaskOutput` said nothing while `ListAgents` showed the completion. The
// registry no longer lets anyone set `readBy` — `update` keeps the value it
// found and `markRead` runs *after* the hand has taken the text — so the only
// way to consume a result is to deliver it.
// ---------------------------------------------------------------------------
{
	console.log("\ntaking a result reads it exactly once");
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const done = { name: "pin", taskId: "a1", ownerSessionId: "seat", type: "worker", description: "d", status: "completed", depth: 1, sessionFile: undefined, sessionId: "c", cwd: "/", branch: undefined, model: "m", result: "The whole reply.", error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: 2, toolCallId: undefined, workflowChild: false };
	const registry = new AgentRegistry(() => {}, [done]);
	const runtime = new AgentRuntime({ sessionId: "seat", role: "main" }, registry);
	check("registry.update cannot flip readBy — the value survives the change", registry.update("pin", { readBy: "conversation", status: "completed" })?.readBy === undefined);
	let thrown;
	try {
		runtime.takeUnread(["pin"], () => {
			throw new Error("the reader blew up");
		}, "tool");
	} catch (error) {
		thrown = error;
	}
	check("a hand that throws leaves the result unread — nothing is lost", thrown?.message === "the reader blew up" && registry.byName("pin").readBy === undefined);
	let handed;
	const batch = runtime.takeUnread(undefined, (notification) => {
		handed = notification.content;
	}, "tool");
	check("takeUnread records which path read it, not merely that something did", handed.includes("<result>The whole reply.</result>") && batch.content === handed && registry.byName("pin").readBy === "tool" && typeof registry.byName("pin").readAt === "number");
	check("and a second take finds nothing", runtime.takeUnread(["pin"], () => check("never handed twice", false), "tool") === undefined);
	// `handed` is the weakest claim and the only one that may be upgraded: a
	// result given to pi's queue becomes `conversation` when — and only when — the
	// harness has seen the message in the session file.
	const two = { ...done, name: "pin2", taskId: "a2" };
	const reg2 = new AgentRegistry(() => {}, [two]);
	reg2.markRead("pin2", "a2", "handed", 10);
	check("a handed result is not claimed to be in any conversation", reg2.byName("pin2").readBy === "handed");
	reg2.markRead("pin2", "a2", "conversation", 20);
	check("and becomes `conversation` only on the upgrade", reg2.byName("pin2").readBy === "conversation" && reg2.byName("pin2").readAt === 20);
	reg2.markRead("pin2", "a2", "handed", 30);
	check("never the other way round: the strongest claim made stands", reg2.byName("pin2").readBy === "conversation" && reg2.byName("pin2").readAt === 20);
}

// ---------------------------------------------------------------------------
// Who arrives when (ticket 09, ruled 2026-09-04)
//
// Driven through `publishSettled` with a stub host, because the rule is about
// *which* settles reach the seat and in what grouping — a scripted session
// would only prove the same decision through four seconds of real timing.
// ---------------------------------------------------------------------------
{
	console.log("\nwho arrives when");
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const record = (name, type, over = {}) => ({ name, taskId: `t-${name}`, ownerSessionId: "seat", type, description: `${name} job`, status: "running", depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: "/", branch: undefined, model: "m", result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, workflowChild: false, ...over });
	const delivered = [];
	const registry = new AgentRegistry(() => {});
	const runtime = new AgentRuntime({ sessionId: "seat", role: "main", emit: () => {}, deliver: (notification) => delivered.push(notification) }, registry);
	const settle = (name, type, result) => {
		registry.put(record(name, type, { status: "completed", result, completedAt: 2 }));
		runtime.publishSettled(registry.byName(name));
	};
	const explorers = ["e1", "e2", "e3", "e4"];
	for (const name of explorers) registry.put(record(name, "explore"));
	registry.put(record("w1", "worker"));
	settle("e1", "explore", "e1 found it.");
	settle("e2", "explore", "e2 found it.");
	check("an explorer holds while its siblings are still reading", delivered.length === 0, JSON.stringify(delivered.map((d) => d.details.name)));
	// A worker alongside them proves the batch is explorers-only: its result needs
	// a decision, so it must not queue behind reading material.
	settle("w1", "worker", "The worker's answer.");
	check("a worker delivers alone the moment it lands, live siblings or not", delivered.length === 1 && delivered[0].content.includes("<result>The worker's answer.</result>") && !delivered[0].content.includes("e1 found it."), delivered[0]?.content?.slice(0, 120));
	settle("e3", "explore", "e3 found it.");
	check("still nothing while the last explorer reads", delivered.length === 1);
	settle("e4", "explore", "e4 found it.");
	check("the last explorer to land brings all four, in one message", delivered.length === 2 && explorers.every((name) => delivered[1].content.includes(`<result>${name} found it.</result>`)) && delivered[1].content.startsWith("4 agents finished."), delivered[1]?.content?.slice(0, 120));
	check("one delivery carries the other three in its details, for the row", delivered[1]?.details.others?.length === 3, JSON.stringify(delivered[1]?.details.others?.map((d) => d.name)));
	// `handed`, not `conversation`: `deliver` gives the message to pi's queue and
	// gets nothing back, so this path may not claim the text has arrived anywhere.
	check("and every result was handed exactly once (C7)", registry.all().every((r) => r.readBy === "handed"), registry.all().filter((r) => r.readBy !== "handed").map((r) => `${r.name}:${r.readBy}`).join());
	check("the instruction rides both deliveries", delivered.every((d) => d.content.trimEnd().endsWith("Ending your turn silently is allowed and expected.")));
	// A run that died is a verdict like any other: it delivers once and is marked
	// read, so nothing downstream may hand it over a second time (issues/56).
	registry.put(record("dead", "worker", { status: "error", error: "it blew up", completedAt: 3 }));
	runtime.publishSettled(registry.byName("dead"));
	check("an errored run delivers its verdict once and is marked read, exactly like a completed one", delivered.length === 3 && delivered[2].content.includes("it blew up") && registry.byName("dead").readBy === "handed", `${delivered.length} · ${registry.byName("dead")?.readBy}`);
}

// ---------------------------------------------------------------------------
// 2026-09-23: a parked runtime reached the outgoing session's `pi` through its
// host (`host.emit` ← `publishProgress`, "extension ctx is stale"), and its held
// settle, delivered after rehost, started a turn ahead of the continuation.
// ---------------------------------------------------------------------------
{
	console.log("\na parked runtime cannot reach the session it left");
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const record = (name, over = {}) => ({ name, taskId: `t-${name}`, ownerSessionId: "old-seat", type: "worker", description: `${name} job`, status: "running", depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: "/", branch: undefined, model: "m", result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, workflowChild: false, ...over });
	const reachedDead = [];
	let dead = false;
	const touch = (what, value) => (...args) => {
		if (dead) {
			reachedDead.push(what);
			throw new Error("This extension ctx is stale");
		}
		return typeof value === "function" ? value(...args) : value;
	};
	const oldHost = { sessionId: "old-seat", role: "main", depth: 0, types: [], emit: touch("emit"), log: touch("log"), deliver: touch("deliver"), hasPendingInput: touch("hasPendingInput", true), model: touch("model"), resolveModel: touch("resolveModel"), exec: touch("exec"), childLoader: touch("childLoader"), persist: touch("persist") };
	const runtime = new AgentRuntime(oldHost, new AgentRegistry(touch("registry persist"), [record("w1"), record("w2")]));
	runtime.park();
	dead = true;
	runtime.host.emit("subagents:progress", {});
	runtime.host.log("said while parked", "info");
	const pending = runtime.host.hasPendingInput();
	let refusal = "";
	try { runtime.host.model(); } catch (error) { refusal = error.message; }
	runtime.registry.update("w1", { toolUses: 3 });
	// A run the handoff did not carry: its write while parked must not make the new session hold it.
	runtime.registry.put(record("w9"));
	runtime.publishSettled(runtime.registry.put({ ...runtime.registry.byName("w2"), status: "completed", result: "w2 done", completedAt: 2 }));
	check("no host call and no registry write reaches the outgoing session", reachedDead.length === 0, reachedDead.join(","));
	check("pending input reads false, and a spawn-only call refuses naming the park", pending === false && refusal.includes("parked for a session replacement"), refusal);
	const delivered = [];
	const said = [];
	const newHost = { sessionId: "new-seat", role: "main", depth: 0, types: [], emit: () => {}, log: (message) => said.push(message), deliver: (n) => delivered.push(n), hasPendingInput: () => false };
	const persisted = [];
	const carried = [record("w1", { ownerSessionId: "new-seat" }), record("w2", { ownerSessionId: "new-seat" })];
	await runtime.rehost(newHost, new AgentRegistry((r) => persisted.push(r), carried));
	check("what was written while parked lands in the new session, under the new owner", persisted.some((r) => r.name === "w1" && r.toolUses === 3 && r.ownerSessionId === "new-seat") && persisted.some((r) => r.name === "w2" && r.status === "completed"), JSON.stringify(persisted.map((r) => `${r.name}:${r.status}:${r.ownerSessionId}`)));
	check("a write while parked for a run the new session does not hold is not replayed into it", !persisted.some((r) => r.name === "w9") && runtime.registry.byTaskId("t-w9") === undefined, JSON.stringify(persisted.map((r) => r.name)));
	check("and what was said while parked is said by the new host", said.includes("said while parked"), JSON.stringify(said));
	check("a settle held across the park starts no turn before the new session's first", delivered.length === 0, String(delivered.length));
	const carriedIn = runtime.takeForTurn(() => false, () => {});
	check("it rides the first turn instead (C7)", carriedIn?.content.includes("w2 done") === true, carriedIn?.content?.slice(0, 80));
	runtime.publishSettled(runtime.registry.put({ ...runtime.registry.byName("w1"), status: "completed", result: "w1 done", completedAt: 3 }));
	check("after that first turn a settle delivers on its own again", delivered.length === 1 && delivered[0].content.includes("w1 done"), String(delivered.length));

	dead = false;
	reachedDead.length = 0;
	const orphan = new AgentRuntime({ ...oldHost }, new AgentRegistry(touch("registry persist"), [record("w3")]));
	orphan.park();
	dead = true;
	await orphan.retire("orphaned");
	orphan.publishSettled(orphan.registry.put({ ...orphan.registry.byName("w3"), status: "stopped", completedAt: 4 }));
	check("an unclaimed park is retired without reaching the outgoing session", reachedDead.length === 0, reachedDead.join(","));
}

// ---------------------------------------------------------------------------
// A result landing mid-turn appends; it never starts a second turn
// ---------------------------------------------------------------------------
{
	console.log("\na result landing mid-turn");
	const seat = await mainSeat();
	let turns = 0;
	seat.session.subscribe((event) => { if (event.type === "agent_start") turns++; });
	scriptFor("start one and keep working", [
		[call("Agent", { description: "quick job", prompt: "Land while I work.", name: "quick" })],
		{ delay: 1200, content: [text("still working")] },
	]);
	scriptFor("Land while I work.", [{ delay: 300, content: [text("Landed mid-turn.")] }]);
	await seat.session.prompt("start one and keep working");
	await seat.session.waitForIdle();
	check("the result arrived", seat.customs().some((m) => m.content.includes("<result>Landed mid-turn.</result>")), seat.customs().map((m) => m.content.slice(0, 60)).join(" | "));
	check("as an append to the turn in flight, not a second turn", turns === 1, String(turns));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Mid-turn, a handed result is not yet in the conversation (fault (a))
//
// `publishSettled` gives the text to pi's queue, which appends it at the end of
// the turn in flight. A `TaskOutput` asked during that window used to answer
// "scroll back" — pointing at a message that was not there yet, and would not
// be until after the caller had stopped looking.
// ---------------------------------------------------------------------------
{
	console.log("\na result handed but not yet in the conversation");
	const seat = await mainSeat();
	scriptFor("start one and ask mid-turn", [
		[call("Agent", { description: "quick job", prompt: "Land while I ask.", name: "quick" })],
		{ delay: 900, content: [call("TaskOutput", { names: ["quick"], block: false })] },
		{ delay: 300, content: [text("still working")] },
	]);
	scriptFor("Land while I ask.", [{ delay: 300, content: [text("Landed mid-turn.")] }]);
	await seat.session.prompt("start one and ask mid-turn");
	await seat.session.waitForIdle();
	const asked = seat.toolResults()[1]?.content[0].text ?? "";
	check("a seat is never sent looking for a message that has not landed", !asked.includes("scroll back"), asked);
	check("it is told where the result actually is: pi's queue", asked.includes("queued for your conversation; it arrives on its own when this turn ends"), asked);
	check("and told not to wait on it again", asked.includes("do not wait again"), asked);
	check("the promise is kept: the text does arrive in the conversation", seat.customs().some((m) => m.content.includes("<result>Landed mid-turn.</result>")), seat.customs().map((m) => m.content.slice(0, 60)).join(" | "));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// TaskStop on a run that has already ended names the verdict (ticket 56)
//
// "is not running (error)" reads like an unknown name, so a seat that had just
// been handed the error went looking for the run instead of reading it.
// ---------------------------------------------------------------------------
{
	console.log("\nTaskStop on a run that already ended");
	const seat = await mainSeat();
	scriptFor("start one and stop it too late", [
		[call("Agent", { description: "brief job", prompt: "Be quick.", name: "quickie" })],
		{ delay: 700, content: [call("TaskStop", { name: "quickie" })] },
		[text("ok")],
	]);
	scriptFor("Be quick.", [[text("Done already.")]]);
	await seat.session.prompt("start one and stop it too late");
	await seat.session.waitForIdle();
	const late = seat.toolResults()[1]?.content[0].text ?? "";
	check("TaskStop on an ended run says it ended and which verdict it reached", late.startsWith('Agent "quickie" already ended (completed);'), late);
	check("and says where that verdict went, rather than sounding like an unknown name", late.includes("queued for your conversation") && !late.includes("is not running"), late);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A name never means the caller or a seat above it
//
// On 2026-09-03 a seat called `worker-1` ran `TaskOutput ["worker-1"]` and was
// told "Still running: worker-1": it had matched its own child, named after
// itself by the collision. Unique auto names close that door; a caller can
// still *choose* the name, so both the spawn and the address are refused.
// ---------------------------------------------------------------------------
{
	console.log("\na name that means the caller or an ancestor");
	const seat = await mainSeat();
	scriptFor("nest three deep", [[call("Agent", { description: "papa job", prompt: "Be papa.", name: "papa" })], [text("started papa")]]);
	scriptFor("Be papa.", [
		[call("Agent", { description: "twin job", prompt: "Never runs.", name: "papa" })],
		[call("TaskOutput", { names: ["papa"], block: false })],
		[call("Agent", { description: "kid job", prompt: "Be the kid.", name: "kid" })],
		[text("papa done")],
	]);
	scriptFor("Be the kid.", [[call("SendMessage", { to: "papa", message: "hi grandad" })], [call("Agent", { description: "impostor", prompt: "Never runs.", name: "papa" })], [text("kid done")]]);
	await seat.session.prompt("nest three deep");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "papa"), 15000);
	const recordsIn = (file) => SessionManager.open(file).getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data);
	const resultsIn = (file) => SessionManager.open(file).getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult").map((e) => e.message.content.map((b) => b.text).join(""));
	const papa = recordsIn(seat.session.sessionFile).filter((r) => r.name === "papa").at(-1);
	const papaResults = resultsIn(papa.sessionFile);
	check("a seat cannot name an agent after itself", papaResults[0]?.includes('"papa" is this seat\'s own name'), papaResults[0]);
	check("the refusal points at ListAgents", papaResults[0]?.includes("Run ListAgents to see the agents you started."), papaResults[0]);
	check("and cannot wait on its own name either", papaResults[1]?.includes('"papa" is this seat\'s own name'), papaResults[1]);
	const kid = recordsIn(papa.sessionFile).filter((r) => r.name === "kid").at(-1);
	const kidResults = resultsIn(kid.sessionFile);
	check("a grandchild cannot message a seat above it", kidResults[0]?.includes('"papa" is a seat above you in the agent tree, not an agent you started.'), kidResults[0]);
	check("nor name its own child after one", kidResults[1]?.includes('"papa" is a seat above you in the agent tree'), kidResults[1]);
	check("no impostor was ever started: papa's record is still the one the main seat holds", recordsIn(papa.sessionFile).every((r) => r.name !== "papa"), recordsIn(papa.sessionFile).map((r) => r.name).join());
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Auto-generated names are unique across the whole tree, not per seat
// ---------------------------------------------------------------------------
{
	console.log("\nauto-names under nesting and fan-out");
	const seat = await mainSeat();
	scriptFor("fan out and nest", [
		[call("Agent", { description: "branch a", prompt: "Nest deeper." }), call("Agent", { description: "branch b", prompt: "Stay shallow." })],
		[text("spawned two")],
	]);
	scriptFor("Nest deeper.", [[call("Agent", { description: "inner", prompt: "Innermost." })], [text("nested")]]);
	scriptFor("Innermost.", [[text("bottom")]]);
	scriptFor("Stay shallow.", [[text("shallow")]]);
	await seat.session.prompt("fan out and nest");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 8000);
	const recordsOf = (file) => SessionManager.open(file).getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data);
	const top = recordsOf(seat.session.sessionFile);
	const topNames = [...new Set(top.map((r) => r.name))];
	check("two siblings spawned without names get two names", topNames.length === 2, topNames.join());
	const nested = top.find((r) => r.description === "branch a");
	const inner = [...new Set(recordsOf(nested.sessionFile).map((r) => r.name))];
	check("the nested seat auto-named its own child", inner.length === 1, inner.join());
	check("a grandchild's auto name collides with no name above it", !topNames.includes(inner[0]), `${topNames.join()} vs ${inner.join()}`);
	check("the names stay short and human-addressable, no hex ids (C2)", [...topNames, ...inner].every((name) => /^worker-\d+$/.test(name)), [...topNames, ...inner].join());
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// SendMessage: a running agent is steered, a finished one is resumed by name
// ---------------------------------------------------------------------------
{
	console.log("\nSendMessage, ListAgents, TaskStop");
	const seat = await mainSeat();
	scriptFor("start then message", [
		[call("Agent", { description: "listener job", prompt: "Listen for a while.", name: "listener" }, "toolu_spawn_listener")],
		[call("SendMessage", { to: "listener", message: "also count the tests" })],
		[text("sent")],
	]);
	scriptFor("Listen for a while.", [{ delay: 300, content: [call("ListAgents", {})] }, [text("Heard: done listening.")]]);
	await seat.session.prompt("start then message");
	await seat.session.waitForIdle();
	const sent = seat.toolResults()[1];
	check("a message to a running agent is queued for its next step", sent?.content[0].text === "Sent to listener; it reads the message at its next step.", sent?.content[0]?.text);
	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 3000);
	const steered = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("also count the tests")));
	check("the child saw the message in its conversation", steered !== undefined);
	await quiet(seat);

	scriptFor("message the finished one", [[call("SendMessage", { to: "listener", message: "one more thing" }, "toolu_resume_listener")], [text("resumed")]]);
	scriptFor("one more thing", [[text("Resumed and done.")]]);
	await seat.session.prompt("message the finished one");
	await seat.session.waitForIdle();
	const resumed = seat.toolResults()[2];
	check("a message to a finished agent resumes it from its transcript", /^listener resumed from its transcript with your message \(task a[0-9a-f]{12}\)/.test(resumed?.content[0].text ?? ""), resumed?.content[0]?.text);
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 3000);
	await quiet(seat);
	const resumedRequest = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("one more thing")));
	check("with its context intact: the earlier conversation precedes the new message", resumedRequest !== undefined && resumedRequest.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("ListAgents")) && resumedRequest.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("also count the tests")));
	const record = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data).filter((d) => d.name === "listener");
	// The task id is the agent's, not the run's: a fresh one gave the dock two
	// rows under one name, the older still asserting `completed` while it ran.
	check("the name still maps to one record and one task id across the resume", record.length >= 6 && record[record.length - 1].result === "Resumed and done." && record[0].taskId === record[record.length - 1].taskId);
	check("the resume announces itself on its own channel, so the row is revived rather than doubled", seat.events.filter((e) => e.channel === "subagents:resumed" && e.name === "listener").length === 1 && seat.events.filter((e) => e.channel === "subagents:created" && e.name === "listener").length === 1);

	scriptFor("who is there", [[call("ListAgents", {})], [text("listed")]]);
	await seat.session.prompt("who is there");
	await seat.session.waitForIdle();
	const listed = seat.toolResults()[3];
	// Money is diagnosis, and this row is where the model reads it (map C15).
	// It is never on a dock row: Joel reads time there.
	check("ListAgents reports a settled agent's cost — the model's only money", /\$/.test(listed?.content[0].text ?? ""), listed?.content[0]?.text);
	check("ListAgents: name, type, status, run time, cost, last result", /^listener \u00b7 worker \u00b7 completed \u00b7 ran \d+s( \u00b7 (\$[\d,.]+|<\$0\.01))? \u00b7 Resumed and done\.$/.test(listed?.content[0].text ?? ""), listed?.content[0]?.text);

	// One tool-use id per delivery. A resume used to reuse the `Agent` call's
	// id, so a genuinely new result looked exactly like a redelivery of the old
	// one (observed 2026-09-03: three runs, three task ids, one tool-use id).
	const deliveries = seat.customs().map((m) => m.content).join("\n");
	const useIds = [...deliveries.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)].map((m) => m[1]);
	check("each delivery carries its own tool-use id", useIds.length === 2 && new Set(useIds).size === 2, useIds.join());
	check("the first is the Agent call's, the resumed run's is the SendMessage call's", useIds[0] === "toolu_spawn_listener" && useIds[1] === "toolu_resume_listener", useIds.join());

	scriptFor("message nobody", [[call("SendMessage", { to: "ghost", message: "hi" })], [text("ok")]]);
	await seat.session.prompt("message nobody");
	await seat.session.waitForIdle();
	check("an unknown name is refused with a pointer to ListAgents", seat.toolResults()[4]?.isError === true && seat.toolResults()[4].content[0].text.includes('No agent named "ghost"'));

	// TaskStop keeps the result so far and stops the agent's own agents.
	scriptFor("start a lead and stop it", [
		[call("Agent", { description: "lead job", prompt: "Lead the work.", subagent_type: "lead", name: "boss" })],
		[call("TaskStop", { name: "boss" })],
		[text("stopped")],
	]);
	scriptFor("Lead the work.", [
		[text("Starting a worker."), call("Agent", { description: "sub job", prompt: "Do the sub job.", name: "hand" })],
		{ delay: 2000, content: [text("never reached")] },
	]);
	scriptFor("Do the sub job.", [{ delay: 3000, content: [text("sub done")] }]);
	await seat.session.prompt("start a lead and stop it");
	await seat.session.waitForIdle();
	const stopped = seat.toolResults()[6];
	check("TaskStop stops a running agent and keeps its text so far", stopped?.content[0].text.startsWith("Stopped boss.") && stopped.content[0].text.includes("Starting a worker."), stopped?.content[0]?.text);
	const failed = seat.events.filter((e) => e.channel === "subagents:failed");
	check("the dock hears it as failed with status stopped", failed.some((e) => e.name === "boss" && e.status === "stopped"), JSON.stringify(failed.map((e) => [e.name, e.status])));
	const { liveAgentCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
	check("and the lead's own worker is gone with it", await until(() => liveAgentCount() === 0, 3000));

	// The dock's stop request, answered on its reply channel.
	scriptFor("start for the dock", [[call("Agent", { description: "dock job", prompt: "Wait for the dock.", name: "docked" })], [text("ok")]]);
	scriptFor("Wait for the dock.", [{ delay: 3000, content: [text("too late")] }]);
	await seat.session.prompt("start for the dock");
	await seat.session.waitForIdle();
	const taskId = seat.events.filter((e) => e.channel === "subagents:started").at(-1).id;
	let reply;
	const requestId = `agent-dock-1-${Date.now()}`;
	seat.bus.on(`subagents:rpc:stop:reply:${requestId}`, (r) => { reply = r; });
	seat.bus.emit("subagents:rpc:stop", { requestId, agentId: taskId });
	await until(() => reply !== undefined, 3000);
	check("subagents:rpc:stop by task id replies {success: true}", reply?.success === true, JSON.stringify(reply));
	let refusal;
	seat.bus.on(`subagents:rpc:stop:reply:${requestId}-again`, (r) => { refusal = r; });
	seat.bus.emit("subagents:rpc:stop", { requestId: `${requestId}-again`, agentId: taskId });
	await until(() => refusal !== undefined, 3000);
	check("a second stop is refused with a reason the dock can show", refusal?.success === false && /not running/.test(refusal.error), JSON.stringify(refusal));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Depth: four levels run, the fifth is refused with the ruled text
// ---------------------------------------------------------------------------
{
	console.log("\ndepth cap");
	const seat = await mainSeat();
	scriptFor("go deeper 0", [[call("Agent", { description: "depth 1", prompt: "go deeper 1", name: "d1" })], [text("started")]]);
	for (const d of [1, 2, 3, 4]) {
		scriptFor(`go deeper ${d}`, [[call("Agent", { description: `depth ${d + 1}`, prompt: `go deeper ${d + 1}`, name: `d${d + 1}` })], [text(`level ${d} done`)]]);
	}
	await seat.session.prompt("go deeper 0");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "d1"), 15000);
	const refused = requests.find((r) => r.messages.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("Agent depth limit (4) reached. Do the task yourself.")));
	check("a depth-5 spawn errors with the ruled text", refused !== undefined);
	const tails = requests.map((r) => lastUserText({ messages: r.messages })).filter((t) => t.includes("You are a **worker** named `d4`"));
	check("the depth-4 child's tail says depth 4 of 4", tails.some((t) => t.includes("depth 4 of 4")), tails[0]?.slice(0, 100));
	check("every level reported up: four completions", seat.events.filter((e) => e.channel === "subagents:completed").length === 1);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// The fork is dead (ticket 29 §3): "fork" is just an unknown type now
// ---------------------------------------------------------------------------
{
	console.log("\nno fork");
	const seat = await mainSeat();
	scriptFor("fork it", [[text("About to do it."), call("Agent", { description: "do the thing", prompt: "Do the thing.", subagent_type: "fork" })], [text("no fork, then")]]);
	await seat.session.prompt("fork it");
	await seat.session.waitForIdle();
	const refusal = seat.toolResults()[0]?.content[0].text ?? "";
	// The schema enum refuses it before the runtime does; either way no child starts and "fork" is not offered.
	check("a spawn asking for a fork is refused as an unknown type", /subagent_type/.test(refusal) && !refusal.includes('or "fork"'), refusal);
	check("no child session was started for it", !seat.events.some((e) => e.channel === "subagents:created"));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Worktree isolation (C19): branch agent/<name>, clean-only removal, no branch deleted
// ---------------------------------------------------------------------------
{
	const { createAgentWorktree, settleAgentWorktree, worktreeBranchFor, worktreeReportLine } = await jiti.import(`${ROOT}/lib/agent-worktree.ts`);
	console.log("\nworktree isolation");
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-worktree-repo-"));
	const git = (args, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init -q -b main");
	git('-c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
	const exec = async (command, args, options) => {
		try {
			return { code: 0, stdout: execSync(`${command} ${args.map((a) => `'${a}'`).join(" ")}`, { cwd: options?.cwd ?? repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
		} catch (error) {
			return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? String(error) };
		}
	};
	check("the branch is agent/<name>, suffixed when taken", worktreeBranchFor("fix tests", new Set()) === "agent/fix-tests" && worktreeBranchFor("x", new Set(["agent/x", "agent/x-2"])) === "agent/x-3");

	const clean = await createAgentWorktree(exec, repo, "tidy");
	check("a worktree is checked out on its branch", fs.existsSync(clean.path) && git("rev-parse --abbrev-ref HEAD", clean.path) === "agent/tidy");
	const cleanSettle = await settleAgentWorktree(exec, clean);
	check("a clean worktree is removed", cleanSettle.kept === false && !fs.existsSync(clean.path));
	check("but its branch is never deleted", git("branch --list agent/tidy").includes("agent/tidy"));

	const dirty = await createAgentWorktree(exec, repo, "messy");
	fs.writeFileSync(path.join(dirty.path, "new.txt"), "work");
	const dirtySettle = await settleAgentWorktree(exec, dirty);
	check("uncommitted changes keep the worktree and say so", dirtySettle.kept === true && dirtySettle.reason === "uncommitted-changes" && fs.existsSync(dirty.path));
	check("the report names the branch and the path", worktreeReportLine(dirtySettle) === `Worktree kept at ${dirty.path} (branch \`agent/messy\`, uncommitted changes). Merge the branch yourself.`);

	const committed = await createAgentWorktree(exec, repo, "done");
	fs.writeFileSync(path.join(committed.path, "done.txt"), "work");
	git("add -A", committed.path);
	git('-c user.email=t@t -c user.name=t commit -q -m "agent work"', committed.path);
	const committedSettle = await settleAgentWorktree(exec, committed);
	check("commits past the base keep the worktree", committedSettle.kept === true && committedSettle.reason === "commits");

	const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
	let refused;
	try { await createAgentWorktree(exec, notRepo, "x"); } catch (error) { refused = error; }
	check("outside a repo the create fails with the step named", refused?._tag === "AgentWorktreeError" && refused.step === "not-a-repo");

	// Through the tool: the child's cwd is the worktree, its tail says so, and the result reports the settlement.
	const seat = await mainSeat({ cwd: repo });
	scriptFor("isolate one", [[call("Agent", { description: "isolated job", prompt: "Work in isolation.", name: "island", isolation: "worktree" })], [text("ok")]]);
	scriptFor("Work in isolation.", [[text("Nothing to change.")]]);
	await seat.session.prompt("isolate one");
	await seat.session.waitForIdle();
	check("the launch names the branch", seat.toolResults()[0]?.content[0].text.includes("Branch: agent/island"));
	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 5000);
	const islandRequest = requests.find((r) => lastUserText({ messages: r.messages }).includes("Work in isolation."));
	check("the tail carries the worktree line with the branch", islandRequest !== undefined && lastUserText({ messages: islandRequest.messages }).includes("You work in your own copy of the repo on branch `agent/island`. Commit there."));
	const completed = seat.events.find((e) => e.channel === "subagents:completed");
	check("the result ends with the settlement: clean, removed", completed?.result.endsWith("Worktree on branch `agent/island` had no changes and was removed."), completed?.result);
	seat.session.dispose();
	for (const wt of [dirty, committed]) execSync(`git worktree remove --force '${wt.path}'`, { cwd: repo });
	fs.rmSync(repo, { recursive: true, force: true });
	fs.rmSync(notRepo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// What a finished agent reports: context size, not the billed sum (issues/31 (d))
// ---------------------------------------------------------------------------
{
	console.log("\nthe numbers a finished agent reports");
	const seat = await mainSeat();
	scriptFor("start a re-reader", [[call("Agent", { description: "re-read files", prompt: "Read it three times.", name: "rereader" })], [text("started")]]);
	scriptFor("Read it three times.", [[call("ListAgents", {})], [call("ListAgents", {})], [text("Read it.")]]);
	await seat.session.prompt("start a re-reader");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "rereader"), 8000);
	await quiet(seat);
	scriptFor("what did it report", [[text("read")]]);
	await seat.session.prompt("what did it report");
	await seat.session.waitForIdle();
	const reported = seat.customs().at(-1)?.content ?? "";
	const usage = /<total_tokens>(\d+)<\/total_tokens><output_tokens>(\d+)<\/output_tokens>/.exec(reported);
	const child = requests.filter((r) => lastUserText({ messages: r.messages }).includes("Read it three times."));
	const billed = child.map((r) => 10 * (r.messages.length + 1) + 5);
	check("the token count is the last message's usage — the context size", usage !== null && Number(usage[1]) === billed.at(-1), `${usage?.[1]} vs last ${billed.at(-1)} of ${billed.join()}`);
	check("not the billed sum, which every cached re-read inflates", usage !== null && Number(usage[1]) < billed.reduce((a, b) => a + b, 0), `${usage?.[1]} vs sum ${billed.reduce((a, b) => a + b, 0)}`);
	check("and it says how much the agent wrote: every message's output side, summed", usage !== null && Number(usage[2]) === 5 * child.length, `${usage?.[2]} for ${child.length} messages`);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A bare TaskOutput counts the agents it was waiting for (issues/31 (g))
// ---------------------------------------------------------------------------
{
	console.log("\nthe yield counts what is running");
	const seat = await mainSeat();
	scriptFor("start two and wait for anything", [
		[call("Agent", { description: "job one", prompt: "Take a while, one.", name: "slow-one" }), call("Agent", { description: "job two", prompt: "Take a while, two.", name: "slow-two" })],
		[call("TaskOutput", {})],
		[text("carrying on")],
		[text("steered reply")],
	]);
	scriptFor("Take a while, one.", [{ delay: 2500, content: [text("one done")] }]);
	scriptFor("Take a while, two.", [{ delay: 2500, content: [text("two done")] }]);
	const turn = seat.session.prompt("start two and wait for anything");
	await until(() => seat.toolResults().length === 2 && seat.session.isStreaming, 5000);
	await sleep(50);
	await seat.session.prompt("never mind", { streamingBehavior: "steer" });
	await until(() => seat.toolResults().length === 3, 3000);
	const yielded = seat.toolResults()[2]?.content[0].text ?? "";
	check("a nameless wait says how many of its agents are done, not 0 of 0", yielded.startsWith("interrupted by Joel — 0 of 2 done"), yielded.split("\n")[0]);
	await turn;
	await seat.session.waitForIdle();
	check("and both children kept running", await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 8000));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A cold fan-out staggers its siblings' first prompts (issues/31 (i))
//
// The runtime is built here rather than driven through a seat, because the
// point is the delay: the host's timer is scripted, so the order is pinned
// without a wall clock. A sibling is *created* at once either way — only its
// first prompt waits, so the dock shows it immediately.
// ---------------------------------------------------------------------------
// The advisor is the main thread's alone: Opus at max reasoning is not a
// budget a child seat gets to spend on its own behalf.
// ---------------------------------------------------------------------------
{
	console.log("\nthe advisor is the main thread's alone");
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { ADVISOR_MAIN_THREAD_ONLY } = await jiti.import(`${ROOT}/lib/agent-tool-text.ts`);
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const hostAt = (depth) => ({
		sessionId: `advisor-seat-${depth}`, sessionFile: undefined, sessionDir: path.join(AGENT_DIR, "sessions"), cwd: ROOT, agentDir: AGENT_DIR,
		depth, role: depth === 0 ? "main" : "lead",
		types: [{ name: "advisor", description: "Judgment.", model: "opus", thinking: "max", prompt: "Advise.", source: "" }],
		model: () => scripted, thinkingLevel: () => "off", resolveModel: () => scripted, modelRuntime,
		persist: () => {}, emit: () => {}, deliver: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }), hasPendingInput: () => false,
		childLoader: async () => { throw new Error("no child should start"); },
		log: () => {}, sleep: async () => {},
	});
	const refusal = await new AgentRuntime(hostAt(1), new AgentRegistry(() => {}))
		.spawn({ description: "ask the advisor", prompt: "Is this design right?", subagentType: "advisor" })
		.then(() => "no refusal", (error) => error.message);
	check("a child seat's advisor spawn is refused with the ruled text", refusal === ADVISOR_MAIN_THREAD_ONLY, refusal);
	const fromMain = await new AgentRuntime(hostAt(0), new AgentRegistry(() => {}))
		.spawn({ description: "ask the advisor", prompt: "Is this design right?", subagentType: "advisor" })
		.then(() => "spawned", (error) => error.message);
	check("the main thread gets past the same gate", fromMain !== ADVISOR_MAIN_THREAD_ONLY, fromMain);
}

// ---------------------------------------------------------------------------
// Every seat may run at any level, low to max. What a model lacks is its own
// limit: the spawn clamps to its level map and records what the child runs at,
// and that level is what reaches the provider.
// ---------------------------------------------------------------------------
{
	console.log("\nany seat, any level, clamped to the model");
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { liveAgentCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	// Like Opus 4.7+ and Luna: every level through max. And like Opus 4.5: nothing past high.
	const fullRange = { ...scripted, id: "scripted-1", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
	const toHigh = { ...scripted, id: "scripted-1", reasoning: true };
	const hostOn = (model, types = []) => ({
		sessionId: `levels-seat-${Math.random().toString(16).slice(2, 8)}`, sessionFile: undefined, sessionDir: path.join(AGENT_DIR, "sessions"), cwd: ROOT, agentDir: AGENT_DIR,
		depth: 0, role: "main", types,
		model: () => model, thinkingLevel: () => "off", resolveModel: () => model, modelRuntime,
		persist: () => {}, emit: () => {}, deliver: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }), hasPendingInput: () => false,
		childLoader: async ({ cwd }) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			return loader;
		},
		log: () => {}, sleep: async () => {},
	});
	const lead = { name: "lead", description: "Owns work.", model: undefined, thinking: "high", prompt: "", source: "" };
	const full = new AgentRuntime(hostOn(fullRange, [lead]), new AgentRegistry(() => {}));
	for (const level of ["low", "medium", "high", "xhigh", "max"]) {
		const prompt = `Run at ${level}.`;
		scriptFor(prompt, [[text(`ran at ${level}`)]]);
		const record = await full.spawn({ description: `a lead at ${level}`, prompt, subagentType: "lead", thinking: level });
		check(`a lead spawned at ${level} is recorded at ${level}`, record.thinking === level, record.thinking);
		const sent = await until(() => requests.some((r) => r.reasoning === level && lastUserText({ messages: r.messages }).includes(prompt)), 5000);
		check(`and ${level} is the level the provider is asked for`, sent, JSON.stringify(requests.filter((r) => lastUserText({ messages: r.messages }).includes(prompt)).map((r) => r.reasoning)));
	}
	const typeDefault = await full.spawn({ description: "a lead at its default", prompt: "Run at the type's level.", subagentType: "lead" });
	check("no level asked takes the type's", typeDefault.thinking === "high", typeDefault.thinking);
	const refused = await full.spawn({ description: "x", prompt: "x", thinking: "enormous" }).then(() => "spawned", (error) => error.message);
	check("a level that does not exist is refused, naming the ones that do", refused === 'Thinking level "enormous" does not exist. Only "low", "medium", "high", "xhigh", "max" do.', refused);
	const narrow = new AgentRuntime(hostOn(toHigh), new AgentRegistry(() => {}));
	const clamped = await narrow.spawn({ description: "max on a model without it", prompt: "Run past your range.", thinking: "max" });
	check("max on a model without it is clamped to the model's top level, not refused", clamped.thinking === "high", clamped.thinking);
	// The seat reaches all of this through the Agent tool's own parameter.
	const seat = await mainSeat();
	const thinkingParam = seat.tool("Agent").parameters.properties.thinking;
	check("Agent carries a thinking parameter enumerating low to max", thinkingParam?.enum?.join() === "low,medium,high,xhigh,max", JSON.stringify(thinkingParam));
	scriptFor("spawn a max lead", [[call("Agent", { description: "worker at max", prompt: "Lead at max.", subagent_type: "worker", name: "maxlead", thinking: "max" })], [text("started")]]);
	scriptFor("Lead at max.", [[text("led")]]);
	await seat.session.prompt("spawn a max lead");
	await seat.session.waitForIdle();
	const started = seat.toolResults().map((m) => m.content.map((c) => c.text).join("")).join("\n");
	check("the Agent tool passes thinking through to the spawn", /Agent started in background/.test(started) && !/does not exist/.test(started), started);
	await quiet(seat);
	seat.session.dispose();
	await Promise.all([full.stopAll(), narrow.stopAll()]);
	await until(() => liveAgentCount() === 0, 8000);
}

// ---------------------------------------------------------------------------
{
	console.log("\na cold fan-out staggers its siblings");
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { liveAgentCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
	const { childSeatOf, declareSeatWorkflows } = await jiti.import(`${ROOT}/lib/seat.ts`);
	const slept = [];
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const host = {
		sessionId: "stagger-seat",
		sessionFile: undefined,
		sessionDir: path.join(AGENT_DIR, "sessions"),
		cwd: ROOT,
		agentDir: AGENT_DIR,
		depth: 0,
		role: "main",
		types: [],
		model: () => scripted,
		thinkingLevel: () => "off",
		resolveModel: () => scripted,
		modelRuntime,
		persist: () => {},
		emit: () => {},
		deliver: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		hasPendingInput: () => false,
		childLoader: async ({ cwd }) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			return loader;
		},
		log: () => {},
		sleep: (ms) => new Promise((resolve) => slept.push({ ms, resolve })),
	};
	const runtime = new AgentRuntime(host, new AgentRegistry(() => {}));
	const names = ["sib-1", "sib-2", "sib-3", "sib-4", "sib-5", "sib-6", "sib-7"];
	for (const name of names) scriptFor(`Fan out, ${name}.`, [{ delay: 4000, content: [text(`${name} done`)] }]);
	await runtime.spawn({ description: "first of the fan-out", prompt: `Fan out, ${names[0]}.`, name: names[0] });
	check("a lone child is not staggered: nothing else is live", slept.length === 0, JSON.stringify(slept.map((s) => s.ms)));
	// The launch answer is inherited, never re-decided: a child of a seat that was
	// started without workflows has none either.
	const seatOfChild = (name) => childSeatOf(runtime.registry.byName(name).sessionId);
	check("a child of a no-workflow seat carries no workflows", seatOfChild(names[0])?.workflows === false, JSON.stringify(seatOfChild(names[0])));
	check("and it prompts at once, writing the prefix", await until(() => requests.some((r) => lastUserText({ messages: r.messages }).includes(`Fan out, ${names[0]}.`)), 5000));
	declareSeatWorkflows(host.sessionId, true);
	for (const name of names.slice(1)) await runtime.spawn({ description: "sibling of the fan-out", prompt: `Fan out, ${name}.`, name });
	check("and a child spawned once the seat carries them inherits that", seatOfChild(names[1])?.workflows === true);
	declareSeatWorkflows(host.sessionId, false);
	check("every sibling past the first waits a step longer, capped at five seconds", slept.map((s) => s.ms).join() === "1000,2000,3000,4000,5000,5000", slept.map((s) => s.ms).join());
	const asked = (name) => requests.some((r) => lastUserText({ messages: r.messages }).includes(`Fan out, ${name}.`));
	check("a staggered sibling has sent nothing while it waits", names.slice(1).every((name) => !asked(name)), names.slice(1).filter(asked).join());
	check("but the dock sees it at once: created and running before the prompt", runtime.registry.live().length === names.length, String(runtime.registry.live().length));
	slept[0].resolve();
	check("and it prompts when its turn comes", await until(() => asked(names[1]), 5000));
	check("the ones behind it are still waiting", !asked(names[2]));
	for (const pending of slept) pending.resolve();
	await runtime.stopAll();
	await until(() => liveAgentCount() === 0, 8000);
}

// ---------------------------------------------------------------------------
// The stagger counts the launch batch, not every live child (38's finding 8).
// A run that has ended a turn has written the cache prefix already, so a child
// spawned behind it reads one and waits for nothing.
// ---------------------------------------------------------------------------
{
	console.log("\nthe stagger counts the launch batch, not the living");
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { liveAgentCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
	const slept = [];
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const host = {
		sessionId: "batch-seat",
		sessionFile: undefined,
		sessionDir: path.join(AGENT_DIR, "sessions"),
		cwd: ROOT,
		agentDir: AGENT_DIR,
		depth: 0,
		role: "main",
		types: [],
		model: () => scripted,
		thinkingLevel: () => "off",
		resolveModel: () => scripted,
		modelRuntime,
		persist: () => {},
		emit: () => {},
		deliver: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		hasPendingInput: () => false,
		childLoader: async ({ cwd }) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			return loader;
		},
		log: () => {},
		sleep: (ms) => new Promise((resolve) => slept.push({ ms, resolve })),
	};
	const runtime = new AgentRuntime(host, new AgentRegistry(() => {}));
	// One tool call, then a long silence: the first assistant message ends, so the
	// run leaves the batch while it is still very much alive.
	scriptFor("Work, then wait.", [[call("read", { path: `${ROOT}/package.json` })], { delay: 30000, content: [text("first done")] }]);
	scriptFor("Come in behind it.", [{ delay: 30000, content: [text("second done")] }]);
	await runtime.spawn({ description: "first of the pair", prompt: "Work, then wait.", name: "batch-1" });
	const ended = await until(() => requests.filter((r) => lastUserText({ messages: r.messages }).includes("Work, then wait.")).length === 2, 8000);
	check("the first child has ended a turn: it wrote the prefix", ended);
	await runtime.spawn({ description: "second of the pair", prompt: "Come in behind it.", name: "batch-2" });
	check("a child spawned behind it is not staggered: there is a prefix to read", slept.length === 0, JSON.stringify(slept.map((s) => s.ms)));
	check("and it prompts at once", await until(() => requests.some((r) => lastUserText({ messages: r.messages }).includes("Come in behind it.")), 5000));
	await runtime.stopAll();
	await until(() => liveAgentCount() === 0, 8000);
}

// ---------------------------------------------------------------------------
// `onFirstPrompt` is when a child starts acting on the world: a workflow reads
// its journal `after` there, so it fires after every hold and before the
// prompt, and never for a child stopped while it was held.
// ---------------------------------------------------------------------------
{
	console.log("\na child's onFirstPrompt fires as its first prompt goes out");
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { liveAgentCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
	const slept = [];
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const host = {
		sessionId: "first-prompt-seat",
		sessionFile: undefined,
		sessionDir: path.join(AGENT_DIR, "sessions"),
		cwd: ROOT,
		agentDir: AGENT_DIR,
		depth: 0,
		role: "main",
		types: [],
		model: () => scripted,
		thinkingLevel: () => "off",
		resolveModel: () => scripted,
		modelRuntime,
		persist: () => {},
		emit: () => {},
		deliver: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		hasPendingInput: () => false,
		childLoader: async ({ cwd }) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			return loader;
		},
		log: () => {},
		sleep: (ms) => new Promise((resolve) => slept.push({ ms, resolve })),
	};
	const runtime = new AgentRuntime(host, new AgentRegistry(() => {}));
	const asked = (prompt) => requests.some((r) => lastUserText({ messages: r.messages }).includes(prompt));
	// Each hook call notes whether the prompt had already been sent: it must not have been.
	const fired = [];
	const onFirstPrompt = (prompt) => () => fired.push({ prompt, sent: asked(prompt) });
	const prompts = ["Lead the batch.", "Wait your turn.", "Be stopped while held."];
	for (const prompt of prompts) scriptFor(prompt, [{ delay: 30000, content: [text("done")] }]);
	await runtime.spawn({ description: "lead", prompt: prompts[0], name: "fp-lead", onFirstPrompt: onFirstPrompt(prompts[0]) });
	check("a child that is not held fires it at once", await until(() => fired.length === 1, 5000) && fired[0].prompt === prompts[0]);
	await runtime.spawn({ description: "held", prompt: prompts[1], name: "fp-held", onFirstPrompt: onFirstPrompt(prompts[1]) });
	const heldTask = (await runtime.spawn({ description: "stopped", prompt: prompts[2], name: "fp-stopped", onFirstPrompt: onFirstPrompt(prompts[2]) })).taskId;
	check("both siblings are held by the stagger", slept.length === 2, JSON.stringify(slept.map((s) => s.ms)));
	check("and neither has fired it while held", fired.length === 1, JSON.stringify(fired));
	await runtime.stop(heldTask, "cascade");
	slept[0].resolve();
	check("the held child fires it once its hold ends", await until(() => fired.length === 2, 5000) && fired[1].prompt === prompts[1], JSON.stringify(fired));
	check("before its prompt is sent", fired.every((f) => !f.sent), JSON.stringify(fired));
	check("and its prompt then goes out", await until(() => asked(prompts[1]), 5000));
	for (const pending of slept) pending.resolve();
	await runtime.stopAll();
	await until(() => liveAgentCount() === 0, 8000);
	check("a child stopped while held never fires it: it never started", !fired.some((f) => f.prompt === prompts[2]), JSON.stringify(fired));
}

// ---------------------------------------------------------------------------
// A workflow's child is the workflow's to read, never this seat's (ticket 23).
// `unread()` is the one list every delivery path is built from, so the rule
// belongs there rather than in each caller (38's finding 5).
// ---------------------------------------------------------------------------
{
	console.log("\na workflow's child is never this seat's to read");
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const registry = new AgentRegistry(() => {});
	const runtime = new AgentRuntime({ sessionId: "unread-seat" }, registry);
	const record = (name, extra) => ({ name, taskId: `t-${name}`, ownerSessionId: "unread-seat", type: "worker", description: "a job", status: "completed", stoppedBy: undefined, depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: ROOT, branch: undefined, model: "scripted/scripted-1", result: "done", error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: 2, toolCallId: undefined, workflowChild: false, ...extra });
	registry.put(record("ordinary"));
	registry.put(record("workflow-child", { workflowChild: true }));
	check("the ordinary child is unread; the workflow's is not in the list at all", runtime.unread().map((r) => r.name).join() === "ordinary", runtime.unread().map((r) => r.name).join());
	check("and no delivery can take it: takeUnread hands over the same list", runtime.takeUnread(["workflow-child"], () => {}, "tool") === undefined);
}

// ---------------------------------------------------------------------------
// The seam's counterpart (38's finding 7): every published entry pins a
// runtime, its registry and every child session it held.
// ---------------------------------------------------------------------------
{
	console.log("\nthe runtime seam has a counterpart");
	const seam = await jiti.import(`${ROOT}/lib/agent-runtime-seam.ts`);
	const runtime = { marker: "a runtime" };
	seam.publishAgentRuntime("seam-session", runtime);
	check("a published runtime is found by its session id", seam.agentRuntimeOf("seam-session") === runtime);
	seam.forgetAgentRuntime("seam-session");
	check("and the session's end drops it", seam.agentRuntimeOf("seam-session") === undefined);
}

// ---------------------------------------------------------------------------
// A child that hit its own context stop (ticket 51 §2): its abort is
// indistinguishable from a crash, so the mark its ladder left is the only
// thing that can tell the parent the truth.
// ---------------------------------------------------------------------------
{
	console.log("\na child stopped by its own context ladder says so to its parent");
	const { markContextStop, contextStopOf } = await jiti.import(`${ROOT}/lib/continue-session.ts`);
	const seat = await mainSeat();
	scriptFor("start a filler", [[call("Agent", { description: "fills its window", prompt: "Fill the window.", name: "filler" })], [text("started")]]);
	scriptFor("Fill the window.", [{ delay: 1500, content: [text("nearly full")] }]);
	await seat.session.prompt("start a filler");
	const recordOf = () => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === "filler").pop()?.data;
	await until(() => recordOf()?.sessionId !== undefined, 5000);
	const child = recordOf();
	markContextStop(child.sessionId, { tokens: 251_000, stop: 250_000, recorded: true, byModel: true });
	await until(() => ["completed", "stopped", "error"].includes(recordOf()?.status), 8000);
	const settled = recordOf();
	check("the parent's record says stopped, not error and not completed", settled?.status === "stopped", String(settled?.status));
	check("and it names the cause: the context ladder, not a caller", settled?.stoppedBy === "context", String(settled?.stoppedBy));
	check("the error carries the numbers and the child's own file, so a fresh agent can be handed it", settled?.error?.includes("251k") && settled.error.includes("250k") && settled.error.includes(child.sessionFile) && settled.error.includes("Do not resume it"), settled?.error);
	check("the mark dies with the run it described", contextStopOf(child.sessionId) === undefined);
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Joel aborts the turn: the children are their own sessions and keep running
// (issues/31 (h)). Two died with an abort on 2026-09-04.
// ---------------------------------------------------------------------------
{
	console.log("\nan aborted turn leaves the children running");
	const seat = await mainSeat();
	scriptFor("start two then abort", [
		[call("Agent", { description: "survivor one", prompt: "Survive the abort, one.", name: "survivor-1" }), call("Agent", { description: "survivor two", prompt: "Survive the abort, two.", name: "survivor-2" })],
		{ delay: 4000, content: [text("never reached")] },
	]);
	scriptFor("Survive the abort, one.", [{ delay: 1500, content: [text("one survived")] }]);
	scriptFor("Survive the abort, two.", [{ delay: 1500, content: [text("two survived")] }]);
	const turn = seat.session.prompt("start two then abort");
	await until(() => seat.events.filter((e) => e.channel === "subagents:started").length === 2, 5000);
	await seat.session.abort();
	await turn.catch(() => {});
	const landed = await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 10000);
	check("both children finish after the parent's turn is aborted", landed, JSON.stringify(seat.events.map((e) => [e.channel, e.name, e.status])));
	check("with their answers, not an aborted stub", seat.events.filter((e) => e.channel === "subagents:completed").map((e) => e.result).sort().join("|") === "one survived|two survived", JSON.stringify(seat.events.filter((e) => e.channel === "subagents:completed").map((e) => e.result)));
	await quiet(seat);
	const arrived = seat.customs().map((m) => m.content).join("\n");
	check("and their results still delivered themselves, not lost with the abort", arrived.includes("<result>one survived</result>") && arrived.includes("<result>two survived</result>"), arrived.slice(0, 200));
	const causes = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data.stoppedBy);
	check("and no record names a stop cause, because nothing stopped them", causes.every((c) => c === undefined), JSON.stringify(causes));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Every stop names its caller (issues/31 (h)). The status is `stopped` whoever
// asked, so without this the session file cannot say which of five paths ran.
// ---------------------------------------------------------------------------
{
	console.log("\na stopped agent records who stopped it");
	const { claimScreen } = await jiti.import(`${ROOT}/lib/notice.ts`);
	const said = [];
	const release = claimScreen((message) => said.push(message));
	const seat = await mainSeat();
	scriptFor("start one and stop it", [[call("Agent", { description: "long runner", prompt: "Run for a while.", name: "long-runner" })], [call("TaskStop", { name: "long-runner" })], [text("stopped it")]]);
	scriptFor("Run for a while.", [{ delay: 30000, content: [text("too late")] }]);
	await seat.session.prompt("start one and stop it");
	await seat.session.waitForIdle();
	release();
	// issues/31 (h): the stop that killed two children was found in the record
	// hours later. A live line names the caller while Joel is still watching.
	check("the stop says on the screen who asked for it, as it happens", said.includes("agent long-runner: stopping \u2014 asked by TaskStop"), JSON.stringify(said));
	const last = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === "long-runner").pop()?.data;
	check("the record says it was stopped", last?.status === "stopped", String(last?.status));
	check("and the session file names the caller, so the next 11:33 is answerable", last?.stoppedBy === "TaskStop", String(last?.stoppedBy));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A report is the last substantive message, not the last message (ticket 57).
//
// Replayed from the shape of the `test-audit` transcript of 2026-09-05: the
// worker wrote its report, one of its own children's results landed, it said
// "that data was already in the report above" — and that sentence was the whole
// of what its parent received.
// ---------------------------------------------------------------------------
{
	console.log("\na report is the last substantive message");
	const { childReport, SIGN_OFF_NOTE } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	const says = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
	const calls = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] });
	const result = () => ({ role: "toolResult", content: [{ type: "text", text: "output" }] });
	const delivery = () => ({ role: "custom", customType: "subagent-notification", content: "<task-notification>a child's result</task-notification>" });
	const asked = () => ({ role: "user", content: [{ type: "text", text: "a new question" }] });
	const session = (...messages) => ({ messages });
	const report = `report: ${"x".repeat(3000)}`;
	const signOff = "That data was already in the report above — nothing changes.";

	const landed = childReport(session(asked(), calls(), result(), says(report), delivery(), says(signOff)), signOff);
	check("the report lands, with the sign-off after it and a line saying why", landed === `${report}\n\n${signOff}\n\n${SIGN_OFF_NOTE}`, landed?.slice(0, 80));
	check("a child that writes only a sign-off delivers the sign-off", childReport(session(asked(), says(signOff)), signOff) === signOff);
	check("a report that is the last message is delivered untouched", childReport(session(asked(), calls(), result(), says(report)), report) === report);
	// The window closes where the child was last asked something: a resumed run
	// answers the new question and never re-delivers the report it already sent.
	check("a resumed run delivers its answer, not the report it delivered before", childReport(session(says(report), delivery(), says(signOff), asked(), says("No, X is fine.")), "No, X is fine.") === "No, X is fine.");
	// And where work happened after the long text, the long text is superseded.
	check("a long message from before the last tool call is not the report", childReport(session(asked(), says(report), calls(), result(), says("done")), "done") === "done");
	check("a child that said nothing has no result", childReport(session(asked()), "") === undefined);
}

// ---------------------------------------------------------------------------
// The same fault through the engine: a worker whose own child lands after it
// has written its report. What reaches the parent is the report.
// ---------------------------------------------------------------------------
{
	console.log("\na worker's report survives its sign-off");
	const seat = await mainSeat();
	const report = `Findings: ${"x".repeat(3000)}`;
	const signOff = "That data was already in the report above — nothing changes.";
	scriptFor("start the auditor", [[call("Agent", { description: "audits the suite", prompt: "Audit it.", name: "auditor" })], [text("started")]]);
	scriptFor("Audit it.", [[call("Agent", { description: "a slow look", prompt: "Look slowly.", name: "looker" })], [text(report)], [text(signOff)]]);
	scriptFor("Look slowly.", [{ delay: 1200, content: [text("looked")] }]);
	await seat.session.prompt("start the auditor");
	const recordOf = (name) => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === name).pop()?.data;
	await until(() => recordOf("auditor")?.status === "completed", 15000);
	const settled = recordOf("auditor");
	check("the sign-off did not replace the report", settled?.result?.startsWith(report), settled?.result?.slice(0, 80));
	check("the sign-off still rides along, with the reason it does", settled?.result?.includes(signOff) && settled.result.endsWith("[report taken from the message before the sign-off]"), settled?.result?.slice(-120));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A seat has no present, so the reader's clock is stamped where the text is
// read (ticket 60).
//
// `deliver` hands pi's queue a frozen string and a followUp is appended at the
// end of the turn in flight: on 2026-09-05 an explorer's result waited 167
// seconds and its notification still printed `waited-ms 0`.
// ---------------------------------------------------------------------------
{
	console.log("\na delivery that waited says how long");
	const { AgentRegistry } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);
	const { AgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime.ts`);
	let clock = 1_000_000;
	const delivered = [];
	const registry = new AgentRegistry(() => {});
	const runtime = new AgentRuntime({ sessionId: "seat", role: "main", emit: () => {}, deliver: (n) => delivered.push(n), now: () => clock }, registry);
	const record = (name, over = {}) => ({ name, taskId: `t-${name}`, ownerSessionId: "seat", type: "explore", description: `${name} job`, status: "completed", depth: 1, sessionFile: undefined, sessionId: `s-${name}`, cwd: "/", branch: undefined, model: "m", result: `${name} found it.`, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: clock, toolCallId: undefined, workflowChild: false, ...over });
	registry.put(record("ccwf2"));
	runtime.publishSettled(registry.byName("ccwf2"));
	check("the queued text says when it was queued and claims nothing about when it is read", delivered[0]?.content.includes("<queued-at>") && !delivered[0].content.includes("<settled-ago>") && !delivered[0].content.includes("waited-ms"), delivered[0]?.content?.slice(0, 300));
	// The turn in flight runs for 167 seconds; only now does the text land.
	clock += 167_000;
	let turnMessage;
	runtime.takeForTurn(() => true, (n) => { turnMessage = n; });
	check("a delivery the harness has already seen is not repeated into the turn", turnMessage === undefined);
	check("the record is in the conversation only now that the harness has seen it", registry.byName("ccwf2").readBy === "conversation" && registry.byName("ccwf2").readAt === clock);
	// The seat's present, stamped where the text is read: subtract it from the
	// frozen `<queued-at>` above and the 167-second wait is arithmetic, not a guess.
	registry.put(record("prompt", { completedAt: clock }));
	let read;
	runtime.takeUnread(["prompt"], (n) => { read = n.content; }, "conversation");
	check("the turn that reads a result stamps the reader's clock", read?.includes(`<read-at>${new Date(clock).toISOString()}</read-at>`), read?.slice(0, 400));
	check("a queued delivery carries no reader's clock, because its text is frozen", !delivered[0].content.includes("<read-at>"), delivered[0]?.content?.slice(0, 300));
	check("nothing prints prose about lateness", !read.includes("late-delivery") && !delivered[0].content.includes("late-delivery"));
	// A tool result is rendered where it is returned, so there the relative number
	// is the honest one — no queue sits between it and the reader.
	registry.put(record("tooled", { completedAt: clock - 5_000 }));
	let returned;
	runtime.takeUnread(["tooled"], (n) => { returned = n.content; }, "tool");
	check("a result returned by a tool carries its age, not an absolute a seat cannot read", returned?.includes("<settled-ago>5s before you read this</settled-ago>") && !returned.includes("<queued-at>"), returned?.slice(0, 300));
}

// ---------------------------------------------------------------------------
// A family word names the newest model of that family on any provider, and
// nothing else: no substring answer, and no pick between two providers.
// Last in the file, because a registered provider stays in the shared runtime.
// ---------------------------------------------------------------------------
{
	console.log("\na family word resolves across providers, or is refused");
	const scriptedModel = (id) => ({ ...SCRIPTED_MODEL, id, name: id });
	const lunaProvider = (name, ids) => (pi) => {
		pi.registerProvider(name, { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: ids.map(scriptedModel) });
	};
	const recordOf = (seat, name) => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === name).pop()?.data;

	const one = await mainSeat({ extraFactories: [lunaProvider("luna-a", ["gpt-5.6-luna", "gpt-6-luna", "opusless-substring"])] });
	scriptFor("spawn a luna seat", [[call("Agent", { description: "routine job", prompt: "Routine luna job.", model: "luna", name: "moon" })], [text("started")]]);
	scriptFor("Routine luna job.", [[text("routine done")]]);
	await one.session.prompt("spawn a luna seat");
	await until(() => recordOf(one, "moon")?.status === "completed", 10000);
	check("luna runs on the newest luna, not the first id containing the word", recordOf(one, "moon")?.model === "luna-a/gpt-6-luna", recordOf(one, "moon")?.model);
	await quiet(one);

	const before = one.toolResults().length;
	scriptFor("spawn an opus seat", [[call("Agent", { description: "judgment job", prompt: "Opus job.", model: "opus", name: "sun" })], [text("refused")]]);
	await one.session.prompt("spawn an opus seat");
	await quiet(one);
	const noOpus = one.toolResults()[before];
	check("an id that merely contains the word is no answer: opus with no opus model is refused", noOpus?.isError === true && noOpus.content[0].text.includes('No model for agent type "worker" (asked for "opus")'), noOpus?.content?.[0]?.text);
	one.session.dispose();

	const two = await mainSeat({ extraFactories: [lunaProvider("luna-b", ["gpt-6-luna"])] });
	scriptFor("spawn a luna on two providers", [[call("Agent", { description: "routine job", prompt: "Ambiguous luna job.", model: "luna", name: "eclipse" })], [text("refused")]]);
	await two.session.prompt("spawn a luna on two providers");
	await quiet(two);
	const ambiguous = two.toolResults()[0];
	const said = ambiguous?.content?.[0]?.text ?? "";
	check("a family two providers carry is refused, not picked", ambiguous?.isError === true && said.startsWith('Model "luna" is ambiguous:'), said);
	check("and the refusal names both", said.includes("luna-a/gpt-6-luna") && said.includes("luna-b/gpt-6-luna"), said);
	check("no agent was started", recordOf(two, "eclipse") === undefined);
	two.session.dispose();
}

trailer();
