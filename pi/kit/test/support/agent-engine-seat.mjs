/**
 * The owned agent engine's offline harness, shared by the `agents/agent-*.test.mjs`
 * files that were one `agent-engine.test.mjs`: a private agent dir with the
 * worker, lead and explore types and a probe that records each child's session
 * scope, one scripted provider for the process (`scriptFor`, `requests`), a
 * main seat with the engine loaded (`mainSeat`), stub runtimes (`runtimeOver`)
 * and runtimes over held git and loader gates (`inFlightRig`). Importing it
 * sets the agent dir and the child extensions, so a file imports it right after
 * the check harness, e.g.
 * `import { call, mainSeat, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";`.
 * `TaskStop` is registered deferred, so the seat activates it here, as `tool_search` would. It keeps pi's built-in tools on the seat and no default step delay, unlike
 * `scripted-seat.mjs`, because the engine's checks were written against both.
 */

import { atFinish } from "./check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "./pi-package.mjs";
import { until } from "./async-waits.mjs";
import { childExtensionsList } from "./child-extensions.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The one jiti every engine file imports kit modules through. */
export const jiti = kitJiti({ moduleCache: false });

// A private agent dir: the type files under test, no auth, no real sessions
// dir polluted. Set before pi loads anything that reads it.
/** The private pi agent dir: the type files under test, no auth. */
export const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-engine-home-"));
fs.mkdirSync(path.join(AGENT_DIR, "agents"));
fs.writeFileSync(path.join(AGENT_DIR, "agents", "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "agents", "lead.md"), "---\nname: lead\ndescription: Coordinates a chunk end to end.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "agents", "explore.md"), "---\nname: explore\ndescription: Find things.\ndelivery: batch\ntools: read, bash, edit, write\n---\nYou are an explorer. Paths and lines, not prose.\n");
fs.writeFileSync(path.join(AGENT_DIR, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews.\ndelivery: batch\ntools: read, bash, edit, write\n---\nYou are a reviewer.\n");
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(AGENT_DIR, "sessions");
// Children under test load the engine and a probe that records their session scopes' lives.
/** A child extension that records each child session scope's opening and close in `globalThis.__childScopes`. */
export const SCOPE_PROBE = path.join(AGENT_DIR, "scope-probe.ts");
fs.writeFileSync(SCOPE_PROBE, `import { createSessionScope } from ${JSON.stringify(`${KIT_ROOT}/lib/session/session-scope.ts`)};
export default function (pi) {
	const scope = createSessionScope(pi);
	pi.on("session_start", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const lives = (globalThis.__childScopes ??= { opened: new Set(), closed: new Set() });
		lives.opened.add(id);
		scope.signal.addEventListener("abort", () => lives.closed.add(id));
	});
}
`);
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts", SCOPE_PROBE);

const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await importPi("dist/index.js");
/** pi's own loader, session manager and agent dir, as the seats here use them. */
export { DefaultResourceLoader, SessionManager, getAgentDir };
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");
atFinish(() => fs.rmSync(AGENT_DIR, { recursive: true, force: true }));

/** The keys of a flat stub seat that are the process's, not the session's; the engine splits them the same way. */
const PROCESS_KEYS = ["cwd", "agentDir", "exec", "childLoader", "now", "sleep"];
/** A runtime over a flat stub seat and the records its session file would fold to. */
export async function runtimeOver(flat, records = []) {
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const { AgentWaitBoard } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-wait-board.ts`);
	const deps = { cwd: "/", agentDir: AGENT_DIR, waitBoard: new AgentWaitBoard() };
	const port = { sessionFile: undefined, sessionDir: AGENT_DIR, depth: 0, role: "main", types: [], persist: () => {}, emit: () => {}, deliver: () => false, log: () => {}, hasPendingInput: () => false };
	for (const [key, value] of Object.entries(flat)) (PROCESS_KEYS.includes(key) ? deps : port)[key] = value;
	return new AgentRuntime(deps, port, records);
}

/**
 * One provider for the whole process, answering from a script keyed by the
 * last user text it sees, so a parent and every child it spawns share it and
 * each gets the lines written for it. `requests` records every `Context`
 * pi-ai was handed: system, tools and messages — the fork's whole contract.
 */
const script = new Map();
/** Every request the scripted provider answered, in order. */
export const requests = [];
/** Queues the steps answered to the longest script key the last user text contains. */
export const scriptFor = (userText, steps) => script.set(userText, [...steps]);
/** The last user text of a context, skipping drained notifications: what a script is keyed on. */
export const lastUserText = (context) => {
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
/** A scripted text block. */
export const text = (t) => ({ type: "text", text: t });
/** A scripted tool call block; the id is random unless given. */
export const call = (name, args, id = `call_${Math.random().toString(16).slice(2, 8)}`) => ({ type: "toolCall", id, name, arguments: args });

/** The scripted provider's stream: replays the script keyed by the last user text. */
export function streamSimple(model, context, options) {
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
	const input = globalThis.__billedInput ?? 10 * (context.messages.length + 1);
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

/** The scripted provider's model, `scripted/scripted-1`. */
export const SCRIPTED_MODEL = { id: "scripted-1", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
const scriptedProvider = (pi) => {
	pi.registerProvider("scripted", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: [SCRIPTED_MODEL] });
};

/** The process's one pi ModelRuntime, created after the agent dir is set. */
export const modelRuntime = await ModelRuntime.create({});
// A stub runtime built before any seat has loaded the provider factory must still resolve `scripted/scripted-1`.
scriptedProvider({ registerProvider: (name, config) => modelRuntime.registerProvider(name, config) });

/**
 * A main seat with the engine loaded, on the scripted model. `events` records
 * every `subagents:*` emission; `custom` every custom message the seat's
 * conversation received; `tools` every tool result the model was handed.
 *
 * It keeps pi's built-in tools, like a real seat does, because the tools array
 * is what C4 is about: a main seat built without them would make "the child's
 * array equals the parent's" a comparison between two different harnesses.
 */
export async function mainSeat({ persisted = true, extraExtensions = [], extraFactories = [], cwd = KIT_ROOT, resume } = {}) {
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
		additionalExtensionPaths: [`${KIT_ROOT}/extensions/agent-engine/index.ts`, ...extraExtensions],
		extensionFactories: [scriptedProvider, observer, ...extraFactories],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		thinkingLevel: "off",
		resourceLoader: loader,
		sessionManager: resume !== undefined ? SessionManager.open(resume) : persisted ? SessionManager.create(cwd) : SessionManager.inMemory(cwd),
		modelRuntime,
	});
	await session.bindExtensions({ mode: "print" });
	await session.setModel(modelRuntime.getModel("scripted", "scripted-1"));
	session.setActiveToolsByName([...session.getActiveToolNames(), "TaskStop"]);
	const toolResults = () => session.messages.filter((m) => m.role === "toolResult");
	const customs = () => session.messages.filter((m) => m.role === "custom");
	const tool = (name) => session.getToolDefinition(name);
	return { session, events, toolResults, customs, tool, bus };
}

/**
 * Idle with nothing in flight, delivery included. A settle now opens a turn of
 * its own (ticket 09), so a test that prompts straight after one would be
 * prompting a busy seat.
 */
export async function quiet(seat) {
	await until(() => seat.session.isStreaming, 300);
	await seat.session.waitForIdle();
}

/**
 * Runtimes over a throwaway repo whose git worktree removal, status check and
 * child loader can each be held at a named gate the test opens: the work in
 * flight a retire, an attach or a spawn overlaps. The repo is removed at finish.
 */
export async function inFlightRig() {
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const { AgentWaitBoard } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-wait-board.ts`);
	const { processExec } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-worktree.ts`);
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-inflight-repo-"));
	execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo, stdio: "pipe" });
	atFinish(() => fs.rmSync(repo, { recursive: true, force: true }));
	/** Named holds on the git removal and the child loader, each opened by the test. */
	const gates = new Map();
	const gate = (name) => {
		let open;
		const promise = new Promise((resolve) => (open = resolve));
		const held = { promise, reached: false, open: () => { gates.delete(name); open(); } };
		gates.set(name, held);
		return held;
	};
	const pass = async (name) => {
		const held = gates.get(name);
		if (held === undefined) return;
		held.reached = true;
		await held.promise;
	};
	const exec = async (command, args, options) => {
		if (args[0] === "worktree" && args[1] === "remove") await pass("remove");
		if (args[0] === "status") await pass("status");
		return processExec(command, args, options);
	};
	const childLoader = async ({ cwd }) => {
		await pass("loader");
		const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		return loader;
	};
	const deps = () => ({ cwd: repo, agentDir: AGENT_DIR, exec, childLoader, waitBoard: new AgentWaitBoard() });
	const port = (sessionId, persisted, over = {}) => ({ sessionId, sessionFile: undefined, sessionDir: path.join(AGENT_DIR, "sessions"), depth: 0, role: "main", types: [], model: () => scripted, resolveModel: () => scripted, exactModel: () => scripted, modelRuntime, persist: (record) => persisted.push(record), emit: () => {}, deliver: () => false, log: () => {}, hasPendingInput: () => false, ...over });
	const lastOf = (persisted, name) => persisted.filter((record) => record.name === name).at(-1);
	const prompted = (prompt) => requests.some((r) => lastUserText({ messages: r.messages }).includes(prompt));
	return { AgentRuntime, processExec, repo, gate, deps, port, lastOf, prompted };
}
