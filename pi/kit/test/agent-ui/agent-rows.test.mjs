/**
 * The subagent rows: the resolver that supplies them, and what the four one-line
 * tools draw. The `Agent` row's launch batches are in
 * `agent-launch-batch.test.mjs`, the shared outcome line in
 * `agent-outcome-line.test.mjs`, the notice in `agent-completion-notice.test.mjs`.
 *
 * Everything runs through pi's real `ToolExecutionComponent`, because the whole
 * extension is a resolver for that component's render slots — a test that called
 * the renderers directly would pass with the seam broken, which is the one
 * failure this file exists to catch.
 *
 *   node test/agent-ui/agent-rows.test.mjs
 */

import { check, finish, is } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, initDarkTheme, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();

const { ToolExecutionComponent } = await importPi("dist/modes/interactive/components/index.js");
const theme = await initDarkTheme();

const receipt = await jiti.import(`${KIT_ROOT}/extensions/agent-rows/agent-receipt.ts`);

const ok = (label, value) => is(label, value, true);

const WIDTH = 80;
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "");
const ui = { requestRender: () => {} };

// ---------------------------------------------------------------------------
// The seam. If pi's row component changes shape, this is the alarm.
// ---------------------------------------------------------------------------

const rows = receipt.agentRowSlots();
is("every engine tool has a row", Object.keys(rows).sort().join(","), "Agent,ListAgents,SendMessage,TaskOutput,TaskStop");

// The extension's resolver, as pi's runner chains it: the resolver, then the registered tool.
const resolvers = [];
const agentRows = await jiti.import(`${KIT_ROOT}/extensions/agent-rows/index.ts`);
agentRows.default({ registerMessageRenderer: () => {}, registerToolRenderer: (resolver) => resolvers.push(resolver), on: () => {} });
is("the extension registers one resolver", resolvers.length, 1);
const piRenderers = { renderShell: "default" };

function row(tool, id, args) {
	return new ToolExecutionComponent(tool, id, args, {}, resolvers[0](tool, () => piRenderers), ui, process.cwd());
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
	is("an engine tool renders its own shell", probe.getRenderShell(), "self");
	ok("an engine tool has a call renderer", typeof probe.getCallRenderer() === "function");
	ok("an engine tool has a result renderer", typeof probe.getResultRenderer() === "function");
}
is("another tool's name goes to next()", resolvers[0]("read", () => piRenderers), piRenderers);
is("including one named like an object's own property", resolvers[0]("constructor", () => piRenderers), piRenderers);

// ---------------------------------------------------------------------------
// The other four tools. Each drew its result text raw before ticket 31, and
// TaskOutput's result text is the engine's `<task-notification>` XML.
// ---------------------------------------------------------------------------

{
	const sent = row("SendMessage", "m1", { to: "quota-docs", message: "stop after the table" });
	settle(sent, "Sent to quota-docs; it reads the message at its next step.", { status: "running", name: "quota-docs" });
	const drawn = lines(sent);
	is("a message names who it went to", drawn[0], "● SendMessage(quota-docs)");
	is("and says what happened to it", drawn[1], "  ⎿  Sent to quota-docs; it reads the message at its next step.");
	is("in two lines", drawn.length, 2);
}
{
	const list = row("ListAgents", "l1", {});
	settle(list, "quota-docs · explore · completed · ran 3m · $0.12\nquota-measured · worker · running · 2m", undefined);
	const drawn = lines(list);
	is("the roster is its own header", drawn[0], "● ListAgents");
	is("counted rather than listed", drawn[1], "  ⎿  2 agents");
	list.setExpanded(true);
	ok("and listed when it is opened", lines(list).some((line) => line.includes("quota-measured · worker · running")));
	list.setExpanded(false);
}
{
	const empty = row("ListAgents", "l2", {});
	settle(empty, "No agents this session.", undefined);
	is("an empty roster says so in its own words", lines(empty)[1], "  ⎿  No agents this session.");
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
	is("a collection names who it waited for", drawn[0], "● TaskOutput(quota-docs, quota-measured)");
	is("one line per agent, by name", drawn[1], "  ⎿  quota-docs · Done · 12 tools · 4.5k out · $0.12");
	is("including the one that failed", drawn[2], "     quota-measured · Failed · watchdog: aborted after 15m");
	ok("and never the notification XML", !drawn.some((line) => line.includes("<task-notification>")));
	collected.setExpanded(true);
	ok("opening it shows the agent's own words", lines(collected).some((line) => line.includes("The parser is in src/lex/parse.ts")));
	collected.setExpanded(false);
}
{
	const nothing = row("TaskOutput", "o2", {});
	settle(nothing, "Nothing to report: no agent of yours is running or has an unread result.", undefined);
	is("a wait with nothing to collect keeps its own sentence", lines(nothing)[1], "  ⎿  Nothing to report: no agent of yours is running or has an unread result.");
}
{
	const stopped = row("TaskStop", "s1", { name: "quota-docs" });
	settle(stopped, "Stopped quota-docs.\nResult so far:\nhalf an answer", { status: "stopped", toolUses: 12, outputTokens: 4_500, costUsd: 0.12, name: "quota-docs" });
	const drawn = lines(stopped);
	is("a stop names the agent", drawn[0], "● TaskStop(quota-docs)");
	is("and keeps the counts a stopped run earned", drawn[1], "  ⎿  Stopped · 12 tools · 4.5k out · $0.12");
}
{
	const read = row("TaskOutput", "o3", { task: 3 });
	settle(read, "<background-task-notification>\n<task-id>3</task-id>\n<status>Failed (exit 3)</status>\n</background-task-notification>\nFull log at: /tmp/x.log", { kind: "task", id: 3, outcome: "finished", exitCode: 3, signal: null });
	const drawn = lines(read);
	is("a task read names the task", drawn[0], "● TaskOutput(task 3)");
	is("and says how it ended", drawn[1], "  ⎿  Failed (exit 3)");
	ok("and never the notification XML", !drawn.some((line) => line.includes("<background-task-notification>")));
	const waiting = row("TaskOutput", "o4", { task: 4 });
	settle(waiting, "Timed out: task 4 is still running after 30s", { kind: "task", id: 4, outcome: "timed-out" });
	is("a task read that timed out says the task still runs", lines(waiting)[1], "  ⎿  Timed out · still running");
}
{
	const ended = row("TaskStop", "s2", { task: 3 });
	settle(ended, "Background task 3 already ended; its result is in your conversation.", { kind: "task", id: 3, outcome: "in-conversation" });
	const drawn = lines(ended);
	is("a task stop names the task", drawn[0], "● TaskStop(task 3)");
	is("and a task that had already ended is not drawn as stopped", drawn[1], "  ⎿  Already ended");
	ok("anywhere in the row", !drawn.some((line) => line.includes("Stopped")));
	const stopping = row("TaskStop", "s3", { task: 5 });
	settle(stopping, "Stopping background task 5; its notification follows.", { kind: "task", id: 5, outcome: "stopping" });
	is("a task being stopped says so", lines(stopping)[1], "  ⎿  Stopping");
}
{
	const refused = row("SendMessage", "m2", { to: "nobody", message: "hi" });
	settle(refused, "No agent of yours is named nobody.", undefined, true);
	is("a refusal is the row's error line", lines(refused)[1], "  ⎿  No agent of yours is named nobody.");
}

// ---------------------------------------------------------------------------
// A renderer must never throw, whatever it is handed.
// ---------------------------------------------------------------------------

const bare = { args: undefined, toolCallId: undefined, state: undefined, cwd: "", isPartial: false, expanded: false, isError: false, showImages: false, lastComponent: undefined };
for (const [name, slots] of Object.entries(receipt.agentRowSlots())) {
	try {
		slots.renderCall({}, theme, { ...bare });
		slots.renderResult({ content: [] }, { isPartial: false, expanded: false }, theme, { ...bare });
		slots.renderResult({ content: [{ type: "text", text: "x" }] }, { isPartial: true, expanded: false }, theme, { ...bare });
		check(`${name} does not throw on a bare context`, true);
	} catch (err) {
		check(`${name} does not throw on a bare context`, false, err.message);
	}
}

await finish();
