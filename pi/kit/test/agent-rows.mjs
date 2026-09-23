/**
 * The subagent rows: the seam that claims them, and what they draw.
 *
 * Everything runs through pi's real `ToolExecutionComponent`, because the whole
 * extension is a claim on that component's render slots — a test that called
 * the renderers directly would pass with the seam broken, which is the one
 * failure this file exists to catch.
 *
 *   node test/agent-rows.mjs
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { ToolExecutionComponent } = await import(`${PI}/dist/modes/interactive/components/index.js`);
const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);

const claim = await jiti.import(`${ROOT}/lib/claim-tool-rows.ts`);
const receipt = await jiti.import(`${ROOT}/extensions/agent-rows/agent-receipt.ts`);
const launches = await jiti.import(`${ROOT}/extensions/agent-rows/agent-launch-group.ts`);
const outcome = await jiti.import(`${ROOT}/extensions/agent-rows/agent-outcome-line.ts`);
const notice = await jiti.import(`${ROOT}/extensions/agent-rows/agent-completion-notice.ts`);

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (actual === expected) {
		pass++;
		return;
	}
	fail++;
	console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
};
const ok = (label, value) => eq(label, value, true);

const WIDTH = 80;
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "");
const ui = { requestRender: () => {} };

// ---------------------------------------------------------------------------
// The seam. If pi's row component changes shape, this is the alarm.
// ---------------------------------------------------------------------------

for (const method of claim.PATCHED_METHODS) {
	ok(`pi's ToolExecutionComponent still has ${method}`, typeof ToolExecutionComponent.prototype[method] === "function");
}

const release = claim.claimToolRows(receipt.agentRowSlots());
eq("every engine tool's row is claimed", claim.claimedToolNames().join(","), "Agent,ListAgents,SendMessage,TaskOutput,TaskStop");

function row(tool, id, args) {
	return new ToolExecutionComponent(tool, id, args, {}, undefined, ui, process.cwd());
}
function lines(component) {
	return component.render(WIDTH).map(plain).filter((line) => line !== "");
}
function settle(component, text, details, isError = false) {
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text }], details, isError }, false);
}

{
	const probe = row("Agent", "seam-1", { description: "a task" });
	eq("a claimed tool renders its own shell", probe.getRenderShell(), "self");
	ok("a claimed tool has a call renderer", typeof probe.getCallRenderer() === "function");
	ok("a claimed tool has a result renderer", typeof probe.getResultRenderer() === "function");
	ok("a claimed tool counts as having a definition", probe.hasRendererDefinition() === true);
}
{
	const other = row("read", "seam-2", { path: "x" });
	ok("an unclaimed tool keeps pi's own answer", other.getRenderShell() !== "self" || other.getCallRenderer() === undefined);
}

// ---------------------------------------------------------------------------
// One launch is its own row.
// ---------------------------------------------------------------------------

{
	const one = row("Agent", "solo", { description: "where the parser lives", subagent_type: "explore" });
	launches.planAgentLaunches({ role: "assistant", content: [{ type: "toolCall", id: "solo", name: "Agent" }] });
	settle(one, "Agent started in background.\nAgent ID: explore-1", {
		status: "background",
		displayName: "explore",
		description: "where the parser lives",
		agentId: "explore-1",
	});
	const drawn = lines(one);
	eq("a lone launch is its own header", drawn[0], "● Agent(where the parser lives)");
	eq("and says where it went", drawn[1], "  ⎿  Running in background");
	eq("in two lines and no more", drawn.length, 2);
}

// ---------------------------------------------------------------------------
// Several launches in one message are one line and a tree.
// ---------------------------------------------------------------------------

const batchIds = ["b1", "b2", "b3"];
const batch = batchIds.map((id, index) => row("Agent", id, { description: `task ${index + 1}`, subagent_type: index === 0 ? "explore" : "worker" }));
launches.planAgentLaunches({
	role: "assistant",
	content: batchIds.map((id) => ({ type: "toolCall", id, name: "Agent" })),
});

{
	const speaking = lines(batch[0]);
	eq("a batch mid-flight says what it is doing", speaking[0], "● Launching 3 agents…");
	eq("and names nothing whose arguments are still streaming", speaking.length, 1);
	eq("a member of a batch draws nothing", lines(batch[1]).length, 0);
}

// The tree grows as each call's arguments land, before any launch returns.
launches.planAgentLaunches({
	role: "assistant",
	content: [
		{ type: "toolCall", id: "b1", name: "Agent", arguments: { description: "task 1", subagent_type: "explore" } },
		{ type: "toolCall", id: "b2", name: "Agent", arguments: { description: "task 2", subagent_type: "worker" } },
		{ type: "toolCall", id: "b3", name: "Agent", arguments: { description: "task 3" }, partialJson: '{"description":"task 3' },
	],
});
{
	const speaking = lines(batch[0]);
	eq("the count still says how many are coming", speaking[0], "● Launching 3 agents…");
	eq("a launch whose arguments landed is in the tree at once", speaking[1], "  ├─ explore  task 1");
	eq("the default type is badged Agent", speaking[2], "  └─ Agent    task 2");
	eq("one still streaming is counted, not named", speaking.length, 3);
}
launches.planAgentLaunches({
	role: "assistant",
	content: [
		{ type: "toolCall", id: "b1", name: "Agent", arguments: { description: "task 1", subagent_type: "explore" } },
		{ type: "toolCall", id: "b2", name: "Agent", arguments: { description: "task 2", subagent_type: "worker" } },
		{ type: "toolCall", id: "b3", name: "Agent", arguments: { description: "task 3", subagent_type: "worker" } },
	],
});
eq("the third joins when its arguments close", lines(batch[0]).slice(1).join("\n"), "  ├─ explore  task 1\n  ├─ Agent    task 2\n  └─ Agent    task 3");

batch.forEach((component, index) => {
	settle(component, "Agent started in background.", {
		status: "background",
		displayName: index === 0 ? "explore" : "Agent",
		description: `task ${index + 1}`,
		agentId: `a-${index}`,
	});
});
await new Promise((resolve) => setTimeout(resolve, 0));

{
	const drawn = lines(batch[0]);
	eq("a settled batch is one line", drawn[0], "● 3 background agents launched (↓ to manage)");
	eq("with a tree under it", drawn[1], "  ├─ explore  task 1");
	eq("padded to the widest type", drawn[2], "  ├─ Agent    task 2");
	eq("and a corner on the last", drawn[3], "  └─ Agent    task 3");
	eq("four lines for three launches", drawn.length, 4);
	eq("members still draw nothing", lines(batch[1]).length + lines(batch[2]).length, 0);
}

{
	batch[0].setExpanded(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	ok("opening the line opens the rows behind it", lines(batch[1])[0] === "● Agent(task 2)");
	batch[0].setExpanded(false);
	await new Promise((resolve) => setTimeout(resolve, 0));
	eq("and closing it puts them back", lines(batch[1]).length, 0);
}

// ---------------------------------------------------------------------------
// A batch dissolves the moment a member is not a background launch.
// ---------------------------------------------------------------------------

{
	const ids = ["d1", "d2"];
	const rows = ids.map((id, index) => row("Agent", id, { description: `mixed ${index + 1}` }));
	launches.planAgentLaunches({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "Agent" })) });
	settle(rows[0], "Agent started in background.", { status: "background", displayName: "Agent", description: "mixed 1" });
	settle(rows[1], "the agent's whole answer", { status: "completed", displayName: "Agent", description: "mixed 2", toolUses: 3, outputTokens: 12_000, costUsd: 0.12 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	eq("a blocking call puts the first row back", lines(rows[0])[0], "● Agent(mixed 1)");
	eq("and keeps its own", lines(rows[1])[0], "● Agent(mixed 2)");
	eq("with the outcome: what it wrote and what that cost", lines(rows[1])[1], "  ⎿  Done · 3 tools · 12.0k out · $0.12");
}

// ---------------------------------------------------------------------------
// A launch that failed keeps its row and says why.
// ---------------------------------------------------------------------------

{
	const failed = row("Agent", "f1", { description: "audit the error paths" });
	launches.planAgentLaunches({ role: "assistant", content: [{ type: "toolCall", id: "f1", name: "Agent" }] });
	settle(failed, "Agent failed: watchdog: aborted after 15m", { status: "error", displayName: "Agent", description: "audit the error paths", error: "watchdog: aborted after 15m" }, false);
	const drawn = lines(failed);
	eq("a failed agent says the reason", drawn[1], "  ⎿  Failed · watchdog: aborted after 15m");
}
{
	const blocked = row("Agent", "f2", { description: "blocked" });
	settle(blocked, "Tool call blocked: no scan starts at /", undefined, true);
	eq("a pre-execution failure shows the reason it was given", lines(blocked)[1], "  ⎿  Failed · Tool call blocked: no scan starts at /");
}

// ---------------------------------------------------------------------------
// The other four tools. Each drew its result text raw before ticket 31, and
// TaskOutput's result text is the engine's `<task-notification>` XML.
// ---------------------------------------------------------------------------

{
	const sent = row("SendMessage", "m1", { to: "quota-docs", message: "stop after the table" });
	settle(sent, "Sent to quota-docs; it reads the message at its next step.", { status: "running", name: "quota-docs" });
	const drawn = lines(sent);
	eq("a message names who it went to", drawn[0], "● SendMessage(quota-docs)");
	eq("and says what happened to it", drawn[1], "  ⎿  Sent to quota-docs; it reads the message at its next step.");
	eq("in two lines", drawn.length, 2);
}
{
	const list = row("ListAgents", "l1", {});
	settle(list, "quota-docs · explore · completed · ran 3m · $0.12\nquota-measured · worker · running · 2m", undefined);
	const drawn = lines(list);
	eq("the roster is its own header", drawn[0], "● ListAgents");
	eq("counted rather than listed", drawn[1], "  ⎿  2 agents");
	list.setExpanded(true);
	ok("and listed when it is opened", lines(list).some((line) => line.includes("quota-measured · worker · running")));
	list.setExpanded(false);
}
{
	const empty = row("ListAgents", "l2", {});
	settle(empty, "No agents this session.", undefined);
	eq("an empty roster says so in its own words", lines(empty)[1], "  ⎿  No agents this session.");
}
{
	const collected = row("TaskOutput", "o1", { names: ["quota-docs", "quota-measured"] });
	settle(collected, "<task-notification>\n<task-id>t1</task-id>\n<result>the answer</result>\n</task-notification>", {
		id: "t1",
		name: "quota-docs",
		description: "where the parser lives",
		status: "completed",
		toolUses: 12,
		outputTokens: 4_500,
		totalCost: 0.12,
		resultPreview: "The parser is in src/lex/parse.ts",
		others: [{ id: "t2", name: "quota-measured", status: "error", toolUses: 2, outputTokens: 0, error: "watchdog: aborted after 15m" }],
	});
	const drawn = lines(collected);
	eq("a collection names who it waited for", drawn[0], "● TaskOutput(quota-docs, quota-measured)");
	eq("one line per agent, by name", drawn[1], "  ⎿  quota-docs · Done · 12 tools · 4.5k out · $0.12");
	eq("including the one that failed", drawn[2], "     quota-measured · Failed · watchdog: aborted after 15m");
	ok("and never the notification XML", !drawn.some((line) => line.includes("<task-notification>")));
	collected.setExpanded(true);
	ok("opening it shows the agent's own words", lines(collected).some((line) => line.includes("The parser is in src/lex/parse.ts")));
	collected.setExpanded(false);
}
{
	const nothing = row("TaskOutput", "o2", {});
	settle(nothing, "Nothing to report: no agent of yours is running or has an unread result.", undefined);
	eq("a wait with nothing to collect keeps its own sentence", lines(nothing)[1], "  ⎿  Nothing to report: no agent of yours is running or has an unread result.");
}
{
	const stopped = row("TaskStop", "s1", { name: "quota-docs" });
	settle(stopped, "Stopped quota-docs.\nResult so far:\nhalf an answer", { status: "stopped", toolUses: 12, outputTokens: 4_500, costUsd: 0.12, name: "quota-docs" });
	const drawn = lines(stopped);
	eq("a stop names the agent", drawn[0], "● TaskStop(quota-docs)");
	eq("and keeps the counts a stopped run earned", drawn[1], "  ⎿  Stopped · 12 tools · 4.5k out · $0.12");
}
{
	const refused = row("SendMessage", "m2", { to: "nobody", message: "hi" });
	settle(refused, "No agent of yours is named nobody.", undefined, true);
	eq("a refusal is the row's error line", lines(refused)[1], "  ⎿  No agent of yours is named nobody.");
}

// ---------------------------------------------------------------------------
// The outcome line, which both a blocking row and the notice share.
// ---------------------------------------------------------------------------

eq("one tool is singular", outcome.formatAgentToolUses(1), "1 tool");
eq("two tools are plural", outcome.formatAgentToolUses(2), "2 tools");
eq("output tokens are written short", outcome.formatAgentOutputTokens(512), "512 out");
eq("thousands are abbreviated", outcome.formatAgentOutputTokens(12_300), "12.3k out");
eq("millions too", outcome.formatAgentOutputTokens(2_400_000), "2.4M out");
eq(
	"a finished agent says how much work, how expensive, how many tools",
	outcome.agentOutcomeLine({ status: "completed", toolUses: 45, outputTokens: 12_300, costUsd: 0.42 }),
	"Done · 45 tools · 12.3k out · $0.42",
);
eq(
	"a failed one says why instead",
	outcome.agentOutcomeLine({ status: "error", toolUses: 45, outputTokens: 12_300, costUsd: 0.42, error: "ENOENT: no such file\nat foo" }),
	"Failed · ENOENT: no such file",
);
eq("a zero count is not a fact worth reporting", outcome.agentOutcomeLine({ status: "completed", toolUses: 0, outputTokens: 0, costUsd: 0 }), "Done");
eq("sub-cent spend is still spend", outcome.agentOutcomeLine({ status: "completed", toolUses: 1, outputTokens: 20, costUsd: 0.001 }), "Done · 1 tool · 20 out · <$0.01");
eq("a turn-limit wrap-up says so", outcome.agentOutcomeLine({ status: "steered", toolUses: 1, outputTokens: 0 }), "Wrapped up · 1 tool");

// ---------------------------------------------------------------------------
// The completion notice.
// ---------------------------------------------------------------------------

const theme = themeModule.theme;
function noticeLines(details, expanded = false) {
	const component = notice.renderSubagentNotification({ details }, { expanded }, theme);
	return component === undefined ? [] : component.render(WIDTH).map(plain).filter((line) => line !== "");
}
function noticeRaw(details) {
	const component = notice.renderSubagentNotification({ details }, { expanded: false }, theme);
	return component === undefined ? [] : component.render(WIDTH).map(plain);
}

{
	const drawn = noticeLines({
		id: "explore-1",
		description: "where the parser lives",
		status: "completed",
		toolUses: 45,
		outputTokens: 12_300,
		totalCost: 0.42,
		durationMs: 681_000,
		resultPreview: "The parser is in src/lex/parse.ts",
	});
	eq("the notice is the same header", drawn[0], "● Agent(where the parser lives)");
	eq("and one line of outcome", drawn[1], "  ⎿  Done · 45 tools · 12.3k out · $0.42 · 11m 21s");
	eq("two lines, not four", drawn.length, 2);
}
{
	const drawn = noticeLines({
		id: "a-1",
		description: "audit the error paths",
		status: "error",
		toolUses: 2,
		outputTokens: 900,
		durationMs: 4000,
		error: "watchdog: aborted after 15m\nstack",
		resultPreview: "No output.",
	});
	eq("a failed notice says the first line of the reason", drawn[1], "  ⎿  Failed · watchdog: aborted after 15m · 4.0s");
}
{
	const drawn = noticeLines({
		id: "a-1",
		description: "first",
		status: "completed",
		toolUses: 1,
		outputTokens: 10,
		durationMs: 1000,
		resultPreview: "one",
		others: [{ id: "a-2", description: "second", status: "completed", toolUses: 2, outputTokens: 20, durationMs: 2000, resultPreview: "two" }],
	});
	eq("a group notice draws one pair per agent", drawn.length, 4);
	eq("the first", drawn[0], "● Agent(first)");
	eq("and the second", drawn[2], "● Agent(second)");
	const raw = noticeRaw({
		id: "a-1",
		description: "first",
		status: "completed",
		toolUses: 1,
		outputTokens: 10,
		durationMs: 1000,
		resultPreview: "one",
		others: [{ id: "a-2", description: "second", status: "completed", toolUses: 2, outputTokens: 20, durationMs: 2000, resultPreview: "two" }],
	});
	eq("with the same blank margin between them a tool row gets", raw[2], "");
	eq("and none above the first", raw[0], "● Agent(first)");
}
eq("a notice with no details falls back to pi", notice.renderSubagentNotification({}, { expanded: false }, theme), undefined);

// ---------------------------------------------------------------------------
// A renderer must never throw, whatever it is handed.
// ---------------------------------------------------------------------------

const bare = { args: undefined, toolCallId: undefined, state: undefined, cwd: "", isPartial: false, expanded: false, isError: false, showImages: false, lastComponent: undefined };
for (const [name, slots] of Object.entries(receipt.agentRowSlots())) {
	try {
		slots.renderCall({}, theme, { ...bare });
		slots.renderResult({ content: [] }, { isPartial: false, expanded: false }, theme, { ...bare });
		slots.renderResult({ content: [{ type: "text", text: "x" }] }, { isPartial: true, expanded: false }, theme, { ...bare });
		pass++;
	} catch (err) {
		fail++;
		console.log(`FAIL ${name} threw on a bare context: ${err.message}`);
	}
}
try {
	notice.renderSubagentNotification({ details: { others: "not an array" } }, { expanded: false }, theme);
	pass++;
} catch (err) {
	fail++;
	console.log(`FAIL the notice threw on a bad payload: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Releasing the claim gives the rows back.
// ---------------------------------------------------------------------------

release();
eq("release drops every name it claimed", claim.claimedToolNames().length, 0);
{
	const after = row("Agent", "after", { description: "x" });
	ok("and pi answers for the tool again", after.getRenderShell() !== "self");
}

launches.forgetAgentLaunches();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
