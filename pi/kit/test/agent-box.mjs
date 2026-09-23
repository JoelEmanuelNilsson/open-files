/**
 * The agent box: one subagent's conversation drawn the way the main transcript
 * draws it, live, in a bordered box with a prompt line.
 *
 * Three things are worth pinning. **The rows are the kit's receipts**, built
 * through pi's real `ToolExecutionComponent` from a session's messages and
 * events, so the box cannot drift from the main screen. **A subagent's rows
 * are off the transcript**: the main run settling must not hollow them out,
 * which is the cross-talk the planner's process-wide map invites. And **the
 * frame is the whole difference** between a window and a crash: every row is
 * framed, the width is exact, and the prompt line only exists when there is an
 * agent to talk to.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const { visibleWidth } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/utils.js`);
const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const feedModule = await jiti.import(`${ROOT}/extensions/agent-dock/agent-conversation-feed.ts`);
const boxModule = await jiti.import(`${ROOT}/extensions/agent-dock/agent-conversation-box.ts`);
const receiptModule = await jiti.import(`${ROOT}/extensions/transcript/receipt.ts`);
const rowModule = await jiti.import(`${ROOT}/extensions/transcript/row.ts`);
const plannerModule = await jiti.import(`${ROOT}/extensions/transcript/planner-state.ts`);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${label}`); return; }
	fail++;
	console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
};
const eq = (label, actual, expected) =>
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const bare = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const ui = { requestRender: () => { ui.renders++; }, renders: 0 };
const theme = themeModule.theme;

/** A fake pi session: messages, a subscribe that hands back an emitter, the kit's read receipt. */
function fakeSession(messages) {
	const listeners = new Set();
	return {
		messages,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (event) => { for (const listener of listeners) listener(event); },
		getToolDefinition: (name) => (name === "read" ? { name, ...receiptModule.receipt("read") } : undefined),
	};
}

const readCall = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const readResult = (id, lines) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") }],
	isError: false,
});

// ---------------------------------------------------------------------------
console.log("agent-box: history becomes the kit's rows");
{
	const { AgentConversationFeed } = feedModule;
	const session = fakeSession([
		{ role: "user", content: "audit the wire" },
		{ role: "assistant", content: [{ type: "text", text: "Reading it." }, readCall("c1", "lib/wire.ts")], stopReason: "toolUse" },
		readResult("c1", 3),
	]);
	const feed = new AgentConversationFeed(session, ui, process.cwd());
	const text = feed.render(80).map(bare).join("\n");
	check("the user's prompt is there", text.includes("audit the wire"));
	check("the assistant's prose is there", text.includes("Reading it."));
	check("the tool call is a receipt header", /● Read\(lib\/wire\.ts\)/.test(text), text);
	check("its result is the receipt's count, not a dump", /⎿\s+Read 3 lines/.test(text) && !text.includes("line 2"), text);
	eq("three components, one per message with content", feed.size, 3);
	feed.dispose();
}

// ---------------------------------------------------------------------------
console.log("\nagent-box: the stream continues it, off the transcript");
{
	const { AgentConversationFeed } = feedModule;
	const session = fakeSession([{ role: "user", content: "go" }]);
	const feed = new AgentConversationFeed(session, ui, process.cwd());
	const inFlight = plannerModule.transcriptPlannerState().inFlight;
	inFlight.clear();

	const streaming = { role: "assistant", content: [{ type: "text", text: "On it." }], stopReason: "stop" };
	session.emit({ type: "message_start", message: streaming });
	const withCall = { ...streaming, content: [...streaming.content, readCall("c2", "lib/a.ts")] };
	session.emit({ type: "message_update", message: withCall });
	eq("a streamed tool call adds a row", feed.size, 3);
	session.emit({ type: "message_end", message: { ...withCall, stopReason: "toolUse" } });
	session.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "lib/a.ts" } });
	let text = feed.render(80).map(bare).join("\n");
	check("the running row is a receipt header", /● Read\(lib\/a\.ts\)/.test(text), text);
	check("the running row is not registered with the main transcript's in-flight map", !inFlight.has("c2"));

	// The cross-talk this guards: the main run settling hollows out every row it
	// knows to be in flight. This row must not be one it knows.
	rowModule.quiesce();
	session.emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: readResult("c2", 5), isError: false });
	text = feed.render(80).map(bare).join("\n");
	check("the result lands as a count after the main run settled", /Read 5 lines/.test(text), text);
	check("and is not drawn as cut off", !text.includes("○"), text);
	check("every event asked for a repaint", ui.renders >= 5);

	feed.dispose();
	session.emit({ type: "message_start", message: streaming });
	eq("a disposed feed stops listening", feed.size, 3);
}

// ---------------------------------------------------------------------------
console.log("\nagent-box: the box");
{
	const { AgentConversationBox, AGENT_BOX_OVERLAY_OPTIONS, agentBoxMaxRows, wrapAnswer } = boxModule;
	const task = (over) => ({
		id: "a1", type: "worker", description: "audit the wire", status: "running",
		startedAt: 0, settledAt: undefined, durationMs: undefined, toolUses: undefined,
		result: undefined, error: undefined, outcome: undefined, stopRequested: false, ...over,
	});
	check("the box floats in the centre, most of the screen wide", AGENT_BOX_OVERLAY_OPTIONS.overlayOptions.anchor === "center" && AGENT_BOX_OVERLAY_OPTIONS.overlayOptions.width === "90%");
	eq("the row budget is the overlay's share of the terminal", agentBoxMaxRows(40), 32);
	check("a short terminal keeps the chrome and a row", agentBoxMaxRows(4) >= 5);

	const session = fakeSession([
		{ role: "user", content: "audit the wire" },
		{ role: "assistant", content: [readCall("c1", "lib/wire.ts")], stopReason: "toolUse" },
		readResult("c1", 3),
	]);
	const closed = [];
	// What the dock hands the box: the child's live session to read, and one
	// `send` that the engine routes as a prompt or a steer. The box holds no
	// session method that could be the wrong one.
	const sent = [];
	let current = task({ totalTokens: 32_000 });
	const deps = { task: () => current, session: () => session, send: async (text) => { sent.push(text); }, cwd: process.cwd() };
	const make = () => new AgentConversationBox(theme, deps, ui, () => closed.push("closed"), () => 24);

	const box = make();
	const lines = box.render(80);
	const plain = lines.map(bare);
	check("every line is exactly the width", lines.every((line) => visibleWidth(line) === 80), lines.map((l) => visibleWidth(l)).join(","));
	check("the top is a rule with corners naming the agent", plain[0].startsWith("╭") && plain[0].endsWith("╮") && plain[0].includes("Agent(audit the wire)"), plain[0]);
	// The same words as the dock row, from the same function: a running child is
	// said with what it is carrying, never with the word `running` (ticket 53).
	check("the status rides the top rule's right", plain[0].includes("32k context") && !plain[0].includes("running"), plain[0]);
	check("every row between the rules is framed", plain.slice(1, -1).every((line) => /^[│├].*[│┤]$/.test(line)));
	check("the rows inside are the kit's receipts", plain.join("\n").includes("● Read(lib/wire.ts)"));
	check("a live agent has a prompt line", plain.some((line) => line.includes("❯ tell it what to do")));
	check("the bottom rule says how to send and how to leave", /enter send · esc back/.test(plain[plain.length - 1]) && plain[plain.length - 1].startsWith("╰"));
	eq("the box is exactly its budget", lines.length, agentBoxMaxRows(24));

	box.handleInput("s");
	box.handleInput("t");
	box.handleInput("o");
	box.handleInput("p");
	check("typing goes to the prompt line", box.render(80).map(bare).some((line) => /❯ stop/.test(line)));
	box.handleInput("\r");
	eq("enter hands the typed text to the engine's send, never to the session", sent, ["stop"]);
	check("and clears the prompt", box.render(80).map(bare).some((line) => line.includes("tell it what to do")));
	box.handleInput("\r");
	eq("an empty enter sends nothing", sent, ["stop"]);
	box.handleInput("\x1b");
	eq("esc leaves the box", closed, ["closed"]);

	// Follow mode: a long conversation shows its newest rows until you scroll up.
	const long = fakeSession(Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `message ${i + 1}` })));
	const tall = new AgentConversationBox(theme, { ...deps, session: () => long }, ui, () => {}, () => 24);
	let text = tall.render(80).map(bare).join("\n");
	const bodyOf = (view) => view.render(80).map(bare).slice(1, -4).join("\n");
	const followed = bodyOf(tall);
	check("a long conversation opens on its newest row", followed.includes("message 30") && !/message 1 /.test(followed), followed);
	check("it is following", tall.following);
	tall.handleInput("\x1b[A");
	const backOne = bodyOf(tall);
	check("↑ breaks off and scrolls back one row", !tall.following && backOne !== followed && backOne.includes("message 29"), backOne);
	tall.handleInput("\x1b[B");
	check("↓ back to the end re-attaches", bodyOf(tall) === followed && tall.following);
	tall.handleInput("\x1b[5~");
	check("page up goes a page further", !tall.following && !bodyOf(tall).includes("message 30"));
	tall.handleInput("\x1b[F");
	check("end re-attaches", tall.following);
	// The wheel: pi hands it to a focused overlay untouched, so the box reads it.
	tall.handleInput("\x1b[<64;10;5M");
	check("a wheel notch up breaks off, three rows at a time", !tall.following && bodyOf(tall).includes("message 29") && !bodyOf(tall).includes("message 30"));
	tall.handleInput("\x1b[<65;10;5M");
	check("a wheel notch down re-attaches", tall.following);
	tall.handleInput("\x1b[M\x60\x2b\x26");
	check("the X10 encoding is read too", !tall.following);
	tall.handleInput("\x1b[<0;10;5M");
	check("a click is not a wheel", !tall.following && bodyOf(tall) === bodyOf(tall));
	tall.handleInput("\x1b[F");
	tall.handleInput("\x1b[H");
	check("home goes to the first row", /message 1 /.test(bodyOf(tall)) && !tall.following);
	tall.dispose();

	// A settled agent: no prompt, its duration in the title, its rows still there.
	current = task({ status: "completed", toolUses: 4, durationMs: 90_000, result: "All good." });
	const settled = make();
	const settledPlain = settled.render(80).map(bare);
	check("a settled agent's title carries the duration and nothing else", settledPlain[0].includes("1m 30s") && !settledPlain[0].includes("tools"), settledPlain[0]);
	check("no prompt line to nowhere", !settledPlain.some((line) => line.includes("tell it what to do")) && !/enter send/.test(settledPlain[settledPlain.length - 1]));
	check("its rows are still the transcript", settledPlain.join("\n").includes("● Read(lib/wire.ts)"));
	settled.handleInput("x");
	settled.handleInput("\r");
	eq("keys do not steer a settled agent", sent, ["stop"]);

	// The session is gone: the answer stands in.
	const gone = new AgentConversationBox(theme, { ...deps, session: () => undefined }, ui, () => {}, () => 24);
	check("without a session the final answer is the body", gone.render(80).map(bare).join("\n").includes("All good."));
	// Ticket 31 (f): the box used to say "Still starting" about a child that had
	// been working for minutes. The dock now hands over the live session, so this
	// sentence is only for a run this seat holds none for — and even then the
	// true statement is that the output is not on screen, not that it has not begun.
	eq("a running agent with no session to follow says so, and when its answer arrives", wrapAnswer(task(), 100), [
		"Running, with no live session to follow here; the answer lands when it finishes.",
	]);
	check("nothing calls a working agent still starting", !wrapAnswer(task(), 100).join(" ").includes("Still starting"));
	eq("a queued agent is the one that has not started", wrapAnswer(task({ status: "queued" }), 100), ["Queued. It has not started yet."]);
	check("the notice wraps into a narrow box rather than overflowing it",
		wrapAnswer(task(), 40).length > 1 && wrapAnswer(task(), 40).every((line) => visibleWidth(line) <= 40));
	eq("an agent that has already stored a reply shows the reply, not the notice",
		wrapAnswer(task({ result: "Half way through the wire." }), 100), ["Half way through the wire."]);
	eq("a settled agent with nothing says so", wrapAnswer(task({ status: "completed" }), 40), ["No output."]);
	eq("an error stands in for a result", wrapAnswer(task({ status: "failed", error: "boom", result: "half" }), 40), ["boom"]);

	// Reading and talking are two capabilities: a box given a session but no
	// `send` follows the agent and draws no prompt line at all.
	current = task();
	const readOnly = new AgentConversationBox(theme, { task: () => current, session: () => session, cwd: process.cwd() }, ui, () => {}, () => 24);
	const readOnlyPlain = readOnly.render(80).map(bare);
	check("a box with no way to send draws no prompt line", !readOnlyPlain.some((line) => line.includes("tell it what to do")));
	check("and still draws the agent's rows", readOnlyPlain.join("\n").includes("● Read(lib/wire.ts)"));
	readOnly.handleInput("h");
	readOnly.handleInput("\r");
	eq("typing into it sends nothing anywhere", sent, ["stop"]);
	readOnly.dispose();

	// The session goes away while the box is open.
	current = task();
	let live = session;
	const dropping = new AgentConversationBox(theme, { ...deps, session: () => live }, ui, () => {}, () => 24);
	check("with a session the rows draw", dropping.render(80).map(bare).join("\n").includes("● Read("));
	live = undefined;
	current = task({ status: "completed", result: "Finished." });
	check("once it is dropped the answer stands in", dropping.render(80).map(bare).join("\n").includes("Finished."));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
