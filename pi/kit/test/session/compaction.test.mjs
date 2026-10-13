/**
 * In-place compaction (`extensions/compaction/index.ts`): the summary call is
 * the last request the wire sent plus one user message, and the summary pi
 * stores is Joel's messages verbatim, the model's summary, then what is running.
 * Driven through the extension's `session_before_compact` handler, with the
 * provider faked at pi-ai's stream boundary.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { isDeepStrictEqual } from "node:util";

const jiti = kitJiti({ moduleCache: false });
const { publishLastRequest: publishPingTarget, forgetLastRequests: forgetPingTargets } = await jiti.import(`${KIT_ROOT}/lib/wire/last-request.ts`);
const { markAgentLive, markAgentSettled } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
const { adoptBackgroundTask, endBackgroundTasksOf } = await jiti.import(`${KIT_ROOT}/lib/tools/background-tasks.ts`);
const { declareChildSeat, forgetChildSeat } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
const { publishAgentRuntime, forgetAgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
const compaction = await jiti.import(`${KIT_ROOT}/extensions/compaction/index.ts`, { default: true });

const SESSION = "main-compaction";
const MODEL = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", contextWindow: 1_000_000 };
const CAPTURED = {
	model: "claude-opus-5-5",
	stream: true,
	system: [{ type: "text", text: "x-anthropic-billing-header: cc" }, { type: "text", text: "You are Claude Code" }],
	tools: [{ name: "bash", input_schema: { type: "object" } }],
	messages: [
		{ role: "user", content: [{ type: "text", text: "finish the parser" }] },
		{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts", cache_control: { type: "ephemeral" } }] },
	],
};
const SUMMARY = "## Goal and constraints\nFinish the parser.\n## Next step\nRun the tests, as Joel asked: \"finish the parser\".";
const USAGE = { input: 40, output: 900, cacheRead: 480_000, cacheWrite: 0, totalTokens: 480_940 };

let i = 0;
const id = () => `e${++i}`;
const userEntry = (text, at) => ({ type: "message", id: id(), timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(at) } });
const agentRecord = (over) => ({ type: "custom", id: id(), customType: "agent-record", data: { name: "worker-1", taskId: "task-w1", ownerSessionId: SESSION, type: "worker", description: "port the lexer", status: "running", stoppedBy: undefined, depth: 1, sessionFile: undefined, sessionId: "child-w1", cwd: "/", branch: undefined, model: "anthropic/claude-sonnet-5-5", thinking: undefined, result: undefined, error: undefined, readBy: undefined, readAt: undefined, toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: 1, completedAt: undefined, toolCallId: undefined, workflowChild: false, ...over } });

/** A provider at pi-ai's stream boundary: records the payload it was handed and streams `events`. */
const providerOf = (events) => {
	const sent = [];
	return {
		sent,
		registry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fresh-token", headers: { authorization: "Bearer fresh" } }),
			getProvider: () => ({
				stream: (_model, _context, options) => {
					sent.push({ payload: options.onPayload(), headers: options.headers });
					return (async function* () {
						for (const event of events) yield event;
					})();
				},
			}),
		},
	};
};

const toolResultEntry = { type: "message", id: "tr", timestamp: "2026-10-08T10:30:00Z", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a.ts" }], isError: false } };
const finalAssistant = { type: "message", id: "fa", timestamp: "2026-10-08T10:31:00Z", message: { role: "assistant", content: [{ type: "text", text: "FINAL-ASSISTANT" }] } };
const callAssistant = { type: "message", id: "ca", timestamp: "2026-10-08T10:20:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] } };
const warnings = [];

async function compact({ entries, events, tip = [callAssistant, toolResultEntry, finalAssistant], captured = CAPTURED, leafId = "tr", firstKeptEntryId = "ca", publish = true, sessionId = SESSION, reason = "threshold", customInstructions, signal = new AbortController().signal, sessionFile = "/tmp/sessions/s.jsonl", registry }) {
	const provider = providerOf(events);
	if (registry) provider.registry = registry;
	if (publish) publishPingTarget({ payload: captured, headers: { authorization: "Bearer stale", "anthropic-beta": "x" }, model: MODEL, sessionId, leafId, registry: provider.registry, record: () => {} });
	warnings.length = 0;
	const pi = fakeExtensionApi();
	compaction(pi.api);
	const ctx = { model: MODEL, modelRegistry: provider.registry, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile ?? undefined }, hasUI: true, ui: { notify: (message, level) => warnings.push({ message, level }) } };
	const preparation = { firstKeptEntryId, tokensBefore: 501_234, previousSummary: undefined, settings: { enabled: true, reserveTokens: 500_000, keepRecentTokens: 20_000 } };
	const [result] = await pi.fire("session_before_compact", { type: "session_before_compact", preparation, branchEntries: [...entries, ...tip], reason, customInstructions, willRetry: false, signal }, ctx);
	forgetPingTargets(sessionId);
	return { result, sent: provider.sent, warnings: [...warnings], appended: pi.entries };
}

const done = [{ type: "start" }, { type: "done", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: SUMMARY }], usage: USAGE, stopReason: "stop" } }];

console.log("the summary call resends the last request with one user message");
{
	const entries = [userEntry("finish the parser", "2026-10-08T10:00:00Z"), { type: "compaction", id: id(), summary: "earlier", firstKeptEntryId: "x", tokensBefore: 1 }];
	const { result, sent } = await compact({ entries, events: done });
	const payload = sent[0]?.payload;
	const { messages, ...rest } = payload ?? {};
	const { messages: capturedMessages, ...capturedRest } = CAPTURED;
	check("everything but messages is the captured request's", isDeepStrictEqual(rest, capturedRest), JSON.stringify(Object.keys(rest)));
	check("the captured messages come first, unchanged", isDeepStrictEqual(messages?.slice(0, capturedMessages.length), capturedMessages));
	const asked = messages?.[capturedMessages.length];
	const askedText = asked?.content?.map((b) => b.text).join("") ?? "";
	check("then one user message asking for the summary", messages?.length === capturedMessages.length + 1 && asked.role === "user", JSON.stringify(asked));
	check("which forbids tools and names this compaction's number", /do not call tools/i.test(askedText) && /compaction 2\b/.test(askedText), askedText.slice(0, 200));
	check("credentials are the fresh ones, the rest of the captured headers ride along", sent[0]?.headers.authorization === "Bearer fresh" && sent[0]?.headers["anthropic-beta"] === "x", JSON.stringify(sent[0]?.headers));
	check("pi gets the summary with the kept boundary, tokens before and the call's usage", result?.compaction?.firstKeptEntryId === "ca" && result.compaction.tokensBefore === 501_234 && isDeepStrictEqual(result.compaction.usage, USAGE), JSON.stringify(result?.compaction && { ...result.compaction, summary: undefined }));
}

console.log("the summary call keeps a thinking block the provider reported dropping, byte for byte");
{
	const thinking = { type: "thinking", thinking: "kept after a compaction", signature: "sig" };
	const call = { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } };
	const withThinking = { ...CAPTURED, messages: [CAPTURED.messages[0], { role: "assistant", content: [thinking, call] }, CAPTURED.messages[2]] };
	const reportedDrop = { ...finalAssistant, message: { ...finalAssistant.message, diagnostics: [{ type: "anthropic_input_transformations", timestamp: 1, details: { transformations: [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }] } }] } };
	const entries = [userEntry("finish the parser", "2026-10-08T10:00:00Z")];
	const result = await compact({ entries, events: done, captured: withThinking, tip: [callAssistant, toolResultEntry, reportedDrop] });
	check("the captured messages are replayed unchanged", isDeepStrictEqual(result.sent[0]?.payload.messages?.slice(0, 3), withThinking.messages), JSON.stringify(result.sent[0]?.payload.messages?.[1]));
}

console.log("\nthe summary pins Joel's messages, newest first, within about 20k tokens");
{
	const oldest = `oldest ${"o".repeat(59_000)} OLDEST-END`;
	const middle = `middle ${"m".repeat(39_000)}`;
	const entries = [
		userEntry(oldest, "2026-10-08T09:00:00Z"),
		{ type: "custom_message", id: id(), customType: "subagent-notification", content: "NOTIFICATION-TEXT", display: true },
		userEntry(middle, "2026-10-08T10:00:00Z"),
		{ type: "message", id: id(), message: { role: "assistant", content: [{ type: "text", text: "ASSISTANT-TEXT" }] } },
		userEntry("newest: finish the parser", "2026-10-08T11:00:00Z"),
	];
	const { result } = await compact({ entries, events: done });
	const summary = result?.compaction?.summary ?? "";
	const pinned = summary.slice(0, summary.indexOf("</user_messages>"));
	check("the summary opens with the pinned messages", summary.startsWith("<user_messages>"), summary.slice(0, 80));
	check("newest first", pinned.indexOf("newest: finish the parser") < pinned.indexOf("middle "), `${pinned.indexOf("newest")} ${pinned.indexOf("middle")}`);
	check("the newer messages verbatim", pinned.includes(middle) && pinned.includes("newest: finish the parser"));
	check("the older one that does not fit is dropped whole, not cut", !pinned.includes("oldest") && !pinned.includes("OLDEST-END"));
	check("the block stays within 20k tokens (4 chars each) plus its framing", pinned.length <= 80_000 + 1_000, String(pinned.length));
	check("only Joel's messages: no notification, no assistant text", !pinned.includes("NOTIFICATION-TEXT") && !pinned.includes("ASSISTANT-TEXT"));
	check("the model's summary follows the pinned block", summary.indexOf(SUMMARY) > summary.indexOf("</user_messages>"));
}

console.log("\n<live_state> lists what is running");
{
	markAgentLive(SESSION, "task-w1");
	adoptBackgroundTask(SESSION, { id: 3, command: "npm test", logPath: "/tmp/task-3.log" }, { kill: () => true, exitedWith: undefined }, () => "appended", Date.now());
	const entries = [userEntry("start the lexer port", "2026-10-08T10:00:00Z"), agentRecord({}), agentRecord({ name: "explorer-1", taskId: "task-e1", type: "explore", status: "completed", completedAt: 2 })];
	const { result } = await compact({ entries, events: done });
	const summary = result?.compaction?.summary ?? "";
	const live = summary.slice(summary.indexOf("<live_state>"));
	check("the summary ends with <live_state>", summary.trimEnd().endsWith("</live_state>") && summary.indexOf("<live_state>") > summary.indexOf(SUMMARY), summary.slice(-200));
	check("it lists the running agent by name and type", /worker-1\b.*\bworker\b/.test(live), live);
	check("and the background task with its command and log", live.includes("npm test") && live.includes("/tmp/task-3.log"), live);
	check("and not the agent that already finished", !live.includes("explorer-1"), live);
	markAgentSettled(SESSION, "task-w1");
	endBackgroundTasksOf(SESSION);
}

console.log("\na failed summary call leaves the summary to pi");
{
	const failed = [{ type: "start" }, { type: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" } }];
	const { result, sent } = await compact({ entries: [userEntry("finish the parser", "2026-10-08T10:00:00Z")], events: failed });
	check("the call was made", sent.length === 1);
	check("and the handler returns nothing, so pi's default summariser runs", result === undefined, JSON.stringify(result));
}

console.log("\nevery failure path shows one notice and leaves the summary to pi, except the ones that are not failures");
{
	const entries = [userEntry("finish the parser", "2026-10-08T10:00:00Z")];
	const reply = (content, stopReason) => [{ type: "start" }, { type: "done", message: { role: "assistant", content, usage: USAGE, stopReason } }];
	const text = (t) => [{ type: "text", text: t }];
	for (const [name, events, expected] of [
		["a length stop", reply(text("cut off"), "length"), /length/],
		["a tool-use stop", reply(text("preamble"), "toolUse"), /toolUse/],
		["empty text", reply(text("  "), "stop"), /no text/],
		["a stream with no done", [{ type: "start" }], /without a result/],
	]) {
		const { result, sent, warnings } = await compact({ entries, events });
		check(`${name}: the call was made, nothing stored, one warning`, sent.length === 1 && result === undefined && warnings.length === 1 && warnings[0].level === "warning" && expected.test(warnings[0].message), JSON.stringify([result, warnings]));
	}
	const missing = await compact({ entries, events: done, registry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }), getProvider: () => undefined } });
	check("no credentials: nothing stored, one warning", missing.result === undefined && missing.warnings.length === 1, JSON.stringify(missing.warnings));
	const thrown = await compact({ entries, events: done, registry: { getApiKeyAndHeaders: async () => { throw new Error("boom"); }, getProvider: () => undefined } });
	check("a thrown error: one warning with its message", thrown.result === undefined && thrown.warnings.length === 1 && /boom/.test(thrown.warnings[0].message), JSON.stringify(thrown.warnings));

	const controller = new AbortController();
	const cancelled = await compact({ entries, signal: controller.signal, events: (function* () { yield { type: "start" }; controller.abort(); yield { type: "error", error: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" } }; })() });
	check("a user cancel: no notice, nothing stored", cancelled.result === undefined && cancelled.warnings.length === 0, JSON.stringify(cancelled.warnings));
	const thrownAbort = new AbortController();
	thrownAbort.abort();
	const abortedThrow = await compact({ entries, signal: thrownAbort.signal, events: done, registry: { getApiKeyAndHeaders: async () => { throw new Error("aborted"); }, getProvider: () => undefined } });
	check("a cancel that throws: no notice", abortedThrow.result === undefined && abortedThrow.warnings.length === 0, JSON.stringify(abortedThrow.warnings));
}

console.log("\nthe handler stands down to pi's summariser, with one notice, when the replay would leave part of the branch out");
{
	const entries = [userEntry("finish the parser", "2026-10-08T10:00:00Z")];
	const noticed = (run, expected) => run.sent.length === 0 && run.result === undefined && run.warnings.length === 1 && run.warnings[0].level === "warning" && expected.test(run.warnings[0].message);
	const none = await compact({ entries, events: done, publish: false });
	check("no captured request: no call, one notice naming why", noticed(none, /no request/), JSON.stringify(none.warnings));
	const overflow = await compact({ entries, events: done, reason: "overflow" });
	check("reason overflow: the rejected request is not replayed, one notice", noticed(overflow, /overflow/), JSON.stringify(overflow.warnings));
	const offBranch = await compact({ entries, events: done, leafId: "elsewhere" });
	check("the captured request was built from an entry off this branch (after /tree or a fork): one notice", noticed(offBranch, /branch/), JSON.stringify(offBranch.warnings));
	const gap = await compact({ entries, events: done, leafId: "ca", firstKeptEntryId: "fa" });
	check("entries after the captured request that pi does not keep: one notice", noticed(gap, /branch/), JSON.stringify(gap.warnings));
}

console.log("\nthe replay matches a real branch tip whatever messages it holds");
{
	const entries = [userEntry("finish the parser", "2026-10-08T10:00:00Z")];
	const thinking = { type: "message", id: "th", timestamp: "2026-10-08T10:20:00Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] } };
	const imageResult = { type: "message", id: "img", timestamp: "2026-10-08T10:30:00Z", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "Read image" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false } };
	const bash = { type: "message", id: "bx", timestamp: "2026-10-08T10:31:00Z", message: { role: "bashExecution", command: "ls", output: "a.ts", exitCode: 0, cancelled: false, truncated: false } };
	const steer = { type: "custom_message", id: "cm", timestamp: "2026-10-08T10:32:00Z", customType: "subagent-notification", content: "worker-1 finished", display: true };
	const answer = { type: "message", id: "ans", timestamp: "2026-10-08T10:33:00Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "done", thinkingSignature: "sig2" }, { type: "text", text: "Read it." }] } };
	const record = { type: "custom", id: "rec", timestamp: "2026-10-08T10:34:00Z", customType: "agent-record", data: {} };
	const run = await compact({ entries, events: done, tip: [thinking, imageResult, bash, steer, answer, record], leafId: "cm", firstKeptEntryId: "th" });
	check("thinking, an image tool result, a bash run, a steered message and a later custom entry: the summary call is made, no notice", run.sent.length === 1 && run.result !== undefined && run.warnings.length === 0, JSON.stringify(run.warnings));
	const kept = await compact({ entries, events: done, tip: [thinking, imageResult, bash, steer, answer], leafId: "img", firstKeptEntryId: "bx" });
	check("entries after the captured request that pi keeps verbatim: still a match", kept.sent.length === 1 && kept.result !== undefined && kept.warnings.length === 0, JSON.stringify(kept.warnings));
}

console.log("\na child's summary pins its brief verbatim");
{
	const PARENT = "parent-of-child";
	const CHILD = "child-compaction";
	const brief = "Port the lexer.\n\n  Keep `tokens.ts` as is; run npm test after each step.\n";
	const records = [agentRecord({ name: "worker-7", taskId: "task-w7", ownerSessionId: PARENT, sessionId: CHILD, brief, laterMessages: [{ from: "main", text: "FIRST-LATER", at: Date.parse("2026-10-08T10:10:00Z") }, { from: "Joel", text: "SECOND-LATER", at: Date.parse("2026-10-08T10:20:00Z") }] }).data];
	publishAgentRuntime(PARENT, { registry: new AgentRegistry(() => {}, records) });
	declareChildSeat(CHILD, { name: "worker-7", role: "worker", depth: 1, parentSessionId: PARENT, workflowChild: false, agentTypes: [], workflows: false, prompt: { kind: "inherit" } });
	const { result, sent } = await compact({ entries: [userEntry("<sub_agent_context>tail</sub_agent_context>\n\nPort the lexer.", "2026-10-08T10:00:00Z")], events: done, sessionId: CHILD });
	const summary = result?.compaction?.summary ?? "";
	check("the summary opens with the brief, byte for byte, from its parent", summary.startsWith(`<original_brief from="main">\n${brief}\n</original_brief>`), summary.slice(0, 160));
	check("then the later messages, newest first, each with its sender", summary.indexOf("from Joel\nSECOND-LATER") > summary.indexOf("</original_brief>") && summary.indexOf("from main\nFIRST-LATER") > summary.indexOf("SECOND-LATER"), summary.slice(0, 600));
	check("not the child's session user messages", !summary.includes("<user_messages>") && !summary.includes("tail</sub_agent_context>"));
	const asked = sent[0]?.payload.messages.at(-1).content[0].text ?? "";
	check("the summary request speaks of the parent, not Joel", asked.includes("your parent's most recent explicit request") && !asked.includes("Joel"), asked.slice(-400));

	const missing = await compact({ entries: [userEntry("go", "2026-10-08T10:00:00Z")], events: done, sessionId: CHILD, publish: false });
	check("a child that cannot replay stands down to pi's summariser, with no notice and no entry", missing.result === undefined && missing.warnings.length === 0 && missing.appended.length === 0, JSON.stringify(missing.appended));
	forgetChildSeat(CHILD);
	forgetAgentRuntime(PARENT);
}

console.log("\ncustom instructions, carry-forward and numbering reach the request");
{
	const entries = [userEntry("finish the parser", "2026-10-08T10:00:00Z"), { type: "compaction", id: id(), summary: "SUMMARY-ONE", firstKeptEntryId: "x", tokensBefore: 1 }, { type: "compaction", id: id(), summary: "SUMMARY-TWO", firstKeptEntryId: "y", tokensBefore: 2 }];
	const { sent } = await compact({ entries, events: done, customInstructions: "  keep the lexer notes  " });
	const messages = sent[0]?.payload.messages ?? [];
	const asked = messages.at(-1).content.map((b) => b.text).join("");
	check("/compact text is in the instruction, trimmed, under the principal's name", asked.endsWith("Joel asked this summary to focus on: keep the lexer notes"), asked.slice(-120));
	check("compaction number counts the earlier compactions", /compaction 3\b/.test(asked), asked.slice(0, 60));
	check("the instruction tells the model to carry an earlier summary forward", /carry forward everything in it that still holds/.test(asked));
	const plain = await compact({ entries, events: done });
	check("without custom text there is no focus line", !/focus on/.test(plain.sent[0].payload.messages.at(-1).content[0].text));
}

console.log("\nthe pin handles string and image content, and keeps the newest message whole");
{
	const stringUser = { type: "message", id: id(), timestamp: "2026-10-08T08:00:00Z", message: { role: "user", content: "plain string ask", timestamp: 1 } };
	const imageUser = { type: "message", id: id(), timestamp: "2026-10-08T09:00:00Z", message: { role: "user", content: [{ type: "text", text: "see this" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 2 } };
	const blank = userEntry("   ", "2026-10-08T09:30:00Z");
	const { result } = await compact({ entries: [stringUser, imageUser, blank], events: done });
	const summary = result?.compaction?.summary ?? "";
	check("a string message is pinned", summary.includes("plain string ask"));
	check("an image becomes [image] beside its text, and its data is not copied", summary.includes("see this\n[image]") && !summary.includes("AAAA"));
	check("a whitespace-only message is skipped", !summary.includes("[2026-10-08T09:30:00Z]"));

	const huge = `HEAD ${"h".repeat(120_000)} TAIL-END`;
	const older = userEntry("older ask that no longer fits", "2026-10-08T08:00:00Z");
	const big = await compact({ entries: [older, userEntry(huge, "2026-10-08T11:00:00Z")], events: done });
	const pinned = big.result.compaction.summary.slice(0, big.result.compaction.summary.indexOf("</user_messages>"));
	check("a newest message over the budget is cut to the budget, head kept, and says so", pinned.includes(huge.slice(0, 80_000)) && !pinned.includes("TAIL-END") && /\[cut: \d+ more characters\]/.test(pinned) && pinned.length <= 80_000 + 1_000, String(pinned.length));
	check("and older ones that no longer fit are dropped", !pinned.includes("older ask"));
}

console.log("\n<live_state> says where earlier detail is");
{
	const { result } = await compact({ entries: [userEntry("go", "2026-10-08T10:00:00Z")], events: done });
	const live = (result?.compaction?.summary ?? "").split("<live_state>")[1] ?? "";
	check("the session file and the pi-recall command to read it", live.includes("/tmp/sessions/s.jsonl") && /bin\/pi-recall\.mjs \/tmp\/sessions\/s\.jsonl list/.test(live), live);
	const memory = await compact({ entries: [userEntry("go", "2026-10-08T10:00:00Z")], events: done, sessionFile: null });
	check("an in-memory session has no pointer", !/pi-recall/.test(memory.result?.compaction?.summary ?? ""));
}

await finish();
