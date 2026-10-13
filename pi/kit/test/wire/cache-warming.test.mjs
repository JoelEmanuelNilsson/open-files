/**
 * The kit's cache warmer (extensions/wire/cache-warmer.ts), driven through the
 * wire extension with the clock faked: it replays the seat's last request with
 * one output token before the entry expires, until 30 minutes after the last
 * real request, never for an entry already expired or a transcript replaced by
 * a compaction or a tree navigation, and the prompt box's countdown
 * (lib/wire/cache-touch.ts) covers only what was sent and the one warm scheduled.
 */

import { check, finish } from "../support/check-harness.mjs";
import { mock } from "node:test";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cache-warming-test-"));
process.env.PI_WIRE_TRACE_DIR = DIR;
delete process.env.PI_WIRE_TRACE;

const MIN = 60_000;
const T0 = Date.parse("2026-10-09T09:35:05Z");
mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });

const jiti = kitJiti({ moduleCache: false });
const { cacheLabel, readCacheTouch, seatWantsWarming } = await jiti.import(`${KIT_ROOT}/lib/wire/cache-touch.ts`);
const { declareChildSeat, forgetChildSeat } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
const { readLastRequest } = await jiti.import(`${KIT_ROOT}/lib/wire/last-request.ts`);

const TURN = {
	model: "claude-test",
	max_tokens: 32000,
	stream: true,
	system: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral" } }],
	tools: [{ name: "Read", input_schema: { type: "object" } }],
	messages: [{ role: "user", content: [{ type: "text", text: "go", cache_control: { type: "ephemeral" } }] }],
};
const USAGE = { input: 2, output: 1, cacheRead: 68_269, cacheWrite: 0, totalTokens: 68_272 };

let instance = 0;
/** One seat running the wire, with the provider faked at pi-ai's stream boundary answering `events`. */
async function seat(sessionId, events = [{ type: "done", message: { usage: USAGE } }]) {
	const pi = fakeExtensionApi({ getSettings: () => ({ cacheWarming: "idle" }) });
	(await jiti.import(`${KIT_ROOT}/extensions/wire/index.ts?warm${++instance}`)).default(pi.api);
	const sent = [];
	const notices = [];
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "anthropic", id: "claude-test", api: "anthropic-messages" },
		modelRegistry: {
			isUsingOAuth: () => true,
			find: (provider, id) => ({ provider, id }),
			getAvailable: () => [{ provider: "anthropic", id: "claude-test" }],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token", headers: {} }),
			getProvider: () => ({
				stream: (_model, _context, options) => {
					sent.push(options.onPayload());
					return (async function* () {
						yield* events;
					})();
				},
			}),
		},
		sessionManager: { getLeafId: () => "leaf-1", getSessionId: () => sessionId, getHeader: () => ({ id: sessionId }) },
		hasUI: true,
		isIdle: () => true,
		ui: { setStatus: () => {}, notify: (message) => notices.push(message), theme: { fg: (_c, s) => s } },
	};
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	await pi.fire("before_agent_start", { systemPromptOptions: { cwd: process.cwd(), customPrompt: "You are a worker." } }, ctx);
	const request = async () => (await pi.fire("before_provider_request", { payload: structuredClone(TURN) }, ctx)).at(-1);
	const shutdown = (reason) => pi.fire("session_shutdown", { type: "session_shutdown", reason }, ctx);
	return { pi, ctx, sent, notices, request, shutdown };
}

/** Advance the clock by `ms` and let a warm that fired finish its stream. */
async function advance(ms) {
	mock.timers.tick(ms);
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const warmsIn = (sessionId) =>
	fs.readFileSync(path.join(DIR, `${sessionId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.t === "warm").length;

console.log("cache-warming: the main seat stays warm through an idle pause, up to 30 minutes after its last request");
{
	const main = await seat("main-idle");
	const turn = await main.request();
	check("pi's own warmer is told to stop for an Anthropic request", isDeepStrictEqual(await main.pi.fire("cache_warming_decision", { type: "cache_warming_decision", action: "stop" }, main.ctx), [{ action: "stop" }]));
	check("right after the request the box counts to the last planned warm (27m) plus its 5-minute entry: 32m", cacheLabel(readCacheTouch("main-idle"), Date.now(), seatWantsWarming("main-idle")) === "❄32m");

	await advance(4.5 * MIN);
	check("at 4m30s the last request goes out again with one output token", main.sent.length === 1 && isDeepStrictEqual(main.sent[0], { ...turn, max_tokens: 1 }));
	check("the session records the warm and what it read", isDeepStrictEqual(main.pi.entries, [{ type: "custom", customType: "cache_warm", data: { model: "claude-test", usage: USAGE } }]));
	check("the wire trace files it as a warm", warmsIn("main-idle") === 1);
	check("after the warm the box keeps counting down: 27m30s left, no jump back", cacheLabel(readCacheTouch("main-idle"), Date.now(), seatWantsWarming("main-idle")) === "❄27m");

	for (let step = 0; step < 6; step++) await advance(4.5 * MIN);
	check("six warms fit in the 30 minutes after the request, every 4m30s", main.sent.length === 6);
	check("at 31m30s the box counts the last warm's entry (27m plus 5m)", cacheLabel(readCacheTouch("main-idle"), Date.now(), seatWantsWarming("main-idle")) === "❄30s");
	await advance(1 * MIN);
	check("and shows the prefix cold when it is", cacheLabel(readCacheTouch("main-idle"), Date.now(), seatWantsWarming("main-idle")) === "❄");
	await main.shutdown("quit");
}

console.log("cache-warming: a model switch leaves nothing to warm, so the box stops projecting warms");
{
	const main = await seat("main-switched");
	await main.request();
	check("before the switch the box projects the warms (32m)", cacheLabel(readCacheTouch("main-switched"), Date.now(), seatWantsWarming("main-switched")) === "❄32m");
	main.ctx.model = { provider: "anthropic", id: "claude-other", api: "anthropic-messages" };
	await main.pi.fire("model_select", { type: "model_select" }, main.ctx);
	check("after it the box counts only the entry's own 5 minutes", cacheLabel(readCacheTouch("main-switched"), Date.now(), seatWantsWarming("main-switched")) === "❄5m");
	await advance(5 * MIN);
	check("and no warm is sent", main.sent.length === 0);
	await main.shutdown("quit");
}

console.log("cache-warming: a failed warm is said once, and the box falls back to the entry's own lifetime");
{
	const main = await seat("main-failing", [{ type: "error", error: { errorMessage: "overloaded" } }]);
	await main.request();
	await advance(4.5 * MIN);
	check("one notice gives the reason", isDeepStrictEqual(main.notices, ["cache warming stopped: the warm request failed (overloaded); the next request writes the prefix again"]));
	check("the box counts down the last request's entry: 30 seconds left", cacheLabel(readCacheTouch("main-failing"), Date.now(), seatWantsWarming("main-failing")) === "❄30s");
	await advance(10 * MIN);
	check("no second warm is tried", main.sent.length === 1);
	await main.shutdown("quit");
}

console.log("cache-warming: a reload hands the schedule to the new wire instance");
{
	const before = await seat("main-reload");
	await before.request();
	await before.shutdown("reload");
	const after = await seat("main-reload");
	await advance(4.5 * MIN);
	check("the old instance sends nothing", before.sent.length === 0);
	check("the new instance warms the entry the old one's request wrote", after.sent.length === 1);
	await after.shutdown("quit");
}

console.log("cache-warming: a transcript that was replaced leaves nothing to warm until the next request");
for (const [event, why] of [["session_compact", "compaction"], ["session_tree", "tree navigation"]]) {
	const sessionId = `main-${event}`;
	const main = await seat(sessionId);
	await main.request();
	await advance(4.5 * MIN);
	check(`before ${why} the entry is warmed`, main.sent.length === 1);
	await main.pi.fire(event, { type: event }, main.ctx);
	check(`${why} drops the request the warm would replay`, readLastRequest(sessionId, main.ctx.model) === undefined);
	check(`${why} drops the countdown for the old prefix`, cacheLabel(readCacheTouch(sessionId), Date.now(), seatWantsWarming(sessionId)) === "");
	await advance(30 * MIN);
	check(`after ${why} no warm replays the old prefix`, main.sent.length === 1);
	await main.request();
	await advance(4.5 * MIN);
	check(`the first request after ${why} starts warming again`, main.sent.length === 2);
	await main.shutdown("quit");
}

console.log("cache-warming: a warm in flight when the transcript is replaced is abandoned");
{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const main = await seat("main-inflight", (async function* () {
		await gate;
		yield { type: "done", message: { usage: USAGE } };
	})());
	await main.request();
	await advance(4.5 * MIN);
	check("the warm is on the wire", main.sent.length === 1);
	await main.pi.fire("session_compact", { type: "session_compact" }, main.ctx);
	release();
	await advance(1);
	check("its answer files nothing in the session", main.pi.entries.length === 0);
	check("its answer files nothing in the wire trace", warmsIn("main-inflight") === 0);
	check("and no countdown is rebuilt for the old prefix", readCacheTouch("main-inflight") === undefined);
	await main.shutdown("quit");
}

console.log("cache-warming: a warm that comes due after the entry expired is not sent");
{
	const main = await seat("main-slept");
	await main.request();
	mock.timers.setTime(Date.now() + 20 * MIN);
	await advance(1);
	check("the machine slept past the entry's life: the warm would write the whole prefix again, so none is sent", main.sent.length === 0);
	check("and the box shows the prefix cold", cacheLabel(readCacheTouch("main-slept"), Date.now(), seatWantsWarming("main-slept")) === "❄");
	check("and no notice says warming stopped", main.notices.length === 0);
	await main.shutdown("quit");
}

console.log("cache-warming: a reload that lands after the entry expired does not warm it");
{
	const before = await seat("main-reload-late");
	await before.request();
	await before.shutdown("reload");
	mock.timers.setTime(Date.now() + 20 * MIN);
	const after = await seat("main-reload-late");
	await advance(1);
	check("the new instance sends nothing for an entry that no longer exists", after.sent.length === 0);
	await after.shutdown("quit");
}

console.log("cache-warming: a child seat is warmed only while it has something running");
{
	declareChildSeat("child-idle", { name: "c", role: "worker", depth: 1, parentSessionId: "main", workflowChild: false, agentTypes: [], workflows: false, prompt: { kind: "own" } });
	const child = await seat("child-idle");
	await child.request();
	await advance(4.5 * MIN);
	check("an idle child is not warmed", child.sent.length === 0);
	check("and its box counts down the last request's entry", cacheLabel(readCacheTouch("child-idle"), Date.now(), seatWantsWarming("child-idle")) === "❄30s");
	await child.shutdown("quit");
	forgetChildSeat("child-idle");
}

mock.timers.reset();
await finish();
