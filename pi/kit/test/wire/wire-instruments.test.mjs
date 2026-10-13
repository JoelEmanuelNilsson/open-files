/**
 * The wire extension's instruments, driven through the extension: the cache
 * trace and /trace, the model witness, and the quota meter reading the
 * response. Each rides beside the request and never rewrites it.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { bootWire } from "../support/boot-wire.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wire-instruments-test-"));
process.env.PI_WIRE_TRACE_DIR = DIR;
delete process.env.PI_WIRE_TRACE;

const thinkingBlock = (text, signature) => ({ type: "thinking", thinking: text, signature });
const textBlock = (text) => ({ type: "text", text });

const payloadOf = ({ system = ["prompt"], tools = ["Read", "Bash"], messages = [] } = {}) => ({
	system: system.map((text, i) => ({ type: "text", text, ...(i === system.length - 1 ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) })),
	tools: tools.map((name, i) => ({ name, input_schema: { type: "object" }, ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) })),
	messages,
});

const loop = (extra = []) => [
	{ role: "user", content: [textBlock("go")] },
	{ role: "assistant", content: [thinkingBlock("a long think", "sig-A"), { type: "tool_use", id: "t1", name: "Read", input: {} }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file", cache_control: { type: "ephemeral" } }] },
	...extra,
];

/** Anchored to the wall clock so the resets cannot pass; quota-meter.test.mjs says why. */
const NOW_SEC = Math.floor(Date.now() / 1000);
const FIVE_HOUR_RESET_SEC = NOW_SEC + 70_000;
const SEVEN_DAY_RESET_SEC = NOW_SEC + 500_000;

/** A full header bag, as Anthropic sends it on a subscription response. */
const HEADERS = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-5h-utilization": "0.34",
	"anthropic-ratelimit-unified-7d-utilization": "0.61",
	"anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET_SEC),
	"anthropic-ratelimit-unified-7d-reset": String(SEVEN_DAY_RESET_SEC),
	"anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
	"request-id": "req_abc",
};

// ---------------------------------------------------------------------------
console.log("\nwire: the trace rides along without touching the wire");
{
	const { handlers, commands } = await bootWire(jiti, "?trace");
	const notices = [];
	const ctx = {
		cwd: process.cwd(),
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }), getAvailable: () => [{ provider: "anthropic", id: "claude-test" }] },
		sessionManager: { getLeafId: () => null, getSessionId: () => "session-wire", getHeader: () => ({ id: "session-wire" }) },
		hasUI: true,
		ui: { setStatus: () => {}, notify: (m) => notices.push(m), theme: { fg: (_c, s) => s } },
	};
	// The model witness reads the launcher's declaration off argv, and falls back
	// to pi's settings file when argv is silent. Declared here so this suite tests
	// the kit rather than whatever `defaultModel` this machine happens to hold.
	process.argv.push("--model", "anthropic/claude-test");
	// As a live seat arrives: pi captures the prompt options at turn start, and
	// only then is a request built. Without it `wire` refuses to build a prompt
	// at all, which is a different suite's subject.
	handlers.get("before_agent_start")({ systemPromptOptions: { cwd: process.cwd() } }, ctx);
	const send = (messages) => handlers.get("before_provider_request")({ payload: { ...payloadOf({ messages }), system: [{ type: "text", text: "vanilla", cache_control: { type: "ephemeral", ttl: "1h" } }] } }, ctx);

	const first = send(loop());
	check("the wire still owns the system array with the trace in the path", first.system[0].text.startsWith("x-anthropic-billing-header:") && first.system.length === 4);
	handlers.get("message_end")({ message: { role: "assistant", usage: { input: 4, cacheRead: 0, cacheWrite: 9033 } } }, ctx);
	check("a non-assistant message is not paired with a request", handlers.get("message_end")({ message: { role: "user" } }, ctx) === undefined);

	const restated = loop();
	restated[1] = { role: "assistant", content: [thinkingBlock("a summarised think", "sig-A")] };
	send(restated);
	handlers.get("message_end")({ message: { role: "assistant", usage: { input: 4, cacheRead: 7399, cacheWrite: 82435 } } }, ctx);
	check("the break reaches the human as one line", notices.length === 1 && notices[0].startsWith("wire: cache break: edit \u2014 messages[1] changed"), notices.join(" | "));
	check("/trace is registered so the file is findable", commands.has("trace"));
	notices.length = 0;
	await commands.get("trace").handler("", ctx);
	// The re-billed total renders here and nowhere else: money is diagnosis on demand, never chrome.
	check("/trace prices the session off its own ledger",
		notices.length === 1 && notices[0].includes("session-wire.jsonl") && notices[0].includes("1,634 tokens re-billed"), notices.join(" | "));

	await commands.get("prompt").handler("", { ...ctx, hasUI: false });
	const promptDump = path.join(DIR, "prompt-session-wire.md");
	check("/prompt lands in the private state dir, not world-readable /tmp", fs.existsSync(promptDump) && (fs.statSync(promptDump).mode & 0o777) === 0o600);

	const tracePath = path.join(DIR, "session-wire.jsonl");
	const lines = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const firstReq = lines.find((line) => line.t === "req");
	check("the traced system blocks are the owned ones, not pi's", firstReq.sys.length === 4 && firstReq.bp.includes("system[2]"));
	const body = lines.find((line) => line.t === "prompt");
	check("the first request records the cached block's text, so two sessions can be diffed", body?.n === 1 && body.hash === firstReq.sys[2] && body.text.length > 0, JSON.stringify(body?.text?.slice(0, 40)));
	check("and only once — it is a per-session fact", lines.filter((line) => line.t === "prompt").length === 1);
	check("the trace is a per-session file", fs.existsSync(tracePath));
}

// ---------------------------------------------------------------------------
// The instrument is only worth anything wired up: the headers have to reach the
// trace and `/quota` off a real response, through the one extension that holds
// the request. Driven through a stand-in ExtensionAPI, as the trace is above.
//
// The bottom rule is the contract that matters here. Joel ruled the quota label
// off it — the numbers are for diagnosis on demand — so the test pins that no
// status is written at all, not merely that it reads well.
console.log("\nwire: the meter reads the response the harness already had");
{
	const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quota-meter-test-"));
	process.env.PI_WIRE_TRACE_DIR = DIR;
	const { handlers, commands } = await bootWire(jiti, "?quota");
	const statuses = new Map();
	const notices = [];
	const ctx = {
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) },
		sessionManager: { getLeafId: () => null, getSessionId: () => "session-quota", getHeader: () => ({ id: "session-quota" }) },
		hasUI: true,
		cwd: "/tmp",
		ui: { setStatus: (key, value) => statuses.set(key, value), notify: (text) => notices.push(text), theme: { fg: (_c, s) => s } },
	};

	check("nothing has been read before the first response", (await runQuota(commands, ctx, notices)).startsWith("No quota headers seen yet"));

	handlers.get("after_provider_response")({ status: 200, headers: HEADERS }, ctx);
	check("no quota status reaches the bottom rule", statuses.size === 0, [...statuses.keys()].join(","));
	const asked = await runQuota(commands, ctx, notices);
	check("`/quota` prints the two windows on demand", asked.startsWith("Quota 5h 34% · 7d 61%"), asked);
	check("`/quota` prints the resets it knows", asked.includes("5h resets ") && asked.includes("7d resets "), asked);

	// A response without the headers is not a fresh allowance. Forgetting the
	// reading on one would blank the answer every time a proxy or a side request
	// answered without them.
	handlers.get("after_provider_response")({ status: 200, headers: { "request-id": "req_2" } }, ctx);
	check("a response with no quota headers leaves the last reading standing", (await runQuota(commands, ctx, notices)).startsWith("Quota 5h 34% · 7d 61%"));
	check("the bottom rule is still untouched", statuses.size === 0, [...statuses.keys()].join(","));

	const payload = {
		system: [{ type: "text", text: "vanilla", cache_control: { type: "ephemeral", ttl: "1h" } }],
		tools: [{ name: "Read", input_schema: { type: "object" } }],
		messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
	};
	handlers.get("before_provider_request")({ payload }, ctx);
	handlers.get("message_end")({ message: { role: "assistant", usage: { input: 4, cacheRead: 0, cacheWrite: 9033 } } }, ctx);

	const log = fs.readFileSync(path.join(DIR, "session-quota.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const use = log.find((record) => record.t === "use");
	check("the quota reading is recorded beside the token counts", use.read === 0 && use.write === 9033 && use.quota !== undefined, JSON.stringify(use));
	check("all five headers survive to disk",
		use.quota.fiveHourUtilization === 0.34 && use.quota.sevenDayUtilization === 0.61 &&
		use.quota.fiveHourResetAtSec === FIVE_HOUR_RESET_SEC && use.quota.sevenDayResetAtSec === SEVEN_DAY_RESET_SEC &&
		use.quota.representativeClaim === "seven_day_overage_included",
		JSON.stringify(use.quota));

	// A second response with no headers must not re-file the first one's numbers
	// against it: a stale reading on a fresh request is a lie the delta is read
	// off later.
	handlers.get("before_provider_request")({ payload }, ctx);
	handlers.get("message_end")({ message: { role: "assistant", usage: { input: 4, cacheRead: 9033, cacheWrite: 20 } } }, ctx);
	const second = fs.readFileSync(path.join(DIR, "session-quota.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.t === "use").at(-1);
	check("a response that reported no quota records none", second.quota === undefined, JSON.stringify(second));

	fs.rmSync(DIR, { recursive: true, force: true });
}

/** Run `/quota` and return what it told the seat. */
async function runQuota(commands, ctx, notices) {
	await commands.get("quota").handler("", ctx);
	return notices.at(-1) ?? "";
}

await finish();
