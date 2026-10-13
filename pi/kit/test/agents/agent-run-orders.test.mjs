/**
 * One isolation:"worktree" agent under generated orders of the events that can
 * overlap its run: the child loader resolves, two sends, a stop, the child's
 * turn ends, the worktree settle resolves or throws, the spawn's signal aborts,
 * the seat retires (twice), and the retire's bound passes. Each event is a held
 * gate the order opens. The 9! orders are sampled with a seeded shuffle,
 * `PI_KIT_ORDER_SAMPLES` of them (default 160), alternating the settle's
 * outcome, and every order must hold the five lifecycle invariants:
 * 1. every child runtime created is disposed, and at most one is undisposed at any moment;
 * 2. every worktree acquired (add or lock) is settled (unlock) exactly once;
 * 3. every send is refused, or its text reaches a prompt, or a stop, abort or retire later in the order took the run down first;
 * 4. at the end the record is terminal, the runtime holds no run and the seat no live agent;
 * 5. both retire calls resolve only after the record is written.
 */

import { atFinish, check, finish } from "../support/check-harness.mjs";
import { DefaultResourceLoader, getAgentDir, jiti, modelRuntime, SCRIPTED_MODEL } from "../support/agent-engine-seat.mjs";
import { importPi, KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_KIT_REPLY_FORMATS = "off";
const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
const { AgentWaitBoard } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-wait-board.ts`);
const { liveAgentsOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
const { createAssistantMessageEventStream } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");

const EVENTS = ["load", "sendA", "sendB", "stop", "turn", "settle", "abort", "retire", "bound"];
const TAKES_RUN_DOWN = new Set(["stop", "abort", "retire", "bound"]);
const SAMPLES = Number(process.env.PI_KIT_ORDER_SAMPLES ?? 160);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orders-"));
atFinish(() => fs.rmSync(HOME, { recursive: true, force: true }));

function deferred() {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
}

function mulberry32(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function sampledOrders(count, seed) {
	const random = mulberry32(seed);
	const seen = new Set();
	const orders = [];
	while (orders.length < count) {
		const order = [...EVENTS];
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[order[i], order[j]] = [order[j], order[i]];
		}
		const key = order.join();
		if (seen.has(key)) continue;
		seen.add(key);
		orders.push(order);
	}
	return orders;
}

let current;

function gatedStream(model, context, options) {
	const stream = createAssistantMessageEventStream();
	const order = current;
	order.requests.push(JSON.stringify(context.messages));
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let ended = false;
	const end = (message, kind) => {
		if (ended) return;
		ended = true;
		stream.push(kind === "error" ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: "stop", message });
		stream.end();
	};
	options?.signal?.addEventListener("abort", () => end({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "aborted", errorMessage: "Request was aborted", timestamp: Date.now() }, "error"), { once: true });
	order.turn.promise.then(() => {
		const message = { role: "assistant", content: [{ type: "text", text: "turn done" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
		if (ended) return;
		stream.push({ type: "start", partial: { ...message, content: [] } });
		end(message, "done");
	});
	return stream;
}

modelRuntime.registerProvider("gated", { baseUrl: "http://gated.invalid", apiKey: "gated", api: "gated-api", streamSimple: gatedStream, models: [{ ...SCRIPTED_MODEL, id: "gated-1", name: "gated" }] });
const gated = modelRuntime.getModel("gated", "gated-1");

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

function execFor(order) {
	return async (command, args) => {
		if (command !== "git") return { code: 1, stdout: "", stderr: "" };
		const [verb, sub] = args;
		if (verb === "rev-parse") return ok(args.includes("--is-inside-work-tree") ? "true\n" : args.includes("--show-toplevel") ? `${HOME}\n` : `${SHA}\n`);
		if (verb === "merge-base") return ok(`${SHA}\n`);
		if (verb === "worktree" && sub === "list") return { code: 1, stdout: "", stderr: "" };
		if (verb === "worktree" && (sub === "add" || sub === "lock")) {
			order.worktreeLog.push(sub);
			if (sub === "add") fs.mkdirSync(args.at(-2), { recursive: true });
			return ok();
		}
		if (verb === "worktree" && sub === "unlock") {
			order.worktreeLog.push("unlock");
			const verdict = await order.settle.promise;
			if (verdict === "throw" && !order.threw) {
				order.threw = true;
				throw new Error("worktree settle exploded");
			}
			return ok();
		}
		if (verb === "worktree" && sub === "remove") {
			fs.rmSync(args.at(-1), { recursive: true, force: true });
			return ok();
		}
		return ok();
	};
}

function probeFor(order) {
	return (pi) => {
		order.created++;
		const live = order.created - order.disposed;
		order.maxLive = Math.max(order.maxLive, live);
		pi.on("session_shutdown", () => {
			order.disposed++;
		});
	};
}

async function flush() {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

const settledStatus = (status) => status !== undefined && status !== "queued" && status !== "running";

async function runOrder(events, index) {
	const name = `order-${index}`;
	const seat = `orders-seat-${index}`;
	const order = { requests: [], worktreeLog: [], created: 0, disposed: 0, maxLive: 0, threw: false, turn: deferred(), load: deferred(), settle: deferred(), bounds: [], boundPassed: false };
	current = order;
	const signal = new AbortController();
	const deps = {
		cwd: HOME,
		agentDir: getAgentDir(),
		exec: execFor(order),
		childLoader: async ({ cwd }) => {
			await order.load.promise;
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [probeFor(order)] });
			await loader.reload();
			return loader;
		},
		sleep: (ms) => {
			if (order.boundPassed) return Promise.resolve();
			const held = deferred();
			order.bounds.push(held);
			return held.promise;
		},
		waitBoard: new AgentWaitBoard(),
	};
	const port = { sessionId: seat, sessionFile: undefined, sessionDir: path.join(getAgentDir(), "sessions"), depth: 0, role: "main", types: [], model: () => gated, resolveModel: () => gated, exactModel: () => gated, modelRuntime, persist: () => {}, emit: () => {}, deliver: () => false, log: () => {}, hasPendingInput: () => false };
	const runtime = new AgentRuntime(deps, port, []);
	const pending = [];
	const sends = [];
	const retires = [];
	pending.push(runtime.spawn({ description: "order", prompt: `Order ${index} brief.`, name, isolation: "worktree", signal: signal.signal }).catch(() => {}));
	await until(() => runtime.registry.byName(name) !== undefined, 2000);
	const taskId = runtime.registry.byName(name)?.taskId;
	for (const [at, event] of events.entries()) {
		if (event === "load") order.load.resolve();
		if (event === "turn") order.turn.resolve();
		if (event === "settle") order.settle.resolve(index % 2 === 0 ? "pass" : "throw");
		if (event === "abort") signal.abort();
		if (event === "bound") {
			order.boundPassed = true;
			for (const held of order.bounds) held.resolve();
		}
		if (event === "stop") pending.push(runtime.stop(name, "TaskStop").catch(() => {}));
		if (event === "sendA" || event === "sendB") {
			const message = `ORDER-${index}-${event}`;
			const sent = { message, at, fate: "pending" };
			sends.push(sent);
			pending.push(runtime.send(name, message, false, "Joel").then((outcome) => (sent.fate = outcome.kind), (error) => (sent.fate = error?._tag === "AgentSendRefused" ? "refused" : `threw ${error?.message}`)));
		}
		if (event === "retire") {
			for (let i = 0; i < 2; i++) {
				const call = { writtenAtResolve: undefined };
				retires.push(call);
				pending.push(runtime.retire("shutdown").then(() => (call.writtenAtResolve = settledStatus(runtime.registry.byTaskId(taskId)?.status))));
			}
		}
		await flush();
	}
	const drained = await Promise.race([Promise.all(pending).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
	const quiet = await until(() => order.created === order.disposed && liveAgentsOf(seat).size === 0 && runtime.liveRun(taskId) === undefined, 3000);
	const record = runtime.registry.byTaskId(taskId);
	const acquired = order.worktreeLog.filter((step) => step === "add" || step === "lock").length;
	const settles = order.worktreeLog.filter((step) => step === "unlock").length;
	const lostSends = sends.filter((sent) => {
		if (sent.fate === "refused") return false;
		if (order.requests.some((request) => request.includes(sent.message))) return false;
		return !(sent.fate === "queued" && events.slice(sent.at + 1).some((event) => TAKES_RUN_DOWN.has(event)));
	});
	const broken = [];
	if (!drained) broken.push("not every call returned");
	if (order.created !== order.disposed || order.maxLive > 1) broken.push(`1: runtimes created ${order.created} disposed ${order.disposed} max live ${order.maxLive}`);
	if (acquired !== settles) broken.push(`2: worktree ${order.worktreeLog.join(",")}`);
	if (lostSends.length > 0) broken.push(`3: lost ${lostSends.map((sent) => `${sent.message}=${sent.fate}`).join(" ")}`);
	if (!quiet || !settledStatus(record?.status)) broken.push(`4: record ${record?.status}, live ${liveAgentsOf(seat).size}, run ${runtime.liveRun(taskId) !== undefined}`);
	if (!retires.every((call) => call.writtenAtResolve === true)) broken.push(`5: retire resolved with the record ${retires.map((call) => call.writtenAtResolve).join(",")}`);
	return broken;
}

{
	console.log(`\n${SAMPLES} sampled orders of ${EVENTS.length} events on one worktree agent`);
	const started = Date.now();
	const failures = [];
	for (const [index, events] of sampledOrders(SAMPLES, 62).entries()) {
		const broken = await runOrder(events, index);
		if (broken.length > 0) failures.push(`${events.join(" ")} [${index % 2 === 0 ? "settle passes" : "settle throws"}]: ${broken.join("; ")}`);
	}
	console.log(`  ran in ${((Date.now() - started) / 1000).toFixed(1)} s`);
	check("every sampled order holds the five lifecycle invariants", failures.length === 0, `${failures.length} broken:\n       ${failures.slice(0, 8).join("\n       ")}`);
}

await finish();
