/**
 * The warm-prefix ledger: what a fresh seat may promise about its first request.
 *
 * Two claims, each pinned here because each is what the glow's truth rests on:
 *
 *   - The wire key sees what the server sees. The attribution block changes on
 *     every request and the server strips it; `cache_control` is asked for, not
 *     cached. Neither may move the key. Everything else must.
 *   - The ledger is a set of facts with a clock, not a cache of opinions: the
 *     newest anchor wins, a stale entry is cold, an unseen input is unknown,
 *     and a contradiction (same inputs, different bytes) is reported once and
 *     takes the newest bytes — the ones the provider now holds.
 */

import "./env.mjs";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { inputsKey, inputsParts, measuresReasoning, predictWarmth, prefixInputsOf, pruneWarmPrefixes, readsAcrossReasoning, reasoningChangeCost, recordPrediction, recordReasoningFact, recordWarmPrefix, seatName, wireKey, withdrawRenewal } = await jiti.import(
	`${ROOT}/lib/warm-prefix.ts`,
);
const { ATTRIBUTION_PREFIX } = await jiti.import(`${ROOT}/lib/claude-code.ts`);
const { warmthOf } = await jiti.import(`${ROOT}/extensions/zen-chrome/warmth.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const payload = (over = {}) => ({
	model: "claude-fable-5-1",
	max_tokens: 32000,
	thinking: { type: "adaptive", display: "summarized" },
	output_config: { effort: "high" },
	stream: true,
	tools: [{ name: "Read", description: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
	system: [
		{ type: "text", text: `${ATTRIBUTION_PREFIX} cc_version=2.1.75.abc; cc_prompt_id=1111;` },
		{ type: "text", text: "You are Claude Code" },
		{ type: "text", text: "the owned prompt", cache_control: { type: "ephemeral" } },
	],
	messages: [{ role: "user", content: "hi" }],
	...over,
});

console.log("wire key: sees what the server sees, with the reasoning fields and without");
{
	const base = wireKey(payload());
	eq("a key is sixteen hex chars, twice", [base.exact, base.bytes].every((key) => /^[0-9a-f]{16}$/.test(key)), true);
	eq("the two hashes differ when the payload carries reasoning fields", base.exact !== base.bytes, true);
	const same = (over) => wireKey(over);
	const otherPrompt = payload();
	otherPrompt.system[0].text = `${ATTRIBUTION_PREFIX} cc_version=2.1.75.zzz; cc_prev_req=req_1; cc_prompt_id=2222;`;
	eq("the attribution block is stripped by the server, so it does not move the key", same(otherPrompt), base);
	const longTtl = payload();
	longTtl.system[2].cache_control = { type: "ephemeral", ttl: "1h" };
	longTtl.tools[0].cache_control = { type: "ephemeral", ttl: "1h" };
	eq("the TTL asked for is not part of the cached bytes", same(longTtl), base);
	eq("the first user message is not the prefix", same(payload({ messages: [{ role: "user", content: "something else" }] })), base);
	eq("streaming is transport, not prefix", same(payload({ stream: false })), base);
	const reordered = Object.fromEntries(Object.entries(payload()).reverse());
	eq("field order is serialization, not prefix", same(reordered), base);
	const model = wireKey(payload({ model: "claude-opus-5" }));
	eq("another model is another entry under both hashes", [model.exact !== base.exact, model.bytes !== base.bytes], [true, true]);
	// Opus 5, 2026-09-08: high → low re-wrote the whole prefix (read 0, write 6346); Fable 5.1 read it (6346, 0).
	const effort = wireKey(payload({ output_config: { effort: "low" } }));
	eq("another effort moves the exact hash and not the bytes", [effort.exact !== base.exact, effort.bytes === base.bytes], [true, true]);
	const budget = wireKey(payload({ thinking: { type: "enabled", budget_tokens: 1024 } }));
	eq("another thinking budget likewise", [budget.exact !== base.exact, budget.bytes === base.bytes], [true, true]);
	const meta = wireKey(payload({ metadata: { user_id: "u1" } }));
	eq("a field this build did not know is still a field, in both", [meta.exact !== base.exact, meta.bytes !== base.bytes], [true, true]);
	const editedPrompt = payload();
	editedPrompt.system[2].text = "the owned prompt, edited";
	eq("one byte of system prompt is another entry", wireKey(editedPrompt).bytes !== base.bytes, true);
	const editedTool = payload();
	editedTool.tools[0].description = "read files";
	eq("one byte of tool schema is another entry", wireKey(editedTool).bytes !== base.bytes, true);
	eq("a tool added is another entry", wireKey(payload({ tools: [...payload().tools, { name: "Bash", description: "", input_schema: {} }] })).bytes !== base.bytes, true);
	const noIdentity = payload();
	noIdentity.system.splice(1, 1);
	eq("a Console-key request, without the identity block, is another entry", wireKey(noIdentity).bytes !== base.bytes, true);
	const bare = wireKey(payload({ thinking: undefined, output_config: undefined }));
	eq("no reasoning fields: one hash, the same twice", bare.exact === bare.bytes, true);
	eq("not an Anthropic payload, no key", wireKey({ messages: [] }), undefined);
	// The provider caches up to the last breakpoint, so what follows it is the
	// conversation's, not the prefix's — which is what lets two seats in
	// different directories share one tools+system entry.
	const here = payload();
	here.system.push({ type: "text", text: "Current working directory: /a" });
	const there = payload();
	there.system.push({ type: "text", text: "Current working directory: /b" });
	eq("a system block past the last breakpoint is not in the key", [wireKey(here), wireKey(there)], [base, base]);
	const unbroken = payload();
	delete unbroken.system[2].cache_control;
	unbroken.system.push({ type: "text", text: "trailing" });
	const trimmed = payload();
	delete trimmed.system[2].cache_control;
	eq("with no breakpoint at all the whole array is keyed", wireKey(unbroken).bytes !== wireKey(trimmed).bytes, true);
}

console.log("one entry across directories: the cwd cannot split a prefix");
{
	const { capturePromptOptions } = await jiti.import(`${ROOT}/lib/prompt-capture.ts`);
	const { cwdBlockText } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const api = {
		getAllTools: () => [
			{ name: "Read", description: "read", parameters: { type: "object" } },
			{ name: "Bash", description: "run", parameters: { type: "object" } },
			{ name: "grep", description: "deleted everywhere", parameters: { type: "object" } },
		],
		getActiveTools: () => ["Read", "Bash", "grep"],
		getThinkingLevel: () => "high",
	};
	// Two seats, identical but for where they run — the parent and its worker in
	// a worktree. Each captured pi's options with its own cwd.
	const seat = (sessionId, cwd) => {
		capturePromptOptions(sessionId, { cwd, selectedTools: ["read", "bash", "edit", "write"] });
		return {
			cwd,
			model: { id: "claude-fable-5-1", api: "anthropic-messages" },
			modelRegistry: { isUsingOAuth: () => true },
			getSystemPrompt: () => `pi's rendering\nCurrent working directory: ${cwd}`,
			sessionManager: { getSessionId: () => sessionId },
		};
	};
	const home = prefixInputsOf(api, seat("s-home", "/repo"), false);
	const worktree = prefixInputsOf(api, seat("s-worktree", "/repo/wt"), false);
	eq("the prompt body a seat predicts carries no cwd", home.systemPrompt.includes("Current working directory"), false);
	eq("two seats that differ only in cwd have one inputs key", inputsKey(worktree), inputsKey(home));
	// And the bytes those inputs produce: the wire's array, with the cwd block
	// after the breakpoint (extensions/wire.ts).
	const wire = (cwd) => payload({ system: [...payload().system, { type: "text", text: cwdBlockText(cwd) }] });
	eq("and one wire key", wireKey(wire("/repo/wt")), wireKey(wire("/repo")));
	// The witness is pi's rendering on both sides of the ledger: a fresh seat has
	// no captured options yet, and a key that changed at the first request would
	// leave every fresh seat reading never-seen.
	eq("the witness is pi's rendering with the footer cut", home.systemPrompt, "pi's rendering");
	const uncaptured = prefixInputsOf(api, { ...seat("s-none", "/repo"), sessionManager: { getSessionId: () => "s-uncaptured" } }, false);
	eq("a seat with no captured options predicts the same key it will record", inputsKey(uncaptured), inputsKey(home));
	// The witness is the list the wire sends: the cuts applied, then sorted, by
	// the same two functions `extensions/wire.ts` calls on the payload.
	eq("the tools witnessed are the cut ones, in canonical order", home.tools.map((tool) => tool.name), ["Bash", "Read"]);
	eq("a chat seat witnesses its own cut", prefixInputsOf(api, seat("s-chat", "/repo"), true).tools.map((tool) => tool.name), ["Bash"]);
}

console.log("build stamp: the code that turns the inputs into bytes is one of the inputs");
{
	const api = {
		getAllTools: () => [{ name: "Read", description: "read", parameters: { type: "object" } }],
		getActiveTools: () => ["Read"],
		getThinkingLevel: () => "high",
	};
	const ctx = (model) => ({
		cwd: "/repo",
		model,
		modelRegistry: { isUsingOAuth: () => true },
		getSystemPrompt: () => "pi's rendering",
		sessionManager: { getSessionId: () => "s-build" },
	});
	const record = { id: "claude-fable-5-1", api: "anthropic-messages", maxTokens: 32000 };
	const inputs = prefixInputsOf(api, ctx(record), false);
	eq("the stamp is a digest", /^[0-9a-f]{16}$/.test(inputs.build), true);
	// Hashed once at load: a seat that re-asked per request would file its old
	// bytes under the new source's key the moment an edit landed mid-session.
	eq("and it does not move within a process", prefixInputsOf(api, ctx(record), false).build, inputs.build);
	eq("the whole model record is witnessed, not just its id", prefixInputsOf(api, ctx({ ...record, maxTokens: 64000 }), false).modelRecord !== inputs.modelRecord, true);
	eq("and field order in that record is not a difference", prefixInputsOf(api, ctx({ maxTokens: 32000, api: "anthropic-messages", id: "claude-fable-5-1" }), false).modelRecord, inputs.modelRecord);
	eq("a changed model record is a changed key", inputsKey(prefixInputsOf(api, ctx({ ...record, maxTokens: 64000 }), false)) !== inputsKey(inputs), true);
	eq("and `/warm` prints both components", [inputsParts(inputs).build, inputsParts(inputs).modelRecord], [inputs.build, inputs.modelRecord]);
}

console.log("inputs key: the seat's own view, complete and pure");
{
	const inputs = {
		model: "claude-fable-5-1",
		modelRecord: "m0",
		build: "b0",
		reasoning: "high",
		oauth: true,
		seat: "main",
		systemPrompt: "pi's rendering",
		tools: [{ name: "Read", description: "read", parameters: { type: "object", properties: {} } }],
	};
	const base = inputsKey(inputs);
	eq("the same inputs give the same key", inputsKey({ ...inputs, tools: [...inputs.tools] }), base);
	eq("the model is an input", inputsKey({ ...inputs, model: "claude-opus-5" }) !== base, true);
	eq("the model's whole record is an input", inputsKey({ ...inputs, modelRecord: "m1" }) !== base, true);
	eq("the code that builds the bytes is an input", inputsKey({ ...inputs, build: "b1" }) !== base, true);
	eq("the reasoning level is an input", inputsKey({ ...inputs, reasoning: "low" }) !== base, true);
	eq("how the seat authenticates is an input", inputsKey({ ...inputs, oauth: false }) !== base, true);
	eq("the seat is an input", inputsKey({ ...inputs, seat: "main+workflows" }) !== base, true);
	eq("pi's prompt is an input", inputsKey({ ...inputs, systemPrompt: "pi's rendering, after an AGENTS.md edit" }) !== base, true);
	eq("a tool's schema is an input", inputsKey({ ...inputs, tools: [{ ...inputs.tools[0], parameters: { type: "object" } }] }) !== base, true);
	eq("tool order is an input", inputsKey({ ...inputs, tools: [inputs.tools[0], { name: "Bash", description: "", parameters: {} }] }) !== inputsKey({ ...inputs, tools: [{ name: "Bash", description: "", parameters: {} }, inputs.tools[0]] }), true);
	eq("seat names: chat wins, then role with its launch answer", [seatName({ role: "main", workflows: false }, true), seatName({ role: "main", workflows: true }, false), seatName({ role: "worker", workflows: false }, false)], ["chat", "main+workflows", "worker"]);
}

console.log("ledger: facts with a clock");
{
	const dir = mkdtempSync(path.join(tmpdir(), "warm-prefix-"));
	const T = 1_700_000_000_000;
	const FIVE_M = 5 * 60 * 1000;
	const key = (exact, bytes = exact) => ({ exact, bytes });
	const W1 = key("wire-1");
	const W2 = key("wire-2");
	eq("an input nobody has sent from is unknown, not cold", predictWarmth(dir, "inputs-a", T), { kind: "unknown", reason: "never-seen" });

	eq("first mapping records without complaint", recordPrediction(dir, "inputs-a", W1), {});
	eq("mapped but never sent: cold", predictWarmth(dir, "inputs-a", T), { kind: "cold" });

	recordWarmPrefix(dir, W1, "seat-1", { model: "claude-fable-5-1", at: T, ttlMs: FIVE_M });
	eq("sent a moment ago: warm until the TTL", predictWarmth(dir, "inputs-a", T + 1000), { kind: "warm", until: T + FIVE_M, model: "claude-fable-5-1" });
	eq("at the TTL exactly: cold", predictWarmth(dir, "inputs-a", T + FIVE_M), { kind: "cold" });

	recordWarmPrefix(dir, W1, "seat-1", { model: "claude-fable-5-1", at: T + 4 * 60 * 1000, ttlMs: FIVE_M });
	eq("a ping four minutes in restarts the clock", predictWarmth(dir, "inputs-a", T + FIVE_M), { kind: "warm", until: T + 9 * 60 * 1000, model: "claude-fable-5-1" });
	recordWarmPrefix(dir, W1, "seat-1", { model: "claude-fable-5-1", at: T + 60 * 1000, ttlMs: FIVE_M });
	eq("a late report of an older request cannot move the clock backwards", predictWarmth(dir, "inputs-a", T + FIVE_M), { kind: "warm", until: T + 9 * 60 * 1000, model: "claude-fable-5-1" });
	recordWarmPrefix(dir, W1, "seat-1", { model: "claude-fable-5-1", at: T + 5 * 60 * 1000, ttlMs: 60 * 60 * 1000 });
	eq("a 1h write is an hour of warmth", predictWarmth(dir, "inputs-a", T + 60 * 60 * 1000), { kind: "warm", until: T + 65 * 60 * 1000, model: "claude-fable-5-1" });

	eq("two seats with the same inputs sending the same bytes agree", recordPrediction(dir, "inputs-a", W1), {});
	eq("the same inputs producing different bytes is a contradiction, and says which", recordPrediction(dir, "inputs-a", W2), { contradiction: "wire-1" });
	// Newest wins: the bytes just sent are the ones the provider holds, so the
	// mapping follows them rather than going dark on the seat.
	eq("the newer mapping is the one the ledger keeps", predictWarmth(dir, "inputs-a", T + 1000), { kind: "cold" });
	recordWarmPrefix(dir, W2, "seat-1", { model: "claude-fable-5-1", at: T, ttlMs: FIVE_M });
	eq("and it is the one the glow reads", predictWarmth(dir, "inputs-a", T + 1000), { kind: "warm", until: T + FIVE_M, model: "claude-fable-5-1" });
	eq("the same bytes twice is no contradiction", recordPrediction(dir, "inputs-a", W2), {});
	const writeLegacy = (await import("node:fs")).writeFileSync;
	writeLegacy(path.join(dir, "inputs", "inputs-old.json"), JSON.stringify({ wire: "wire-legacy", bytes: "wire-legacy", unstable: true }));
	eq("a file written by the build that marked keys unstable still reads, minus the flag", predictWarmth(dir, "inputs-old", T), { kind: "cold" });
	eq("another input is its own question", predictWarmth(dir, "inputs-b", T), { kind: "unknown", reason: "never-seen" });

	// Reasoning: two hashes per request, one fact per model, measured not guessed.
	const fableHigh = key("fable-high", "fable-bytes");
	const fableLow = key("fable-low", "fable-bytes");
	recordPrediction(dir, "inputs-fable-high", fableHigh);
	recordPrediction(dir, "inputs-fable-low", fableLow);
	eq("a request at another level is a measurement only once the bytes are warm", measuresReasoning(dir, fableLow, T), false);
	recordWarmPrefix(dir, fableHigh, "seat-1", { model: "claude-fable-5-1", at: T, ttlMs: FIVE_M });
	eq("its own level: warm, no fact needed", predictWarmth(dir, "inputs-fable-high", T + 1000), { kind: "warm", until: T + FIVE_M, model: "claude-fable-5-1" });
	eq("another level, model unmeasured: unknown, not cold", predictWarmth(dir, "inputs-fable-low", T + 1000), { kind: "unknown", reason: "reasoning-unmeasured" });
	eq("and sending it now would measure", measuresReasoning(dir, fableLow, T + 1000), true);
	eq("sending the warm level would not", measuresReasoning(dir, fableHigh, T + 1000), false);
	eq("a payload without reasoning fields never measures", measuresReasoning(dir, key("plain"), T), false);
	eq("no fact yet", readsAcrossReasoning(dir, "claude-fable-5-1"), undefined);
	eq("a model nobody has measured costs an unknown", reasoningChangeCost(dir, "claude-fable-5-1"), "unmeasured");
	eq("the provider read it: the model reads across, and that is news", recordReasoningFact(dir, "claude-fable-5-1", { prefix: true }, T + 2000), { changed: true });
	eq("the fact so far: prefix yes, conversation unanswered", readsAcrossReasoning(dir, "claude-fable-5-1"), { prefix: true });
	eq("a prefix answer alone still says nothing about the conversation", reasoningChangeCost(dir, "claude-fable-5-1"), "unmeasured");
	eq("another level, model reads across: warm on the bytes' clock", predictWarmth(dir, "inputs-fable-low", T + 3000), { kind: "warm", until: T + FIVE_M, model: "claude-fable-5-1" });
	eq("the same answer again is not news", recordReasoningFact(dir, "claude-fable-5-1", { prefix: true }, T + 4000), { changed: false });
	eq("a mid-conversation measurement adds the conversation answer", recordReasoningFact(dir, "claude-fable-5-1", { prefix: true, conversation: true }, T + 4500), { changed: true });
	eq("a later prefix-only measurement leaves it standing", recordReasoningFact(dir, "claude-fable-5-1", { prefix: true }, T + 4600), { changed: false });
	eq("both held", readsAcrossReasoning(dir, "claude-fable-5-1"), { prefix: true, conversation: true });
	eq("a model that reads the conversation across costs nothing", reasoningChangeCost(dir, "claude-fable-5-1"), "keeps");
	eq("an older measurement cannot overwrite a newer one", recordReasoningFact(dir, "claude-fable-5-1", { prefix: false }, T + 1000), { changed: false });
	eq("the fact stands", readsAcrossReasoning(dir, "claude-fable-5-1"), { prefix: true, conversation: true });
	eq("the provider changing its mind is news, and wins", recordReasoningFact(dir, "claude-fable-5-1", { prefix: false }, T + 5000), { changed: true });
	eq("a rewritten prefix takes the conversation with it", readsAcrossReasoning(dir, "claude-fable-5-1"), { prefix: false, conversation: false });
	eq("and that is what the level mark warns about", reasoningChangeCost(dir, "claude-fable-5-1"), "rewrites");
	eq("Haiku 4.5: reads tools+system, rewrites the messages", recordReasoningFact(dir, "claude-haiku-4-5", { prefix: true, conversation: false }, T), { changed: true });
	eq("which is warm before the first request", (() => { recordPrediction(dir, "inputs-haiku-high", key("haiku-high", "haiku-bytes")); recordPrediction(dir, "inputs-haiku-low", key("haiku-low", "haiku-bytes")); recordWarmPrefix(dir, key("haiku-high", "haiku-bytes"), "seat-1", { model: "claude-haiku-4-5", at: T, ttlMs: FIVE_M }); return predictWarmth(dir, "inputs-haiku-low", T + 1000).kind; })(), "warm");
	eq("another level, model rewrites: cold", predictWarmth(dir, "inputs-fable-low", T + 6000), { kind: "cold" });
	eq("the bytes' clock past its TTL: cold whatever the fact", predictWarmth(dir, "inputs-fable-low", T + FIVE_M), { kind: "cold" });

	// Several renewers on one key: the key is warm until the last of them gives up.
	const SHUTOFF = 25 * 60 * 1000;
	recordPrediction(dir, "inputs-shared", key("wire-shared"));
	recordWarmPrefix(dir, key("wire-shared"), "seat-a", { model: "claude-fable-5-1", at: T, ttlMs: FIVE_M, keepUntil: T + SHUTOFF });
	recordWarmPrefix(dir, key("wire-shared"), "seat-b", { model: "claude-fable-5-1", at: T + 1000, ttlMs: FIVE_M });
	eq("a second seat writing later does not shorten the first's commitment", predictWarmth(dir, "inputs-shared", T + 2000), { kind: "warm", until: T + SHUTOFF, model: "claude-fable-5-1" });
	eq("and a halted renewer contributes only its own TTL", predictWarmth(dir, "inputs-shared", T + FIVE_M + 500), { kind: "warm", until: T + 1000 + FIVE_M, model: "claude-fable-5-1" });
	recordWarmPrefix(dir, key("wire-shared"), "seat-b", { model: "claude-opus-5", at: T + 2000, ttlMs: FIVE_M, keepUntil: T + 2 * SHUTOFF });
	eq("the newest file names the model, the latest commitment names the clock", predictWarmth(dir, "inputs-shared", T + 3000), { kind: "warm", until: T + 2 * SHUTOFF, model: "claude-opus-5" });
	eq("a renewer whose own TTL has run out drops out, commitment and all", predictWarmth(dir, "inputs-shared", T + 2000 + FIVE_M), { kind: "cold" });
	recordWarmPrefix(dir, key("wire-shared"), "seat-a", { model: "claude-fable-5-1", at: T - 1000, ttlMs: FIVE_M, keepUntil: T + 3 * SHUTOFF });
	eq("a late report of an older request cannot move one renewer's clock", predictWarmth(dir, "inputs-shared", T + 3000), { kind: "warm", until: T + 2 * SHUTOFF, model: "claude-opus-5" });
	// A seat that halts or quits knows it: its commitment goes, its anchor stays.
	withdrawRenewal(dir, key("wire-shared"), "seat-b");
	eq("a withdrawn renewer keeps only its TTL", predictWarmth(dir, "inputs-shared", T + 3000), { kind: "warm", until: T + SHUTOFF, model: "claude-opus-5" });
	withdrawRenewal(dir, key("wire-shared"), "seat-never");
	eq("withdrawing a renewer that never wrote is a no-op", predictWarmth(dir, "inputs-shared", T + 3000), { kind: "warm", until: T + SHUTOFF, model: "claude-opus-5" });

	// A ledger file that is not a ledger file reads as absent, never as a throw.
	recordPrediction(dir, "inputs-c", key("wire-9"));
	const { mkdirSync, writeFileSync } = await import("node:fs");
	mkdirSync(path.join(dir, "entries", "wire-9"), { recursive: true });
	writeFileSync(path.join(dir, "entries", "wire-9", "seat.json"), "{not json");
	eq("a corrupt entry is cold, not a crash", predictWarmth(dir, "inputs-c", T), { kind: "cold" });
	writeFileSync(path.join(dir, "inputs", "inputs-c.json"), "");
	eq("a corrupt prediction is unknown, not a crash", predictWarmth(dir, "inputs-c", T), { kind: "unknown", reason: "never-seen" });

	// Pruning: entries past every TTL go, inputs stay for a month.
	const old = new Date(T - 4 * 60 * 60 * 1000);
	for (const name of readdirSync(path.join(dir, "entries", "wire-1"))) utimesSync(path.join(dir, "entries", "wire-1", name), old, old);
	eq("no staging files are left behind", readdirSync(path.join(dir, "entries", "wire-1")).some((name) => !name.endsWith(".json")), false);
	pruneWarmPrefixes(dir, T);
	eq("an entry older than any TTL is pruned, and its empty key with it", readdirSync(path.join(dir, "entries")).includes("wire-1"), false);
	eq("a key with a live renewer stays", readdirSync(path.join(dir, "entries")).includes("wire-shared"), true);
	eq("its inputs mapping survives", readdirSync(path.join(dir, "inputs")).includes("inputs-a.json"), true);
	eq("the pruned entry reads as cold", predictWarmth(dir, "inputs-c", T), { kind: "unknown", reason: "never-seen" });
	rmSync(dir, { recursive: true, force: true });
}

console.log("verdict: whether the next request reads its prefix from cache, for the model shown");
{
	const T = 1_700_000_000_000;
	const fable = { model: "claude-fable-5-1", reasoning: "high", inputsKey: "in-fable" };
	const opus = { model: "claude-opus-5", reasoning: "high", inputsKey: "in-opus" };
	const ledger = (key) => (key === "in-fable" ? { kind: "warm", until: T + 60_000, model: "claude-fable-5-1" } : { kind: "cold" });
	const facts = (over) => ({ now: T, running: false, seat: fable, conversationStarted: false, ledger, ...over });
	const started = (over) => facts({ conversationStarted: true, ...over });

	eq("a fresh seat asks the ledger, and carries its word for the bottom rule", warmthOf(facts({})), { warm: true, ledger: { kind: "warm", until: T + 60_000, model: "claude-fable-5-1" } });
	eq("Ctrl-P to a model the ledger has cold: off", warmthOf(facts({ seat: opus })), { warm: false, ledger: { kind: "cold" } });
	eq("a turn in flight: off, whatever the ledger says", warmthOf(facts({ running: true })), { warm: false });
	eq("not an Anthropic request: off", warmthOf(facts({ seat: undefined })), { warm: false });

	// The light is a prompt for a decision — which model and level to start with —
	// so it goes out with the first message, however warm the seat's own window is.
	eq("a started conversation: off, the choice is made", warmthOf(started({})), { warm: false });
	eq("a started conversation on a model the ledger has warm: still off", warmthOf(started({ seat: fable })), { warm: false });
	eq("and the ledger is not consulted once it has started", warmthOf(started({ ledger: () => { throw new Error("asked"); } })), { warm: false });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
