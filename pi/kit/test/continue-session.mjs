/**
 * Handoff v2 — "continue session" (map C23, ticket 11), offline.
 *
 * First the rules through their own exports: the ladder (thresholds, the
 * window fit of C18, the phase order, the last-request measure that counts
 * an aborted turn, Joel's wording), the detector, the generated block, the
 * first message, and which entries the new session carries. Then the recall
 * script against a fixture session file.
 *
 * Then the switch itself, on real pi sessions driven by a scripted provider
 * (`pi.registerProvider` + `streamSimple`, as `test/agent-engine.mjs` does)
 * under pi's own `AgentSessionRuntime`, so `ctx.newSession` is pi's code and
 * not a stand-in. The bars: the old session file is byte-unchanged after the
 * switch; the new file is linked to it; the first message is "Continue
 * session `<path>`. <doc>"; agent names resolve in the new session; live
 * runs keep running and settle into the new session; a child seat hands off
 * the same way; and the 2026-09-03 failure shape — the last entry a tool
 * result, which pi's `findCutPoint` refused to compact — switches fine,
 * because nothing here compacts.
 *
 * The live half — the cached prefix read on the new session's first real
 * request — is `continue-session-live.mjs`.
 */

import "./env.mjs";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "continue-session-home-"));
fs.mkdirSync(path.join(AGENT_DIR, "agents"));
fs.writeFileSync(path.join(AGENT_DIR, "agents", "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(AGENT_DIR, "sessions");
// Children under test load the engine and the continuation, nothing else.
process.env.PI_AGENT_CHILD_EXTENSIONS = `${ROOT}/extensions/agent-engine.ts:${ROOT}/extensions/continue-session.ts`;
// Thresholds any scripted turn clears: the ladder is exercised, the switch is not driven by it.
delete process.env.PI_HANDOFF_THRESHOLDS;

const { createAgentSession, createAgentSessionRuntime, createEventBus, DefaultResourceLoader, ExtensionRunner, ModelRuntime, SessionManager, getAgentDir } = await import(`${PI}/dist/index.js`);
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const trailer = () => {
	fs.rmSync(AGENT_DIR, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
};

const ladder = await jiti.import(`${ROOT}/lib/handoff-ladder.ts`);
const seam = await jiti.import(`${ROOT}/lib/agent-runtime-seam.ts`);
const rules = await jiti.import(`${ROOT}/lib/continue-session.ts`);
const { AGENT_RECORD_ENTRY } = await jiti.import(`${ROOT}/lib/agent-registry.ts`);

// ---------------------------------------------------------------------------
console.log("the ladder");
{
	const { DEFAULT_THRESHOLDS, thresholdsFrom, fitThresholds, phaseFor, ladderStep, lastRequestTokens, contextTokens, nudgeText, stopText, NUDGE_WORDING, GATE_WORDING, HANDOFF_HEADING, HANDOFF_SECTIONS, k } = ladder;
	check("defaults are 250k / 270k / 300k (Joel)", DEFAULT_THRESHOLDS.nudge === 250_000 && DEFAULT_THRESHOLDS.gate === 270_000 && DEFAULT_THRESHOLDS.stop === 300_000);
	check("an override of three ascending integers is taken", JSON.stringify(thresholdsFrom("100,200,300")) === JSON.stringify({ nudge: 100, gate: 200, stop: 300 }));
	check("a malformed override is ignored", thresholdsFrom("300,200,100") === DEFAULT_THRESHOLDS && thresholdsFrom("a,b,c") === DEFAULT_THRESHOLDS && thresholdsFrom("1,2") === DEFAULT_THRESHOLDS);
	const haiku = fitThresholds(DEFAULT_THRESHOLDS, 200_000);
	check("a 200k window is fitted: stop at 85%, gaps in proportion (C18)", haiku.stop === 170_000 && haiku.nudge === 141_666 && haiku.gate === 153_000, JSON.stringify(haiku));
	check("only a window of 353k or more sees the three numbers as written", fitThresholds(DEFAULT_THRESHOLDS, 352_942) === DEFAULT_THRESHOLDS && fitThresholds(DEFAULT_THRESHOLDS, 352_000).stop === 299_200);
	check("a 1M window is left alone", fitThresholds(DEFAULT_THRESHOLDS, 1_000_000) === DEFAULT_THRESHOLDS);
	check("an unknown window is left alone", fitThresholds(DEFAULT_THRESHOLDS, null) === DEFAULT_THRESHOLDS && fitThresholds(DEFAULT_THRESHOLDS, 0) === DEFAULT_THRESHOLDS);
	const t = { nudge: 100, gate: 200, stop: 300 };
	check("phases follow the size", phaseFor(50, "idle", t) === "idle" && phaseFor(100, "idle", t) === "nudged" && phaseFor(250, "idle", t) === "gated" && phaseFor(300, "idle", t) === "stopped");
	check("a phase never steps back", phaseFor(50, "gated", t) === "gated" && phaseFor(null, "nudged", t) === "nudged");
	check("each message is sent once, where the phase changes", ladderStep(100, "idle", t).inject === "nudged" && ladderStep(150, "nudged", t).inject === undefined && ladderStep(200, "nudged", t).inject === "gated" && ladderStep(250, "gated", t).inject === undefined);
	check("a step that crosses both thresholds says the gate and never the nudge", ladderStep(200, "idle", t).inject === "gated" && ladderStep(200, "idle", t).phase === "gated");
	check("a step that reaches the stop says nothing: the harness writes the document itself", ladderStep(300, "idle", t).inject === undefined && ladderStep(300, "idle", t).phase === "stopped" && ladderStep(300, "gated", t).inject === undefined);
	check("nothing repeats: the repeat machinery is gone", ladder.shouldNudge === undefined && ladder.NUDGE_REPEAT_TURNS === undefined);
	const entries = [
		{ type: "message", id: "a", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } } },
		{ type: "message", id: "b", message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 99_000, cacheWrite: 1_000 } } },
		{ type: "message", id: "c", message: { role: "toolResult" } },
	];
	check("the last request counts an aborted turn's input side (totalTokens 0)", lastRequestTokens(entries) === 100_000);
	check("past a compaction with no request since, the last request is unknown", lastRequestTokens([...entries, { type: "compaction", id: "d" }]) === null);
	check("the larger of pi's figure and the last request wins", contextTokens(61_000, 100_000) === 100_000 && contextTokens(120_000, 100_000) === 120_000 && contextTokens(undefined, 100_000) === 100_000 && contextTokens(5, null) === 5 && contextTokens(null, null) === null);
	const nudge = nudgeText("nudged", 253_000, DEFAULT_THRESHOLDS);
	const gate = nudgeText("gated", 271_000, DEFAULT_THRESHOLDS);
	check("the nudge carries Joel's wording verbatim", nudge.includes(NUDGE_WORDING) && NUDGE_WORDING === "Write a handoff now, or when it suits the ongoing work. Start winding down; write it when relevant without destroying the work in flight.");
	check("the gate is Joel's three beats and nothing else", gate.includes(GATE_WORDING) && GATE_WORDING === "Do this now. As soon as possible. Don't start new work." && !gate.includes(NUDGE_WORDING));
	check("both name the size and the limit", nudge.startsWith("[handoff] Context is at 253k tokens; the soft limit is 250k.") && gate.startsWith("[handoff] Context is at 271k tokens; the hard limit is 270k."));
	check("both carry the detector line and every section heading", [nudge, gate].every((text) => text.includes(`\`${HANDOFF_HEADING}\``) && HANDOFF_SECTIONS.every((h) => text.includes(h))));
	check("the nudge asks for a plain message, not a tool", nudge.includes("no tool") && !/call the `handoff` tool/.test(nudge));
	const stopped = stopText({ tokens: 301_000, thresholds: DEFAULT_THRESHOLDS, previous: "gated", recorded: true });
	check("the stop names the size, the limit and the two ways forward", stopped.includes("301k") && stopped.includes("stop at 300k") && stopped.includes("/handoff-continue") && stopped.includes("/handoff asks") && k(1_499) === "1k");
	check("the stop says whether the model was ever asked", stopText({ tokens: 301_000, thresholds: DEFAULT_THRESHOLDS, previous: "idle", recorded: true }).includes("never asked") && stopped.includes("asked at 250k and again at 270k"));
	check("the stop says what was recorded and what is lost", stopped.includes("recorded what it knows") && stopped.includes("is lost") && stopText({ tokens: 301_000, thresholds: DEFAULT_THRESHOLDS, previous: "gated", recorded: false }).includes("could not record"));
	const granted = ladder.lastTurnText(299_000, DEFAULT_THRESHOLDS);
	check("the last turn names the size, the stop, and that the run ends whatever the turn contains", granted.startsWith("[handoff] Context is at 299k tokens; the stop is 300k.") && granted.includes(ladder.LAST_TURN_WORDING) && granted.includes(`\`${HANDOFF_HEADING}\``));
	check("it forbids tools, because no turn follows in which a result could be used", ladder.LAST_TURN_WORDING.includes("no turn after this one") && ladder.LAST_TURN_WORDING.includes("Do not read, search, spawn or call any tool"));
	const spent = (lastTurn) => stopText({ tokens: 301_000, thresholds: DEFAULT_THRESHOLDS, previous: "idle", recorded: true, lastTurn });
	check("after a granted turn the stop says the model was asked once, and what came of it", spent("wrote").includes("given one turn to write its handoff and wrote one") && spent("silent").includes("and did not") && !spent("wrote").includes("never asked"));
	check("a written handoff is not called lost, and the stop does not say none was written", spent("wrote").includes("The model's own handoff is recorded in this session.") && !spent("wrote").includes("is lost") && !spent("wrote").includes("no handoff written") && spent("silent").includes("with no handoff written"));
	const child = stopText({ tokens: 301_000, thresholds: DEFAULT_THRESHOLDS, previous: "gated", recorded: true, seat: "child" });
	check("a child seat is not offered the commands only a human types", !child.includes("/handoff-continue") && !child.includes("/handoff asks") && child.includes("Its parent is told") && stopped.includes("/handoff-continue"));
	const { nudgeDelivery } = ladder;
	check("a run that continues is steered, a run that is ending is appended", nudgeDelivery(true) === "steer" && nudgeDelivery(false) === "append");
}

// ---------------------------------------------------------------------------
// /handoff used to start its turn with a custom message, which skips pi's
// `before_agent_start`: on the first turn of a process nothing had captured the
// prompt options, and Anthropic refused pi's own prompt behind the Claude Code
// identity block (req_011CenGzjBfwouGRX52Q5PE3, 2026-09-06). It asks as the
// user now, so the turn is an ordinary one and nothing has to be primed by hand.
console.log("\n/handoff asks as the user");
{
	const sessionId = "7a1c9f60-0000-4000-8000-0000000aa001";
	let asked = 0;
	const sent = [];
	const said = [];
	const toasts = [];
	const ctx = {
		hasUI: true,
		cwd: ROOT,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 120_000, contextWindow: 1_000_000 }),
		getSystemPromptOptions: () => { asked++; return {}; },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getHeader: () => ({}) },
		ui: { notify: (text) => toasts.push(text), setStatus: () => {}, theme: { fg: (_c, s) => s } },
	};
	const commands = new Map();
	const handlers = new Map();
	const mod = await jiti.import(`${ROOT}/extensions/continue-session.ts?handoff-asks`);
	mod.default({
		on: (e, h) => handlers.set(e, h),
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: (n, o) => commands.set(n, o),
		registerMessageRenderer: () => {},
		sendMessage: (message, o) => said.push({ message, o }),
		sendUserMessage: (content, o) => sent.push({ content, o }),
		getThinkingLevel: () => "high",
		appendEntry: () => {},
	});
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await commands.get("handoff").handler("", ctx);
	check("/handoff sends the gate's words as a user message, steered when a run is in flight", sent.length === 1 && String(sent[0].content).startsWith("[handoff]") && sent[0].o?.deliverAs === "steer", JSON.stringify(sent.map((s) => s.o)));
	check("and no custom message, so no turn skips before_agent_start", said.length === 0, JSON.stringify(said.map((s) => s.o)));
	check("it no longer primes the prompt options by hand", asked === 0, String(asked));
	const askedNotice = () => toasts.filter((text) => String(text).includes("asked for the document")).length;
	check("it says nothing until pi accepts the message", askedNotice() === 0, JSON.stringify(toasts));
	// What pi emits for a message it accepted: `input`, then, if it reaches the model, the message's `message_start`.
	const accepted = (text, streamingBehavior) => handlers.get("input")?.({ type: "input", text, source: "extension", ...(streamingBehavior ? { streamingBehavior } : {}) }, ctx);
	const reached = (role, text) => handlers.get("message_start")?.({ type: "message_start", message: { role, content: [{ type: "text", text }], timestamp: 0 } }, ctx);
	accepted(String(sent[0]?.content));
	check("idle, its input alone says nothing: pi checks the model and key after it", askedNotice() === 0, JSON.stringify(toasts));
	reached("assistant", String(sent[0]?.content));
	check("an assistant message with the same words is not the ask", askedNotice() === 0, JSON.stringify(toasts));
	reached("user", String(sent[0]?.content));
	check("idle, it says it asked once its message starts", askedNotice() === 1, JSON.stringify(toasts));
	await commands.get("handoff").handler("", ctx);
	const beforeSteer = askedNotice();
	accepted(String(sent[1]?.content), "steer");
	check("mid-run, a queued steer that Joel's abort drops says nothing", askedNotice() === beforeSteer, JSON.stringify(toasts));
	reached("user", String(sent[1]?.content));
	check("mid-run, it says it asked once pi injects the steer", askedNotice() === beforeSteer + 1, JSON.stringify(toasts));
}

// ---------------------------------------------------------------------------
console.log("\nthe session scope");
{
	let scopes;
	try { scopes = await jiti.import(`${ROOT}/lib/session-scope.ts`); } catch (error) { check("lib/session-scope.ts loads", false, error.message.split("\n")[0]); }
	if (scopes !== undefined) {
		const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		// One extension runtime: several factories on one event bus, as pi loads them.
		const runtime = () => {
			const listeners = new Map();
			const bus = { on: (channel, handler) => { listeners.set(channel, [...(listeners.get(channel) ?? []), handler]); return () => {}; }, emit: (channel, data) => { for (const handler of listeners.get(channel) ?? []) handler(data); } };
			const extension = () => {
				const handlers = new Map();
				const sent = [];
				const pi = { on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]), events: bus, sendMessage: (message, options) => sent.push({ message, options }) };
				const fire = async (event) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event }, {}); };
				return { scope: scopes.createSessionScope(pi), sent, fire };
			};
			return { extension };
		};
		const message = { customType: "t", content: "x", display: true };
		const first = runtime();
		const engine = first.extension();
		const bash = first.extension();
		check("unprimed: startTurn returns false and sends nothing", engine.scope.startTurn(message, { deliverAs: "followUp" }) === false && engine.sent.length === 0);
		await engine.fire("before_agent_start");
		check("once before_agent_start has fired, startTurn sends with triggerTurn and returns true", engine.scope.startTurn(message, { deliverAs: "followUp" }) === true && engine.sent.length === 1 && engine.sent[0].options.triggerTurn === true && engine.sent[0].options.deliverAs === "followUp");
		await bash.fire("before_agent_start");
		// Every scope of the runtime refuses, whichever of them saw the switch begin.
		const refusing = () => engine.scope.startTurn(message, { deliverAs: "followUp" }) === false && bash.scope.startTurn(message, { deliverAs: "followUp" }) === false && engine.sent.length === 1 && bash.sent.length === 0;
		const runStarts = async () => { await engine.fire("agent_start"); await bash.fire("agent_start"); };
		const open = () => {
			const ok = engine.scope.startTurn(message, { deliverAs: "followUp" }) === true && bash.scope.startTurn(message, { deliverAs: "followUp" }) === true;
			engine.sent.splice(1);
			bash.sent.splice(0);
			return ok;
		};
		for (const begins of ["session_before_switch", "session_before_fork"]) {
			await engine.fire(begins);
			const refused = refusing();
			// A cancelled switch: the refusal ends when the next run starts.
			await runStarts();
			check(`${begins} in one scope: every scope refuses until the next agent_start`, refused && open());
		}
		bash.scope.holdTurnsForSwitch();
		const held = refusing();
		await runStarts();
		check("holdTurnsForSwitch in one scope: every scope refuses until the next agent_start", held && open());
		let fired = 0;
		bash.scope.timeout(5, () => fired++);
		bash.scope.interval(5, () => fired++);
		await engine.fire("session_shutdown");
		check("the first shutdown handler closes every scope of the runtime", engine.scope.signal.aborted && bash.scope.signal.aborted);
		check("closed: startTurn returns false and sends nothing", bash.scope.startTurn(message, { deliverAs: "steer" }) === false && bash.sent.length === 0 && engine.scope.startTurn(message, { deliverAs: "steer" }) === false && engine.sent.length === 1);
		await pause(30);
		check("closed: its timers are cleared, and a new one never starts", fired === 0 && (bash.scope.timeout(1, () => fired++), await pause(10), fired === 0));
		// A reload reuses the loader's bus: the new runtime's scopes share it with the closed ones.
		const reloaded = first.extension();
		check("a reload is a new runtime on the same bus, and it starts unprimed and open", reloaded.scope.startTurn(message, { deliverAs: "followUp" }) === false && reloaded.sent.length === 0 && !reloaded.scope.signal.aborted);
		await engine.fire("session_shutdown");
		await bash.fire("session_shutdown");
		await reloaded.fire("before_agent_start");
		check("the old runtime's shutdown does not close the new runtime's scopes", !reloaded.scope.signal.aborted && reloaded.scope.startTurn(message, { deliverAs: "followUp" }) === true && reloaded.sent.length === 1);
	}
}

// ---------------------------------------------------------------------------
console.log("\nthe detector");
{
	const { handoffDocumentOf, isHandoffDocumentText } = rules;
	const doc = "# Handoff\n## Intent\nShip it.\n";
	check("an assistant message whose first line is # Handoff is a document", handoffDocumentOf({ role: "assistant", content: [{ type: "text", text: doc }] }) === doc.trim());
	check("leading blank lines and whitespace are fine", isHandoffDocumentText("\n\n  # Handoff  \n## Intent"));
	check("a mention in prose is not a document", handoffDocumentOf({ role: "assistant", content: [{ type: "text", text: "I could write a\n# Handoff\nlater" }] }) === undefined);
	check("a sub-heading is not the heading", isHandoffDocumentText("## Handoff\n") === false && isHandoffDocumentText("# Handoff notes") === false);
	check("a user message is never a document", handoffDocumentOf({ role: "user", content: doc }) === undefined);
	check("thinking blocks are skipped, text blocks joined", handoffDocumentOf({ role: "assistant", content: [{ type: "thinking", thinking: "# Handoff" }, { type: "text", text: "# Handoff\n## Intent" }] }) === "# Handoff\n## Intent");
}

// ---------------------------------------------------------------------------
console.log("\nthe generated block");
{
	const { agentFactsFromEntries, backgroundTasksFromEntries, filesFromEntries, renderHandoffBlock, HANDOFF_BLOCK_HEADING, continueSessionMessage } = rules;
	const record = (name, status, extra = {}) => ({ type: "custom", customType: AGENT_RECORD_ENTRY, data: { name, taskId: `t-${name}-${status}`, ownerSessionId: "old", sessionId: `s-${name}`, type: "worker", description: `${name} job`, status, depth: 1, cwd: "/w", model: "m", resultRead: false, ...extra } });
	const entries = [
		record("worker-1", "queued"),
		record("worker-1", "running"),
		record("worker-2", "running"),
		record("worker-2", "completed", { result: "All green.\nDetails follow." }),
		record("worker-3", "completed", { result: "Read already.", resultRead: true }),
		record("foreign", "running", { ownerSessionId: "someone-else" }),
		{ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "sleep 999" } }, { type: "toolCall", id: "c3", name: "read", arguments: { path: "/a.ts" } }, { type: "toolCall", id: "c4", name: "edit", arguments: { path: "/b.ts" } }, { type: "toolCall", id: "c5", name: "read", arguments: { path: "/b.ts" } }, { type: "toolCall", id: "c6", name: "multi_edit", arguments: { files: [{ path: "/c.ts" }] } }] } },
		{ type: "message", id: "r1", message: { role: "toolResult", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "…\nStill running after 120s, so it was moved to the background as task 1. Output continues at /logs/s-1.log — `read` it any time. You will be notified…" }] } },
		{ type: "message", id: "r2", message: { role: "toolResult", toolName: "bash", toolCallId: "c2", content: [{ type: "text", text: "Started in the background as task 2; it is running now. Output continues at /logs/s-2.log — `read` it any time." }] } },
		{ type: "custom_message", id: "n1", customType: "background-task-notification", content: "done", details: { id: 1, logPath: "/logs/s-1.log", exitCode: 0 } },
		{ type: "custom_message", id: "n2", customType: "background-task-notification", content: "stalled", details: { id: 2, logPath: "/logs/s-2.log", stalled: true } },
	];
	const agents = agentFactsFromEntries(entries, "old");
	check("live agents: the latest run per name, this owner only", JSON.stringify(agents.liveAgents) === JSON.stringify([{ name: "worker-1", type: "worker", status: "running" }]), JSON.stringify(agents.liveAgents));
	check("unread results: settled and not read, first line only", JSON.stringify(agents.unreadResults) === JSON.stringify([{ name: "worker-2", status: "completed", firstLine: "All green." }]), JSON.stringify(agents.unreadResults));
	const tasks = backgroundTasksFromEntries(entries);
	check("background tasks: started minus finished, stall is not finished, command from the call", JSON.stringify(tasks) === JSON.stringify([{ id: 2, command: "sleep 999", logPath: "/logs/s-2.log" }]), JSON.stringify(tasks));
	const files = filesFromEntries(entries);
	check("files: changed listed once, a changed file is not repeated under read", JSON.stringify(files) === JSON.stringify({ filesRead: ["/a.ts"], filesChanged: ["/b.ts", "/c.ts"] }), JSON.stringify(files));
	const block = renderHandoffBlock({ ...agents, backgroundTasks: tasks, ...files });
	const expected = [
		HANDOFF_BLOCK_HEADING,
		"- agent worker-1 · worker · running",
		"- unread result worker-2 · completed · All green.",
		"- background task 2 · sleep 999 · log /logs/s-2.log",
		"- files changed: /b.ts, /c.ts",
		"- files read: /a.ts",
	].join("\n");
	check("the block is one line per fact, no prose", block === expected, block);
	check("nothing in flight renders nothing", renderHandoffBlock({ liveAgents: [], unreadResults: [], backgroundTasks: [], filesRead: [], filesChanged: [] }) === "");
	const first = continueSessionMessage({ oldSessionFile: "/s/old.jsonl", document: "# Handoff\n## Intent\nx\n", block, recallCommand: "/k/bin/pi-recall.mjs" });
	check("the first message opens with Continue session `<path>`.", first.startsWith("Continue session `/s/old.jsonl`.\n\n# Handoff\n## Intent\nx\n\n## In flight"));
	check("and ends with the way back to the raw history", /\/k\/bin\/pi-recall\.mjs \/s\/old\.jsonl list \| grep <word> \| show <n>/.test(first));
	check("no block, no blank section", !continueSessionMessage({ oldSessionFile: "/s/old.jsonl", document: "# Handoff", block: "", recallCommand: "r" }).includes("\n\n\n"));
	const { seatText, seatCarryWarning, HANDOFF_SEAT_ENTRY } = rules;
	check("a seat is named model-at-level, and an unknown model says so", seatText({ model: "anthropic/claude-opus-5", thinking: "high" }) === "anthropic/claude-opus-5 at high" && seatText({ model: null, thinking: "medium" }) === "an unknown model at medium" && HANDOFF_SEAT_ENTRY === "handoff-seat");
	const failed = seatCarryWarning({ wanted: { model: "anthropic/claude-opus-5", thinking: "high" }, got: { model: "anthropic/claude-fable-5-1", thinking: "medium" }, reason: "there is no API key for that model" });
	check("a carry that could not happen names the seat it wanted, the one it got, and why", failed.includes("wanted anthropic/claude-opus-5 at high") && failed.includes("runs on anthropic/claude-fable-5-1 at medium") && failed.includes("no API key"), failed);
	const { generatedHandoff, GENERATED_HANDOFF_ENTRY, isHandoffDocumentText } = rules;
	const harnessDoc = generatedHandoff({ tokens: 301_000, thresholds: ladder.DEFAULT_THRESHOLDS });
	check("the harness's own handoff is a document by the detector's rule", isHandoffDocumentText(harnessDoc) && GENERATED_HANDOFF_ENTRY === "handoff-generated");
	check("it names the size and the stop, and claims nothing it cannot know", harnessDoc.includes("301k") && harnessDoc.includes("stop at 300k") && harnessDoc.includes("Not recorded") && harnessDoc.includes("Read the old session"));
	check("and it carries no history of its own: the block that follows is all the harness has", harnessDoc.split("\n").length <= 10);
}

// ---------------------------------------------------------------------------
console.log("\nwhat the new session carries");
{
	const { carriedEntries, CACHE_MODE_ENTRY } = rules;
	const entries = [
		{ type: "custom", customType: AGENT_RECORD_ENTRY, data: { name: "w", taskId: "t1", ownerSessionId: "old", sessionId: "s", status: "running" } },
		{ type: "custom", customType: AGENT_RECORD_ENTRY, data: { name: "x", taskId: "t2", ownerSessionId: "other", sessionId: "s2", status: "completed" } },
		{ type: "custom", customType: CACHE_MODE_ENTRY, data: { mode: "short" } },
		{ type: "custom", customType: CACHE_MODE_ENTRY, data: { mode: "keepalive" } },
		{ type: "custom", customType: "another-extension-entry", data: {} },
		{ type: "custom", customType: AGENT_RECORD_ENTRY, data: { name: "w", taskId: "t1", ownerSessionId: "old", sessionId: "s", status: "completed", result: "ok" } },
		{ type: "custom", customType: AGENT_RECORD_ENTRY, data: { broken: true } },
	];
	const carried = carriedEntries(entries, "old", "new", new Set());
	check("agent records of this owner are carried in order with the new owner (ticket 19 q6)", carried.length === 3 && carried[0].data.name === "w" && carried[0].data.ownerSessionId === "new" && carried[0].data.status === "running" && carried[1].data.status === "completed" && carried[1].data.ownerSessionId === "new", JSON.stringify(carried));
	check("another session's records and malformed ones are not", !carried.some((e) => e.data?.name === "x" || e.data?.broken));
	check("the latest cache-mode choice rides along last, so the launch question is not asked again", carried[2].customType === CACHE_MODE_ENTRY && carried[2].data.mode === "keepalive");
	const handed = (taskId) => ({ type: "custom", customType: AGENT_RECORD_ENTRY, data: { name: `h-${taskId}`, taskId, ownerSessionId: "old", sessionId: `s-${taskId}`, status: "completed", result: "ok", readBy: "handed", readAt: 1 } });
	const marks = carriedEntries([handed("seen"), handed("lost")], "old", "new", new Set(["seen"])).map((e) => `${e.data.taskId}:${e.data.readBy}`).join(",");
	check("a handed result the old file answered is carried read by the conversation; one it never answered stays handed", marks === "seen:conversation,lost:handed", marks);
	check("session-mode really persists under that type", fs.readFileSync(`${ROOT}/extensions/session-mode.ts`, "utf8").includes(`const ENTRY_TYPE = "${CACHE_MODE_ENTRY}"`));
}

// ---------------------------------------------------------------------------
console.log("\nthe recall script");
{
	const RECALL = `${ROOT}/bin/pi-recall.mjs`;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-"));
	const file = path.join(dir, "old.jsonl");
	// A branch with a dead side branch (entry x, parent u1) the model never saw at the end.
	const lines = [
		{ type: "session", id: "h", version: 3, timestamp: "t0" },
		{ type: "model_change", id: "mc", parentId: null, provider: "p", modelId: "m" },
		{ type: "message", id: "u1", parentId: "mc", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "Fix the cache TTL bug\nin session-mode" }] } },
		{ type: "message", id: "x", parentId: "u1", timestamp: "tx", message: { role: "assistant", content: [{ type: "text", text: "ABANDONED BRANCH" }] } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm TTL" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x.ts" } }] } },
		{ type: "message", id: "r1", parentId: "a1", timestamp: "t3", message: { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: `const TTL = 300; // ${"z".repeat(200)} end` }] } },
		{ type: "custom", id: "k", parentId: "r1", customType: "agent-record", data: { name: "secret-TTL-record" } },
		{ type: "custom_message", id: "cm", parentId: "k", timestamp: "t4", customType: "handoff-nudge", content: "[handoff] Context is at 150k" },
		{ type: "message", id: "u2", parentId: "cm", timestamp: "t5", message: { role: "user", content: "Now the ping" } },
		{ type: "custom", id: "hs", parentId: "u2", customType: "handoff-seat", data: { side: "continuation", model: "p/m", thinking: "medium", wanted: { model: "p/big", thinking: "high" }, carried: false } },
	];
	fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const run = (...args) => {
		try {
			return { code: 0, out: execFileSync("node", [RECALL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
		} catch (error) {
			return { code: error.status, out: error.stdout ?? "", err: error.stderr ?? "" };
		}
	};
	const listed = run(file, "list");
	check("list: every user message, numbered by branch position, one line each", listed.code === 0 && listed.out === "1  Fix the cache TTL bug in session-mode\n5  Now the ping\n", JSON.stringify(listed));
	const grepped = run(file, "grep", "ttl");
	check("grep: case-insensitive, numbered, with a snippet, over messages and custom messages", grepped.code === 0 && grepped.out.includes("[1 user] t1") && grepped.out.includes("[2 assistant] t2") && grepped.out.includes("[3 toolResult read] t3") && grepped.out.trim().endsWith("3 entries match"), grepped.out);
	check("grep: the abandoned branch and extension bookkeeping are never seen", !grepped.out.includes("ABANDONED") && !run(file, "grep", "secret").out.includes("secret-TTL-record") && run(file, "grep", "ABANDONED").out.trim() === "0 entries match");
	check("grep: --limit caps and says so", run(file, "grep", "ttl", "--limit", "1").out.includes("1 of 3 shown"));
	const shown = run(file, "show", "3");
	check("show: the entry whole, by the number list and grep printed", shown.code === 0 && shown.out.startsWith("[3 toolResult read] t3\nconst TTL = 300;") && shown.out.includes("end"));
	check("show: --max cuts and says how to see all", run(file, "show", "3", "--max", "20").out.includes("more characters; --max"));
	check("show: a custom message is reachable", run(file, "show", "4").out.includes("[4 custom handoff-nudge]"));
	check("show: an unknown number is an error naming the branch size", run(file, "show", "9").code === 1 && run(file, "show", "9").err.includes("the branch has 5"));
	check("usage on a bad command, a bad regex, a bad number", run(file, "nope").code === 1 && run(file, "grep", "(").err.includes("bad regex") && run(file, "show", "x").err.includes("entry number"));
	// The flag that does not exist is named, not swallowed into the positionals
	// and answered with a usage blob that never mentions it (issues/49).
	check("an unknown flag is named, with the reason there is no -i", run(file, "grep", "-i", "ttl").err.includes("no such option -i") && run(file, "grep", "-i", "ttl").err.includes("always case-insensitive"));
	check("and the usage says the same thing", run(file, "nope").err.includes("always case-insensitive"));
	const seated = run(file, "seat");
	check("seat: the model and level the session ran on, and that a handoff did not keep the seat", seated.code === 0 && seated.out === "model p/m\ncontinuation on p/m at medium — the seat was NOT kept; it wanted p/big at high\n", JSON.stringify(seated));
	check("a missing file is an error, not a stack trace", run(path.join(dir, "missing.jsonl"), "list").err.startsWith("cannot read"));
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The scripted model, as test/agent-engine.mjs builds it
// ---------------------------------------------------------------------------

const script = new Map();
const requests = [];
const scriptFor = (userText, steps) => script.set(userText, [...steps]);
/** A request's conversation, without the leading system message pi-ai folds the prompt and tools into. */
const conversationOf = (request) => request.messages.filter((m) => m.role !== "system");
const lastUserText = (context) => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const t = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		// The harness's own injected messages are not the user's prompt: a nudge
		// steered into a live run must not decide which script the model follows.
		if (t.includes("<task-notification>") || t.startsWith("[handoff]")) continue;
		return t;
	}
	return "";
};
const text = (t) => ({ type: "text", text: t });
const call = (name, args, id = `call_${Math.random().toString(16).slice(2, 8)}`) => ({ type: "toolCall", id, name, arguments: args });

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	let aborted = false;
	const request = { model: model.id, sessionId: options?.sessionId, reasoning: options?.reasoning, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), messages: context.messages };
	requests.push(request);
	const key = [...script.keys()].filter((k) => lastUserText(context).includes(k)).sort((a, b) => b.length - a.length)[0];
	const steps = key === undefined ? undefined : script.get(key);
	const step = steps?.shift() ?? [text(`(no script for: ${lastUserText(context).slice(0, 60)})`)];
	// A provider that never answers an abort: the run stays streaming until the script ends it.
	if (!Array.isArray(step) && step.ignoreAbort === true) options = { ...options, signal: undefined };
	options?.signal?.addEventListener("abort", () => {
		if (aborted) return;
		aborted = true;
		const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() };
		stream.push({ type: "error", reason: "aborted", error: { ...partial, errorMessage: "Request was aborted" } });
		stream.end();
	}, { once: true });
	const content = Array.isArray(step) ? step : step.content;
	const delay = Array.isArray(step) ? 5 : (step.delay ?? 5);
	const live = Array.isArray(step) ? undefined : step.live;
	const stopReason = content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
	// The context grows 15 tokens per request in the process, so a ladder with
	// small thresholds can be walked turn by turn.
	const usage = { input: 10 * requests.length, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 * requests.length, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
	const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
	setTimeout(async () => {
		// A custom provider is what calls pi's `before_provider_request`; on the
		// Anthropic api that is where `wire` writes the system array.
		if (model.api === "anthropic-messages") {
			const tools = getCurrentTools(context.messages).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
			const payload = await options?.onPayload?.({ model: model.id, system: [{ type: "text", text: "vanilla pi prompt", cache_control: { type: "ephemeral" } }], messages: [], tools }, model);
			request.wireSystem = payload?.system;
			request.wireTools = payload?.tools ?? tools;
		}
		if (aborted) return;
		stream.push({ type: "start", partial: { ...message, content: [] } });
		if (live !== undefined) {
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "…", partial: message });
			let open = true;
			live.attach({
				delta: (delta) => { if (open && !aborted) stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message }); },
				end: () => {
					if (!open || aborted) return;
					open = false;
					stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
					stream.push({ type: "done", reason: stopReason, message });
					stream.end();
				},
			});
			return;
		}
		content.forEach((block, i) => {
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex: i, partial: message });
				stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: message });
				stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: message });
			} else {
				stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
				stream.push({ type: "toolcall_delta", contentIndex: i, delta: JSON.stringify(block.arguments), partial: message });
				stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message });
			}
		});
		stream.push({ type: "done", reason: stopReason, message });
		stream.end();
	}, delay);
	return stream;
}

const SCRIPTED_MODEL = { id: "scripted-1", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
// A second model that thinks: a seat can sit on something other than the
// default the next session would otherwise be created with.
const THINKING_MODEL = { ...SCRIPTED_MODEL, id: "scripted-2", name: "scripted thinker", reasoning: true };
const scriptedProvider = (pi) => {
	pi.registerProvider("scripted", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: [SCRIPTED_MODEL, THINKING_MODEL] });
};
const modelRuntime = await ModelRuntime.create({});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await sleep(10);
	}
	return true;
}

/**
 * A main seat under pi's own `AgentSessionRuntime`, the way `pi` itself runs
 * one: a fresh loader (fresh extension instances) per session, and
 * `ctx.newSession` bound to the runtime's replacement flow. `log` records
 * every session_start / session_shutdown with the file bytes at shutdown, so
 * the old file can be compared after the switch.
 */
async function mainSeat({ extensions = [`${ROOT}/extensions/agent-engine.ts`, `${ROOT}/extensions/continue-session.ts`], cwd = ROOT, provider = scriptedProvider, model = ["scripted", "scripted-1"], gap, onShutdown, onStart, sessionManager = SessionManager.create(cwd) } = {}) {
	const log = [];
	const events = [];
	const observer = (pi) => {
		pi.on("session_start", async (event, ctx) => {
			log.push({ type: "start", reason: event.reason, previous: event.previousSessionFile, file: ctx.sessionManager.getSessionFile(), id: ctx.sessionManager.getSessionId() });
			// Inline factories load after the extension files, so the engine has re-hosted by now.
			if (event.reason === "new") await onStart?.(ctx);
		});
		pi.on("session_shutdown", async (event, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			log.push({ type: "shutdown", reason: event.reason, target: event.targetSessionFile, file, bytes: file && fs.existsSync(file) ? fs.readFileSync(file) : undefined });
			// Inline factories load after the extension files, so the engine has parked by now.
			if (event.reason === "new") await onShutdown?.();
		});
		for (const channel of ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed"]) pi.events.on(channel, (payload) => events.push({ channel, ...payload }));
	};
	const createRuntime = async ({ cwd: runCwd, agentDir, sessionManager, sessionStartEvent }) => {
		// The old session is disposed and its ctx stale; the new one's session_start has not run.
		if (sessionStartEvent?.reason === "new") await gap?.();
		const loader = new DefaultResourceLoader({
			cwd: runCwd,
			agentDir,
			eventBus: createEventBus(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: extensions,
			extensionFactories: [provider, observer],
		});
		await loader.reload();
		const seatModel = modelRuntime.getModel(...model);
		const { session } = await createAgentSession({ cwd: runCwd, agentDir, thinkingLevel: "off", noTools: "builtin", resourceLoader: loader, sessionManager, modelRuntime, ...(seatModel ? { model: seatModel } : {}), ...(sessionStartEvent ? { sessionStartEvent } : {}) });
		return { session, services: { cwd: runCwd, agentDir, modelRuntime, settingsManager: session.settingsManager, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: getAgentDir(), sessionManager });
	const bind = async (session) => {
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
			},
		});
		await session.setModel(modelRuntime.getModel(...model));
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return { runtime, log, events, session: () => runtime.session };
}

/**
 * A child seat in a worktree: the same extension files, loaded under a
 * different cwd. pi's extension-factory cache is keyed by cwd, so this clears
 * it and every later load in the process re-imports the extension modules —
 * which on 2026-09-05 left the old session's switch reading a module-level map
 * the successor could never fill (ticket 64).
 */
async function loadExtensionsUnderAnotherCwd() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "continue-session-worktree-"));
	const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), eventBus: createEventBus(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [`${ROOT}/extensions/continue-session.ts`] });
	await loader.reload();
	fs.rmSync(cwd, { recursive: true, force: true });
}

const DOC = "# Handoff\n## Intent\nFinish the switch.\n## State\nTests green so far.\n## Next\nRun the suite.\n## Map\n- pi/kit/extensions/continue-session.ts\n## Decisions\n- no tool\n## Open\n- none";
const entriesOf = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

// ---------------------------------------------------------------------------
console.log("\nthe switch, on a real pi session");
{
	const seat = await mainSeat();
	const old = seat.session();
	const oldFile = old.sessionFile;
	// The model reads a file (a tool result is the last entry), then writes the
	// document: the exact shape pi's compaction refused on 2026-09-03.
	scriptFor("Do the work", [[call("read", { path: `${ROOT}/package.json` })], [text(DOC)]]);
	scriptFor("Continue session", [[text("Continuing from the document.")]]);
	// The seat sits on a non-default model at a non-default thinking level; a new
	// session is created on the default of both (ticket 31 (e)).
	await old.setModel(modelRuntime.getModel("scripted", "scripted-2"));
	old.setThinkingLevel("high");
	await old.prompt("Do the work");
	check("the handoff turn ends the old session's run with a tool result behind it", old.messages.at(-2)?.role === "toolResult" && old.messages.at(-1)?.role === "assistant");
	const switched = await until(() => seat.session() !== old && seat.session().isIdle && seat.session().messages.length >= 2, 8000);
	check("the harness switched to a new session and its first turn ran", switched, `${seat.session() === old ? "same session" : "new session"}, ${seat.session().messages.length} messages`);
	const fresh = seat.session();
	const shutdown = seat.log.find((e) => e.type === "shutdown");
	const start = seat.log.filter((e) => e.type === "start").at(-1);
	check("the old session shut down for a replacement, not a quit", shutdown?.reason === "new" && shutdown.file === oldFile && shutdown.target === fresh.sessionFile, JSON.stringify(shutdown && { ...shutdown, bytes: undefined }));
	check("the old session file is byte-unchanged after the switch", shutdown?.bytes !== undefined && fs.readFileSync(oldFile).equals(shutdown.bytes), `${shutdown?.bytes?.length} bytes at shutdown, ${fs.statSync(oldFile).size} now`);
	check("the old file's last entry is the tool result, then the document; no compaction entry", (() => { const e = entriesOf(oldFile); return e.at(-1)?.message?.role === "assistant" && e.at(-2)?.message?.role === "toolResult" && !e.some((x) => x.type === "compaction"); })());
	check("the new session started as `new` and names the old file as previous", start?.reason === "new" && start.previous === oldFile && start.file === fresh.sessionFile);
	check("the new file is linked to the old one in its header", entriesOf(fresh.sessionFile)[0]?.parentSession === oldFile, JSON.stringify(entriesOf(fresh.sessionFile)[0]));
	const first = fresh.messages.find((m) => m.role === "user");
	const firstText = first?.role === "user" ? first.content.map((b) => b.text ?? "").join("") : "";
	check("the first message is the user's: Continue session `<old file>`. + the document", firstText.startsWith(`Continue session \`${oldFile}\`.\n\n${DOC}`), firstText.slice(0, 160));
	check("the block names the file the old session read", firstText.includes(`- files read: ${ROOT}/package.json`), firstText);
	check("the first request carried exactly that one message", conversationOf(requests.at(-1)).length === 1 && conversationOf(requests.at(-1))[0].role === "user");
	check("the model answered it in the new session", fresh.messages.at(-1)?.role === "assistant" && fresh.messages.at(-1).content[0]?.text === "Continuing from the document.");
	check("the continuation is the same seat: its first request carries the seat's model and thinking level", requests.at(-1)?.model === "scripted-2" && requests.at(-1)?.reasoning === "high", `${requests.at(-1)?.model} / ${requests.at(-1)?.reasoning}`);
	check("and the new session itself is on that model and level, not the default", fresh.model?.id === "scripted-2" && fresh.thinkingLevel === "high", `${fresh.model?.id} / ${fresh.thinkingLevel}`);
	check("no summariser ran: every request in the process was scripted", requests.every((r) => r.model.startsWith("scripted-")) && requests.length === 3, `${requests.length} requests`);
	check("the nudge never fired: the ladder was below its threshold", !old.messages.some((m) => m.role === "custom" && m.customType === "handoff-nudge"));
	const oldId = seat.log.find((e) => e.type === "start")?.id;
	check("the old session's runtime is dropped at its shutdown, so a process across handoffs keeps one", oldId !== undefined && seam.agentRuntimeOf(oldId) === undefined && seam.agentRuntimeOf(seat.session().sessionManager.getSessionId()) !== undefined, `${oldId} -> ${seam.agentRuntimeOf(oldId) !== undefined}`);
	seat.runtime.session.dispose();
}

// ---------------------------------------------------------------------------
// Ticket 64: the seat Joel chose must survive the switch, and the only way he
// can find out it did not is the harness telling him.
console.log("\nthe seat survives a handoff even after a worktree seat reloaded the extension modules");
{
	const seat = await mainSeat();
	const old = seat.session();
	const oldFile = old.sessionFile;
	scriptFor("Work then hand off the seat", [[text(DOC)]]);
	scriptFor("Continue session", [[text("Continuing on the same seat.")]]);
	await old.setModel(modelRuntime.getModel("scripted", "scripted-2"));
	old.setThinkingLevel("high");
	await loadExtensionsUnderAnotherCwd();
	await old.prompt("Work then hand off the seat");
	const switched = await until(() => seat.session() !== old && seat.session().isIdle && seat.session().messages.length >= 2, 8000);
	const fresh = seat.session();
	check("the harness switched to a new session and its first turn ran", switched, `${seat.session() === old ? "same session" : "new session"}, ${seat.session().messages.length} messages`);
	check("the continuation's first request goes out on the seat's model and thinking level", requests.at(-1)?.model === "scripted-2" && requests.at(-1)?.reasoning === "high", `${requests.at(-1)?.model} / ${requests.at(-1)?.reasoning}`);
	check("and the new session itself is on them, not the defaults it was created with", fresh.model?.id === "scripted-2" && fresh.thinkingLevel === "high", `${fresh.model?.id} / ${fresh.thinkingLevel}`);
	const continued = entriesOf(fresh.sessionFile).find((e) => e.customType === "handoff-seat")?.data;
	check("the new file records the seat it came up on and that it was kept", continued?.side === "continuation" && continued.carried === true && continued.model === "scripted/scripted-2" && continued.thinking === "high", JSON.stringify(continued));
	const seatOf = (file) => execFileSync("node", [`${ROOT}/bin/pi-recall.mjs`, file, "seat"], { encoding: "utf8" });
	check("pi-recall reads the old file's seat off pi's own record: the model and level it handed off from", seatOf(oldFile).trim().endsWith("model scripted/scripted-2\nthinking high"), seatOf(oldFile));
	check("and says of the new file that the handoff kept the seat", seatOf(fresh.sessionFile).includes("continuation on scripted/scripted-2 at high — the seat was kept"), seatOf(fresh.sessionFile));
	fresh.dispose();
}

// ---------------------------------------------------------------------------
console.log("\na carry that cannot happen is said out loud, never skipped");
{
	const seat = await mainSeat();
	const old = seat.session();
	scriptFor("Hand off with no key for the seat", [[text(DOC)]]);
	scriptFor("Continue session", [[text("Continuing.")]]);
	await old.setModel(modelRuntime.getModel("scripted", "scripted-2"));
	old.setThinkingLevel("high");
	// The one failure the harness cannot prevent: the successor has no API key
	// for that model, so `setModel` refuses. Injected at the seam the switch
	// reads, which is where a real refusal arrives.
	const controls = globalThis.__piKitSeatControls;
	const register = controls.set.bind(controls);
	controls.set = (id, value) => register(id, { ...value, setModel: async () => false });
	// Read at the screen owner's seam, not off stderr: `lib/notice.ts` writes to
	// no process stream a seat does not own, so stderr is where this message is
	// guaranteed *not* to be. What matters is that it reaches the human's
	// channel, whichever one the seat has.
	const said = [];
	const { claimScreen } = await jiti.import(`${ROOT}/lib/notice.ts`);
	const release = claimScreen((message) => said.push(message));
	let switched = false;
	try {
		await old.prompt("Hand off with no key for the seat");
		switched = await until(() => seat.session() !== old && seat.session().isIdle && seat.session().messages.length >= 2, 8000);
	} finally {
		// The claim is process-wide: leaking it would silently swallow every later
		// suite's notices rather than fail here.
		release();
	}
	delete controls.set;
	const fresh = seat.session();
	const warning = said.find((line) => line.startsWith("handoff:")) ?? "";
	check("the continuation still ran: a failed carry does not cancel the switch", switched, `${seat.session() === old ? "same session" : "new session"}, ${seat.session().messages.length} messages`);
	check("the harness said so, naming the seat it wanted and the one it got", warning.includes("wanted scripted/scripted-2 at high") && warning.includes("runs on scripted/scripted-1 at off") && warning.includes("no API key"), JSON.stringify(said));
	const continued = entriesOf(fresh.sessionFile).find((e) => e.customType === "handoff-seat")?.data;
	check("and the new file records that the seat was not kept, with the one it wanted", continued?.carried === false && continued.model === "scripted/scripted-1" && continued.wanted?.model === "scripted/scripted-2" && continued.wanted.thinking === "high", JSON.stringify(continued));
	fresh.dispose();
}

// ---------------------------------------------------------------------------
console.log("\nthe ladder, on a real pi session");
{
	// Read once, at the extension's factory: set before the seat's loader runs.
	// The context grows 15 tokens per request, so the gaps put a silent turn
	// between the nudge and the gate and another between the gate and the stop.
	const base = 15 * requests.length;
	process.env.PI_HANDOFF_THRESHOLDS = `${base + 10},${base + 40},${base + 70}`;
	const seat = await mainSeat();
	delete process.env.PI_HANDOFF_THRESHOLDS;
	const session = seat.session();
	const nudges = () => session.messages.filter((m) => m.role === "custom" && m.customType === "handoff-nudge").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));
	for (const n of ["one", "two", "three", "four", "five"]) scriptFor(`turn ${n}`, [[text(n)]]);
	const before = requests.length;
	await session.prompt("turn one");
	check("crossing the soft limit lands one nudge in Joel's words", nudges().length === 1 && nudges()[0].includes(ladder.NUDGE_WORDING), nudges().join(" | ").slice(0, 200));
	check("the nudge triggers no turn of its own", requests.length === before + 1 && session.isIdle, `${requests.length - before} requests`);
	await session.prompt("turn two");
	check("the nudge is never repeated: between the soft and the hard limit the ladder is silent", nudges().length === 1, `${nudges().length} nudges`);
	await session.prompt("turn three");
	check("crossing the hard limit lands one gate, in Joel's three beats", nudges().length === 2 && nudges()[1].includes(ladder.GATE_WORDING) && !nudges()[1].includes(ladder.NUDGE_WORDING), nudges().at(-1)?.slice(0, 120));
	check("the model saw the nudge on its next request, at the tail", requests.at(-1).messages.at(-2)?.role === "custom" || JSON.stringify(requests.at(-1).messages).includes(ladder.NUDGE_WORDING));
	await session.prompt("turn four");
	check("the gate is never repeated either", nudges().length === 2, `${nudges().length} nudges`);
	await session.prompt("turn five");
	const last = session.messages.at(-1);
	check("past the stop the run is aborted and nothing more is asked", nudges().length === 2 && session.isIdle && requests.length === before + 5, `${nudges().length} nudges, last ${last?.role} ${last?.stopReason ?? ""}`);
	const generated = entriesOf(session.sessionFile).filter((e) => e.customType === "handoff-generated");
	check("the harness recorded its own handoff before aborting", generated.length === 1 && rules.isHandoffDocumentText(generated[0].data.document), JSON.stringify(generated[0]?.data).slice(0, 160));
	check("no session switch happened: the stop waits for a human", seat.session() === session && seat.log.filter((e) => e.type === "shutdown").length === 0);
	session.dispose();
}

// ---------------------------------------------------------------------------
// The failure mode Joel named: a subagent lands, or a big file is read, and
// one step crosses the gate and the stop together. The model was never given a
// turn in which it could write a handoff, so ticket 51 §1 gives it exactly one
// — steered, and the last whatever it contains.
console.log("\na step that crosses every threshold at once buys one turn");
{
	const base = 15 * requests.length;
	process.env.PI_HANDOFF_THRESHOLDS = `${base + 5},${base + 8},${base + 11}`;
	const seat = await mainSeat();
	delete process.env.PI_HANDOFF_THRESHOLDS;
	const session = seat.session();
	scriptFor("one huge step", [[text("done")], [text("I would rather keep working.")]]);
	const before = requests.length;
	await session.prompt("one huge step");
	await until(() => entriesOf(session.sessionFile).some((e) => e.customType === "handoff-generated"), 8000);
	await until(() => session.isIdle, 5000);
	const steers = session.messages.filter((m) => m.role === "custom" && m.customType === "handoff-nudge").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));
	check("no nudge and no gate: nothing was ever below the stop", steers.length === 1 && !steers[0].includes(ladder.NUDGE_WORDING) && !steers[0].includes(ladder.GATE_WORDING), steers.join(" | ").slice(0, 160));
	check("one turn is granted instead, in the harness's words", steers[0].includes(ladder.LAST_TURN_WORDING));
	check("that turn ran and it was the last: two requests, then the stop", requests.length === before + 2 && session.isIdle, `${requests.length - before} requests`);
	const generated = entriesOf(session.sessionFile).filter((e) => e.customType === "handoff-generated");
	check("the turn wrote nothing, so the harness wrote a handoff of the right shape from what it knows", generated.length === 1 && generated[0].data.byModel === false && rules.isHandoffDocumentText(generated[0].data.document) && generated[0].data.document.includes("Not recorded"), JSON.stringify(generated[0]?.data).slice(0, 200));
	check("and it is honest that the model wrote none of it", generated[0]?.data.document.includes("the harness wrote this document") && generated[0].data.stop === base + 11);
	check("nothing continued on its own", seat.session() === session && seat.log.filter((e) => e.type === "shutdown").length === 0);
	session.dispose();
}

// ---------------------------------------------------------------------------
// The same jump, with the turn spent the way it is meant to be: the model's own
// document is the record, and the run still stops — a handoff written under the
// stop does not continue itself (ticket 51 §1).
console.log("\nthe granted turn writes the handoff, and that document is the record");
{
	const base = 15 * requests.length;
	process.env.PI_HANDOFF_THRESHOLDS = `${base + 5},${base + 8},${base + 11}`;
	const seat = await mainSeat();
	delete process.env.PI_HANDOFF_THRESHOLDS;
	const session = seat.session();
	scriptFor("another huge step", [[text("done")], [text(DOC)]]);
	await session.prompt("another huge step");
	await until(() => entriesOf(session.sessionFile).some((e) => e.customType === "handoff-generated"), 8000);
	await until(() => session.isIdle, 5000);
	const generated = entriesOf(session.sessionFile).filter((e) => e.customType === "handoff-generated");
	check("the model's own document is the record, marked as the model's", generated.length === 1 && generated[0].data.byModel === true && generated[0].data.document === DOC.trim(), JSON.stringify(generated[0]?.data).slice(0, 200));
	check("and it still stops: a document written under the stop does not continue itself", seat.session() === session && seat.log.filter((e) => e.type === "shutdown").length === 0 && session.isIdle);
	session.dispose();
}

// ---------------------------------------------------------------------------
// The 2026-09-03 failure, as a test: a nudge sent mid-run must be in the
// messages the provider is actually handed, not merely in the session file.
// pi's agent snapshots its messages when a run starts, so an appended custom
// message is invisible to the run in flight — that session took three nudges
// at 152k–156k, wrote none of them into a request, and died with no handoff.
console.log("\nthe nudge reaches the model inside a run in flight");
{
	const base = 15 * requests.length;
	process.env.PI_HANDOFF_THRESHOLDS = `${base + 10},${base + 5000},${base + 9000}`;
	const seat = await mainSeat();
	delete process.env.PI_HANDOFF_THRESHOLDS;
	const session = seat.session();
	// One run, three turns: two tool calls (the run continues) and a final answer.
	scriptFor("work then answer", [[call("read", { path: `${ROOT}/package.json` })], [call("read", { path: `${ROOT}/package.json` })], [text("done")]]);
	const before = requests.length;
	await session.prompt("work then answer");
	const inRun = requests.slice(before);
	const nudged = inRun.filter((r) => JSON.stringify(r.messages).includes(ladder.NUDGE_WORDING));
	check("the nudge is in the messages handed to the provider on the next request of the same run", nudged.length >= 1 && nudged[0] === inRun[1], `${inRun.length} requests, nudge first seen in request ${inRun.indexOf(nudged[0])}`);
	const tail = inRun[1]?.messages.at(-1);
	const tailText = tail === undefined ? "" : typeof tail.content === "string" ? tail.content : (tail.content ?? []).map((b) => b.text ?? "").join("");
	check("it is the tail of that request, so the cached prefix is untouched", tail?.role === "user" && tailText.includes(ladder.NUDGE_WORDING), `${tail?.role}: ${tailText.slice(0, 80)}`);
	check("it cost no request of its own: three scripted turns, three requests", inRun.length === 3 && session.isIdle, `${inRun.length} requests`);
	const nudges = session.messages.filter((m) => m.role === "custom" && m.customType === "handoff-nudge");
	check("three turns ended and the soft nudge was said once, not three times", nudges.length === 1, `${nudges.length} nudges`);
	check("and the session file records that one nudge", entriesOf(session.sessionFile).filter((e) => e.customType === "handoff-nudge").length === 1);
	session.dispose();
}

// ---------------------------------------------------------------------------
console.log("\nlive agents survive the switch and their names resolve");
{
	const seat = await mainSeat();
	const old = seat.session();
	const oldFile = old.sessionFile;
	const DOC2 = "# Handoff\n## Intent\nKeep worker-1 running.\n## State\nworker-1 mid-job.\n## Next\nRead its result.\n## Map\n-\n## Decisions\n-\n## Open\n-";
	scriptFor("Spawn and hand off", [[call("Agent", { description: "slow job", prompt: "child slow job", name: "worker-1" })], [text(DOC2)]]);
	// Slower than the switch (a fresh loader for the new session takes a while), so the child is mid-job when it happens.
	scriptFor("child slow job", [{ content: [text("child done: 42")], delay: 3000 }]);
	scriptFor("Continue session", [[call("ListAgents", {})], [text("listed")]]);
	scriptFor("after the child", [[text("read it")]]);
	await old.prompt("Spawn and hand off");
	const switched = await until(() => seat.session() !== old && seat.session().isIdle && seat.session().messages.some((m) => m.role === "toolResult"), 8000);
	const fresh = seat.session();
	check("switched while worker-1 was still running", switched && seat.events.filter((e) => e.channel === "subagents:completed").length === 0, `${seat.events.map((e) => e.channel).join(",")}`);
	const listed = fresh.messages.find((m) => m.role === "toolResult" && m.toolName === "ListAgents");
	const listedText = listed?.content?.map((b) => b.text ?? "").join("") ?? "";
	check("the first message's block names the live agent", (fresh.messages.find((m) => m.role === "user")?.content ?? []).map((b) => b.text ?? "").join("").includes("- agent worker-1 · worker · running"));
	check("ListAgents in the new session resolves worker-1, still running (ticket 19 q6)", listedText.includes("worker-1 · worker · running"), listedText);
	check("the new session's registry file says running under the new owner", entriesOf(fresh.sessionFile).some((e) => e.customType === "agent-record" && e.data?.name === "worker-1" && e.data.status === "running" && e.data.ownerSessionId === fresh.sessionId));
	check("the dock was told about the carried agent as a fresh start", seat.events.filter((e) => e.channel === "subagents:started" && e.name === "worker-1").length === 2, seat.events.map((e) => `${e.channel}:${e.name}`).join(","));
	const done = await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "worker-1"), 8000);
	check("worker-1 ran to completion after the switch, not stopped", done && seat.events.find((e) => e.channel === "subagents:completed" && e.name === "worker-1")?.result === "child done: 42");
	await until(() => entriesOf(fresh.sessionFile).some((e) => e.customType === "agent-record" && e.data?.status === "completed"), 3000);
	check("its completed record is in the new file, owned by the new session", entriesOf(fresh.sessionFile).some((e) => e.customType === "agent-record" && e.data?.name === "worker-1" && e.data.status === "completed" && e.data.ownerSessionId === fresh.sessionId && e.data.result === "child done: 42"));
	const shutdown = seat.log.find((e) => e.type === "shutdown");
	check("and the old file is still byte-unchanged", shutdown?.bytes !== undefined && fs.readFileSync(oldFile).equals(shutdown.bytes));
	// Ticket 09, ruled: the carried run delivers itself into the new session the
	// moment it lands, so there is no prompt here to carry it.
	const carried = await until(() => requests.some((r) => JSON.stringify(r.messages).includes("child done: 42")), 5000);
	await fresh.waitForIdle();
	const carrying = requests.filter((r) => JSON.stringify(r.messages).includes("child done: 42")).at(-1);
	check("the result reaches the new session on its own, once", carried && carrying.messages.filter((m) => JSON.stringify(m).includes("<task-notification>")).length === 1, String(carrying?.messages.filter((m) => JSON.stringify(m).includes("<task-notification>")).length));
	fresh.dispose();
}

// ---------------------------------------------------------------------------
console.log("\na child hands off the same way (C18)");
{
	const seat = await mainSeat();
	const main = seat.session();
	const CHILD_DOC = "# Handoff\n## Intent\nHandoff of the child worker: finish the job.\n## State\nhalf done.\n## Next\nfinish.\n## Map\n-\n## Decisions\n-\n## Open\n-";
	scriptFor("Delegate a handoff", [[call("Agent", { description: "long job", prompt: "child hands off", name: "worker-2" })], [text("spawned")]]);
	scriptFor("child hands off", [[text(CHILD_DOC)]]);
	scriptFor("Handoff of the child worker", [[text("child finished after its handoff")]]);
	scriptFor("after worker-2", [[text("noted")]]);
	// The child inherits this seat's model but not its level: a child runs at
	// CHILD_THINKING unless it was asked for more. Its own handoff must keep both.
	await main.setModel(modelRuntime.getModel("scripted", "scripted-2"));
	main.setThinkingLevel("medium");
	await main.prompt("Delegate a handoff");
	const created = seat.events.find((e) => e.channel === "subagents:created" && e.name === "worker-2");
	const childFileBefore = entriesOf(main.sessionFile).find((e) => e.customType === "agent-record" && e.data?.name === "worker-2")?.data.sessionFile;
	const childBytes = await (async () => { await until(() => fs.existsSync(childFileBefore) && entriesOf(childFileBefore).some((e) => e.message?.role === "assistant"), 5000); return fs.readFileSync(childFileBefore); })();
	const done = await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "worker-2"), 10000);
	const completed = seat.events.find((e) => e.channel === "subagents:completed" && e.name === "worker-2");
	check("the child was not settled on its handoff document: it continued and finished", done && completed?.result === "child finished after its handoff", JSON.stringify(completed));
	check("the main seat never switched", seat.session() === main && seat.log.filter((e) => e.type === "shutdown").length === 0);
	const record = entriesOf(main.sessionFile).filter((e) => e.customType === "agent-record" && e.data?.name === "worker-2").at(-1)?.data;
	check("the child's record follows it to the new session file", record?.status === "completed" && record.sessionFile !== childFileBefore && fs.existsSync(record.sessionFile), JSON.stringify(record));
	check("the child's new file is linked to its old one", entriesOf(record.sessionFile)[0]?.parentSession === childFileBefore);
	check("the child's old file is byte-unchanged after its switch", fs.readFileSync(childFileBefore).equals(childBytes) && entriesOf(childFileBefore).at(-1)?.message?.content?.[0]?.text === CHILD_DOC);
	const childFirst = entriesOf(record.sessionFile).find((e) => e.type === "message" && e.message?.role === "user");
	check("the child's continuation opened with Continue session `<its old file>`.", (childFirst?.message?.content?.[0]?.text ?? "").startsWith(`Continue session \`${childFileBefore}\`.\n\n${CHILD_DOC}`));
	check("same task id across the child's switch: one run, one result", created?.id === completed?.id);
	const childContinued = requests.filter((r) => JSON.stringify(r.messages).includes(`Continue session \`${childFileBefore}\``)).at(-1);
	check("the child's continuation runs on the model and thinking level the child had (C18)", childContinued?.model === "scripted-2" && childContinued?.reasoning === "high", `${childContinued?.model} / ${childContinued?.reasoning}`);
	check("a child of a `medium` seat runs at CHILD_THINKING (high), not the parent's level, and its record says so", record?.thinking === "high", String(record?.thinking));
	await main.waitForIdle();
	const read = requests.filter((r) => JSON.stringify(r.messages).includes("child finished after its handoff")).at(-1);
	check("the parent reads the child's final answer, not its handoff document", read !== undefined && !JSON.stringify(read.messages).includes("<result># Handoff"));
	main.dispose();
}

// ---------------------------------------------------------------------------
console.log("\na plain /new is not a handoff: nothing claims the agents, so they stop");
{
	const { liveAgentCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
	const seat = await mainSeat();
	const main = seat.session();
	scriptFor("Spawn and leave", [[call("Agent", { description: "long job", prompt: "child long job", name: "worker-3" })], [text("spawned")]]);
	scriptFor("child long job", [{ content: [text("never read")], delay: 4000 }]);
	await main.prompt("Spawn and leave");
	const liveBefore = liveAgentCount();
	await seat.runtime.newSession({});
	const gone = await until(() => liveAgentCount() === 0, 3000);
	check("the child was live before /new and stopped after it, without a result anywhere", liveBefore >= 1 && gone && !seat.events.some((e) => e.channel === "subagents:completed" && e.name === "worker-3"), `${liveBefore} live before, ${liveAgentCount()} after`);
	check("the fresh session's registry holds nothing", seat.session().sessionManager.getEntries().every((e) => e.customType !== "agent-record"));
	seat.session().dispose();
}

// ---------------------------------------------------------------------------
// A park used to happen at every `/new`, and a run that wrote while parked (here,
// a child handing off: its rebind rewrites its record) had that write replayed
// into the fresh registry, which then held the run and adopted it. Only an
// announced handoff parks; `/new` stops the runs like quit.
console.log("\na child that writes during the switch: /new adopts nothing, a handoff still adopts");
{
	const { liveAgentCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
	for (const via of ["new", "handoff"]) {
		console.log(`  -- via ${via}`);
		const worker = `gap-writer-${via}`;
		const childDoc = `# Handoff\n## Intent\nHandoff of the gap child ${via}: finish.\n## State\n-\n## Next\n-\n## Map\n-\n## Decisions\n-\n## Open\n-`;
		let attach;
		const attached = new Promise((resolve) => { attach = resolve; });
		let runtime;
		let fileBefore;
		let wroteInGap = false;
		let streamed = false;
		// Between the old session's shutdown and the new one's start: the child writes its document and hands off.
		const gap = async () => {
			const controls = await Promise.race([attached, sleep(5000)]);
			streamed = controls !== undefined;
			controls?.end();
			await until(() => runtime.registry.byName(worker)?.sessionFile !== fileBefore || runtime.liveTaskIds().length === 0, 5000);
			wroteInGap = runtime.registry.byName(worker)?.sessionFile !== fileBefore;
		};
		const seat = await mainSeat({ gap });
		const main = seat.session();
		scriptFor(`Spawn the gap child ${via}`, [[call("Agent", { description: "hands off late", prompt: `gap child ${via} works`, name: worker })], via === "handoff" ? [text(DOC)] : [text("spawned")]]);
		scriptFor(`gap child ${via} works`, [{ content: [text(childDoc)], live: { attach } }]);
		scriptFor(`Handoff of the gap child ${via}`, [[text(`gap child ${via} done`)]]);
		scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
		scriptFor(`first turn after ${via}`, [[text("ok")]]);
		runtime = seam.agentRuntimeOf(main.sessionId);
		await main.prompt(`Spawn the gap child ${via}`);
		fileBefore = runtime.registry.byName(worker)?.sessionFile;
		if (via === "new") await seat.runtime.newSession({});
		else await until(() => seat.session() !== main, 8000);
		const fresh = seat.session();
		const oldFile = main.sessionFile;
		await until(() => liveAgentCount() === 0, 8000);
		await fresh.waitForIdle();
		const before = requests.length;
		await fresh.prompt(`first turn after ${via}`);
		await fresh.waitForIdle();
		const records = entriesOf(fresh.sessionFile).filter((e) => e.customType === "agent-record" && e.data?.name === worker).map((e) => e.data);
		const completed = seat.events.some((e) => e.channel === "subagents:completed" && e.name === worker);
		const carriedIntoTurn = requests.slice(before).some((r) => JSON.stringify(r.messages).includes(`gap child ${via} done`));
		check(`${via}: the child was streaming when the switch began`, streamed);
		if (via === "new") {
			const stoppedBy = entriesOf(oldFile).filter((e) => e.customType === "agent-record" && e.data?.name === worker).at(-1)?.data.stoppedBy;
			check("/new: nothing parks: the child is stopped at shutdown, before it can write during the switch", !wroteInGap && stoppedBy === "shutdown", `wrote in gap ${wroteInGap}, stoppedBy ${stoppedBy}`);
			check("/new: the child was stopped, not adopted: it never completed", !completed && liveAgentCount() === 0, `completed ${completed}, wrote in gap ${wroteInGap}, ${liveAgentCount()} live`);
			check("/new: nothing about it lands in the new session file", records.length === 0, JSON.stringify(records.map((r) => `${r.status}:${r.ownerSessionId}`)));
			check("/new: nothing about it rides the first turn", !carriedIntoTurn && !requests.slice(before).some((r) => JSON.stringify(r.messages).includes("<task-notification>")));
		} else {
			check("handoff: the child wrote while parked (its own handoff)", wroteInGap);
			check("handoff: the child was adopted and completed in the new session", completed && records.at(-1)?.status === "completed" && records.at(-1).result === `gap child ${via} done` && records.at(-1).ownerSessionId === fresh.sessionId, JSON.stringify(records.map((r) => `${r.status}:${r.sessionFile === fileBefore ? "old file" : "new file"}`)));
			check("handoff: its write while parked reached the new file (the carried record's new session file)", records.some((r) => r.sessionFile !== fileBefore));
		}
		fresh.dispose();
	}
}

// ---------------------------------------------------------------------------
// 2026-09-23: a handoff while a child streamed. The child died of pi's stale-ctx
// error, its failure notice started a turn in the new session ahead of the
// continuation (wire: no prompt options captured), the continuation's first
// message was refused ("Agent is already processing"), and the next turn broke
// the cache on tools[0].
console.log("\na handoff while a child streams (2026-09-23)");
{
	const { PROMPT_UNAVAILABLE } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const { claimScreen } = await jiti.import(`${ROOT}/lib/notice.ts`);
	const extensions = ["agent-engine", "continue-session", "wire", "workflow"].map((name) => `${ROOT}/extensions/${name}.ts`);
	// The Anthropic api, so `wire` rewrites each request's system array as it does for Joel.
	const wireProvider = (pi) => pi.registerProvider("scripted-wire", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "anthropic-messages", streamSimple, models: [{ ...SCRIPTED_MODEL, id: "scripted-wire-1" }] });
	const liveStream = () => {
		let attach;
		const attached = new Promise((resolve) => { attach = resolve; });
		return { attached, attach: (controls) => attach({ ...controls, at: Date.now() }) };
	};
	// Every assertActive that throws on the old seat leaves the stack of the caller that tripped it.
	const traceStale = (session, sink) => {
		const runner = session.extensionRunner;
		for (const target of [runner, runner.runtime]) {
			const assert = target.assertActive.bind(target);
			target.assertActive = () => {
				try { assert(); } catch (error) { sink.push(new Error("stale").stack); throw error; }
			};
		}
	};
	const userTexts = (request) => conversationOf(request).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));
	const variants = [
		{ name: "a delta lands between invalidation and rehost", at: "gap", act: (live) => live.delta(" more") },
		{ name: "the child finishes between invalidation and rehost", at: "gap", act: (live) => live.end() },
		{ name: "the child finishes after the park, before invalidation", at: "shutdown", act: (live) => live.end() },
	];
	for (const [index, variant] of variants.entries()) {
		console.log(`  -- ${variant.name}`);
		const tag = `v${index}`;
		const worker = `streamer-${index}`;
		const live = liveStream();
		const said = [];
		const stale = [];
		const release = claimScreen((message) => said.push(message));
		let fired = false;
		const act = async (moment) => {
			if (moment !== variant.at || fired) return;
			fired = true;
			const controls = await live.attached;
			// publishProgress drops an unforced event within 1s of the last one; the delta must clear that.
			await sleep(Math.max(0, controls.at + 1100 - Date.now()));
			variant.act(controls);
			for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
		};
		const seat = await mainSeat({ extensions, provider: wireProvider, model: ["scripted-wire", "scripted-wire-1"], gap: () => act("gap"), onShutdown: () => act("shutdown") });
		const old = seat.session();
		const oldId = old.sessionId;
		traceStale(old, stale);
		scriptFor(`Spawn a streaming child ${tag}`, [[call("Agent", { description: "streams", prompt: `child streams ${tag}`, name: worker })], [text(DOC)]]);
		scriptFor(`child streams ${tag}`, [{ content: [text(`child ${tag} done`)], live }]);
		scriptFor("Continue session", [[text("continued")], [text("continued again")], [text("and again")]]);
		await old.prompt(`Spawn a streaming child ${tag}`);
		await until(() => seat.session() !== old, 8000);
		const fresh = seat.session();
		const freshId = fresh.sessionId;
		const freshRequests = () => requests.filter((r) => r.sessionId === freshId);
		await until(() => said.some((m) => m.includes("already processing")) || freshRequests().some((r) => userTexts(r).some((t) => t.startsWith("Continue session"))), 8000);
		(await live.attached).end();
		await until(() => seat.events.some((e) => (e.channel === "subagents:completed" || e.channel === "subagents:failed") && e.name === worker), 8000);
		await until(() => freshRequests().some((r) => JSON.stringify(r.messages).includes(`child ${tag} done`)), 3000);
		await fresh.waitForIdle();
		// Joel's cache break showed on the first real user turn after the rogue one.
		scriptFor(`the next real turn ${tag}`, [[text("ok")]]);
		await fresh.prompt(`the next real turn ${tag}`);
		release();

		const record = entriesOf(fresh.sessionFile).filter((e) => e.customType === "agent-record" && e.data?.name === worker).at(-1)?.data;
		const delivered = freshRequests().some((r) => JSON.stringify(r.messages).includes(`child ${tag} done`));
		check(`(a) the child completes and its result reaches the new session — not "extension ctx is stale"`, record?.status === "completed" && record.result === `child ${tag} done` && delivered, `${record?.status}: ${(record?.error ?? record?.result ?? "").slice(0, 120)}; delivered ${delivered}`);
		if (stale.length > 0) console.log(`       stale-ctx throw ×${stale.length}, first at:\n${stale[0].split("\n").slice(2, 9).map((l) => `         ${l.trim()}`).join("\n")}`);
		const first = freshRequests()[0];
		const firstUser = first === undefined ? [] : userTexts(first);
		check("(b) the new session's first request carries the continuation's first message", firstUser.some((t) => t.startsWith("Continue session `") && t.includes(DOC)), first === undefined ? "no request in the new session" : `roles ${conversationOf(first).map((m) => m.role).join(",")}; users ${JSON.stringify(firstUser.map((t) => t.slice(0, 60)))}`);
		const unavailable = freshRequests().filter((r) => r.wireSystem?.some((b) => b.text === PROMPT_UNAVAILABLE));
		const uncaptured = said.filter((m) => m.includes("no prompt options were captured"));
		check("(b) no request in the new session goes out PROMPT_UNAVAILABLE, no uncaptured-options notice", unavailable.length === 0 && uncaptured.length === 0, `${unavailable.length} of ${freshRequests().length} requests PROMPT_UNAVAILABLE; ${uncaptured.length} notices`);
		const refused = said.filter((m) => m.includes("already processing"));
		check("(c) the continuation's first message is not refused as already processing", refused.length === 0, refused[0]?.slice(0, 160));
		const lastOld = requests.filter((r) => r.sessionId === oldId).at(-1);
		const prefixed = [lastOld, ...freshRequests()].filter(Boolean);
		const toolsOf = (r) => JSON.stringify(r.wireTools);
		const promptOf = (r) => r.wireSystem?.[0]?.text;
		const toolDrift = prefixed.slice(1).filter((r) => toolsOf(r) !== toolsOf(prefixed[0])).map((r) => r.wireTools.map((t, k) => (JSON.stringify(t) === JSON.stringify(prefixed[0].wireTools[k]) ? undefined : `tools[${k}] ${t.name}`)).filter(Boolean).join(",") || `${r.wireTools.length} vs ${prefixed[0].wireTools.length} tools`);
		check("(d) the old session's last request and every new-session request carry the same tools, after wire's cut and order", prefixed.length >= 2 && toolDrift.length === 0, `${prefixed.length} requests, tools ${prefixed[0]?.wireTools?.map((t) => t.name).join(",")}; differ: ${[...new Set(toolDrift)].join(" | ")}`);
		const promptDrift = prefixed.filter((r) => promptOf(r) !== promptOf(prefixed[0])).length;
		check("(d) and the same owned system prompt", prefixed.length >= 2 && promptDrift === 0, `${promptDrift} of ${prefixed.length} requests differ`);
		// A refused offer used to append a mark and a restore, so the file said the result was unread twice.
		const verdicts = entriesOf(fresh.sessionFile).filter((e) => e.customType === "agent-record" && e.data?.name === worker && e.data.status === "completed" && e.data.readBy === undefined).length;
		const landed = conversationOf(freshRequests().at(-1) ?? { messages: [] }).filter((m) => JSON.stringify(m).includes(`child ${tag} done`)).length;
		check("(e) its verdict is written once in the new file and lands once in the conversation", verdicts === 1 && landed === 1, `${verdicts} unread completed records, ${landed} messages carry it`);
		fresh.dispose();
	}
}

// ---------------------------------------------------------------------------
// The turn seam: a custom message that starts a turn skips `before_agent_start`,
// so every turn the harness starts on its own goes through the session scope,
// which refuses until this runtime's first user turn and once shutdown begins.
const wireExtensions = ["agent-engine", "continue-session", "wire"].map((name) => `${ROOT}/extensions/${name}.ts`);
const wireSeatProvider = (pi) => pi.registerProvider("scripted-wire", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "anthropic-messages", streamSimple, models: [{ ...SCRIPTED_MODEL, id: "scripted-wire-1" }] });
const wireSeat = (options = {}) => mainSeat({ extensions: wireExtensions, provider: wireSeatProvider, model: ["scripted-wire", "scripted-wire-1"], ...options });
const userTextsOf = (request) => conversationOf(request).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));

console.log("\na result that settles before the continuation's message starts no turn and rides that message's turn");
{
	const { PROMPT_UNAVAILABLE } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	let freshId;
	let settledBeforeContinuation = false;
	const seat = await wireSeat({
		// The new session has started and re-hosted the runtime; `withSession` has not sent the continuation yet.
		onStart: async (ctx) => {
			freshId = ctx.sessionManager.getSessionId();
			(await attached).end();
			settledBeforeContinuation = await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "early-settler"), 5000);
		},
	});
	const old = seat.session();
	scriptFor("Spawn the early settler", [[call("Agent", { description: "settles early", prompt: "early settler works", name: "early-settler" })], [text(DOC)]]);
	scriptFor("early settler works", [{ content: [text("early settler done")], live: { attach } }]);
	scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
	await old.prompt("Spawn the early settler");
	await until(() => seat.session() !== old, 8000);
	const fresh = seat.session();
	await until(() => requests.some((r) => r.sessionId === freshId), 5000);
	await fresh.waitForIdle();
	const freshRequests = requests.filter((r) => r.sessionId === freshId);
	const first = freshRequests[0];
	check("the child settled in the new session before its continuation was sent", settledBeforeContinuation);
	check("no turn started for it: the new session's first request is the continuation's", first !== undefined && userTextsOf(first).some((t) => t.startsWith("Continue session `")), first === undefined ? "no request" : JSON.stringify(userTextsOf(first).map((t) => t.slice(0, 50))));
	check("and that request carries the result", first !== undefined && JSON.stringify(first.messages).includes("early settler done"));
	check("the new session made exactly the continuation's request", freshRequests.length === 1, `${freshRequests.length} requests`);
	check("none of them went out PROMPT_UNAVAILABLE", freshRequests.every((r) => !r.wireSystem?.some((b) => b.text === PROMPT_UNAVAILABLE)));
	fresh.dispose();
}

console.log("\n/handoff as the first turn after a resume");
{
	const { PROMPT_UNAVAILABLE } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const { declareSeatWorkflows } = await jiti.import(`${ROOT}/lib/seat.ts`);
	const first = await wireSeat();
	scriptFor("an earlier session", [[text("hello")], [text("not written yet")]]);
	await first.session().prompt("an earlier session");
	const file = first.session().sessionFile;
	const id = first.session().sessionId;
	// Quit: wire forgets the capture, as a fresh process has none.
	await first.runtime.dispose();
	declareSeatWorkflows(id, true);
	const seat = await wireSeat({ sessionManager: SessionManager.open(file) });
	const resumed = seat.session();
	const before = requests.length;
	await resumed.prompt("/handoff");
	await until(() => requests.length > before, 5000);
	await resumed.waitForIdle();
	const request = requests.slice(before)[0];
	const agentTool = request?.wireTools?.find((tool) => tool.name === "Agent");
	check("the /handoff turn is a request of the resumed session", request?.sessionId === id);
	check("it goes out with wire's owned prompt, not PROMPT_UNAVAILABLE", request !== undefined && request.wireSystem?.length > 0 && !request.wireSystem.some((b) => b.text === PROMPT_UNAVAILABLE), JSON.stringify(request?.wireSystem?.map((b) => b.text.slice(0, 40))));
	check("and with the workflow seat's Agent description", agentTool?.description?.includes("a `Workflow`;") === true, agentTool?.description?.slice(0, 120));
	check("the gate's words arrive as the user's message", request !== undefined && userTextsOf(request).some((t) => t.startsWith("[handoff]")));
	declareSeatWorkflows(id, false);
	await seat.runtime.dispose();
}

// Between accepting a user prompt and starting its run, pi reads as idle
// (`isStreaming` is false through `_checkCompaction` and the
// `before_agent_start` handlers). A result that started its own turn there took
// the run, and the user's prompt threw "Agent is already processing a prompt".
console.log("\na result that settles while a user prompt is starting");
for (const moment of ["input", "before_agent_start"]) {
	console.log(`  -- during ${moment}`);
	const tag = `window-${moment}`;
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	let armed = false;
	let seat;
	const settle = async () => {
		if (!armed) return;
		armed = false;
		(await attached).end();
		await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === tag), 5000);
	};
	// Loaded after the engine, so its hook runs after the engine's (and its scope's) handlers for the same event.
	const provider = (pi) => {
		scriptedProvider(pi);
		pi.on(moment, async () => { await settle(); return undefined; });
	};
	seat = await mainSeat({ provider });
	const main = seat.session();
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "settles in the window", prompt: `${tag} child works`, name: tag })], [text("spawned")]]);
	scriptFor(`${tag} child works`, [{ content: [text(`${tag} child done`)], live: { attach } }]);
	scriptFor(`the ${tag} turn`, [[text("answered")], [text("answered again")]]);
	await main.prompt(`Spawn the ${tag} child`);
	await main.waitForIdle();
	let starts = 0;
	main.subscribe((event) => { if (event.type === "agent_start") starts++; });
	const before = requests.length;
	armed = true;
	let refused;
	try { await main.prompt(`the ${tag} turn`); } catch (error) { refused = error; }
	await main.waitForIdle();
	const turn = requests.slice(before).filter((r) => r.sessionId === main.sessionId);
	check(`${moment}: the user's prompt is not refused as already processing`, refused === undefined, refused?.message);
	check(`${moment}: one run, the user's`, starts === 1 && turn.length > 0 && userTextsOf(turn[0]).some((t) => t === `the ${tag} turn`), `${starts} runs; first request users ${JSON.stringify(turn[0] && userTextsOf(turn[0]))}`);
	check(`${moment}: the result arrives in that run`, turn.some((r) => JSON.stringify(r.messages).includes(`${tag} child done`)), `${turn.length} requests`);
	main.dispose();
}

console.log("\nno turn starts during shutdown");
{
	process.env.PI_KIT_BACKGROUND_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "continue-session-background-"));
	// Stands in for a shutdown handler that awaits (the engine's retire will), registered between two scoped extensions.
	const slow = path.join(AGENT_DIR, "slow-shutdown.ts");
	fs.writeFileSync(slow, "export default function (pi) { pi.on(\"session_shutdown\", async () => { await globalThis.__slowShutdown?.(); }); }\n");
	const seat = await mainSeat({ extensions: [`${ROOT}/extensions/agent-engine.ts`, slow, `${ROOT}/extensions/bash.ts`] });
	const main = seat.session();
	scriptFor("Start a background sleep", [[call("bash", { command: "sleep 0.4; echo slept", run_in_background: true })], [text("started")], [text("a turn during shutdown")]]);
	await main.prompt("Start a background sleep");
	await main.waitForIdle();
	const before = requests.length;
	let turns = 0;
	main.subscribe((event) => { if (event.type === "agent_start") turns++; });
	globalThis.__slowShutdown = () => sleep(1200);
	await seat.runtime.dispose();
	delete globalThis.__slowShutdown;
	check("a background command that ends while shutdown runs starts no turn", turns === 0 && requests.length === before, `${turns} turns, ${requests.length - before} requests`);
	fs.rmSync(process.env.PI_KIT_BACKGROUND_DIR, { recursive: true, force: true });
	delete process.env.PI_KIT_BACKGROUND_DIR;
}

// The outgoing session is idle at `session_before_switch`: a result that settled
// there started a turn in the outgoing session, which pi's teardown then
// aborted, and the successor never got it.
console.log("\na result that settles inside an awaiting session_before_switch reaches the successor, not the outgoing session");
{
	const tag = "mid-switch";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	let seat;
	// Stands in for an extension whose `session_before_switch` awaits (a confirm dialog); the child settles inside it.
	const provider = (pi) => {
		scriptedProvider(pi);
		pi.on("session_before_switch", async () => {
			(await attached).end();
			await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === tag), 5000);
			for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
			return undefined;
		});
	};
	seat = await mainSeat({ provider });
	const old = seat.session();
	const oldId = old.sessionId;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "settles mid-switch", prompt: `${tag} child works`, name: tag })], [text(DOC)], [text("answered in the old session")]]);
	scriptFor(`${tag} child works`, [{ content: [text(`${tag} child done`)], live: { attach } }]);
	scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
	const before = requests.length;
	await old.prompt(`Spawn the ${tag} child`);
	await until(() => seat.session() !== old, 8000);
	const fresh = seat.session();
	await until(() => requests.some((r) => r.sessionId === fresh.sessionId), 5000);
	await fresh.waitForIdle();
	const carries = (r) => JSON.stringify(r.messages).includes(`${tag} child done`);
	const inOld = requests.slice(before).filter((r) => r.sessionId === oldId && carries(r)).length;
	const inFresh = requests.filter((r) => r.sessionId === fresh.sessionId && carries(r));
	check("the outgoing session starts no turn for it", inOld === 0, `${inOld} old-session requests carry it`);
	check("the successor gets it once, in the continuation's turn", inFresh.length > 0 && userTextsOf(inFresh[0]).some((t) => t.startsWith("Continue session `")) && conversationOf(inFresh.at(-1)).filter((m) => JSON.stringify(m).includes(`${tag} child done`)).length === 1, `${inFresh.length} fresh requests carry it`);
	fresh.dispose();
}

// An `agent_settled` handler that awaits, loaded after continue-session: pi
// defers a turn started during that emission (`_deferredSettledActions`) and
// runs it after the handoff command it deferred first, in the outgoing session,
// so the result was answered there and delivered again in the successor.
console.log("\na result that settles inside a later agent_settled handler after the document is answered once, in the successor");
{
	const tag = "mid-settle";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	let seat;
	let armed = true;
	const provider = (pi) => {
		scriptedProvider(pi);
		pi.on("agent_settled", async () => {
			if (!armed || seat === undefined) return;
			armed = false;
			(await attached).end();
			await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === tag), 5000);
			for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
		});
	};
	seat = await mainSeat({ provider });
	const old = seat.session();
	const oldId = old.sessionId;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "settles mid-settle", prompt: `${tag} child works`, name: tag })], [text(DOC)], [text("answered in the old session")]]);
	scriptFor(`${tag} child works`, [{ content: [text(`${tag} child done`)], live: { attach } }]);
	scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
	const before = requests.length;
	await old.prompt(`Spawn the ${tag} child`);
	await until(() => seat.session() !== old, 8000);
	const fresh = seat.session();
	await until(() => requests.some((r) => r.sessionId === fresh.sessionId), 5000);
	await fresh.waitForIdle();
	const carries = (r) => JSON.stringify(r.messages).includes(`${tag} child done`);
	const inOld = requests.slice(before).filter((r) => r.sessionId === oldId && carries(r)).length;
	const inFresh = requests.filter((r) => r.sessionId === fresh.sessionId && carries(r));
	check("the outgoing session starts no turn for it", inOld === 0, `${inOld} old-session requests carry it`);
	check("the successor gets it once, in the continuation's turn", inFresh.length > 0 && userTextsOf(inFresh[0]).some((t) => t.startsWith("Continue session `")) && conversationOf(inFresh.at(-1)).filter((m) => JSON.stringify(m).includes(`${tag} child done`)).length === 1, `${inFresh.length} fresh requests carry it`);
	fresh.dispose();
}

// A result handed to a run in flight as a follow-up is `handed` in its record
// until a turn start sees its notification in the file. The successor's file
// has no notification, so its first turn took the result as never delivered.
console.log("\na result answered in the old session before the document is not delivered again in the successor");
{
	const tag = "handed-mid-run";
	let attachChild;
	let attachParent;
	const childLive = new Promise((resolve) => { attachChild = resolve; });
	const parentLive = new Promise((resolve) => { attachParent = resolve; });
	const seat = await mainSeat();
	const old = seat.session();
	const oldId = old.sessionId;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "handed mid run", prompt: `${tag} child works`, name: tag })], { content: [text("parent keeps working")], live: { attach: attachParent } }, [text(DOC)]]);
	scriptFor(`${tag} child works`, [{ content: [text(`${tag} child done`)], live: { attach: attachChild } }]);
	scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
	const before = requests.length;
	const running = old.prompt(`Spawn the ${tag} child`);
	const parent = await parentLive;
	(await childLive).end();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === tag), 5000);
	await sleep(50);
	parent.end();
	await running;
	await until(() => seat.session() !== old, 8000);
	const fresh = seat.session();
	await until(() => requests.some((r) => r.sessionId === fresh.sessionId), 5000);
	await fresh.waitForIdle();
	const carries = (r) => JSON.stringify(r.messages).includes(`${tag} child done`);
	const inOld = requests.slice(before).filter((r) => r.sessionId === oldId && carries(r)).length;
	const inFresh = requests.filter((r) => r.sessionId === fresh.sessionId && carries(r)).length;
	check("the old session answered it before its document", inOld > 0, `${inOld} old-session requests carry it`);
	check("the successor does not get it again", inFresh === 0, `${inOld} old, ${inFresh} fresh`);
	const readBys = entriesOf(fresh.sessionFile).filter((e) => e.customType === "agent-record" && e.data?.name === tag && e.data.status === "completed").map((e) => e.data.readBy ?? "unread");
	check("and the records the handoff carried say the conversation read it, never handed", readBys.at(-1) === "conversation" && !readBys.includes("handed"), readBys.join(","));
	fresh.dispose();
}

console.log("\na notification entry the file holds malformed is read as no result");
{
	const { AGENT_NOTIFICATION_TYPE, deliveredAgentTaskIds } = await jiti.import(`${ROOT}/lib/agent-notification.ts`);
	const entry = (content) => ({ type: "custom_message", customType: AGENT_NOTIFICATION_TYPE, content });
	let ids;
	try {
		ids = [...deliveredAgentTaskIds([entry([null, 7, { type: "text", text: 3 }, { type: "text", text: "<task-id>kept</task-id>" }])])];
	} catch (error) {
		ids = [`threw: ${error.message}`];
	}
	check("a null, a number or a non-string text block is skipped; a text block still counts", ids.join() === "kept", ids.join());
}

// The document is written at a turn end; a result queued behind that turn runs
// as the next one, and pi files its notification before the request. That
// request killed by Esc answered nothing, so the successor must still get it.
console.log("\na result whose turn after the document is aborted is delivered in the successor");
{
	const tag = "after-doc-aborted";
	let attachChild;
	let attachParent;
	let attachFollow;
	const childLive = new Promise((resolve) => { attachChild = resolve; });
	const parentLive = new Promise((resolve) => { attachParent = resolve; });
	const followLive = new Promise((resolve) => { attachFollow = resolve; });
	const seat = await mainSeat();
	const old = seat.session();
	const oldId = old.sessionId;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "settles behind the document", prompt: `${tag} child works`, name: tag })], { content: [text(DOC)], live: { attach: attachParent } }, { content: [text("never finished")], live: { attach: attachFollow } }]);
	scriptFor(`${tag} child works`, [{ content: [text(`${tag} child done`)], live: { attach: attachChild } }]);
	scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
	const running = old.prompt(`Spawn the ${tag} child`);
	const parent = await parentLive;
	(await childLive).end();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === tag), 5000);
	await sleep(50);
	parent.end();
	await followLive;
	const filed = entriesOf(old.sessionFile).some((e) => e.type === "custom_message" && JSON.stringify(e.content ?? "").includes(`${tag} child done`));
	await old.abort();
	await running;
	await until(() => seat.session() !== old, 8000);
	const fresh = seat.session();
	await until(() => requests.some((r) => r.sessionId === fresh.sessionId), 5000);
	await fresh.waitForIdle();
	const inFresh = requests.filter((r) => r.sessionId === fresh.sessionId && JSON.stringify(r.messages).includes(`${tag} child done`)).length;
	check("its notification was filed in the old session before the aborted request", filed, String(filed));
	check("the successor gets it", inFresh > 0, `${inFresh} fresh requests carry it (old ${oldId})`);
	fresh.dispose();
}

// ---------------------------------------------------------------------------
// Retire: a shutdown nothing follows stops the runs while the seat can still
// write, so the file says `stopped` with the final cost and the worktree
// outcome instead of a `running` the fold later reads as `lost`.
// ---------------------------------------------------------------------------
const { liveAgentCount: liveCount } = await jiti.import(`${ROOT}/lib/agent-live-count.ts`);
const { PARK_DEADLINE_MS, parkAgentRuntime } = await jiti.import(`${ROOT}/lib/agent-runtime-handover.ts`);
const lastRecordOf = (file, name) => entriesOf(file).filter((e) => e.customType === "agent-record" && e.data?.name === name).at(-1)?.data;
/** A throwaway repository, so a worktree child's branch and directory never touch the kit's own. */
function tempRepo() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "continue-session-repo-"));
	const git = (...args) => execSync(`git ${args.join(" ")}`, { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	fs.writeFileSync(path.join(repo, "notes.txt"), "notes\n");
	git("add", "notes.txt");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return repo;
}

console.log("\nquit and /new stop a live worktree child: stopped, final cost, worktree settled");
for (const via of ["quit", "new"]) {
	console.log(`  -- via ${via}`);
	const tag = `retire-${via}`;
	const repo = tempRepo();
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	const seat = await mainSeat({ cwd: repo });
	const main = seat.session();
	const file = main.sessionFile;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "works in a worktree", prompt: `${tag} child works`, name: tag, isolation: "worktree" })], [text("spawned")]]);
	scriptFor(`${tag} child works`, [[call("read", { path: "notes.txt" })], { content: [text("never finished")], live: { attach } }]);
	await main.prompt(`Spawn the ${tag} child`);
	await Promise.race([attached, sleep(8000)]);
	const worktree = lastRecordOf(file, tag)?.cwd;
	if (via === "quit") await seat.runtime.dispose();
	else await seat.runtime.newSession({});
	const record = lastRecordOf(file, tag);
	check(`${via}: the child's last record in the old file reads stopped, by shutdown`, record?.status === "stopped" && record.stoppedBy === "shutdown", `${record?.status} by ${record?.stoppedBy}`);
	check(`${via}: with its final cost`, record?.costUsd > 0, String(record?.costUsd));
	check(`${via}: and its worktree settled: removed, and the result says so`, worktree !== undefined && worktree !== repo && !fs.existsSync(worktree) && /Worktree on branch `agent\/[^`]+` had no changes and was removed\./.test(record?.result ?? ""), `${worktree} exists ${worktree !== undefined && fs.existsSync(worktree)}; result ${JSON.stringify(record?.result)}`);
	check(`${via}: nothing of it is live afterwards`, await until(() => liveCount() === 0, 3000), String(liveCount()));
	if (via === "new") seat.session().dispose();
	fs.rmSync(repo, { recursive: true, force: true });
}

console.log("\na child that ignores abort is cut off at the bound");
{
	const tag = "deaf-child";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	const seat = await mainSeat();
	const main = seat.session();
	const file = main.sessionFile;
	const runtime = seam.agentRuntimeOf(main.sessionId);
	scriptFor(`Spawn the ${tag}`, [[call("Agent", { description: "ignores abort", prompt: `${tag} works`, name: tag })], [text("spawned")]]);
	scriptFor(`${tag} works`, [{ content: [text("late words")], live: { attach }, ignoreAbort: true }]);
	await main.prompt(`Spawn the ${tag}`);
	const controls = await Promise.race([attached, sleep(8000)]);
	const started = Date.now();
	const quit = await Promise.race([seat.runtime.dispose().then(() => "returned"), sleep(6000).then(() => "hung")]);
	const took = Date.now() - started;
	const record = lastRecordOf(file, tag);
	check("quit returns at the bound, not never", quit === "returned" && took >= 1500 && took < 4000, `${quit} after ${took}ms`);
	check("stopped is written for the straggler", record?.status === "stopped" && record.stoppedBy === "shutdown", `${record?.status} by ${record?.stoppedBy}`);
	let refusal = "";
	try { runtime?.host.model(); } catch (error) { refusal = error.message; }
	check("and the link is retired", /is retired/.test(refusal), refusal);
	const bytes = fs.readFileSync(file);
	controls?.end();
	await until(() => liveCount() === 0, 3000);
	await sleep(100);
	check("the straggler's own late settle writes nothing", fs.readFileSync(file).equals(bytes));
}

console.log("\nthe unclaimed handover deadline writes nothing");
{
	const tag = "unclaimed-child";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	const seat = await mainSeat();
	const main = seat.session();
	const file = main.sessionFile;
	const runtime = seam.agentRuntimeOf(main.sessionId);
	scriptFor(`Spawn the ${tag}`, [[call("Agent", { description: "parked, never claimed", prompt: `${tag} works`, name: tag })], [text("spawned")]]);
	scriptFor(`${tag} works`, [{ content: [text("never read")], live: { attach } }]);
	await main.prompt(`Spawn the ${tag}`);
	await Promise.race([attached, sleep(8000)]);
	const bytes = fs.readFileSync(file);
	const eventsBefore = seat.events.length;
	// The deadline's own timer, fired now rather than slept through.
	const realSetTimeout = globalThis.setTimeout;
	let deadline;
	globalThis.setTimeout = (fn, ms, ...rest) => (ms === PARK_DEADLINE_MS ? ((deadline = fn), realSetTimeout(() => {}, 0)) : realSetTimeout(fn, ms, ...rest));
	try { parkAgentRuntime(path.join(AGENT_DIR, "never-opened.jsonl"), runtime); } finally { globalThis.setTimeout = realSetTimeout; }
	deadline?.();
	const stopped = await until(() => liveCount() === 0, 5000);
	await sleep(200);
	check("the deadline stopped the child", deadline !== undefined && stopped, `deadline ${deadline !== undefined}, ${liveCount()} live`);
	check("and wrote nothing: the session file is byte-unchanged", fs.readFileSync(file).equals(bytes), `${bytes.length} -> ${fs.statSync(file).size} bytes`);
	check("and told the dock nothing", seat.events.length === eventsBefore, seat.events.slice(eventsBefore).map((e) => e.channel).join(","));
	main.dispose();
}

console.log("\na workflow's child is carried across a handoff like any run");
{
	const tag = "wf-carried";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	const seat = await mainSeat();
	const old = seat.session();
	scriptFor(`Hand off with a ${tag} child`, [[text(DOC)]]);
	scriptFor(`${tag} works`, [{ content: [text(`${tag} done`)], live: { attach } }]);
	scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
	// Spawned the way the `Workflow` tool spawns: through the published runtime, as a workflow child.
	const record = await seam.agentRuntimeOf(old.sessionId).spawn({ description: "a workflow's agent", prompt: `${tag} works`, name: tag, workflowChild: true });
	const controls = await Promise.race([attached, sleep(8000)]);
	await old.prompt(`Hand off with a ${tag} child`);
	await until(() => seat.session() !== old, 8000);
	const fresh = seat.session();
	await fresh.waitForIdle();
	const runtime = seam.agentRuntimeOf(fresh.sessionId);
	check("the new session's runtime holds it, still running", runtime?.registry.byTaskId(record.taskId)?.status === "running" && runtime.liveTaskIds().includes(record.taskId), `${runtime?.registry.byTaskId(record.taskId)?.status}`);
	controls?.end();
	const settled = await until(() => lastRecordOf(fresh.sessionFile, tag)?.status === "completed", 5000);
	const final = lastRecordOf(fresh.sessionFile, tag);
	check("it completes in the new session, its result the spawner's", settled && final.result === `${tag} done` && final.readBy === "spawner" && final.ownerSessionId === fresh.sessionId, JSON.stringify(final && { status: final.status, readBy: final.readBy }));
	check("and it never enters the new session's conversation", !requests.filter((r) => r.sessionId === fresh.sessionId).some((r) => JSON.stringify(r.messages).includes(`${tag} done`)));
	fresh.dispose();
}

// ---------------------------------------------------------------------------
// Every timer, reply and long await of an extension lives on its session
// scope, so nothing a runtime started reaches pi after its session ends.
// ---------------------------------------------------------------------------
const { claimScreen: claimNoticeScreen, noticeSinkDir } = await jiti.import(`${ROOT}/lib/notice.ts`);
const STALE = "extension ctx is stale";
/** A scripted stream the test ends by hand; `attached` resolves with its controls once the provider streams it. */
const liveStreamOf = () => {
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	return { attached, attach };
};
/**
 * Records the stack of every call into a stale runtime, including the ones an
 * extension swallows: every runner bound while it is installed, a child's too.
 * Returns the uninstall.
 */
const traceStaleCalls = (sink) => {
	const bindCore = ExtensionRunner.prototype.bindCore;
	ExtensionRunner.prototype.bindCore = function (...args) {
		for (const target of [this, this.runtime]) {
			const assert = target.assertActive.bind(target);
			target.assertActive = () => {
				try { assert(); } catch (error) { sink.push(new Error("stale").stack); throw error; }
			};
		}
		return bindCore.apply(this, args);
	};
	return () => { ExtensionRunner.prototype.bindCore = bindCore; };
};
/** Everything a stale call could leave behind: its stack, a throw, stderr, a notice, a session or notice file. */
async function watchForStale(body) {
	const seen = { calls: [], thrown: [], stderr: [], said: [] };
	const onThrow = (error) => seen.thrown.push(String(error?.stack ?? error));
	process.on("uncaughtException", onThrow);
	process.on("unhandledRejection", onThrow);
	const write = process.stderr.write;
	process.stderr.write = function (chunk, ...rest) { seen.stderr.push(String(chunk)); return write.call(this, chunk, ...rest); };
	const release = claimNoticeScreen((message) => seen.said.push(message));
	const untrace = traceStaleCalls(seen.calls);
	try {
		await body();
	} finally {
		untrace();
		release();
		process.stderr.write = write;
		process.off("uncaughtException", onThrow);
		process.off("unhandledRejection", onThrow);
	}
	const files = [process.env.PI_CODING_AGENT_SESSION_DIR, noticeSinkDir()].flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, name)) : []));
	const staleFiles = files.filter((file) => fs.statSync(file).isFile() && fs.readFileSync(file, "utf8").includes(STALE));
	const lines = [...seen.thrown, ...seen.stderr, ...seen.said].filter((line) => line.includes(STALE));
	return { calls: seen.calls, lines, staleFiles };
}
const staleReport = ({ calls, lines, staleFiles }) => `${calls.length} stale calls${calls[0] ? `, first at:\n${calls[0].split("\n").slice(2, 8).map((l) => `         ${l.trim()}`).join("\n")}` : ""}; ${lines.length} lines (${lines[0]?.split("\n")[0]?.slice(0, 120) ?? ""}); files ${staleFiles.join(", ")}`;

console.log("\nno extension ctx is stale across /new, a handoff, reload and quit with work in flight");
{
	process.env.PI_KIT_BACKGROUND_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "continue-session-background-"));
	// The watchdog's warning is the pending timer: armed by the seat's own run, due after the switch.
	process.env.PI_WATCHDOG_MS = "1500";
	process.env.PI_WATCHDOG_MODE = "warn";
	const extensions = ["agent-engine", "continue-session", "wire", "bash", "watchdog", "session-mode", "btw", "workflow", "agent-dock/index", "zen-chrome/index"].map((name) => `${ROOT}/extensions/${name}.ts`);
	for (const via of ["new", "handoff", "reload", "quit", "quit as the handoff document lands"]) {
		const tag = `stale-${via.replaceAll(" ", "-")}`;
		const child = liveStreamOf();
		const own = liveStreamOf();
		const found = await watchForStale(async () => {
			const seat = await wireSeat({ extensions });
			const old = seat.session();
			const handsOff = via === "handoff" || via.startsWith("quit as");
			const ownLive = !handsOff;
			scriptFor(`Start the ${tag} work`, [[call("Agent", { description: "streams", prompt: `${tag} child streams`, name: tag }), call("bash", { command: "sleep 0.4; echo slept", run_in_background: true })], handsOff ? [text(DOC)] : { content: [text("still streaming")], live: own }]);
			scriptFor(`${tag} child streams`, [{ content: [text(`${tag} child done`)], live: child }]);
			scriptFor("Continue session", [[text("continued")], [text("continued again")]]);
			const prompted = old.prompt(`Start the ${tag} work`);
			await child.attached;
			if (ownLive) await own.attached;
			else await prompted;
			if (via === "new") await seat.runtime.newSession({});
			else if (via === "handoff") await until(() => seat.session() !== old, 8000);
			else if (via === "reload") await old.reload();
			else await seat.runtime.dispose();
			(await child.attached).end();
			if (ownLive) (await own.attached).end();
			await prompted.catch(() => {});
			// Past the background command, the watchdog's warning and a macrotask of slack.
			await sleep(1800);
			if (!via.startsWith("quit")) await seat.runtime.dispose();
		});
		check(`${via}: nothing reaches a stale runtime`, found.calls.length === 0 && found.lines.length === 0 && found.staleFiles.length === 0, staleReport(found));
	}
	delete process.env.PI_WATCHDOG_MS;
	delete process.env.PI_WATCHDOG_MODE;
	fs.rmSync(process.env.PI_KIT_BACKGROUND_DIR, { recursive: true, force: true });
	delete process.env.PI_KIT_BACKGROUND_DIR;
}

console.log("\na quit mid-compaction");
{
	const summary = liveStreamOf();
	const seat = await mainSeat();
	const session = seat.session();
	// Two turns past pi's 20k-token keep-recent window, so the first has something to summarise.
	const filler = "words ".repeat(20_000);
	scriptFor("compact-me", [[text("noted")], { content: [text("the summary")], live: summary }]);
	scriptFor("more", [[text("noted too")]]);
	await session.prompt(`compact-me ${filler}`);
	await session.prompt(`more ${filler}`);
	const compacting = session.compact().catch(() => {});
	await summary.attached;
	const startedAt = Date.now();
	await seat.runtime.dispose();
	const took = Date.now() - startedAt;
	await compacting;
	// No run settles a compaction: waiting for one held quit for the whole settle bound.
	check("waits for the compaction's end, not the settle bound", took < 1000, `${took}ms`);
}

console.log("\nthe dock's stop reply after quit");
{
	const tag = "stop-after-quit";
	const child = liveStreamOf();
	let bus;
	const found = await watchForStale(async () => {
		const seat = await mainSeat({ provider: (pi) => { scriptedProvider(pi); bus = pi.events; } });
		const main = seat.session();
		scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "ignores abort", prompt: `${tag} works`, name: tag })], [text("spawned")]]);
		scriptFor(`${tag} works`, [{ content: [text("late words")], live: child, ignoreAbort: true }]);
		await main.prompt(`Spawn the ${tag} child`);
		const controls = await child.attached;
		// The stop is still waiting on a child that ignores its abort when quit invalidates the seat.
		bus.emit("subagents:rpc:stop", { requestId: tag, agentId: tag });
		await seat.runtime.dispose();
		controls.end();
		await until(() => liveCount() === 0, 3000);
		await sleep(100);
	});
	check("a stop that resolves after quit replies to no one", found.calls.length === 0 && found.lines.length === 0, staleReport(found));
}

trailer();
