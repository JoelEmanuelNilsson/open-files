/**
 * The `Workflow` tool on real pi sessions, offline: the harness the
 * `workflow/workflow-*.test.mjs` seat files share. A private agent dir with a
 * `workflows/` directory and a child extension that holds a child's session
 * start for `globalThis.__workflowTestSpawnDelayMs`, one scripted provider for
 * the process (`scriptFor`, `requests`; a step may be `{ error }` or
 * `{ chunks, gapMs }`), and a main seat with the engine and the workflow
 * extension loaded. Importing it sets the agent dir and the child extensions,
 * so a file imports it right after the check harness, e.g.
 * `import { META, call, mainSeat, scriptFor, text } from "../support/workflow-seat.mjs";`.
 */

import { atFinish } from "./check-harness.mjs";
import { KIT_ROOT, importPi } from "./pi-package.mjs";
import { sleep, until } from "./async-waits.mjs";
import { childExtensionsList } from "./child-extensions.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The private pi agent dir; a saved workflow goes in its `workflows/`. */
export const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
atFinish(() => fs.rmSync(AGENT_DIR, { recursive: true, force: true }));
fs.mkdirSync(path.join(AGENT_DIR, "agents"));
fs.mkdirSync(path.join(AGENT_DIR, "workflows"));
fs.writeFileSync(path.join(AGENT_DIR, "agents", "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(AGENT_DIR, "sessions");
// Holds a child's session start for `globalThis.__workflowTestSpawnDelayMs`: the window in which a spawn is in flight.
fs.writeFileSync(path.join(AGENT_DIR, "slow-spawn.mjs"), "export default async function () { const ms = globalThis.__workflowTestSpawnDelayMs ?? 0; if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms)); }\n");
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts", "extensions/workflow/index.ts", "extensions/bash/index.ts", path.join(AGENT_DIR, "slow-spawn.mjs"));

const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await importPi("dist/index.js");
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");

const script = new Map();
/** Every request the scripted provider answered, in order, each with the time it was made. */
export const requests = [];
/** Queues the steps answered to the longest script key the last user text contains. */
export const scriptFor = (userText, steps) => script.set(userText, [...steps]);
/** The last user text of a context, skipping drained notifications: what a script is keyed on. */
export const lastUserText = (context) => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const t = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		if (t.includes("<task-notification>")) continue;
		return t;
	}
	return "";
};
/** A scripted text block. */
export const text = (t) => ({ type: "text", text: t });
/** A scripted tool call block; the id is random unless given. */
export const call = (name, args, id = `call_${Math.random().toString(16).slice(2, 8)}`) => ({ type: "toolCall", id, name, arguments: args });

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	let aborted = false;
	options?.signal?.addEventListener("abort", () => {
		if (aborted) return;
		aborted = true;
		const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() };
		stream.push({ type: "error", reason: "aborted", error: { ...partial, errorMessage: "Request was aborted" } });
		stream.end();
	}, { once: true });
	requests.push({ at: Date.now(), model: model.id, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), messages: context.messages });
	const key = [...script.keys()].filter((k) => lastUserText(context).includes(k)).sort((a, b) => b.length - a.length)[0];
	const steps = key === undefined ? undefined : script.get(key);
	const step = steps?.shift() ?? [text(`(no script for: ${lastUserText(context).slice(0, 60)})`)];
	// `error` ends the turn the way a provider refusal does: stopReason error, the provider's text as errorMessage.
	if (!Array.isArray(step) && step.error !== undefined) {
		const failed = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: step.error, timestamp: Date.now() };
		setTimeout(() => {
			if (aborted) return;
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end();
		}, step.delay ?? 5);
		return stream;
	}
	// `chunks` streams one text delta at a time, `gapMs` apart: the only way to write a step
	// that is alive for longer than its stall window without a tool call or a turn end in it.
	const chunks = Array.isArray(step) ? undefined : step.chunks;
	const content = chunks !== undefined ? [text(chunks.join(""))] : Array.isArray(step) ? step : step.content;
	const delay = (Array.isArray(step) ? undefined : step.delay) ?? 5;
	const stopReason = content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
	const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
	setTimeout(async () => {
		if (aborted) return;
		stream.push({ type: "start", partial: { ...message, content: [] } });
		if (chunks !== undefined) {
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			for (const chunk of chunks) {
				await sleep(step.gapMs ?? 100);
				if (aborted) return;
				stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: message });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
			stream.push({ type: "done", reason: stopReason, message });
			stream.end();
			return;
		}
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

/** Set to act on a lifecycle event the moment it is emitted, inside the emitting call. */
export const onLifecycle = { at: undefined };

/** A main seat with the engine and `Workflow` loaded; `events` and `progress` record the dock's channels. */
export async function mainSeat({ cwd = KIT_ROOT } = {}) {
	const events = [];
	const progress = [];
	const observer = (pi) => {
		for (const channel of ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed", "subagents:resumed"]) pi.events.on(channel, (payload) => { events.push({ channel, ...payload }); onLifecycle.at?.({ channel, ...payload }); });
		pi.events.on("workflow:progress", (payload) => progress.push(payload));
	};
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		eventBus: createEventBus(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [`${KIT_ROOT}/extensions/agent-engine/index.ts`, `${KIT_ROOT}/extensions/workflow/index.ts`],
		extensionFactories: [scriptedProvider, observer],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd, thinkingLevel: "off", noTools: "builtin", resourceLoader: loader, sessionManager: SessionManager.create(cwd), modelRuntime });
	await session.bindExtensions({ mode: "print" });
	// Carry Workflow, and the deferred TaskStop that `tool_search` would load.
	session.setActiveToolsByName([...session.getActiveToolNames(), "Workflow", "TaskStop"]);
	await session.setModel(modelRuntime.getModel("scripted", "scripted-1"));
	return {
		session,
		events,
		progress,
		toolResults: () => session.messages.filter((m) => m.role === "toolResult"),
		customs: () => session.messages.filter((m) => m.role === "custom"),
		records: () => session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data),
	};
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
/** A `meta` line for a script under test: `count-things`, one phase. */
export const META = "export const meta = { name: 'count-things', description: 'Count each thing', phases: [{ title: 'Count' }] }\n";
/** The first request whose last user text contains `fragment`: the one a child was started with. */
export const childRequestFor = (fragment) => requests.find((r) => lastUserText({ messages: r.messages }).includes(fragment));
