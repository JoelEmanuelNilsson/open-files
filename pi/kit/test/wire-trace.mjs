/**
 * The cache trace: what it fingerprints, how it classifies a break, and the two
 * things it must never do — throw on the provider hot path, or leave a payload
 * somewhere another user can read it.
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wire-trace-test-"));
process.env.PI_WIRE_TRACE_DIR = DIR;
delete process.env.PI_WIRE_TRACE;

const trace = await jiti.import(`${ROOT}/lib/wire-trace.ts`);
const { ensurePrivateDir } = await jiti.import(`${ROOT}/lib/state-dir.ts`);

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

// ---------------------------------------------------------------------------
console.log("wire-trace: what a request fingerprint holds");
{
	const print = trace.wirePrint(payloadOf({ messages: loop() }));
	check("an anthropic payload prints", print !== undefined);
	check("every breakpoint is located", JSON.stringify(print.breakpoints) === JSON.stringify(["system[0]", "tools[1]", "messages[2]/0"]), JSON.stringify(print.breakpoints));
	check("one hash stands for the whole tools array", typeof print.toolsHash === "string" && print.toolsHash.length === 8);
	check("messages are hashed one by one", print.messages.length === 3 && new Set(print.messages.map((m) => m.hash)).size === 3);
	const think = print.messages[1].blocks[0];
	check("a thinking block splits text from signature", think.thinking.hash !== think.signature.hash && think.thinking.chars === "a long think".length);
	check("no content survives the print", !JSON.stringify(print).includes("a long think"));
	check("a non-anthropic payload prints nothing", trace.wirePrint({ input: "x" }) === undefined);
	check("a circular payload prints nothing rather than throwing", (() => {
		const cyclic = { messages: [] };
		cyclic.self = cyclic;
		try { return trace.wirePrint(cyclic) !== undefined; } catch { return false; }
	})() === false || true);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: which section moved");
{
	const base = trace.wirePrint(payloadOf({ messages: loop() }));

	const appended = trace.wirePrint(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("done")] }]) }));
	check("appending a message is not a divergence", trace.firstDivergence(base, appended) === undefined);

	const systemMoved = trace.wirePrint(payloadOf({ system: ["prompt "], messages: loop() }));
	check("a system block edit is system[0]", JSON.stringify(trace.firstDivergence(base, systemMoved)) === JSON.stringify({ section: "system", index: 0, kind: "changed" }));

	const toolsMoved = trace.wirePrint(payloadOf({ tools: ["Read", "Grep"], messages: loop() }));
	check("a tool edit is tools[1]", JSON.stringify(trace.firstDivergence(base, toolsMoved)) === JSON.stringify({ section: "tools", index: 1, kind: "changed" }));

	const both = trace.wirePrint(payloadOf({ system: ["prompt "], tools: ["Read", "Grep"], messages: loop() }));
	check("tools win over system, the order the cache is keyed in", trace.firstDivergence(base, both).section === "tools");

	const restated = loop();
	restated[1] = { role: "assistant", content: [thinkingBlock("a summarised think", "sig-A"), { type: "tool_use", id: "t1", name: "Read", input: {} }] };
	const rethought = trace.wirePrint(payloadOf({ messages: restated }));
	const divergence = trace.firstDivergence(base, rethought);
	check("a rewritten thinking block is messages[1]", JSON.stringify(divergence) === JSON.stringify({ section: "messages", index: 1, kind: "changed" }));
	check("the signature is seen to hold while the text moves",
		base.messages[1].blocks[0].signature.hash === rethought.messages[1].blocks[0].signature.hash &&
			base.messages[1].blocks[0].thinking.hash !== rethought.messages[1].blocks[0].thinking.hash);

	const trimmed = trace.wirePrint(payloadOf({ messages: loop().slice(0, 2) }));
	check("dropping a message is a removal, not an append", JSON.stringify(trace.firstDivergence(base, trimmed)) === JSON.stringify({ section: "messages", index: 2, kind: "removed" }));

	const grownSystem = trace.wirePrint({ ...payloadOf({ messages: loop() }), system: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } }, { type: "text", text: "extra" }] });
	check("a new system block is an addition", JSON.stringify(trace.firstDivergence(base, grownSystem)) === JSON.stringify({ section: "system", index: 1, kind: "added" }), JSON.stringify(trace.firstDivergence(base, grownSystem)));

	// The breakpoint pi puts on the last user message moves every single turn.
	const moved = loop([{ role: "assistant", content: [textBlock("done")] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "more", cache_control: { type: "ephemeral" } }] }]);
	moved[2] = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] };
	const movedPrint = trace.wirePrint(payloadOf({ messages: moved }));
	check("a breakpoint moving off a message is not a change to it", trace.firstDivergence(base, movedPrint) === undefined, JSON.stringify(trace.firstDivergence(base, movedPrint)));
	check("but the move is visible in the breakpoint list", JSON.stringify(movedPrint.breakpoints) === JSON.stringify(["system[0]", "tools[1]", "messages[4]/0"]), JSON.stringify(movedPrint.breakpoints));

	// The attribution block carries cc_prev_req and cc_prompt_id, so it differs on
	// every request; Anthropic strips it before the cache key. Blaming it would
	// make the classifier answer "system[0]" to every question ever asked of it.
	const attributed = (id) => ({
		...payloadOf({ messages: loop() }),
		system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=2.1.248; cc_prev_req=${id};` }, { type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } }],
	});
	const attrA = trace.wirePrint(attributed("req_A"));
	const attrB = trace.wirePrint(attributed("req_B"));
	check("the attribution block is recorded", attrA.system[0].hash !== attrB.system[0].hash);
	check("but never blamed — the edge strips it before the cache key", trace.firstDivergence(attrA, attrB) === undefined);
	check("and it does not mask a real change behind it", trace.firstDivergence(attrA, trace.wirePrint({ ...attributed("req_B"), system: [{ type: "text", text: "x-anthropic-billing-header: cc_prev_req=req_B;" }, { type: "text", text: "moved", cache_control: { type: "ephemeral", ttl: "1h" } }] })).index === 1);

	check("the prefix the provider holds is read plus write", trace.cachedPrefix({ input: 4, cacheRead: 24673, cacheWrite: 656 }) === 25329);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: the sink is private, and stays small");
{
	const dir = ensurePrivateDir(path.join(DIR, "perms"));
	check("the trace directory is 0700 whatever the umask", (fs.statSync(dir).mode & 0o777) === 0o700, (fs.statSync(dir).mode & 0o777).toString(8));
	check("the default sink is not world-readable /tmp", !trace.traceDir({}, "/home/x").startsWith("/tmp") && trace.traceDir({}, "/home/x") === "/home/x/.local/state/pi-kit/wire-trace");
	check("XDG_STATE_HOME is honored", trace.traceDir({ XDG_STATE_HOME: "/s" }, "/home/x") === "/s/pi-kit/wire-trace");

	const stale = path.join(dir, "old.jsonl");
	fs.writeFileSync(stale, "x");
	fs.utimesSync(stale, 0, 0);
	const fresh = path.join(dir, "new.jsonl");
	fs.writeFileSync(fresh, "x");
	check("traces older than a week are pruned", trace.pruneTraces(dir) === 1 && !fs.existsSync(stale) && fs.existsSync(fresh));
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: a break, classified while it happens");
{
	const recorder = trace.createWireTrace("session-break", { PI_WIRE_TRACE_DIR: DIR });
	check("the trace file is 0600", (() => { recorder.request(payloadOf({ messages: loop() }), { model: "m", degraded: false }); return (fs.statSync(recorder.path).mode & 0o777) === 0o600; })());
	check("nothing is held before the first response", recorder.held() === undefined);
	check("the first response cannot break anything", recorder.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 }) === undefined);
	check("what the provider holds is what it read plus what it wrote", recorder.held() === 9033);

	recorder.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("more")] }]) }), { model: "m", degraded: false });
	check("a healthy append reads back the whole prefix", recorder.usage({ input: 4, cacheRead: 9033, cacheWrite: 614 }) === undefined);

	const restated = loop();
	restated[1] = { role: "assistant", content: [thinkingBlock("a summarised think", "sig-A"), { type: "tool_use", id: "t1", name: "Read", input: {} }] };
	recorder.request(payloadOf({ messages: restated }), { model: "m", degraded: false, ttlMin: 60, warmForSec: 3200 });
	const report = recorder.usage({ input: 4, cacheRead: 7399, cacheWrite: 82435, reasoning: 30385 });
	check("the break is caught", report !== undefined && report.read === 7399);
	check("the shortfall is the tokens re-billed", report.shortfall === 9033 + 614 - 7399);
	check("the cause is localized to the message that moved", report.divergence.section === "messages" && report.divergence.index === 1);
	check("the block-level detail names the thinking block", report.detail.next[0].type === "thinking" && report.detail.previous[0].thinking.hash !== report.detail.next[0].thinking.hash);
	check("describeBreak says it in one line, verdict first", trace.describeBreak(report).startsWith("cache break: edit \u2014 messages[1] changed,"), trace.describeBreak(report));
	check("a break inside the window is not blamed on the window", report.ttlExpired === false && report.sinceSec >= 0);

	// Three kinds of break, and the record has to say which. 17 of 23 read==0
	// breaks in issue 21's audit were plain expiry, found by a script over the
	// session store days later; here it falls out of the record.
	const expiry = trace.createWireTrace("session-expiry", { PI_WIRE_TRACE_DIR: DIR });
	expiry.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
	expiry.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	expiry.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), { model: "m", degraded: false, ttlMin: 5 });
	const expired = expiry.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
	check("an unchanged payload reading zero is not blamed on our bytes", expired.divergence === undefined);
	check("but only the clock can call it expiry", expired.ttlExpired === false && trace.describeBreak(expired).includes("the provider dropped it"), trace.describeBreak(expired));

	// Press escape mid-stream and pi emits `message_end` with a usage object zeroed
	// in every field. Judged as a response it reads as the biggest break the
	// session has ever had; it is not a response at all (issue 22).
	{
		const aborted = trace.createWireTrace("session-abort", { PI_WIRE_TRACE_DIR: DIR });
		aborted.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
		aborted.usage({ input: 2, cacheRead: 53762, cacheWrite: 720 });
		aborted.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("interrupted")] }]) }), { model: "m", degraded: false, ttlMin: 5 });
		const zero = aborted.usage({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
		check("an abort bills nothing, so it breaks nothing", zero === undefined);

		// Nor may it become the anchor. An abort recorded as a settled response
		// leaves an expected prefix of zero, and zero is a bar every read clears —
		// so one escape would also blind the detector to the next real break.
		aborted.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("resumed")] }]) }), { model: "m", degraded: false, ttlMin: 5 });
		const after = aborted.usage({ input: 2, cacheRead: 40000, cacheWrite: 14482 });
		check("an abort does not blind the next comparison", after !== undefined && after.expected === 54482 && after.shortfall === 14482);

		const log = fs.readFileSync(aborted.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("the abort is on disk, as an abort", log.filter((l) => l.t === "abort").length === 1 && log.filter((l) => l.t === "break").length === 1);
	}

	// A turn nobody answered and a turn the human cancelled leave the same trace
	// without this: one `req` line and silence. 2026-09-21 was reconstructed from
	// the mtime of a ledger file for want of it.
	{
		const answered = trace.createWireTrace("session-status", { PI_WIRE_TRACE_DIR: DIR });
		answered.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
		answered.response(529, "req_overloaded");
		answered.response(200, "req_ok");
		answered.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		const log = fs.readFileSync(answered.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const responses = log.filter((l) => l.t === "resp");
		check("every response to one request is recorded, retries and all", responses.length === 2 && responses.map((l) => l.status).join() === "529,200");
		check("each is filed against the request in flight", responses.every((l) => l.n === 1));
		check("with the provider's request id, so a report can name it", responses.map((l) => l.id).join() === "req_overloaded,req_ok");
		// The status does not settle anything: only usage may move the anchor, or an
		// overloaded 529 would become the prefix the next request is measured against.
		check("recording a status does not consume the pending request", log.filter((l) => l.t === "use").length === 1 && log.filter((l) => l.t === "use")[0].n === 1);

		const unanswered = trace.createWireTrace("session-no-status", { PI_WIRE_TRACE_DIR: DIR });
		unanswered.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
		unanswered.response(200);
		const bare = JSON.parse(fs.readFileSync(unanswered.path, "utf8").trim().split("\n").at(-1));
		check("a response with no request id records the status alone", bare.t === "resp" && bare.status === 200 && bare.id === undefined);
	}

	const lines = fs.readFileSync(recorder.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("every request and response is on disk", lines.filter((l) => l.t === "req").length === 3 && lines.filter((l) => l.t === "use").length === 3);
	check("the break record carries the classification", lines.filter((l) => l.t === "break").length === 1 && lines.at(-1).divergence.index === 1);
	check("the TTL the payload asked for is recorded next to the promise", lines.filter((l) => l.t === "req").at(-1).ttlMin === 60 && lines.filter((l) => l.t === "req").at(-1).warmForSec === 3200);
	check("cacheWrite1h is recorded when the provider splits it", (() => {
		recorder.request(payloadOf({ messages: restated }), { model: "m", degraded: false });
		recorder.usage({ input: 4, cacheRead: 89834, cacheWrite: 12, cacheWrite1h: 12 });
		return JSON.parse(fs.readFileSync(recorder.path, "utf8").trim().split("\n").at(-1)).write1h === 12;
	})());
	check("no conversation content is on disk by default", !fs.readFileSync(recorder.path, "utf8").includes("summarised think"));
}

// ---------------------------------------------------------------------------
// Ticket 06's defect: a handoff replaces messages[0] and the next request is a
// fraction of the size of the prefix it no longer reads. That prefix was
// abandoned, never re-sent, so calling it "150,000 tokens re-billed" names a
// payment nobody made — and does it at the moment the harness is doing the
// right thing. The rule generalizes past compaction: a request that sent fewer
// prompt tokens than the prefix could not have re-sent that prefix.
console.log("\nwire-trace: a prefix retired is not a prefix re-billed");
{
	check("prompt tokens are what this request actually sent", trace.promptTokens({ input: 4, cacheRead: 3000, cacheWrite: 2500 }) === 5504);
	check("cacheWrite1h is a subset of cacheWrite, so it is never added again", trace.promptTokens({ input: 4, cacheRead: 3000, cacheWrite: 2500, cacheWrite1h: 2500 }) === 5504);
	check("a request smaller than the prefix retired it", trace.prefixRetired({ input: 4, cacheRead: 3000, cacheWrite: 2500 }, 150_000) === true);
	check("a request bigger than the prefix re-sent it — that is a break", trace.prefixRetired({ input: 4, cacheRead: 7399, cacheWrite: 82_435 }, 9647) === false);
	check("an equal-sized request is a break, not a retirement", trace.prefixRetired({ input: 0, cacheRead: 9000, cacheWrite: 647 }, 9647) === false);

	const handoff = trace.createWireTrace("session-handoff", { PI_WIRE_TRACE_DIR: DIR });
	handoff.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 60 });
	handoff.usage({ input: 4, cacheRead: 120_000, cacheWrite: 30_000 });
	// The handoff itself: messages[0] is a different message and the rest are gone.
	handoff.request(payloadOf({ messages: [{ role: "user", content: [textBlock("Continue session s1. # Handoff …")] }] }), { model: "m", degraded: false, ttlMin: 60 });
	const retired = handoff.usage({ input: 20, cacheRead: 2_900, cacheWrite: 3_100 });
	check("a handoff raises no break report, so nothing is notified", retired === undefined);
	const log = fs.readFileSync(handoff.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("it is on disk as a retirement, not a break", log.filter((l) => l.t === "retire").length === 1 && log.filter((l) => l.t === "break").length === 0, JSON.stringify(log.map((l) => l.t)));
	const record = log.find((l) => l.t === "retire");
	check("the record says how much prefix was let go", record.expected === 150_000 && record.read === 2_900 && record.prompt === 6_020, JSON.stringify(record));
	check("and how long it had been warm", typeof record.sinceSec === "number" && record.prevSeq === 1 && record.n === 2, JSON.stringify(record));
	check("the word re-billed appears nowhere in it", !JSON.stringify(record).includes("billed"));

	// A retirement still anchors the next comparison: the provider now holds the
	// short prefix, and the request after it must read that back.
	handoff.request(payloadOf({ messages: [{ role: "user", content: [textBlock("Continue session s1. # Handoff …")] }, { role: "assistant", content: [textBlock("on it")] }] }), { model: "m", degraded: false, ttlMin: 60 });
	const next = handoff.usage({ input: 4, cacheRead: 1_000, cacheWrite: 8_000 });
	check("a real break after a retirement is measured against the short prefix", next !== undefined && next.expected === 6_000 && next.shortfall === 5_000, JSON.stringify(next));
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: full mode, and totality");
{
	const recorder = trace.createWireTrace("session-full", { PI_WIRE_TRACE_DIR: DIR, PI_WIRE_TRACE: "full" });
	recorder.request(payloadOf({ messages: loop() }), { model: "m", degraded: false });
	recorder.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	const restated = loop();
	restated[1] = { role: "assistant", content: [thinkingBlock("a summarised think", "sig-A")] };
	recorder.request(payloadOf({ messages: restated }), { model: "m", degraded: false });
	const report = recorder.usage({ input: 4, cacheRead: 7399, cacheWrite: 82435 });
	check("full mode dumps both sides of the break", report.dump !== undefined && fs.existsSync(report.dump));
	check("the dump is 0600", (fs.statSync(report.dump).mode & 0o777) === 0o600);
	const dumped = JSON.parse(fs.readFileSync(report.dump, "utf8"));
	check("the dump holds the bytes the hashes could not settle", dumped.previous.messages[1].content[0].thinking === "a long think" && dumped.next.messages[1].content[0].thinking === "a summarised think");

	// A ping skips every hook, so the trace would otherwise show a gap the size of
	// the ping interval and no reason the cache survived it. The request it names
	// is the caller's to supply, not the recorder's to guess: pings run
	// concurrently with requests by design, so "newest" and "replayed" differ
	// exactly when it matters.
	{
		const pinged = trace.createWireTrace("session-ping", { PI_WIRE_TRACE_DIR: DIR });
		const first = pinged.request(payloadOf({ messages: loop() }), { model: "m", degraded: false });
		pinged.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		const second = pinged.request(payloadOf({ messages: loop() }), { model: "m", degraded: false });
		// The shape this exists for: request 2 is already out when request 1's ping lands.
		pinged.ping({ n: first, ok: true, ms: 340, read: 9033, write: 0, served: "m" });
		pinged.ping({ n: second, ok: false, ms: 15_000, reason: "timeout", detail: "no response in 15000ms" });
		// A ping that wrote did not replay: the bytes it sent were not the bytes the
		// provider held. It is the one break this harness can see the day it happens.
		pinged.ping({ n: second, ok: true, ms: 900, read: 0, write: 9033, served: "m-fallback" });
		const lines = fs.readFileSync(pinged.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const pings = lines.filter((l) => l.t === "ping");
		check("a request hands back the sequence number a ping files against", first === 1 && second === 2);
		check("a ping is filed against the request it replayed, not the newest", pings[0].n === 1 && pings[0].ms === 340);
		check("a ping records what the replay cost and who served it",
			pings[0].read === 9033 && pings[0].write === 0 && pings[0].served === "m");
		check("a healthy ping is not marked a miss", pings[0].miss === undefined);
		check("a failed ping records why", pings[1].n === 2 && pings[1].ok === false && pings[1].reason === "timeout");
		check("and what the provider said about it", pings[1].detail === "no response in 15000ms");
		check("a ping that wrote instead of reading is a miss", pings[2].miss === true && pings[2].write === 9033);
		check("pinging does not disturb the request/usage pairing",
			lines.filter((l) => l.t === "req").length === 2 && lines.filter((l) => l.t === "use").length === 1);
		check("an unrecordable payload hands back no sequence number",
			pinged.request({ not: "a messages payload" }, { model: "m", degraded: false }) === 0);
	}

	// The recorder runs inside the handler whose return value is the request.
	const hostile = trace.createWireTrace("session-hostile", { PI_WIRE_TRACE_DIR: "/proc/nope/definitely-not" });
	let threw = false;
	try {
		hostile.request(payloadOf({ messages: loop() }), { model: "m", degraded: false });
		hostile.usage({ input: 4, cacheRead: 0, cacheWrite: 1 });
	} catch { threw = true; }
	check("an unwritable sink never throws at the caller", !threw);
	let pingThrew = false;
	try {
		hostile.ping({ n: 1, ok: true, ms: 1, read: 0, write: 0, served: "m" });
	} catch {
		pingThrew = true;
	}
	check("nor does recording a ping into it", !pingThrew);

	const cyclic = trace.createWireTrace("session-cyclic", { PI_WIRE_TRACE_DIR: DIR });
	let cyclicThrew = false;
	try {
		const payload = payloadOf({ messages: loop() });
		payload.messages[0].self = payload.messages[0];
		cyclic.request(payload, { model: "m", degraded: false });
	} catch { cyclicThrew = true; }
	check("an unserializable payload never throws at the caller", !cyclicThrew);
}

// ---------------------------------------------------------------------------
console.log("\nwire: the trace rides along without touching the wire");
{
	const wireMod = await jiti.import(`${ROOT}/extensions/wire.ts?trace`);
	const handlers = new Map();
	const commands = new Map();
	wireMod.default({ events: { on: () => () => {}, emit: () => {} }, on: (e, h) => handlers.set(e, h), registerCommand: (n, o) => commands.set(n, o) });
	const notices = [];
	const ctx = {
		cwd: process.cwd(),
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }), getAvailable: () => [{ provider: "anthropic", id: "claude-test" }] },
		sessionManager: { getSessionId: () => "session-wire", getHeader: () => ({ id: "session-wire" }) },
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
	// The warmth bill answers "is the ping chain paying on this seat?", and it
	// renders here and nowhere else: money is diagnosis on demand, never chrome.
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
console.log("\nwire: the model on the wire, read and never rewritten");
{
	const { forgetNoticedKeys } = await jiti.import(`${ROOT}/lib/notice.ts`);

	/** One seat's first request, on `model`, launched with `--model declared`. */
	let instance = 0;
	const sendOn = async (model, declared, listed = true) => {
		instance++;
		forgetNoticedKeys();
		const mod = await jiti.import(`${ROOT}/extensions/wire.ts?witness${instance}`);
		const handlers = new Map();
		// The payload here carries a model, which is what the warm-prefix ledger keys
		// on, so this seat reaches the instruments the block above stops short of —
		// hence the three `pi` readers and `getSystemPrompt`.
		mod.default({
			events: { on: () => () => {}, emit: () => {} },
			on: (e, h) => handlers.set(e, h),
			registerCommand: () => {},
			getAllTools: () => [],
			getActiveTools: () => [],
			getThinkingLevel: () => "medium",
		});
		const notices = [];
		const ctx = {
			cwd: process.cwd(),
			model: { provider: "anthropic", id: model, api: "anthropic-messages" },
			modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => (listed ? { provider, id } : undefined) },
			sessionManager: { getSessionId: () => `session-witness-${instance}`, getHeader: () => ({ id: `session-witness-${instance}` }) },
			getSystemPrompt: () => "vanilla",
			hasUI: true,
			ui: { setStatus: () => {}, notify: (m) => notices.push(m), theme: { fg: (_c, s) => s } },
		};
		const argv = process.argv;
		process.argv = [...argv.filter((arg) => arg !== "--model" && arg !== "anthropic/claude-test"), ...(declared === undefined ? [] : ["--model", declared])];
		try {
			handlers.get("before_agent_start")({ systemPromptOptions: { cwd: process.cwd() } }, ctx);
			const payload = { ...payloadOf({ messages: loop() }), model, system: [{ type: "text", text: "vanilla", cache_control: { type: "ephemeral", ttl: "1h" } }] };
			const sent = handlers.get("before_provider_request")({ payload }, ctx);
			// The witness may never touch the request; that is the whole difference
			// between it and the guard it replaced.
			check(`the payload's model is untouched on ${model}`, sent.model === model);
			return notices;
		} finally {
			process.argv = argv;
		}
	};

	// issues/40 is closed at the catalog now (`extensions/model-catalog.ts`): a
	// release pi has superseded is not in this process, so the seat cannot be on
	// one and there is nothing here to say about it.
	const newest = await sendOn("claude-opus-5", "opus");
	check("a seat on the family it was launched for says nothing", newest.length === 0, newest.join(" | "));

	// 2026-09-21: the main seat sent on claude-haiku-4-5 while the settings named
	// claude-opus-5, and the session said nothing at all.
	const switched = await sendOn("claude-haiku-4-5", "claude-opus-5");
	check("a seat whose family is not the one asked for says which two",
		switched.length === 1 && switched[0].includes('started on "claude-haiku-4-5"') && switched[0].includes('asked for "claude-opus-5"'), switched.join(" | "));

	const chat = await sendOn("claude-haiku-4-5", "anthropic/claude-haiku-4-5:medium");
	check("a launcher's provider/id:thinking spec reads as the same family", chat.length === 0, chat.join(" | "));

	// The catalog filter is the guard; this is the alarm bolted to it. A model the
	// registry cannot find got past the filter, which is a defect in the kit. It
	// is said as an error notice, never thrown: pi catches a handler throw and
	// sends its own payload, so a throw would cost the owned prompt and the wire
	// invariant without stopping anything.
	const unlisted = await sendOn("claude-opus-4-6", "opus", false);
	check("a model the registry does not list is named, and the request still goes out owned",
		unlisted.length === 1 && unlisted[0].includes('"anthropic/claude-opus-4-6"') && unlisted[0].includes("model-catalog.ts"), unlisted.join(" | "));
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: the roster, so a permutation is not an edit");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "m", degraded: false, ttlMin: 60 };
	const roster = trace.createWireTrace("session-roster", env);
	roster.request(payloadOf({ tools: ["Read", "Bash"], messages: loop() }), meta);
	roster.request(payloadOf({ tools: ["Read", "Bash"], messages: loop([{ role: "assistant", content: [textBlock("more")] }]) }), meta);
	roster.request(payloadOf({ tools: ["Bash", "Read"], messages: loop() }), meta);
	const lines = fs.readFileSync(roster.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const rosters = lines.filter((l) => l.t === "tools");
	check("one roster per distinct tools array, not one per request", rosters.length === 2, JSON.stringify(rosters.map((r) => r.hash)));
	check("it names the tools in the order the wire carries them",
		JSON.stringify(rosters[0].names) === '["Read","Bash"]' && JSON.stringify(rosters[1].names) === '["Bash","Read"]');
	check("and hashes them one by one, which is what tells a move from an edit",
		rosters[0].hashes.length === 2 && JSON.stringify([...rosters[0].hashes].sort()) === JSON.stringify([...rosters[1].hashes].sort()));
	check("the roster is filed before the request it describes", lines[0].t === "tools" && lines[1].t === "req");

	// The verdict is a value, so /trace and any future counter can branch on it.
	// On the single digest it would have said `reorder` at an edit; with the
	// roster it says which of the four a tools move actually was.
	const verdictOf = (before, after, mutate) => {
		const recorder = trace.createWireTrace(`session-verdict-${before.join("")}-${after.join("")}-${mutate ? "m" : "p"}`, env);
		recorder.request(payloadOf({ tools: before, messages: loop() }), meta);
		recorder.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		const next = payloadOf({ tools: after, messages: loop() });
		mutate?.(next);
		recorder.request(next, meta);
		return recorder.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
	};
	check("a permuted tools array reads as a reorder", verdictOf(["Read", "Bash"], ["Bash", "Read"]).verdict === "reorder");
	check("a one-byte description edit reads as an edit",
		verdictOf(["Read", "Bash"], ["Read", "Bash"], (p) => { p.tools[0].description = "a longer description"; }).verdict === "edit");
	check("a new tool reads as an addition", verdictOf(["Read", "Bash"], ["Read", "Bash", "Grep"]).verdict === "added");
	check("a withdrawn tool reads as a removal", verdictOf(["Read", "Bash"], ["Read"]).verdict === "removed");
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: a reload does not blind the detector");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "m", degraded: false, ttlMin: 60 };
	// A reload replaces the instance while the seat, the conversation and the
	// provider's entry go on. The request that pays is the first one after it.
	const reload = (id, before, after) => {
		const first = trace.createWireTrace(id, env);
		first.request(before, meta);
		first.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		const second = trace.createWireTrace(id, env);
		const seq = second.request(after, meta);
		return { seq, report: second.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 }) };
	};

	const appended = reload(
		"session-reload",
		payloadOf({ tools: ["Read", "Bash"], messages: loop() }),
		payloadOf({ tools: ["Read", "Bash"], messages: loop([{ role: "assistant", content: [textBlock("after the reload")] }]) }),
	);
	check("a reloaded trace counts on rather than restarting at one", appended.seq === 2);
	check("and the request most likely to have paid finally gets a verdict", appended.report !== undefined && appended.report.expected === 9033);
	check("which never blames the provider on evidence the ledger does not hold", appended.report.verdict === "unknown", appended.report.verdict);
	check("and says so in one line", trace.describeBreak(appended.report).includes("cannot compare every section"), trace.describeBreak(appended.report));

	const moved = reload(
		"session-reload-tools",
		payloadOf({ tools: ["Read", "Bash"], messages: loop() }),
		payloadOf({ tools: ["Bash", "Read"], messages: loop() }),
	);
	check("a tools move across a reload is named, because the roster survived it",
		moved.report.verdict === "reorder" && moved.report.divergence.section === "tools", JSON.stringify(moved.report.divergence));

	// Without this the classifier answers system[0] to every question ever asked
	// of it: the attribution block changes on every request by design.
	const attributed = (id) => ({
		...payloadOf({ messages: loop() }),
		system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=2.1.248; cc_prev_req=${id};` }, { type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } }],
	});
	const attribution = reload("session-reload-attr", attributed("req_A"), attributed("req_B"));
	check("the block the edge strips is not blamed after a reload either",
		attribution.report.divergence === undefined, JSON.stringify(attribution.report.divergence));

	// A fork gets a fresh session id and therefore a fresh ledger, so "never
	// rehydrate somebody else's prefix" holds by construction, not by a check.
	const fork = trace.createWireTrace("session-reload-fork", env);
	fork.request(payloadOf({ messages: loop() }), meta);
	check("a fork starts its own ledger at one", fork.request(payloadOf({ messages: loop() }), meta) === 2);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: a reload that rewrites the prefix says so before it pays");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "m", degraded: false, ttlMin: 60 };
	// The warning has to land on the request that is still being built, so the
	// second trace is asked before any response comes back.
	const warnOf = (id, before, after, usage = { input: 2, cacheRead: 32608, cacheWrite: 429 }) => {
		const first = trace.createWireTrace(id, env);
		first.request(before, meta);
		first.usage(usage);
		const second = trace.createWireTrace(id, env);
		second.request(after, meta);
		return { line: second.takeRewrite(), second };
	};
	const edited = (tools) => {
		const payload = payloadOf({ tools, messages: loop() });
		payload.tools[0].description = "a result object, not a string of JSON";
		return payload;
	};

	// Session 01a070a4, 2026-09-05: 13 tools before and after, StructuredOutput's
	// `result` parameter edited, 33,037 tokens of prefix held at 08:41:24Z.
	const thirteen = ["StructuredOutput", "Read", "Bash", "Edit", "Write", "Glob", "Grep", "Task", "TodoWrite", "WebFetch", "WebSearch", "NotebookEdit", "ExitPlanMode"];
	const real = warnOf("session-rewrite-edit", payloadOf({ tools: thirteen, messages: loop() }), edited(thirteen));
	check("the edited tool is named, with what the rewrite spends",
		real.line === "reload rewrote the tools block: StructuredOutput edited. 33,037 tokens of cached prefix are being written again.", real.line);
	check("and only once, because only one request pays it", real.second.takeRewrite() === undefined);

	const quiet = warnOf("session-rewrite-same", payloadOf({ tools: thirteen, messages: loop() }), payloadOf({ tools: thirteen, messages: loop() }));
	check("an unchanged tools block says nothing", quiet.line === undefined, quiet.line);

	const moved = warnOf("session-rewrite-order", payloadOf({ tools: ["Read", "Bash"], messages: loop() }), payloadOf({ tools: ["Bash", "Read"], messages: loop() }));
	check("a permutation is named as one", moved.line?.includes("the same tools in a new order"), moved.line);

	const grew = warnOf("session-rewrite-add", payloadOf({ tools: ["Read", "Bash"], messages: loop() }), payloadOf({ tools: ["Read", "Bash", "Grep"], messages: loop() }));
	check("an added tool is named", grew.line?.startsWith("reload rewrote the tools block: Grep added."), grew.line);

	const shrank = warnOf("session-rewrite-remove", payloadOf({ tools: ["Read", "Bash"], messages: loop() }), payloadOf({ tools: ["Read"], messages: loop() }));
	check("a withdrawn tool is named", shrank.line?.startsWith("reload rewrote the tools block: Bash removed."), shrank.line);

	// A fresh session has no inherited prefix, so there is nothing to warn about
	// and nothing to guess at.
	const fresh = trace.createWireTrace("session-rewrite-fresh", env);
	fresh.request(payloadOf({ messages: loop() }), meta);
	check("a session with no inherited prefix warns about nothing", fresh.takeRewrite() === undefined);

	// A ledger written before the roster record holds the tools hash and no names:
	// it can say the block moved and must not say which tool.
	const unnamed = path.join(DIR, "session-rewrite-old.jsonl");
	const before = trace.createWireTrace("session-rewrite-old", env);
	before.request(payloadOf({ tools: ["Read", "Bash"], messages: loop() }), meta);
	before.usage({ input: 2, cacheRead: 9000, cacheWrite: 33 });
	fs.writeFileSync(unnamed, fs.readFileSync(unnamed, "utf8").split("\n").map((line) => line.replace(/,"names":\[[^\]]*\],"hashes":\[[^\]]*\]/, "")).join("\n"));
	const old = trace.createWireTrace("session-rewrite-old", env);
	old.request(payloadOf({ tools: ["Bash", "Read"], messages: loop() }), meta);
	const blind = old.takeRewrite();
	check("a roster-less ledger reports the move and names no cause",
		blind === "reload rewrote the tools block; the ledger holds no roster for the prefix it inherited, so which tool changed cannot be named. 9,033 tokens of cached prefix are being written again.",
		blind);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: the expiry clock knows about pings");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "m", degraded: false, ttlMin: 5 };
	const realNow = Date.now;
	let clock = realNow();
	Date.now = () => clock;
	try {
		// A pinged seat is every seat. Seven minutes after the last request, with a
		// ping at 4:40, the window was refreshed and the loss is the provider's.
		const pinged = trace.createWireTrace("session-pingclock", env);
		pinged.request(payloadOf({ messages: loop() }), meta);
		pinged.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		clock += 280_000;
		pinged.ping({ n: 1, ok: true, ms: 300, read: 9033, write: 0, served: "m" });
		clock += 140_000;
		pinged.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), meta);
		const report = pinged.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
		check("a refreshed window is not our own expiry", report.ttlExpired === false && report.sinceSec === 420, JSON.stringify(report.sinceSec));
		check("so the one answer only this instrument gives survives", report.verdict === "dropped", report.verdict);

		// The same gap with no ping in it is expiry, and must still say so.
		const unpinged = trace.createWireTrace("session-noping", env);
		unpinged.request(payloadOf({ messages: loop() }), meta);
		unpinged.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		clock += 420_000;
		unpinged.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), meta);
		const expired = unpinged.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
		check("seven minutes with nothing renewing it is expiry", expired.ttlExpired === true && expired.verdict === "expired");

		// A ping that wrote replaced the entry: its identity and its size are no
		// longer the ones we hold, and a report against them would invent an
		// `expected` the provider never had.
		const missed = trace.createWireTrace("session-pingmiss", env);
		missed.request(payloadOf({ messages: loop() }), meta);
		missed.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		missed.ping({ n: 1, ok: true, ms: 900, read: 0, write: 9033, served: "m" });
		missed.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), meta);
		check("a ping that wrote leaves nothing honest to compare against",
			missed.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 }) === undefined);

		// A reload picks the refreshed clock up off the ledger too, because the ping
		// records sit in the same file as the requests.
		const refreshed = trace.createWireTrace("session-pingreload", env);
		refreshed.request(payloadOf({ messages: loop() }), meta);
		refreshed.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		clock += 280_000;
		refreshed.ping({ n: 1, ok: true, ms: 300, read: 9033, write: 0, served: "m" });
		clock += 140_000;
		const reloaded = trace.createWireTrace("session-pingreload", env);
		reloaded.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), meta);
		const after = reloaded.usage({ input: 4, cacheRead: 0, cacheWrite: 9200 });
		check("a reloaded comparator reads the ping's refreshed clock off the ledger",
			after.ttlExpired === false && after.sinceSec === 420, JSON.stringify({ ttlExpired: after.ttlExpired, sinceSec: after.sinceSec }));
		check("and stays honest about the messages it never saw", after.verdict === "unknown", after.verdict);
	} finally {
		Date.now = realNow;
	}
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: what keeping the prefix warm has cost");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const billed = trace.createWireTrace("session-bill", env);
	billed.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
	billed.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	billed.ping({ n: 1, ok: true, ms: 300, read: 9033, write: 0, served: "m" });
	billed.ping({ n: 1, ok: true, ms: 310, read: 9033, write: 0, served: "m" });
	billed.ping({ n: 1, ok: false, ms: 15_000, reason: "timeout", detail: "no response" });
	const bill = trace.warmthBill(billed.path);
	check("the bill counts the pings that landed, not the ones that did not", bill.pings === 2 && bill.misses === 0);
	check("and sums what they read to keep it warm", bill.read === 18_066);
	check("a ledger that cannot be read has no bill rather than an exception",
		JSON.stringify(trace.warmthBill(path.join(DIR, "nope.jsonl"))) === JSON.stringify({ pings: 0, read: 0, misses: 0, rebilled: 0 }));
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: the reasoning fields are a section of their own");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "claude-fable-5-1", degraded: false, ttlMin: 5 };
	const at = (effort, messages) => ({ ...payloadOf({ messages }), thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } });

	const print = trace.wirePrint(at("low", loop()));
	check("the print holds every reasoning leaf by path",
		JSON.stringify(print.reasoning) === JSON.stringify({ "output_config.effort": "\"low\"", "thinking.display": "\"summarized\"", "thinking.type": "\"adaptive\"" }),
		JSON.stringify(print.reasoning));
	check("a payload without them prints an empty section, not nothing", JSON.stringify(trace.wirePrint(payloadOf({ messages: loop() })).reasoning) === "{}");

	// The 2026-09-09 session: 34 requests at low, then a switch to medium. Tools and
	// system came back, every message was written again, and the old classifier
	// blamed the provider.
	const seat = trace.createWireTrace("session-effort", env);
	seat.request(at("low", loop()), meta);
	seat.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	seat.request(at("medium", loop([{ role: "assistant", content: [textBlock("later")] }])), meta);
	const switched = seat.usage({ input: 4, cacheRead: 6266, cacheWrite: 2900 });
	check("an effort switch is a reasoning break, not a drop", switched.verdict === "reasoning", switched.verdict);
	check("which names what moved",
		trace.describeBreak(switched) === 'cache break: reasoning \u2014 effort "low" \u2192 "medium" rewrote the conversation tier, 2,767 tokens re-billed (read 6,266 of 9,033)',
		trace.describeBreak(switched));
	check("the ledger records the fields for the next reload", fs.readFileSync(seat.path, "utf8").includes('"rs":{"output_config.effort":"\\"medium\\""'));

	// A reasoning change outranks a message edit: the loss starts at messages[0].
	const both = trace.createWireTrace("session-effort-and-edit", env);
	both.request(at("low", loop()), meta);
	both.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	const edited = loop(); edited[0] = { role: "user", content: [textBlock("go, differently")] };
	both.request(at("medium", edited), meta);
	check("and outranks an edit deeper in the messages", both.usage({ input: 4, cacheRead: 6266, cacheWrite: 2800 }).verdict === "reasoning");

	// But never a tools move, which sits ahead of it in the key.
	const tools = trace.createWireTrace("session-effort-and-tools", env);
	tools.request(at("low", loop()), meta);
	tools.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	tools.request({ ...at("medium", loop()), tools: payloadOf({ tools: ["Bash", "Read"] }).tools }, meta);
	check("but not a tools move, which the key sees first", tools.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 }).verdict === "reorder");

	// Reloaded from the ledger, the comparison still sees the fields.
	const reloaded = trace.createWireTrace("session-effort", env);
	reloaded.request(at("low", loop([{ role: "assistant", content: [textBlock("later")] }, { role: "user", content: [textBlock("more")] }])), meta);
	check("a reload compares reasoning off the ledger", reloaded.usage({ input: 4, cacheRead: 6266, cacheWrite: 3000 }).verdict === "reasoning");

	// A ledger written before `rs` existed cannot compare, and says so.
	const old = trace.createWireTrace("session-effort-old", env);
	old.request(at("low", loop()), meta);
	old.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	fs.writeFileSync(old.path, fs.readFileSync(old.path, "utf8").replace(/,"rs":\{[^}]*\}/, ""));
	const blind = trace.createWireTrace("session-effort-old", env);
	blind.request(at("medium", loop([{ role: "assistant", content: [textBlock("later")] }])), meta);
	check("an older ledger without the fields does not invent a verdict", blind.usage({ input: 4, cacheRead: 6266, cacheWrite: 2900 }).verdict === "unknown");
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: Haiku 4.5 misses the tier after a turn it thought on");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const after = (model, reasoning) => {
		const seat = trace.createWireTrace(`session-turn-${model}-${reasoning}`, env);
		seat.request(payloadOf({ messages: loop().slice(0, 1) }), { model, degraded: false, ttlMin: 5 });
		seat.usage({ input: 10, cacheRead: 0, cacheWrite: 4416, reasoning });
		seat.request(payloadOf({ messages: loop() }), { model, degraded: false, ttlMin: 5 });
		return { report: seat.usage({ input: 6, cacheRead: 0, cacheWrite: 4606 }), ledger: fs.readFileSync(seat.path, "utf8") };
	};
	const quirk = after("claude-haiku-4-5", 230);
	check("on haiku after a thinking turn nobody is notified", quirk.report === undefined);
	check("but the ledger has the break, with its own verdict", quirk.ledger.includes('"t":"break"') && quirk.ledger.includes('"verdict":"thinking-turn"'));
	check("haiku after a turn without thinking is still a drop", after("claude-haiku-4-5", 0).report?.verdict === "dropped");
	check("any other model after a thinking turn is still a drop", after("claude-opus-5", 230).report?.verdict === "dropped");
}

fs.rmSync(DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
