/**
 * The ping against the real pi-ai, over a loopback socket.
 *
 * `smoke.mjs` drives the ping through a stub provider, which proves the
 * extensions wire up. It cannot prove the thing the design rests on: that
 * pi-ai builds the envelope, that our payload reaches the wire untouched, and
 * that the two are still consistent after a pi-ai release. So this file uses
 * the shipped `api/anthropic-messages` module and a server that records what
 * actually arrived.
 *
 * The defect it exists to keep dead: `model.compat.allowedFallbackModels` puts
 * a `fallbacks` field in the payload, and the `anthropic-beta` value that
 * licenses that field is added by the SDK client, which only pi-ai builds. A
 * ping that rebuilt its own header bag sent the field without the beta — 26
 * rejections across thirteen sessions, every one `400 fallbacks: Extra inputs
 * are not permitted`, and the trace said only `rejected (400)`. Both halves are
 * checked here on one request, because one request is where they are paired.
 *
 * Since pi-ai 0.86 both halves ride in the payload: `betas` is a payload field
 * that the SDK turns into the header, so the captured bytes carry the licence
 * for the fields they contain and the replay cannot separate them.
 *
 * Everything the ping decides for itself is checked against the wire rather than
 * against a stub: the credential it drops and the one it sends, the null that
 * suppresses a client default, the base url a gateway overrides, and the tokens
 * `message_start` reports — including a ping that *wrote*, which is the
 * detector's whole reason to exist and cannot be seen anywhere else.
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import http from "node:http";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const { sendPing } = await jiti.import(`${ROOT}/lib/ping.ts`);
// The api module itself, which is what `Provider.stream` dispatches to — a
// provider adds routing and nothing else (models.js, `createProvider`).
const anthropic = await import(jiti.esmResolve("@earendil-works/pi-ai/api/anthropic-messages"));

/**
 * A server that answers like Anthropic and records what it was asked.
 *
 * `answer` picks the shape: a streamed reply that stops after the first content
 * block (the ping aborts there and the socket is never finished), an error
 * status with a body, or silence.
 */
let answer = "stream";
let usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 18_282, cache_creation_input_tokens: 0 };
let seen;
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		seen = { method: req.method, url: req.url, headers: req.headers, body };
		if (answer === "silence") return;
		if (answer === "reject") {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fallbacks: Extra inputs are not permitted" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8", content: [],
				stop_reason: null, stop_sequence: null, usage,
			},
		})}\n\n`);
		res.write(`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
		})}\n\n`);
		// Deliberately unfinished. A ping that has its usage has everything it
		// came for, and aborting here is the cost control.
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

/** A fable-5-shaped model: adaptive thinking, and a server-side fallback list. */
const model = {
	id: "claude-fable-5", provider: "anthropic", api: "anthropic-messages", name: "Fable 5",
	baseUrl, maxTokens: 64_000, contextWindow: 200_000, reasoning: true, input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	compat: { allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-4-8", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }] },
};

/** The bytes `wire` published, including the field only a beta header permits. */
const payload = {
	model: "claude-fable-5",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	system: [{ type: "text", text: "owned prompt", cache_control: { type: "ephemeral" } }],
	tools: [{ name: "bash", description: "run", input_schema: { type: "object", properties: {} } }],
	max_tokens: 4,
	stream: true,
	betas: ["claude-code-20250219", "oauth-2025-04-20", "fine-grained-tool-streaming-2025-05-14", "server-side-fallback-2025-07-29"],
	fallbacks: [{ model: "claude-opus-4-8" }],
};

/** The bytes the SDK sends: `betas` is lifted out of the payload into the header. */
const bodyOf = ({ betas, ...rest }) => JSON.stringify(rest);

const targetWith = ({ registry, ...overrides } = {}) => ({
	payload,
	// The bag `before_provider_headers` snapshotted, stale credential and all. The
	// null is how a request suppresses one of the client's own defaults — pi-ai
	// sets `x-app: cli` on every OAuth request, and this one says not to.
	headers: {
		"user-agent": "claude-cli/2.1.251 (external, cli)",
		"x-app": null,
		"X-Claude-Code-Session-Id": "abc",
		Authorization: "Bearer sk-ant-oat01-STALE-FROM-AN-HOUR-AGO",
	},
	model,
	sessionId: "session-under-test",
	registry: {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-oat01-FRESH" }),
		getProvider: (id) => (id === "anthropic" ? { stream: anthropic.stream } : undefined),
		...registry,
	},
	record: () => {},
	...overrides,
});

try {
	// ---- one healthy ping, end to end ---------------------------------------
	console.log("ping — the envelope pi-ai builds");
	{
		const result = await sendPing(targetWith(), 10_000);
		check("the ping reaches the messages endpoint as a POST", seen.method === "POST" && seen.url === "/v1/messages?beta=true", `${seen.method} ${seen.url}`);
		// The whole mechanism. Anthropic keys the cache on these bytes, so one
		// changed byte is a full-price rewrite of the prefix.
		check("the body is the captured payload, byte for byte", seen.body === bodyOf(payload), seen.body);
		// The pairing the rebuilt envelope broke: the captured payload carries the
		// beta beside the field it licenses, and the SDK puts it on the wire.
		check("the fallbacks field arrives with the beta that licenses it",
			seen.body.includes('"fallbacks"') && (seen.headers["anthropic-beta"] ?? "").includes("server-side-fallback"),
			seen.headers["anthropic-beta"]);
		check("with the oauth betas a claude-code request carries",
			(seen.headers["anthropic-beta"] ?? "").includes("claude-code-20250219") && seen.headers["anthropic-beta"].includes("oauth-2025-04-20"));
		check("and the protocol pins nobody had to remember",
			seen.headers["anthropic-version"] === "2023-06-01" && seen.headers["content-type"] === "application/json");
		check("the captured credential never goes out", !seen.headers.authorization.includes("STALE"));
		check("the freshly resolved one does", seen.headers.authorization === "Bearer sk-ant-oat01-FRESH");
		check("the request's own identity survives", seen.headers["user-agent"] === "claude-cli/2.1.251 (external, cli)");
		check("and its own session header", seen.headers["x-claude-code-session-id"] === "abc");
		// The reason `wire` keeps nulls in its header snapshot: pi-ai reads null as
		// "suppress the client's default of this name", and a ping that dropped them
		// would put a header back on that the request went out without.
		check("a null suppresses the client default it names", seen.headers["x-app"] === undefined, seen.headers["x-app"]);

		check("the ping reports the read it came for", result.ok && result.read === 18_282, JSON.stringify(result));
		check("that it wrote nothing, which is the healthy answer", result.ok && result.write === 0);
		check("and which model actually served it", result.ok && result.served === "claude-opus-4-8");
	}

	// ---- the measurement the detector is made of ----------------------------
	// `miss` in the trace is exactly `write > 0`, and its input is one vendor
	// field. Rename that field upstream and every ping reports a healthy zero
	// forever, which is the quietest way this instrument could die.
	{
		usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 11, cache_creation_input_tokens: 18_282 };
		const result = await sendPing(targetWith(), 10_000);
		check("a ping that wrote reports the write, not a healthy zero", result.ok && result.write === 18_282 && result.read === 11, JSON.stringify(result));
		usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 18_282, cache_creation_input_tokens: 0 };
	}

	// ---- the beta set is the request's own, not one recomputed at replay ----
	// pi-ai derives its betas from the context it is handed, which a ping does not
	// have; the replay carries exactly the set the captured request went out with,
	// no more and no less. A recomputed set would silently license different
	// fields than the bytes it accompanies.
	{
		const toolless = { ...payload, betas: payload.betas.filter((b) => !b.startsWith("fine-grained")) };
		delete toolless.tools;
		await sendPing(targetWith({ payload: toolless }), 10_000);
		const sent = seen.headers["anthropic-beta"] ?? "";
		check("a payload whose request needed no tool beta does not get one added",
			!sent.includes("fine-grained-tool-streaming") && sent.includes("oauth-2025-04-20"), sent);
		check("and its body is still the captured bytes", seen.body === bodyOf(toolless), seen.body);
	}

	// ---- where a gateway seat sends its ping --------------------------------
	// The resolution's base url wins over the model's, the same move
	// `ModelRegistry.applyAuth` makes. Regress it and a proxied seat's pings go to
	// the model's stale host and fail somewhere nobody is looking.
	{
		const stale = { ...model, baseUrl: "http://127.0.0.1:1" };
		const result = await sendPing(targetWith({ model: stale, registry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-oat01-FRESH", baseUrl }) } }), 10_000);
		check("the resolved base url wins over the model's", result.ok, JSON.stringify(result));
	}

	// ---- why the credential strip is an invariant ---------------------------
	// Measured rather than asserted: pi-ai merges request headers over the
	// client's own defaults, so a captured `authorization` would beat the token
	// it just resolved. That is the whole reason the bag is stripped.
	{
		const controller = new AbortController();
		const stream = anthropic.stream(model, { messages: [] }, {
			apiKey: "sk-ant-oat01-FRESH",
			headers: { authorization: "Bearer sk-ant-oat01-STALE-FROM-AN-HOUR-AGO" },
			maxRetries: 0,
			signal: controller.signal,
			onPayload: () => payload,
		});
		for await (const event of stream) if (event.type === "start") break;
		controller.abort();
		check("a header-bag credential would override pi-ai's own auth", seen.headers.authorization.includes("STALE"), seen.headers.authorization);
	}

	// ---- the four ways it fails ---------------------------------------------
	console.log("\nping — failures, as values");
	{
		answer = "reject";
		const rejected = await sendPing(targetWith(), 10_000);
		check("a rejected ping is a status failure", !rejected.ok && rejected.reason === "status" && rejected.status === 400, JSON.stringify(rejected));
		// Thirteen sessions of `rejected (400)` said nothing about why. pi-ai puts
		// the provider's status and body in one string; the ping passes it on.
		check("carrying what the provider actually said", rejected.detail.includes("fallbacks: Extra inputs are not permitted"), rejected.detail);

		answer = "silence";
		const timedOut = await sendPing(targetWith(), 300);
		check("a ping nobody answers is a timeout", !timedOut.ok && timedOut.reason === "timeout", JSON.stringify(timedOut));

		// A session that ends mid-ping ends the ping, not its 10s timeout.
		const session = new AbortController();
		const ending = sendPing(targetWith(), 10_000, session.signal);
		setTimeout(() => session.abort(), 50);
		const ended = await ending;
		check("a ping whose session ends stops with it, cancelled rather than failed", !ended.ok && ended.reason === "cancelled" && ended.ms < 1_000, JSON.stringify(ended));

		// A refused connection has no status to parse, which is the branch that
		// separates "the provider said no" from "nobody was there".
		const nowhere = await sendPing(targetWith({ model: { ...model, baseUrl: "http://127.0.0.1:1" } }), 5_000);
		check("a host that is not there is a network failure", !nowhere.ok && nowhere.reason === "network", JSON.stringify(nowhere));

		// Nothing reaching the server is the property, not the millisecond count:
		// these two give up before there is anything to send.
		seen = undefined;
		const unauthenticated = await sendPing(targetWith({ registry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } }), 300);
		check("an unresolvable credential never reaches the wire", !unauthenticated.ok && unauthenticated.reason === "auth" && seen === undefined);

		const unrouted = await sendPing(targetWith({ registry: { getProvider: () => undefined } }), 300);
		check("nor does a model whose provider is gone", !unrouted.ok && unrouted.reason === "auth" && seen === undefined, JSON.stringify(unrouted));
	}
} finally {
	// Every reply here is deliberately unfinished — that is what a ping does to a
	// stream it has already learned from — so the sockets are torn down rather
	// than waited on, and the verdict decides the exit rather than the event loop.
	server.closeAllConnections();
	server.close();
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
