/**
 * `support/scripted-seat.mjs`: each kind of scripted step reaches a real pi
 * seat as its provider would send it, a child the engine spawns answers from
 * the same script, and the seat follows its runtime across a new session.
 */

import { check, checkThrows, eq, finish, is, section } from "../support/check-harness.mjs";
import { childExtensionsList } from "../support/child-extensions.mjs";
import fs from "node:fs";
import path from "node:path";
import { until } from "../support/async-waits.mjs";
import { createScriptedAgentDir, createScriptedModel, quietSeat, SCRIPTED_MODEL, scriptedCall, scriptedMainSeat, scriptedText } from "../support/scripted-seat.mjs";

const agentDir = createScriptedAgentDir("scripted-seat-test", { "workflows/": "", "agents/explore.md": "---\nname: explore\ndescription: Find things.\n---\n" });
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts");

// One model for every seat here, as the harness requires of a process.
const model = createScriptedModel();
const lastText = (session) => session.messages.at(-1)?.content?.map((block) => block.text ?? "").join("");

section("the agent dir");
{
	is("PI_CODING_AGENT_DIR points at it", process.env.PI_CODING_AGENT_DIR, agentDir);
	is("its sessions dir is inside it", process.env.PI_CODING_AGENT_SESSION_DIR, path.join(agentDir, "sessions"));
	eq("settings, the worker type and the given files and directories", [fs.readdirSync(path.join(agentDir, "agents")).sort(), fs.statSync(path.join(agentDir, "workflows")).isDirectory(), JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"))], [["explore.md", "worker.md"], true, { compaction: { enabled: false } }]);
}

section("scripted steps");
{
	const seat = await scriptedMainSeat(model, { extensions: [] });
	model.scriptFor("Say", [[scriptedText("short key")]]);
	model.scriptFor("Say hello", [[scriptedText("hello back")], { content: [scriptedText("second turn")], delay: 20 }]);
	await seat.session.prompt("Say hello please");
	is("the longest key the user text contains answers", lastText(seat.session), "hello back");
	await seat.session.prompt("Say hello again");
	is("a key's steps answer in order", lastText(seat.session), "second turn");
	await seat.session.prompt("Say what?");
	is("the shorter key answers what only it contains", lastText(seat.session), "short key");
	await seat.session.prompt("Nothing written for this");
	is("an unscripted turn says so", lastText(seat.session), "(no script for: Nothing written for this)");
	const first = model.requestFor("Say hello please");
	check("a request records the model, system, tools and messages pi-ai was handed", first?.model === "scripted-1" && typeof first.system === "string" && Array.isArray(first.tools) && first.messages.at(-1)?.role === "user", JSON.stringify(first && { ...first, messages: first.messages.length }));
	eq("usage grows with the context by default", seat.session.messages.filter((m) => m.role === "assistant").map((m) => m.usage.input), model.requests.map((r) => 10 * (r.messages.length + 1)));

	model.scriptFor("Refuse", [{ error: "invalid_request: refused" }]);
	await seat.session.prompt("Refuse this");
	eq("an error step ends the turn as a provider refusal", [seat.session.messages.at(-1).stopReason, seat.session.messages.at(-1).errorMessage], ["error", "invalid_request: refused"]);

	const deltas = [];
	const off = seat.session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") deltas.push(event.assistantMessageEvent.delta);
	});
	model.scriptFor("Chunk", [{ chunks: ["one ", "two"], gapMs: 5 }]);
	await seat.session.prompt("Chunk it");
	off();
	eq("a chunked step streams one delta per chunk and ends as their text", [deltas, lastText(seat.session)], [["one ", "two"], "one two"]);

	let controls;
	model.scriptFor("Stay live", [{ content: [scriptedText("live done")], live: { attach: (c) => { controls = c; } } }]);
	const running = seat.session.prompt("Stay live");
	await until(() => controls !== undefined);
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("a live step keeps the turn open until its end is called", seat.session.isStreaming);
	controls.end();
	await running;
	is("and then ends as its content", lastText(seat.session), "live done");

	model.scriptFor("Slow", [{ content: [scriptedText("too late")], delay: 5000 }]);
	const slow = seat.session.prompt("Slow one");
	await until(() => seat.session.isStreaming);
	await seat.session.abort();
	await slow;
	is("an abort ends a pending step at once", seat.session.messages.at(-1).stopReason, "aborted");
}

section("options");
{
	const thinker = { ...SCRIPTED_MODEL, id: "scripted-2", reasoning: true };
	const seat = await scriptedMainSeat(model, { extensions: [], factories: [model.providerExtension({ name: "scripted-alt", models: [thinker] })], model: ["scripted-alt", "scripted-2"] });
	await seat.session.prompt("one");
	is("a seat sits on the model it names, from the factories it is given", seat.session.messages.at(-1).model, "scripted-2");
	check("pi's built-in tools are left out by default", !seat.session.getActiveToolNames().includes("read"), seat.session.getActiveToolNames().join(","));
	const withBuiltins = await scriptedMainSeat(model, { extensions: [], builtinTools: true });
	check("and kept on request", withBuiltins.session.getActiveToolNames().includes("read"), withBuiltins.session.getActiveToolNames().join(","));

	const counted = createScriptedModel({ usage: ({ requestCount }) => ({ input: 10 * requestCount, output: 5, totalTokens: 15 * requestCount }) });
	const usageOf = async () => {
		for await (const event of counted.streamSimple({ ...SCRIPTED_MODEL, api: "scripted-api", provider: "scripted" }, { messages: [{ role: "user", content: "hi", timestamp: 0 }] })) if (event.type === "done") return [event.message.usage.input, event.message.usage.totalTokens];
	};
	eq("a usage option replaces the default", [await usageOf(), await usageOf()], [[10, 15], [20, 30]]);
	await checkThrows("a second scripted model cannot provide for seats beside the first", () => counted.providerExtension(), "another scripted model already provides");
}

section("a child answers from the same script");
{
	const seat = await scriptedMainSeat(model);
	model.scriptFor("Spawn a helper", [[scriptedCall("Agent", { description: "help", prompt: "Child: count to two", subagent_type: "worker" })], [scriptedText("spawned")]]);
	model.scriptFor("Child: count to two", [[scriptedText("one, two")]]);
	await seat.session.prompt("Spawn a helper");
	const settled = await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 10000);
	await quietSeat(seat);
	check("the child's turn was answered from the parent's script", settled && model.requestFor("Child: count to two") !== undefined, JSON.stringify(seat.events.map((e) => e.channel)));
	eq("the engine's lifecycle events are recorded in order", seat.events.map((e) => e.channel).filter((c) => c !== "subagents:created"), ["subagents:started", "subagents:completed"]);
	check("the seat reads the engine's agent records", seat.agentRecords().length > 0);
	check("its tools are the engine's", seat.tool("Agent") !== undefined);
}

section("the seat follows its runtime to a new session");
{
	const order = [];
	const seat = await scriptedMainSeat(model, { extensions: [], gap: () => order.push("gap"), onShutdown: () => order.push("shutdown"), onStart: () => order.push("start") });
	const old = seat.session;
	const oldBus = seat.bus;
	await seat.session.prompt("before");
	await seat.runtime.newSession();
	check("session and bus are the new session's", seat.session !== old && seat.bus !== oldBus);
	eq("shutdown, gap, start run in that order", order, ["shutdown", "gap", "start"]);
	const shutdown = seat.log.find((e) => e.type === "shutdown");
	check("the log keeps the old file's bytes at shutdown", shutdown?.reason === "new" && shutdown.file === old.sessionFile && fs.readFileSync(old.sessionFile).equals(shutdown.bytes));
	is("the new session's start names the old file as previous", seat.log.at(-1).previous, old.sessionFile);
}

await finish();
