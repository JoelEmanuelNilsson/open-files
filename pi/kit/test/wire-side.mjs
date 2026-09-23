/**
 * The side seat on the wire: a `/btw` request is main's last request (R_k)
 * with only `messages` replaced, so it reads main's cached prefix. Checked
 * through two real `wire` instances — main's, which publishes R_k, and the side
 * child's — because the cache is only cheap if the bytes are R_k's exactly.
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const { buildSideRequest, publishSideRequestBasis, readSideRequestBasis, forgetSideRequestBasis } = await jiti.import(`${ROOT}/lib/side-seat.ts`);
const { readPingTarget } = await jiti.import(`${ROOT}/lib/ping.ts`);
const { warmPrefixDir } = await jiti.import(`${ROOT}/lib/warm-prefix.ts`);
const { CLAUDE_CODE_IDENTITY, SESSION_ID_HEADER, AGENT_ID_HEADER, PARENT_AGENT_ID_HEADER } = await jiti.import(`${ROOT}/lib/claude-code.ts`);

const MODEL = "claude-test";
const WRAPPED = "<side-thread>\nThis is a side thread.\n</side-thread>\n\nwhat does foo do?";
const effort = () => ({ role: "system", content: [], output_config: { effort: "high" } });
const text = (t) => ({ type: "text", text: t });

/** Main's transcript as pi-ai builds it: string content, the breakpoint only on the last user message. */
const mainMessages = () => [
	{ role: "user", content: "fix the parser" },
	{ role: "assistant", content: [text("Reading it."), { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] },
	{ role: "assistant", content: [text("Found it.")] },
	{ role: "user", content: [{ type: "text", text: "now test it", cache_control: { type: "ephemeral", ttl: "1h" } }] },
	effort(),
];

/** The side child's payload: main's cut (string form, no breakpoint), main's newer reply, the wrapped question. */
const sideMessages = () => [
	{ role: "user", content: "fix the parser" },
	{ role: "assistant", content: [text("Reading it."), { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] },
	{ role: "assistant", content: [text("Found it.")] },
	{ role: "user", content: "now test it" },
	{ role: "assistant", content: [text("Tests pass.")] },
	{ role: "user", content: [{ type: "text", text: WRAPPED, cache_control: { type: "ephemeral" } }] },
	effort(),
];

const tools = (names) => names.map((name, i) => ({ name, description: name, input_schema: { type: "object" }, ...(i === names.length - 1 ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) }));

/** Where every breakpoint in a payload sits. */
const breakpoints = (payload) => {
	const at = [];
	payload.system?.forEach((b, i) => b.cache_control && at.push(`system[${i}]`));
	payload.tools?.forEach((t, i) => t.cache_control && at.push(`tools[${i}]`));
	payload.messages?.forEach((m, i) => Array.isArray(m.content) && m.content.forEach((b, j) => b.cache_control && at.push(`messages[${i}]/${j}`)));
	return at;
};

/** Every object reachable from `value`. */
const objectsOf = (value, into = new Set()) => {
	if (typeof value !== "object" || value === null || into.has(value)) return into;
	into.add(value);
	for (const child of Object.values(value)) objectsOf(child, into);
	return into;
};
const sharesObjectWith = (a, b) => {
	const seen = objectsOf(b);
	return [...objectsOf(a)].some((object) => seen.has(object));
};

/** One wire instance on one seat, the way pi loads it: its own module copy, one session id. */
let instance = 0;
const seat = async (sessionId, toolNames = ["Bash", "Read", "Agent"]) => {
	instance++;
	const mod = await jiti.import(`${ROOT}/extensions/wire.ts?side${instance}`);
	const handlers = new Map();
	mod.default({
		on: (e, h) => handlers.set(e, h),
		registerCommand: () => {},
		getAllTools: () => toolNames.map((name) => ({ name, description: name, parameters: { type: "object" } })),
		getActiveTools: () => toolNames,
		getThinkingLevel: () => "high",
		events: { on: () => () => {}, emit: () => {} },
	});
	const notices = [];
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "anthropic", id: MODEL, api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) },
		sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ id: sessionId }) },
		getSystemPrompt: () => "pi prose",
		hasUI: true,
		ui: { setStatus: () => {}, notify: (m) => notices.push(m), theme: { fg: (_c, s) => s } },
	};
	handlers.get("before_agent_start")({ systemPromptOptions: { cwd: process.cwd() } }, ctx);
	return {
		notices,
		send: (payload) => handlers.get("before_provider_request")({ payload }, ctx),
		headers: () => {
			const headers = {};
			handlers.get("before_provider_headers")({ headers }, ctx);
			return headers;
		},
		end: (usage) => handlers.get("message_end")({ message: { role: "assistant", usage } }, ctx),
	};
};

/** A request as pi-ai hands it to extensions: pi's own system, the seat's tools. */
const piPayload = (messages, toolNames, model = MODEL) => ({
	model,
	stream: true,
	max_tokens: 32000,
	thinking: { type: "adaptive" },
	output_config: { effort: "high" },
	system: [{ type: "text", text: "pi prose", cache_control: { type: "ephemeral", ttl: "1h" } }],
	tools: tools(toolNames),
	messages,
});

process.argv.push("--model", `anthropic/${MODEL}`);
const inputsDir = path.join(warmPrefixDir(), "inputs");
const predictions = () => (fs.existsSync(inputsDir) ? fs.readdirSync(inputsDir).length : 0);

// ---------------------------------------------------------------------------
console.log("side seat: main's last request, messages replaced");
const main = await seat("main-1");
main.send(piPayload(mainMessages(), ["Bash", "Read", "Agent"]));
const target = readPingTarget("main-1");
check("main published its request (R_k)", target !== undefined);
const R = target.payload;
const predictionsBefore = predictions();

// As side-chat does it: declared before the child's first request, then R_k at submit.
publishSideRequestBasis("side-1", { mainSessionId: "main-1", mainPayload: R });
const side = await seat("side-1", ["read", "web_search"]);
const out = side.send(piPayload(sideMessages(), ["read", "web_search"]));

const { messages: outMessages, ...outRest } = out;
const { messages: rMessages, ...rRest } = R;
check("everything but messages is R_k's bytes (system, tools, thinking, max_tokens)", isDeepStrictEqual(outRest, rRest));
check("R_k's tools, not the child's", out.tools.map((t) => t.name).join() === R.tools.map((t) => t.name).join() && !out.tools.some((t) => t.name === "web_search"));
check("billing header and identity still open the system array", out.system[0].text.startsWith("x-anthropic-billing-header:") && out.system[1].text === CLAUDE_CODE_IDENTITY);
check("the prefix messages are R_k's own bytes, anchor breakpoint and array form included",
	isDeepStrictEqual(outMessages.slice(0, 5), rMessages.slice(0, 5)), JSON.stringify(outMessages[4]));
check("after the anchor come the side's turns", isDeepStrictEqual(outMessages[5], sideMessages()[5]) && outMessages[6].content[0].text === WRAPPED && outMessages.length === 8);
const bps = breakpoints(out);
check("breakpoints: system, last tool, anchor, tail", isDeepStrictEqual(bps, ["system[2]", `tools[${R.tools.length - 1}]`, "messages[4]/0", "messages[6]/0"]), bps.join(" "));
check("at most four breakpoints", bps.length <= 4);
check("the tail carries R_k's TTL, not the child's default", outMessages[6].content[0].cache_control.ttl === "1h");
check("a matched prefix says nothing", side.notices.length === 0, side.notices.join(" | "));

check("the output shares no object with the published basis", !sharesObjectWith(out, readSideRequestBasis("side-1").mainPayload));
check("nor with main's live R_k, which session-mode mutates and the ping replays", !sharesObjectWith(out, R) && !sharesObjectWith(readSideRequestBasis("side-1").mainPayload, R));
const basisBefore = structuredClone(readSideRequestBasis("side-1").mainPayload);
out.system[2].cache_control.ttl = "5m";
outMessages[4].content[0].cache_control.ttl = "5m";
out.tools[0].name = "Mutated";
check("mutating the side request leaves the basis untouched", isDeepStrictEqual(readSideRequestBasis("side-1").mainPayload, basisBefore));
R.system[2].cache_control.ttl = "5m";
check("mutating main's R_k after publish leaves the basis untouched", readSideRequestBasis("side-1").mainPayload.system[2].cache_control.ttl === "1h");
R.system[2].cache_control.ttl = "1h";

const sideHeaders = side.headers();
check("side headers carry main's session id", sideHeaders[SESSION_ID_HEADER] === "main-1");
check("and no subagent ids", !(AGENT_ID_HEADER in sideHeaders) && !(PARENT_AGENT_ID_HEADER in sideHeaders));
check("the side seat publishes no ping target", readPingTarget("side-1") === undefined);
check("the side seat records no inputs → prefix prediction", predictions() === predictionsBefore, `${predictionsBefore} → ${predictions()}`);

// A second side request after main moved on is a rewrite and a break by design: nothing said.
side.end({ input: 4, cacheRead: 9000, cacheWrite: 300 });
const followUp = sideMessages();
followUp.splice(7, 0, { role: "assistant", content: [text("It parses.")] }, { role: "user", content: [text("and bar?")] });
followUp[6].content[0] = text(WRAPPED);
followUp[8].content[0].cache_control = { type: "ephemeral" };
side.send(piPayload(followUp, ["read", "web_search"]));
side.end({ input: 4, cacheRead: 100, cacheWrite: 20000 });
check("expected side rewrites and breaks raise no notice", side.notices.length === 0, side.notices.join(" | "));

// ---------------------------------------------------------------------------
console.log("\nside seat: a prefix that no longer matches reads cold, said once");
{
	const drifted = sideMessages();
	drifted[0] = { role: "user", content: "compacted summary" };
	const cold = side.send(piPayload(drifted, ["read", "web_search"]));
	const coldBps = breakpoints(cold);
	check("no anchor, only the tail", isDeepStrictEqual(coldBps, ["system[2]", `tools[${R.tools.length - 1}]`, "messages[6]/0"]), coldBps.join(" "));
	check("the messages are the side's own", cold.messages[0].content === "compacted summary");
	check("system and tools are still R_k's", isDeepStrictEqual(cold.system, R.system) && isDeepStrictEqual(cold.tools, R.tools));
	check("one notice names the cold read", side.notices.length === 1 && side.notices[0].includes("side reads cold"), side.notices.join(" | "));
	side.send(piPayload(drifted, ["read", "web_search"]));
	check("and only once", side.notices.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\nside seat: no basis payload falls back to wire's ordinary path");
{
	publishSideRequestBasis("side-cold", { mainSessionId: "main-1", mainPayload: undefined });
	const coldSeat = await seat("side-cold");
	const cold = coldSeat.send(piPayload(sideMessages(), ["read", "web_search"]));
	check("wire builds the system array as for any seat", cold.system.length === 4 && cold.system[0].text.startsWith("x-anthropic-billing-header:") && cold.system[1].text === CLAUDE_CODE_IDENTITY);
	check("the child's own tools go out", cold.tools.map((t) => t.name).join() === "read,web_search");
	check("the child's messages go out as pi built them", isDeepStrictEqual(cold.messages, sideMessages()));
	const headers = coldSeat.headers();
	check("the cold side still speaks as main", headers[SESSION_ID_HEADER] === "main-1" && !(AGENT_ID_HEADER in headers));
	check("and publishes no ping target", readPingTarget("side-cold") === undefined);

	publishSideRequestBasis("side-model", { mainSessionId: "main-1", mainPayload: R });
	const other = await seat("side-model");
	const moved = other.send(piPayload(sideMessages(), ["read", "web_search"], "claude-other"));
	check("a side model other than R_k's takes the ordinary path", moved.model === "claude-other" && moved.tools.map((t) => t.name).join() === "read,web_search");

	forgetSideRequestBasis("side-cold");
	check("forget drops the seat", readSideRequestBasis("side-cold") === undefined);
	const ordinary = await seat("plain-1");
	check("a session that is not a side seat keeps its own session id", ordinary.headers()[SESSION_ID_HEADER] === "plain-1");
}

// ---------------------------------------------------------------------------
console.log("\nbuildSideRequest: breakpoints are relocated, never added");
{
	const rk = piPayload(mainMessages(), ["Bash"]);
	// A stray breakpoint earlier in R_k (from anything but pi-ai) must not survive.
	rk.messages[2].content[0].cache_control = { type: "ephemeral" };
	const tail = sideMessages();
	tail[6] = { role: "user", content: WRAPPED };
	const { payload, prefixMatched } = buildSideRequest(rk, { messages: tail });
	check("a string-content anchor in the side matches R_k's array form", prefixMatched);
	check("a string tail with no breakpoint becomes one text block carrying R_k's", isDeepStrictEqual(payload.messages[6].content, [{ type: "text", text: WRAPPED, cache_control: { type: "ephemeral", ttl: "1h" } }]));
	const found = breakpoints(payload);
	check("stray breakpoints are stripped; four remain", isDeepStrictEqual(found, ["system[0]", "tools[0]", "messages[4]/0", "messages[6]/0"]), found.join(" "));
	check("the input payloads are not mutated", rk.messages[2].content[0].cache_control !== undefined && tail[6].content === WRAPPED);

	const noAnchor = piPayload(mainMessages().slice(0, 4), ["Bash"]);
	const bare = buildSideRequest(noAnchor, { messages: sideMessages() });
	check("an R_k with no message breakpoint matches nothing", !bare.prefixMatched);
	check("and the tail takes the system breakpoint's TTL", bare.payload.messages[6].content[0].cache_control.ttl === "1h" && breakpoints(bare.payload).length === 3);

	const short = buildSideRequest(rk, { messages: mainMessages().slice(0, 5).map((m, i) => (i === 4 ? { role: "user", content: "now test it" } : m)) });
	check("a side payload that ends at the anchor is not a match (nothing after it to ask)", !short.prefixMatched);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
