/**
 * A real pi seat on a scripted model: pi's own `AgentSessionRuntime`, loop and
 * extensions, with a provider whose `streamSimple` replays assistant turns
 * written by the test. One scripted model serves a whole process, so a seat and
 * every child the engine spawns share it; `requests` records each `Context`
 * pi-ai was handed. A test uses it like this:
 *
 *   createScriptedAgentDir("agent-engine", { "agents/lead.md": "…" });
 *   process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts");
 *   const model = createScriptedModel();
 *   const seat = await scriptedMainSeat(model, { extensions: ["extensions/agent-engine/index.ts"] });
 *   model.scriptFor("Do the work", [[scriptedCall("Agent", {...})], [scriptedText("spawned")]]);
 *   await seat.session.prompt("Do the work");
 *   await quietSeat(seat);
 *
 * Unifies the harnesses batch C's analysts planned: agent-engine
 * (agent-engine-seat: scripted provider, shared model runtime, mainSeat with
 * extra extensions and factories, the event bus, quiet), workflow
 * (scripted-seat: error and chunked steps, request times, childRequestFor,
 * agent records, lifecycle events as emitted, workflow progress) and
 * continuation-and-side-chat (scripted-provider + runtime-seat: live and
 * abort-deaf steps, the anthropic payload hook, a seat under
 * `AgentSessionRuntime` with gap/onStart/onShutdown and a start/shutdown log).
 */

import { atFinish } from "./check-harness.mjs";
import { until } from "./async-waits.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIT_ROOT, importPi } from "./pi-package.mjs";

const { createAgentSession, createAgentSessionRuntime, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await importPi("dist/index.js");
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");

/** The scripted provider's default model, `scripted/scripted-1`. */
export const SCRIPTED_MODEL = { id: "scripted-1", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * Makes a private pi agent dir — `settings.json` with compaction off, a
 * `worker` agent type, and `files` (relative path → content; a path ending in
 * `/` is a directory) — points PI_CODING_AGENT_DIR and its sessions dir at it,
 * and removes it at finish. Call before any seat or model runtime exists.
 */
export function createScriptedAgentDir(name, files = {}) {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-home-`));
	const all = { "settings.json": JSON.stringify({ compaction: { enabled: false } }), "agents/worker.md": "---\nname: worker\ndescription: One job, one result.\n---\n", ...files };
	for (const [relative, content] of Object.entries(all)) {
		const target = path.join(agentDir, relative);
		if (relative.endsWith("/")) {
			fs.mkdirSync(target, { recursive: true });
			continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
	atFinish(() => fs.rmSync(agentDir, { recursive: true, force: true }));
	return agentDir;
}

/** A scripted text block for a step. */
export const scriptedText = (text) => ({ type: "text", text });

/** A scripted tool call block for a step; the id is random unless given. */
export const scriptedCall = (name, args, id = `call_${Math.random().toString(16).slice(2, 8)}`) => ({ type: "toolCall", id, name, arguments: args });

/** The last user text in a context, skipping drained `<task-notification>` messages: what a script is keyed on. */
export function lastUserText(context) {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const text = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		// A drained notification rides after the prompt as a user message; the script keys on what Joel typed.
		if (text.includes("<task-notification>")) continue;
		return text;
	}
	return "";
}

let providingModel;

/** Default usage: the input grows with the context, so a run's summed usage and its last message's differ (issues/31 (d)). */
const usageGrowingWithContext = ({ context }) => {
	const input = 10 * (context.messages.length + 1);
	return { input, output: 5, totalTokens: input + 5 };
};

/**
 * A scripted model: `scriptFor(userText, steps)` queues the turns answered to
 * the longest script key the last user text contains. A step is an array of
 * blocks, or `{ content, delay }`, `{ error }` (a provider refusal),
 * `{ chunks, gapMs }` (one text delta per chunk, `gapMs` apart), `{ content,
 * live }` (open until `live.attach`'s controls call `end()`), and any of them
 * may add `ignoreAbort: true`. `usage({ context, requestCount })` returns
 * `{ input, output, totalTokens }` per request. Only one scripted model may
 * provide for seats in a process (see `providerExtension`).
 */
export function createScriptedModel({ usage = usageGrowingWithContext } = {}) {
	const self = {};
	const script = new Map();
	const requests = [];
	const scriptFor = (userText, steps) => script.set(userText, [...steps]);

	function streamSimple(model, context, options) {
		const stream = createAssistantMessageEventStream();
		let aborted = false;
		const request = { at: Date.now(), model: model.id, sessionId: options?.sessionId, reasoning: options?.reasoning, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), messages: context.messages };
		requests.push(request);
		const userText = lastUserText(context);
		const key = [...script.keys()].filter((k) => userText.includes(k)).sort((a, b) => b.length - a.length)[0];
		const step = (key === undefined ? undefined : script.get(key).shift()) ?? [scriptedText(`(no script for: ${userText.slice(0, 60)})`)];
		const shaped = Array.isArray(step) ? { content: step } : step;
		const delay = shaped.delay ?? 5;
		// Like the real provider: an abort ends the stream at once with an aborted message — unless the step is deaf to it.
		if (shaped.ignoreAbort !== true) {
			options?.signal?.addEventListener("abort", () => {
				if (aborted) return;
				aborted = true;
				const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "aborted", timestamp: Date.now() };
				stream.push({ type: "error", reason: "aborted", error: { ...partial, errorMessage: "Request was aborted" } });
				stream.end();
			}, { once: true });
		}
		if (shaped.error !== undefined) {
			const failed = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "error", errorMessage: shaped.error, timestamp: Date.now() };
			setTimeout(() => {
				if (aborted) return;
				stream.push({ type: "error", reason: "error", error: failed });
				stream.end();
			}, delay);
			return stream;
		}
		const content = shaped.chunks !== undefined ? [scriptedText(shaped.chunks.join(""))] : shaped.content;
		const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
		const tokens = usage({ context, requestCount: requests.length });
		const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: tokens.input, output: tokens.output, cacheRead: 0, cacheWrite: 0, totalTokens: tokens.totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason, timestamp: Date.now() };
		const done = () => {
			stream.push({ type: "done", reason: stopReason, message });
			stream.end();
		};
		setTimeout(async () => {
			// A custom provider is what calls pi's `before_provider_request`; on the
			// Anthropic api that is where `wire` writes the system array.
			if (model.api === "anthropic-messages") {
				const tools = getCurrentTools(context.messages).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
				const payload = await options?.onPayload?.({ model: model.id, system: [{ type: "text", text: "vanilla pi prompt", cache_control: { type: "ephemeral" } }], messages: [], tools }, model);
				request.wireSystem = payload?.system;
				request.wireTools = payload?.tools ?? tools;
			}
			if (aborted) return;
			stream.push({ type: "start", partial: { ...message, content: [] } });
			if (shaped.chunks !== undefined) {
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				for (const chunk of shaped.chunks) {
					await new Promise((resolve) => setTimeout(resolve, shaped.gapMs ?? 100));
					if (aborted) return;
					stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: message });
				}
				stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
				return done();
			}
			if (shaped.live !== undefined) {
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "…", partial: message });
				let open = true;
				shaped.live.attach({
					delta: (delta) => {
						if (open && !aborted) stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
					},
					end: () => {
						if (!open || aborted) return;
						open = false;
						stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
						done();
					},
				});
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
			done();
		}, delay);
		return stream;
	}

	return Object.assign(self, {
		scriptFor,
		requests,
		streamSimple,
		/** The first request whose last user text contains `fragment`, e.g. the one a child was started with. */
		requestFor: (fragment) => requests.find((request) => lastUserText(request).includes(fragment)),
		/** An extension factory registering this model's provider (default `scripted` on `scripted-api` with SCRIPTED_MODEL); throws if another scripted model already provides. */
		providerExtension: ({ name = "scripted", api = "scripted-api", models = [SCRIPTED_MODEL] } = {}) => {
			// pi keeps one stream per provider for the whole process, so a second
			// model's registration would silently answer the first model's seats.
			if (providingModel !== undefined && providingModel !== self) throw new Error("createScriptedModel: another scripted model already provides for seats in this process; share one model");
			providingModel = self;
			return (pi) => {
				pi.registerProvider(name, { baseUrl: "http://scripted.invalid", apiKey: "scripted", api, streamSimple, models });
			};
		},
	});
}

let modelRuntime;

/** The process's one pi ModelRuntime, created on first use — after the agent dir is set. */
export async function scriptedModelRuntime() {
	modelRuntime ??= await ModelRuntime.create({});
	return modelRuntime;
}

const SUBAGENT_CHANNELS = ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed", "subagents:resumed"];

/**
 * A main seat under pi's own `AgentSessionRuntime`, the way `pi` runs one: a
 * fresh loader per session and `ctx.newSession` bound to the runtime's
 * replacement flow. `session` and `bus` are always the current session's.
 * `events` records every `subagents:*` emission (`onSubagentEvent` sees each
 * as it is emitted), `progress` every `workflow:progress`, `log` every
 * session_start / session_shutdown with the file bytes at shutdown.
 * `extensions` are kit-relative or absolute; `factories` default to the
 * scripted provider; `beforeSwitch` runs in pi's `session_before_switch`, after
 * the old session's last turn and before its shutdown; `gap` runs between the
 * old session's shutdown and the new one's start.
 */
export async function scriptedMainSeat(scripted, {
	extensions = ["extensions/agent-engine/index.ts"],
	factories = [scripted.providerExtension()],
	cwd = KIT_ROOT,
	builtinTools = false,
	model = ["scripted", "scripted-1"],
	sessionManager = SessionManager.create(cwd),
	onSubagentEvent,
	beforeSwitch,
	gap,
	onStart,
	onShutdown,
} = {}) {
	const runtimeModels = await scriptedModelRuntime();
	const log = [];
	const events = [];
	const progress = [];
	let bus;
	const observer = (pi) => {
		pi.on("session_start", async (event, ctx) => {
			log.push({ type: "start", reason: event.reason, previous: event.previousSessionFile, file: ctx.sessionManager.getSessionFile(), id: ctx.sessionManager.getSessionId() });
			// The observer loads after the extension files, so they have re-hosted by now.
			if (event.reason === "new") await onStart?.(ctx);
		});
		if (beforeSwitch !== undefined) pi.on("session_before_switch", async () => {
			await beforeSwitch();
		});
		pi.on("session_shutdown", async (event, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			log.push({ type: "shutdown", reason: event.reason, target: event.targetSessionFile, file, bytes: file && fs.existsSync(file) ? fs.readFileSync(file) : undefined });
			// The observer loads after the extension files, so their shutdown handlers have run by now.
			if (event.reason === "new") await onShutdown?.();
		});
		for (const channel of SUBAGENT_CHANNELS) {
			pi.events.on(channel, (payload) => {
				events.push({ channel, ...payload });
				onSubagentEvent?.({ channel, ...payload });
			});
		}
		pi.events.on("workflow:progress", (payload) => progress.push(payload));
	};
	const createRuntime = async ({ cwd: runCwd, agentDir, sessionManager: runSessionManager, sessionStartEvent }) => {
		// The old session is disposed and its ctx stale; the new one's session_start has not run.
		if (sessionStartEvent?.reason === "new") await gap?.();
		bus = createEventBus();
		const loader = new DefaultResourceLoader({
			cwd: runCwd,
			agentDir,
			eventBus: bus,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: extensions.map((entry) => path.resolve(KIT_ROOT, entry)),
			extensionFactories: [...factories, observer],
		});
		await loader.reload();
		const seatModel = runtimeModels.getModel(...model);
		const { session } = await createAgentSession({
			cwd: runCwd,
			agentDir,
			thinkingLevel: "off",
			...(builtinTools ? {} : { noTools: "builtin" }),
			resourceLoader: loader,
			sessionManager: runSessionManager,
			modelRuntime: runtimeModels,
			...(seatModel ? { model: seatModel } : {}),
			...(sessionStartEvent ? { sessionStartEvent } : {}),
		});
		return { session, services: { cwd: runCwd, agentDir, modelRuntime: runtimeModels, settingsManager: session.settingsManager, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: getAgentDir(), sessionManager });
	const bind = async (session) => {
		await session.bindExtensions({
			mode: "tui",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
			},
		});
		await session.setModel(runtimeModels.getModel(...model));
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return {
		runtime,
		modelRuntime: runtimeModels,
		get session() {
			return runtime.session;
		},
		get bus() {
			return bus;
		},
		events,
		progress,
		log,
		toolResults: () => runtime.session.messages.filter((message) => message.role === "toolResult"),
		customs: () => runtime.session.messages.filter((message) => message.role === "custom"),
		tool: (name) => runtime.session.getToolDefinition(name),
		/** The engine's `agent-record` entries in the current session file, as data. */
		agentRecords: () => runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "agent-record").map((entry) => entry.data),
	};
}

/**
 * Idle with nothing in flight, delivery included: a settle opens a turn of its
 * own (ticket 09), so a test that prompts straight after one would be
 * prompting a busy seat. Waits up to 300 ms for that turn to start.
 */
export async function quietSeat(seat) {
	await until(() => seat.session.isStreaming, 300);
	await seat.session.waitForIdle();
}
