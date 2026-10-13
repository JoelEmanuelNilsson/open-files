/**
 * The seats the `agents/agent-session-*.test.mjs` files end sessions under:
 * real pi sessions under pi's own `AgentSessionRuntime`, on a scripted
 * provider, with the engine loaded. Importing it points the agent
 * dir and the child extensions at a private home, so a file imports it right
 * after the check harness, e.g.
 * `import { mainSeat, scriptFor, call, text } from "../support/session-lifecycle-seat.mjs";`.
 */

import { atFinish } from "./check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "./pi-package.mjs";
import { childExtensionsList } from "./child-extensions.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The one jiti every file of the family imports kit modules through. */
export const jiti = kitJiti({ moduleCache: false });

/** The private pi agent dir: the worker type, compaction off, the sessions dir. */
export const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-lifecycle-home-"));
fs.mkdirSync(path.join(AGENT_DIR, "agents"));
fs.writeFileSync(path.join(AGENT_DIR, "agents", "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(AGENT_DIR, "sessions");
// Children under test load the engine, nothing else.
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts");

const { createAgentSession, createAgentSessionRuntime, createEventBus, DefaultResourceLoader, ExtensionRunner, ModelRuntime, SessionManager, getAgentDir } = await importPi("dist/index.js");
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");
atFinish(() => fs.rmSync(AGENT_DIR, { recursive: true, force: true }));

/** The engine's runtime seam: `agentRuntimeOf(sessionId)`. */
export const seam = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);

const script = new Map();
/** Every request the scripted provider answered, in order. */
export const requests = [];
/** Queues the steps answered to the longest script key the last user text contains. */
export const scriptFor = (userText, steps) => script.set(userText, [...steps]);
/** A request's conversation, without the leading system message pi-ai folds the prompt and tools into. */
export const conversationOf = (request) => request.messages.filter((m) => m.role !== "system");
const lastUserText = (context) => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const t = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		// The harness's own injected messages are not the user's prompt: a nudge
		// steered into a live run must not decide which script the model follows.
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
	let aborted = false;
	const request = { model: model.id, sessionId: options?.sessionId, reasoning: options?.reasoning, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), messages: context.messages };
	requests.push(request);
	const key = [...script.keys()].filter((k) => lastUserText(context).includes(k)).sort((a, b) => b.length - a.length)[0];
	const steps = key === undefined ? undefined : script.get(key);
	const step = steps?.shift() ?? [text(`(no script for: ${lastUserText(context).slice(0, 60)})`)];
	// A provider that never answers an abort: the run stays streaming until the script ends it.
	if (!Array.isArray(step) && step.ignoreAbort === true) options = { ...options, signal: undefined };
	options?.signal?.addEventListener("abort", () => {
		if (aborted) return;
		aborted = true;
		const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() };
		stream.push({ type: "error", reason: "aborted", error: { ...partial, errorMessage: "Request was aborted" } });
		stream.end();
	}, { once: true });
	const content = Array.isArray(step) ? step : step.content;
	const delay = Array.isArray(step) ? 5 : (step.delay ?? 5);
	const live = Array.isArray(step) ? undefined : step.live;
	const stopReason = content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
	// The context grows 15 tokens per request in the process, so a ladder with
	// small thresholds can be walked turn by turn.
	const usage = { input: 10 * requests.length, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 * requests.length, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
	const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
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
		if (live !== undefined) {
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "…", partial: message });
			let open = true;
			live.attach({
				delta: (delta) => { if (open && !aborted) stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message }); },
				end: () => {
					if (!open || aborted) return;
					open = false;
					stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
					stream.push({ type: "done", reason: stopReason, message });
					stream.end();
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
		stream.push({ type: "done", reason: stopReason, message });
		stream.end();
	}, delay);
	return stream;
}

/** The scripted provider's default model, `scripted/scripted-1`. */
export const SCRIPTED_MODEL = { id: "scripted-1", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
// A second model that thinks: a seat can sit on something other than the
// default the next session would otherwise be created with.
const THINKING_MODEL = { ...SCRIPTED_MODEL, id: "scripted-2", name: "scripted thinker", reasoning: true };
/** Registers the `scripted` provider with the default and the thinking model. */
export const scriptedProvider = (pi) => {
	pi.registerProvider("scripted", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: [SCRIPTED_MODEL, THINKING_MODEL] });
};
const modelRuntime = await ModelRuntime.create({});

/**
 * A main seat under pi's own `AgentSessionRuntime`, the way `pi` itself runs
 * one: a fresh loader (fresh extension instances) per session, and
 * `ctx.newSession` bound to the runtime's replacement flow. `log` records
 * every session_start / session_shutdown with the file bytes at shutdown, so
 * the old file can be compared after the switch.
 */
export async function mainSeat({ extensions = [`${KIT_ROOT}/extensions/agent-engine/index.ts`], cwd = KIT_ROOT, provider = scriptedProvider, model = ["scripted", "scripted-1"], gap, onShutdown, onStart, sessionManager = SessionManager.create(cwd) } = {}) {
	const log = [];
	const events = [];
	const observer = (pi) => {
		pi.on("session_start", async (event, ctx) => {
			log.push({ type: "start", reason: event.reason, previous: event.previousSessionFile, file: ctx.sessionManager.getSessionFile(), id: ctx.sessionManager.getSessionId() });
			// Inline factories load after the extension files, so the engine has re-hosted by now.
			if (event.reason === "new") await onStart?.(ctx);
		});
		pi.on("session_shutdown", async (event, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			log.push({ type: "shutdown", reason: event.reason, target: event.targetSessionFile, file, bytes: file && fs.existsSync(file) ? fs.readFileSync(file) : undefined });
			// Inline factories load after the extension files, so the engine has retired by now.
			if (event.reason === "new") await onShutdown?.();
		});
		for (const channel of ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed"]) pi.events.on(channel, (payload) => events.push({ channel, ...payload }));
	};
	const createRuntime = async ({ cwd: runCwd, agentDir, sessionManager, sessionStartEvent }) => {
		// The old session is disposed and its ctx stale; the new one's session_start has not run.
		if (sessionStartEvent?.reason === "new") await gap?.();
		const loader = new DefaultResourceLoader({
			cwd: runCwd,
			agentDir,
			eventBus: createEventBus(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: extensions,
			extensionFactories: [provider, observer],
		});
		await loader.reload();
		const seatModel = modelRuntime.getModel(...model);
		const { session } = await createAgentSession({ cwd: runCwd, agentDir, thinkingLevel: "off", noTools: "builtin", resourceLoader: loader, sessionManager, modelRuntime, ...(seatModel ? { model: seatModel } : {}), ...(sessionStartEvent ? { sessionStartEvent } : {}) });
		return { session, services: { cwd: runCwd, agentDir, modelRuntime, settingsManager: session.settingsManager, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: getAgentDir(), sessionManager });
	const bind = async (session) => {
		await session.bindExtensions({
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
		await session.setModel(modelRuntime.getModel(...model));
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return { runtime, log, events, session: () => runtime.session };
}

/** Every entry of a session file, parsed. */
export const entriesOf = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

const wireSeatProvider = (pi) => pi.registerProvider("scripted-wire", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "anthropic-messages", streamSimple, models: [{ ...SCRIPTED_MODEL, id: "scripted-wire-1" }] });
/** A main seat on the Anthropic api, so `wire` rewrites each request's system array. */
export const wireSeat = (options = {}) => mainSeat({ provider: wireSeatProvider, model: ["scripted-wire", "scripted-wire-1"], ...options });

/** How many agent runs are live in the process. */
export const { liveAgentCount: liveCount } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
/** The last `agent-record` a session file holds for `name`. */
export const lastRecordOf = (file, name) => entriesOf(file).filter((e) => e.customType === "agent-record" && e.data?.name === name).at(-1)?.data;
/** A throwaway repository, so a worktree child's branch and directory never touch the kit's own. */
export function tempRepo() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-repo-"));
	const git = (...args) => execSync(`git ${args.join(" ")}`, { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	fs.writeFileSync(path.join(repo, "notes.txt"), "notes\n");
	git("add", "notes.txt");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return repo;
}

const { claimScreen: claimNoticeScreen, noticeSinkDir } = await jiti.import(`${KIT_ROOT}/lib/process/human-notice.ts`);
const STALE = "extension ctx is stale";
/** A scripted stream the test ends by hand; `attached` resolves with its controls once the provider streams it. */
export const liveStreamOf = () => {
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	return { attached, attach };
};
/**
 * Records the stack of every call into a stale runtime, including the ones an
 * extension swallows: every runner bound while it is installed, a child's too.
 * Returns the uninstall.
 */
const traceStaleCalls = (sink) => {
	const bindCore = ExtensionRunner.prototype.bindCore;
	ExtensionRunner.prototype.bindCore = function (...args) {
		for (const target of [this, this.runtime]) {
			const assert = target.assertActive.bind(target);
			target.assertActive = () => {
				try { assert(); } catch (error) { sink.push(new Error("stale").stack); throw error; }
			};
		}
		return bindCore.apply(this, args);
	};
	return () => { ExtensionRunner.prototype.bindCore = bindCore; };
};
/** Everything a stale call could leave behind: its stack, a throw, stderr, a notice, a session or notice file. */
export async function watchForStale(body) {
	const seen = { calls: [], thrown: [], stderr: [], said: [] };
	const onThrow = (error) => seen.thrown.push(String(error?.stack ?? error));
	process.on("uncaughtException", onThrow);
	process.on("unhandledRejection", onThrow);
	const write = process.stderr.write;
	process.stderr.write = function (chunk, ...rest) { seen.stderr.push(String(chunk)); return write.call(this, chunk, ...rest); };
	const release = claimNoticeScreen((message) => seen.said.push(message));
	const untrace = traceStaleCalls(seen.calls);
	try {
		await body();
	} finally {
		untrace();
		release();
		process.stderr.write = write;
		process.off("uncaughtException", onThrow);
		process.off("unhandledRejection", onThrow);
	}
	const files = [process.env.PI_CODING_AGENT_SESSION_DIR, noticeSinkDir()].flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, name)) : []));
	const staleFiles = files.filter((file) => fs.statSync(file).isFile() && fs.readFileSync(file, "utf8").includes(STALE));
	const lines = [...seen.thrown, ...seen.stderr, ...seen.said].filter((line) => line.includes(STALE));
	return { calls: seen.calls, lines, staleFiles };
}
/** A stale-call finding as one failure line. */
export const staleReport = ({ calls, lines, staleFiles }) => `${calls.length} stale calls${calls[0] ? `, first at:\n${calls[0].split("\n").slice(2, 8).map((l) => `         ${l.trim()}`).join("\n")}` : ""}; ${lines.length} lines (${lines[0]?.split("\n")[0]?.slice(0, 120) ?? ""}); files ${staleFiles.join(", ")}`;
