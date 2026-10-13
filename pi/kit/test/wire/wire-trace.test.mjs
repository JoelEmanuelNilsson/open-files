/**
 * The cache trace: what it fingerprints, how it classifies a break, and the two
 * things it must never do — throw on the provider hot path, or leave a payload
 * somewhere another user can read it.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wire-trace-test-"));
process.env.PI_WIRE_TRACE_DIR = DIR;
delete process.env.PI_WIRE_TRACE;

const { createWireTrace } = await jiti.import(`${KIT_ROOT}/extensions/wire/wire-trace.ts`);
const { wirePrint } = await jiti.import(`${KIT_ROOT}/extensions/wire/wire-print.ts`);
const { breakIsFault, describeBreak, prefixRetired } = await jiti.import(`${KIT_ROOT}/extensions/wire/cache-break.ts`);
const { pruneTraces, traceDir, rebilledTokens } = await jiti.import(`${KIT_ROOT}/extensions/wire/wire-trace-ledger.ts`);
const cacheUsage = await jiti.import(`${KIT_ROOT}/lib/cache/cache-usage.ts`);
const { ensurePrivateDir } = await jiti.import(`${KIT_ROOT}/lib/process/kit-state-dir.ts`);

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
console.log("\nwire-trace: the sink is private, and stays small");
{
	const dir = ensurePrivateDir(path.join(DIR, "perms"));
	check("the trace directory is 0700 whatever the umask", (fs.statSync(dir).mode & 0o777) === 0o700, (fs.statSync(dir).mode & 0o777).toString(8));
	check("the default sink is not world-readable /tmp", !traceDir({}, "/home/x").startsWith("/tmp") && traceDir({}, "/home/x") === "/home/x/.local/state/pi-kit/wire-trace");
	check("XDG_STATE_HOME is honored", traceDir({ XDG_STATE_HOME: "/s" }, "/home/x") === "/s/pi-kit/wire-trace");

	const stale = path.join(dir, "old.jsonl");
	fs.writeFileSync(stale, "x");
	fs.utimesSync(stale, 0, 0);
	const fresh = path.join(dir, "new.jsonl");
	fs.writeFileSync(fresh, "x");
	check("traces older than a week are pruned", pruneTraces(dir) === 1 && !fs.existsSync(stale) && fs.existsSync(fresh));
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: a break, classified while it happens");
{
	const recorder = createWireTrace("session-break", { PI_WIRE_TRACE_DIR: DIR });
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
	check("describeBreak says it in one line, verdict first", describeBreak(report).startsWith("cache break: edit \u2014 messages[1] changed,"), describeBreak(report));
	check("a break inside the window is not blamed on the window", report.ttlExpired === false && report.sinceSec >= 0);

	// Three kinds of break, and the record has to say which. 17 of 23 read==0
	// breaks in issue 21's audit were plain expiry, found by a script over the
	// session store days later; here it falls out of the record.
	const expiry = createWireTrace("session-expiry", { PI_WIRE_TRACE_DIR: DIR });
	expiry.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
	expiry.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	expiry.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), { model: "m", degraded: false, ttlMin: 5 });
	const expired = expiry.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
	check("an unchanged payload reading zero is not blamed on our bytes", expired.divergence === undefined);
	check("but only the clock can call it expiry", expired.ttlExpired === false && describeBreak(expired).includes("the provider dropped it"), describeBreak(expired));

	// Press escape mid-stream and pi emits `message_end` with a usage object zeroed
	// in every field. Judged as a response it reads as the biggest break the
	// session has ever had; it is not a response at all (issue 22).
	{
		const aborted = createWireTrace("session-abort", { PI_WIRE_TRACE_DIR: DIR });
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
		const answered = createWireTrace("session-status", { PI_WIRE_TRACE_DIR: DIR });
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

		const unanswered = createWireTrace("session-no-status", { PI_WIRE_TRACE_DIR: DIR });
		unanswered.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
		unanswered.response(200);
		const bare = JSON.parse(fs.readFileSync(unanswered.path, "utf8").trim().split("\n").at(-1));
		check("a response with no request id records the status alone", bare.t === "resp" && bare.status === 200 && bare.id === undefined);
	}

	const lines = fs.readFileSync(recorder.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("every request and response is on disk", lines.filter((l) => l.t === "req").length === 3 && lines.filter((l) => l.t === "use").length === 3);
	check("the break record carries the classification", lines.filter((l) => l.t === "break").length === 1 && lines.at(-1).divergence.index === 1);
	check("the TTL the payload asked for is recorded", lines.filter((l) => l.t === "req").at(-1).ttlMin === 60);
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
	check("prompt tokens are what this request actually sent", cacheUsage.promptTokens({ input: 4, cacheRead: 3000, cacheWrite: 2500 }) === 5504);
	check("cacheWrite1h is a subset of cacheWrite, so it is never added again", cacheUsage.promptTokens({ input: 4, cacheRead: 3000, cacheWrite: 2500, cacheWrite1h: 2500 }) === 5504);
	check("a request smaller than the prefix retired it", prefixRetired({ input: 4, cacheRead: 3000, cacheWrite: 2500 }, 150_000) === true);
	check("a request bigger than the prefix re-sent it — that is a break", prefixRetired({ input: 4, cacheRead: 7399, cacheWrite: 82_435 }, 9647) === false);
	check("an equal-sized request is a break, not a retirement", prefixRetired({ input: 0, cacheRead: 9000, cacheWrite: 647 }, 9647) === false);

	const handoff = createWireTrace("session-handoff", { PI_WIRE_TRACE_DIR: DIR });
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
	const recorder = createWireTrace("session-full", { PI_WIRE_TRACE_DIR: DIR, PI_WIRE_TRACE: "full" });
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

	// pi's cache warmer sends a refresh the trace files as a warm record: it is not
	// a turn, so it takes no sequence number and leaves the request/usage pairing alone.
	{
		const warmed = createWireTrace("session-warm", { PI_WIRE_TRACE_DIR: DIR });
		const first = warmed.request(payloadOf({ messages: loop() }), { model: "m", degraded: false });
		warmed.warm("m");
		warmed.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		const second = warmed.request(payloadOf({ messages: loop() }), { model: "m", degraded: false });
		const lines = fs.readFileSync(warmed.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("a warm refresh is filed as a warm record", lines.filter((l) => l.t === "warm").length === 1 && lines.find((l) => l.t === "warm").model === "m");
		check("and takes no sequence number", first === 1 && second === 2);
		check("it does not disturb the request/usage pairing",
			lines.filter((l) => l.t === "req").length === 2 && lines.filter((l) => l.t === "use").length === 1);
		check("an unrecordable payload hands back no sequence number",
			warmed.request({ not: "a messages payload" }, { model: "m", degraded: false }) === 0);
	}

	// The recorder runs inside the handler whose return value is the request.
	const hostile = createWireTrace("session-hostile", { PI_WIRE_TRACE_DIR: "/proc/nope/definitely-not" });
	let threw = false;
	try {
		hostile.request(payloadOf({ messages: loop() }), { model: "m", degraded: false });
		hostile.usage({ input: 4, cacheRead: 0, cacheWrite: 1 });
	} catch { threw = true; }
	check("an unwritable sink never throws at the caller", !threw);
	let warmThrew = false;
	try {
		hostile.warm("m");
	} catch {
		warmThrew = true;
	}
	check("nor does recording a warm refresh into it", !warmThrew);

	const cyclic = createWireTrace("session-cyclic", { PI_WIRE_TRACE_DIR: DIR });
	let cyclicThrew = false;
	try {
		const payload = payloadOf({ messages: loop() });
		payload.messages[0].self = payload.messages[0];
		cyclic.request(payload, { model: "m", degraded: false });
	} catch { cyclicThrew = true; }
	check("an unserializable payload never throws at the caller", !cyclicThrew);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: the roster, so a permutation is not an edit");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "m", degraded: false, ttlMin: 60 };
	const roster = createWireTrace("session-roster", env);
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
		const recorder = createWireTrace(`session-verdict-${before.join("")}-${after.join("")}-${mutate ? "m" : "p"}`, env);
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
		const first = createWireTrace(id, env);
		first.request(before, meta);
		first.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		const second = createWireTrace(id, env);
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
	check("and says so in one line", describeBreak(appended.report).includes("cannot compare every section"), describeBreak(appended.report));

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
	const fork = createWireTrace("session-reload-fork", env);
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
		const first = createWireTrace(id, env);
		first.request(before, meta);
		first.usage(usage);
		const second = createWireTrace(id, env);
		second.request(after, meta);
		const taken = second.takeRewrite();
		return { line: taken?.text, severity: taken?.severity, second };
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
	check("an edit is new code loading: info", real.severity === "info", real.severity);

	const quiet = warnOf("session-rewrite-same", payloadOf({ tools: thirteen, messages: loop() }), payloadOf({ tools: thirteen, messages: loop() }));
	check("an unchanged tools block says nothing", quiet.line === undefined, quiet.line);

	const moved = warnOf("session-rewrite-order", payloadOf({ tools: ["Read", "Bash"], messages: loop() }), payloadOf({ tools: ["Bash", "Read"], messages: loop() }));
	check("a permutation is named as one", moved.line?.includes("the same tools in a new order"), moved.line);
	check("and warns", moved.severity === "warning", moved.severity);

	const grew = warnOf("session-rewrite-add", payloadOf({ tools: ["Read", "Bash"], messages: loop() }), payloadOf({ tools: ["Read", "Bash", "Grep"], messages: loop() }));
	check("an added tool is named", grew.line?.startsWith("reload rewrote the tools block: Grep added."), grew.line);
	check("and is info", grew.severity === "info", grew.severity);

	const shrank = warnOf("session-rewrite-remove", payloadOf({ tools: ["Read", "Bash"], messages: loop() }), payloadOf({ tools: ["Read"], messages: loop() }));
	check("a withdrawn tool is named", shrank.line?.startsWith("reload rewrote the tools block: Bash removed."), shrank.line);
	check("and warns", shrank.severity === "warning", shrank.severity);

	// A fresh session has no inherited prefix, so there is nothing to warn about
	// and nothing to guess at.
	const fresh = createWireTrace("session-rewrite-fresh", env);
	fresh.request(payloadOf({ messages: loop() }), meta);
	check("a session with no inherited prefix warns about nothing", fresh.takeRewrite() === undefined);

	// A ledger written before the roster record holds the tools hash and no names:
	// it can say the block moved and must not say which tool.
	const unnamed = path.join(DIR, "session-rewrite-old.jsonl");
	const before = createWireTrace("session-rewrite-old", env);
	before.request(payloadOf({ tools: ["Read", "Bash"], messages: loop() }), meta);
	before.usage({ input: 2, cacheRead: 9000, cacheWrite: 33 });
	fs.writeFileSync(unnamed, fs.readFileSync(unnamed, "utf8").split("\n").map((line) => line.replace(/,"names":\[[^\]]*\],"hashes":\[[^\]]*\]/, "")).join("\n"));
	const old = createWireTrace("session-rewrite-old", env);
	old.request(payloadOf({ tools: ["Bash", "Read"], messages: loop() }), meta);
	const unnamedRewrite = old.takeRewrite();
	const blind = unnamedRewrite?.text;
	check("a roster-less ledger reports the move and names no cause",
		blind === "reload rewrote the tools block; the ledger holds no roster for the prefix it inherited, so which tool changed cannot be named. 9,033 tokens of cached prefix are being written again.",
		blind);
	check("and warns, because the roster cannot be named", unnamedRewrite?.severity === "warning", unnamedRewrite?.severity);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: the expiry clock knows about warm refreshes");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "m", degraded: false, ttlMin: 5 };
	const realNow = Date.now;
	let clock = realNow();
	Date.now = () => clock;
	try {
		// Seven minutes after the last request, with a refresh at 4:40, the window was
		// refreshed and the loss is the provider's.
		const warmed = createWireTrace("session-warmclock", env);
		warmed.request(payloadOf({ messages: loop() }), meta);
		warmed.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		clock += 280_000;
		warmed.warm("m");
		clock += 140_000;
		warmed.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), meta);
		const report = warmed.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
		check("a refreshed window is not our own expiry", report.ttlExpired === false && report.sinceSec === 420, JSON.stringify(report.sinceSec));
		check("so the one answer only this instrument gives survives", report.verdict === "dropped", report.verdict);

		// The same gap with no refresh in it is expiry, and must still say so.
		const cold = createWireTrace("session-nowarm", env);
		cold.request(payloadOf({ messages: loop() }), meta);
		cold.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		clock += 420_000;
		cold.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), meta);
		const expired = cold.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
		check("seven minutes with nothing renewing it is expiry", expired.ttlExpired === true && expired.verdict === "expired");
		check("and the line says expiry is expected, not a fault", describeBreak(expired).startsWith("cache expired:") && describeBreak(expired).includes("not a fault"), describeBreak(expired));

		// A reload picks the refreshed clock up off the ledger too, because the warm
		// records sit in the same file as the requests.
		const refreshed = createWireTrace("session-warmreload", env);
		refreshed.request(payloadOf({ messages: loop() }), meta);
		refreshed.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
		clock += 280_000;
		refreshed.warm("m");
		clock += 140_000;
		const reloaded = createWireTrace("session-warmreload", env);
		reloaded.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), meta);
		const after = reloaded.usage({ input: 4, cacheRead: 0, cacheWrite: 9200 });
		check("a reloaded comparator reads the refreshed clock off the ledger",
			after.ttlExpired === false && after.sinceSec === 420, JSON.stringify({ ttlExpired: after.ttlExpired, sinceSec: after.sinceSec }));
		check("and stays honest about the messages it never saw", after.verdict === "unknown", after.verdict);
	} finally {
		Date.now = realNow;
	}
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: what the breaks re-billed");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const billed = createWireTrace("session-bill", env);
	billed.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 5 });
	billed.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	billed.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("later")] }]) }), { model: "m", degraded: false, ttlMin: 5 });
	billed.usage({ input: 4, cacheRead: 0, cacheWrite: 9100 });
	check("the total sums what the recorded breaks re-billed", rebilledTokens(billed.path) > 0, String(rebilledTokens(billed.path)));
	check("a ledger that cannot be read has no total rather than an exception", rebilledTokens(path.join(DIR, "nope.jsonl")) === 0);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: the reasoning fields are a section of their own");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const meta = { model: "claude-fable-5-1", degraded: false, ttlMin: 5 };
	const at = (effort, messages) => ({ ...payloadOf({ messages }), thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } });

	const print = wirePrint(at("low", loop()));
	check("the print holds every reasoning leaf by path",
		JSON.stringify(print.reasoning) === JSON.stringify({ "output_config.effort": "\"low\"", "thinking.display": "\"summarized\"", "thinking.type": "\"adaptive\"" }),
		JSON.stringify(print.reasoning));
	check("a payload without them prints an empty section, not nothing", JSON.stringify(wirePrint(payloadOf({ messages: loop() })).reasoning) === "{}");

	// The 2026-09-09 session: 34 requests at low, then a switch to medium. Tools and
	// system came back, every message was written again, and the old classifier
	// blamed the provider.
	const seat = createWireTrace("session-effort", env);
	seat.request(at("low", loop()), meta);
	seat.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	seat.request(at("medium", loop([{ role: "assistant", content: [textBlock("later")] }])), meta);
	const switched = seat.usage({ input: 4, cacheRead: 6266, cacheWrite: 2900 });
	check("an effort switch is a reasoning break, not a drop", switched.verdict === "reasoning", switched.verdict);
	check("which names what moved",
		describeBreak(switched) === 'cache break: reasoning \u2014 effort "low" \u2192 "medium" rewrote the conversation tier, 2,767 tokens re-billed (read 6,266 of 9,033)',
		describeBreak(switched));
	check("the ledger records the fields for the next reload", fs.readFileSync(seat.path, "utf8").includes('"rs":{"output_config.effort":"\\"medium\\""'));

	// A reasoning change outranks a message edit: the loss starts at messages[0].
	const both = createWireTrace("session-effort-and-edit", env);
	both.request(at("low", loop()), meta);
	both.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	const edited = loop(); edited[0] = { role: "user", content: [textBlock("go, differently")] };
	both.request(at("medium", edited), meta);
	check("and outranks an edit deeper in the messages", both.usage({ input: 4, cacheRead: 6266, cacheWrite: 2800 }).verdict === "reasoning");

	// But never a tools move, which sits ahead of it in the key.
	const tools = createWireTrace("session-effort-and-tools", env);
	tools.request(at("low", loop()), meta);
	tools.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	tools.request({ ...at("medium", loop()), tools: payloadOf({ tools: ["Bash", "Read"] }).tools }, meta);
	check("but not a tools move, which the key sees first", tools.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 }).verdict === "reorder");

	// Reloaded from the ledger, the comparison still sees the fields.
	const reloaded = createWireTrace("session-effort", env);
	reloaded.request(at("low", loop([{ role: "assistant", content: [textBlock("later")] }, { role: "user", content: [textBlock("more")] }])), meta);
	check("a reload compares reasoning off the ledger", reloaded.usage({ input: 4, cacheRead: 6266, cacheWrite: 3000 }).verdict === "reasoning");

	// A ledger written before `rs` existed cannot compare, and says so.
	const old = createWireTrace("session-effort-old", env);
	old.request(at("low", loop()), meta);
	old.usage({ input: 4, cacheRead: 0, cacheWrite: 9033 });
	fs.writeFileSync(old.path, fs.readFileSync(old.path, "utf8").replace(/,"rs":\{[^}]*\}/, ""));
	const blind = createWireTrace("session-effort-old", env);
	blind.request(at("medium", loop([{ role: "assistant", content: [textBlock("later")] }])), meta);
	check("an older ledger without the fields does not invent a verdict", blind.usage({ input: 4, cacheRead: 6266, cacheWrite: 2900 }).verdict === "unknown");
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: Haiku 4.5 misses the tier after a turn it thought on");
{
	const env = { PI_WIRE_TRACE_DIR: DIR };
	const after = (model, reasoning) => {
		const seat = createWireTrace(`session-turn-${model}-${reasoning}`, env);
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

// ---------------------------------------------------------------------------
console.log("\nwire-trace: a response that wrote nothing added nothing to the cache");
{
	// Session 01a11fe8-8935, requests 10-12 (2026-10-09): request 11 billed its new
	// tail as a cache read and wrote nothing; request 12 read request 10's entry.
	const seat = createWireTrace("session-unwritten", { PI_WIRE_TRACE_DIR: DIR });
	const meta = { model: "claude-sonnet-5-5", degraded: false, ttlMin: 5 };
	seat.request(payloadOf({ messages: loop() }), meta);
	seat.usage({ input: 2, cacheRead: 38641, cacheWrite: 7556 });
	seat.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("one")] }]) }), meta);
	seat.usage({ input: 2, cacheRead: 48791, cacheWrite: 0 });
	check("the provider holds the last entry written, not the read", seat.held() === 46197, String(seat.held()));
	check("a reload rebuilds the same prefix from the ledger", createWireTrace("session-unwritten", { PI_WIRE_TRACE_DIR: DIR }).held() === 46197);
	seat.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("one")] }, { role: "assistant", content: [textBlock("two")] }]) }), meta);
	const report = seat.usage({ input: 2, cacheRead: 46197, cacheWrite: 4624 });
	check("reading that entry back is not a break", report === undefined && !fs.readFileSync(seat.path, "utf8").includes('"t":"break"'), JSON.stringify(report));

	// Session 01a11bd3-1b06, requests 1-2 (2026-10-08): the first response read its
	// whole prompt and wrote nothing; the second read only tools and system.
	const fresh = createWireTrace("session-unwritten-first", { PI_WIRE_TRACE_DIR: DIR });
	fresh.request(payloadOf({ messages: loop() }), meta);
	fresh.usage({ input: 4, cacheRead: 6651, cacheWrite: 0 });
	check("a first response that wrote nothing leaves nothing known held", fresh.held() === undefined, String(fresh.held()));
	fresh.request(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("one")] }]) }), meta);
	check("so the next request is not judged against it", fresh.usage({ input: 2, cacheRead: 5110, cacheWrite: 3668 }) === undefined);
}

// ---------------------------------------------------------------------------
console.log("\nwire-trace: a break the session explains is named, not warned");
{
	const rebuilt = [{ role: "user", content: [textBlock("Summary of the conversation so far")] }, ...loop().slice(1), { role: "assistant", content: [textBlock("next")] }];
	const run = (id, cause) => {
		const recorder = createWireTrace(id, { PI_WIRE_TRACE_DIR: DIR });
		recorder.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 60 });
		recorder.usage({ input: 4, cacheRead: 0, cacheWrite: 9000 });
		recorder.request(payloadOf({ messages: rebuilt }), { model: "m", degraded: false, ttlMin: 60, cause });
		return recorder.usage({ input: 4, cacheRead: 1000, cacheWrite: 9000 });
	};
	const compacted = run("session-compaction", "compaction");
	check("a compaction between two requests is the verdict", compacted.verdict === "compaction", compacted.verdict);
	check("it is not a fault", !breakIsFault(compacted.verdict));
	check("it reports the new prefix", describeBreak(compacted) === "compaction: new prefix of 10,004 tokens after compaction", describeBreak(compacted));
	const edited = run("session-your-edit", "your edit");
	check("a user edit is named plainly and is not a fault", edited.verdict === "your edit" && !breakIsFault(edited.verdict) && describeBreak(edited).startsWith("your edit:"), describeBreak(edited));
	const switched = createWireTrace("session-model-switch", { PI_WIRE_TRACE_DIR: DIR });
	switched.request(payloadOf({ messages: loop() }), { model: "m", degraded: false, ttlMin: 60 });
	switched.usage({ input: 4, cacheRead: 0, cacheWrite: 9000 });
	switched.request(payloadOf({ messages: [...loop(), { role: "assistant", content: [textBlock("next")] }] }), { model: "other", degraded: false, ttlMin: 60 });
	const switchBreak = switched.usage({ input: 4, cacheRead: 1000, cacheWrite: 9000 });
	check("a model switch is named and is not a fault", switchBreak.verdict === "model switch" && !breakIsFault(switchBreak.verdict) && !describeBreak(switchBreak).includes("provider dropped"), describeBreak(switchBreak));
	const unexplained = run("session-unexplained", undefined);
	check("an unexplained messages[0] change still warns", unexplained.verdict === "edit" && breakIsFault(unexplained.verdict), unexplained.verdict);
}

fs.rmSync(DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
await finish();
