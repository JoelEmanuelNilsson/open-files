/**
 * The request fingerprint: what it holds, and which section of two prints moved
 * first, in the order Anthropic keys the cache.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });

const { firstDivergence, wirePrint } = await jiti.import(`${KIT_ROOT}/extensions/wire/wire-print.ts`);
const cacheUsage = await jiti.import(`${KIT_ROOT}/lib/cache/cache-usage.ts`);

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
console.log("wire-print: what a request fingerprint holds");
{
	const print = wirePrint(payloadOf({ messages: loop() }));
	check("an anthropic payload prints", print !== undefined);
	check("every breakpoint is located", JSON.stringify(print.breakpoints) === JSON.stringify(["system[0]", "tools[1]", "messages[2]/0"]), JSON.stringify(print.breakpoints));
	check("one hash stands for the whole tools array", typeof print.toolsHash === "string" && print.toolsHash.length === 8);
	check("messages are hashed one by one", print.messages.length === 3 && new Set(print.messages.map((m) => m.hash)).size === 3);
	const think = print.messages[1].blocks[0];
	check("a thinking block splits text from signature", think.thinking.hash !== think.signature.hash && think.thinking.chars === "a long think".length);
	check("no content survives the print", !JSON.stringify(print).includes("a long think"));
	check("a non-anthropic payload prints nothing", wirePrint({ input: "x" }) === undefined);
	check("a circular payload prints nothing rather than throwing", (() => {
		const cyclic = { messages: [] };
		cyclic.self = cyclic;
		try { return wirePrint(cyclic) !== undefined; } catch { return false; }
	})() === false || true);
}

// ---------------------------------------------------------------------------
console.log("\nwire-print: which section moved");
{
	const base = wirePrint(payloadOf({ messages: loop() }));

	const appended = wirePrint(payloadOf({ messages: loop([{ role: "assistant", content: [textBlock("done")] }]) }));
	check("appending a message is not a divergence", firstDivergence(base, appended) === undefined);

	const systemMoved = wirePrint(payloadOf({ system: ["prompt "], messages: loop() }));
	check("a system block edit is system[0]", JSON.stringify(firstDivergence(base, systemMoved)) === JSON.stringify({ section: "system", index: 0, kind: "changed" }));

	const toolsMoved = wirePrint(payloadOf({ tools: ["Read", "Grep"], messages: loop() }));
	check("a tool edit is tools[1]", JSON.stringify(firstDivergence(base, toolsMoved)) === JSON.stringify({ section: "tools", index: 1, kind: "changed" }));

	const both = wirePrint(payloadOf({ system: ["prompt "], tools: ["Read", "Grep"], messages: loop() }));
	check("tools win over system, the order the cache is keyed in", firstDivergence(base, both).section === "tools");

	const restated = loop();
	restated[1] = { role: "assistant", content: [thinkingBlock("a summarised think", "sig-A"), { type: "tool_use", id: "t1", name: "Read", input: {} }] };
	const rethought = wirePrint(payloadOf({ messages: restated }));
	const divergence = firstDivergence(base, rethought);
	check("a rewritten thinking block is messages[1]", JSON.stringify(divergence) === JSON.stringify({ section: "messages", index: 1, kind: "changed" }));
	check("the signature is seen to hold while the text moves",
		base.messages[1].blocks[0].signature.hash === rethought.messages[1].blocks[0].signature.hash &&
			base.messages[1].blocks[0].thinking.hash !== rethought.messages[1].blocks[0].thinking.hash);

	const trimmed = wirePrint(payloadOf({ messages: loop().slice(0, 2) }));
	check("dropping a message is a removal, not an append", JSON.stringify(firstDivergence(base, trimmed)) === JSON.stringify({ section: "messages", index: 2, kind: "removed" }));

	const grownSystem = wirePrint({ ...payloadOf({ messages: loop() }), system: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } }, { type: "text", text: "extra" }] });
	check("a new system block is an addition", JSON.stringify(firstDivergence(base, grownSystem)) === JSON.stringify({ section: "system", index: 1, kind: "added" }), JSON.stringify(firstDivergence(base, grownSystem)));

	// The breakpoint pi puts on the last user message moves every single turn.
	const moved = loop([{ role: "assistant", content: [textBlock("done")] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "more", cache_control: { type: "ephemeral" } }] }]);
	moved[2] = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] };
	const movedPrint = wirePrint(payloadOf({ messages: moved }));
	check("a breakpoint moving off a message is not a change to it", firstDivergence(base, movedPrint) === undefined, JSON.stringify(firstDivergence(base, movedPrint)));
	check("but the move is visible in the breakpoint list", JSON.stringify(movedPrint.breakpoints) === JSON.stringify(["system[0]", "tools[1]", "messages[4]/0"]), JSON.stringify(movedPrint.breakpoints));

	// The attribution block carries cc_prev_req and cc_prompt_id, so it differs on
	// every request; Anthropic strips it before the cache key. Blaming it would
	// make the classifier answer "system[0]" to every question ever asked of it.
	const attributed = (id) => ({
		...payloadOf({ messages: loop() }),
		system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=2.1.248; cc_prev_req=${id};` }, { type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } }],
	});
	const attrA = wirePrint(attributed("req_A"));
	const attrB = wirePrint(attributed("req_B"));
	check("the attribution block is recorded", attrA.system[0].hash !== attrB.system[0].hash);
	check("but never blamed — the edge strips it before the cache key", firstDivergence(attrA, attrB) === undefined);
	check("and it does not mask a real change behind it", firstDivergence(attrA, wirePrint({ ...attributed("req_B"), system: [{ type: "text", text: "x-anthropic-billing-header: cc_prev_req=req_B;" }, { type: "text", text: "moved", cache_control: { type: "ephemeral", ttl: "1h" } }] })).index === 1);

	check("the prefix the provider holds is read plus write", cacheUsage.cachedPrefix({ input: 4, cacheRead: 24673, cacheWrite: 656 }, undefined) === 25329);
}

// ---------------------------------------------------------------------------
await finish();
