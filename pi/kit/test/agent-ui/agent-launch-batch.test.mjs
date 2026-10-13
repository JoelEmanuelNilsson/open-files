/**
 * The `Agent` row: a lone launch is its own receipt, consecutive launches in one
 * message are one line and a tree, and a batch dissolves back into rows the
 * moment a member is a blocking call or a failure.
 *
 * Drawn through pi's real `ToolExecutionComponent` with the kit's renderers, because the batch is a plan the rows read on every frame.
 *
 *   node test/agent-ui/agent-launch-batch.test.mjs
 */

import { finish, is } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, initDarkTheme, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();

const { ToolExecutionComponent } = await importPi("dist/modes/interactive/components/index.js");
await initDarkTheme();

const receipt = await jiti.import(`${KIT_ROOT}/extensions/agent-rows/agent-receipt.ts`);
const launches = await jiti.import(`${KIT_ROOT}/extensions/agent-rows/agent-launch-group.ts`);

const ok = (label, value) => is(label, value, true);

const WIDTH = 80;
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "");
const ui = { requestRender: () => {} };

const rows = receipt.agentRowSlots();

function row(tool, id, args) {
	return new ToolExecutionComponent(tool, id, args, {}, rows[tool], ui, process.cwd());
}
function lines(component) {
	return component.render(WIDTH).map(plain).filter((line) => line !== "");
}
function settle(component, text, details, isError = false) {
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text }], details, isError }, false);
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
	is("a lone launch is its own header", drawn[0], "● Agent(where the parser lives)");
	is("and says where it went", drawn[1], "  ⎿  Running in background");
	is("in two lines and no more", drawn.length, 2);
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
	is("a batch mid-flight says what it is doing", speaking[0], "● Launching 3 agents…");
	is("and names nothing whose arguments are still streaming", speaking.length, 1);
	is("a member of a batch draws nothing", lines(batch[1]).length, 0);
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
	is("the count still says how many are coming", speaking[0], "● Launching 3 agents…");
	is("a launch whose arguments landed is in the tree at once", speaking[1], "  ├─ explore  task 1");
	is("the default type is badged Agent", speaking[2], "  └─ Agent    task 2");
	is("one still streaming is counted, not named", speaking.length, 3);
}
launches.planAgentLaunches({
	role: "assistant",
	content: [
		{ type: "toolCall", id: "b1", name: "Agent", arguments: { description: "task 1", subagent_type: "explore" } },
		{ type: "toolCall", id: "b2", name: "Agent", arguments: { description: "task 2", subagent_type: "worker" } },
		{ type: "toolCall", id: "b3", name: "Agent", arguments: { description: "task 3", subagent_type: "worker" } },
	],
});
is("the third joins when its arguments close", lines(batch[0]).slice(1).join("\n"), "  ├─ explore  task 1\n  ├─ Agent    task 2\n  └─ Agent    task 3");

batch.forEach((component, index) => {
	settle(component, "Agent started in background.", {
		status: "background",
		// The engine reports the default type by its own name; the third result carries no name at all.
		...(index < 2 ? { displayName: index === 0 ? "explore" : "worker" } : {}),
		description: `task ${index + 1}`,
		agentId: `a-${index}`,
	});
});
await new Promise((resolve) => setTimeout(resolve, 0));

{
	const drawn = lines(batch[0]);
	is("a settled batch is one line", drawn[0], "● 3 background agents launched (↓ to manage)");
	is("with a tree under it", drawn[1], "  ├─ explore  task 1");
	is("padded to the widest type", drawn[2], "  ├─ Agent    task 2");
	is("and a corner on the last", drawn[3], "  └─ Agent    task 3");
	is("four lines for three launches", drawn.length, 4);
	is("members still draw nothing", lines(batch[1]).length + lines(batch[2]).length, 0);
}

{
	batch[0].setExpanded(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	ok("opening the line opens the rows behind it", lines(batch[1])[0] === "● Agent(task 2)");
	batch[0].setExpanded(false);
	await new Promise((resolve) => setTimeout(resolve, 0));
	is("and closing it puts them back", lines(batch[1]).length, 0);
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
	is("a blocking call puts the first row back", lines(rows[0])[0], "● Agent(mixed 1)");
	is("and keeps its own", lines(rows[1])[0], "● Agent(mixed 2)");
	is("with the outcome: what it wrote and what that cost", lines(rows[1])[1], "  ⎿  Done · 3 tools · 12.0k out · $0.12");
}

// ---------------------------------------------------------------------------
// A launch that failed keeps its row and says why.
// ---------------------------------------------------------------------------

{
	const failed = row("Agent", "f1", { description: "audit the error paths" });
	launches.planAgentLaunches({ role: "assistant", content: [{ type: "toolCall", id: "f1", name: "Agent" }] });
	settle(failed, "Agent failed: watchdog: aborted after 15m", { status: "error", displayName: "Agent", description: "audit the error paths", error: "watchdog: aborted after 15m" }, false);
	const drawn = lines(failed);
	is("a failed agent says the reason", drawn[1], "  ⎿  Failed · watchdog: aborted after 15m");
}
{
	const blocked = row("Agent", "f2", { description: "blocked" });
	settle(blocked, "Tool call blocked: no scan starts at /", undefined, true);
	is("a pre-execution failure shows the reason it was given", lines(blocked)[1], "  ⎿  Failed · Tool call blocked: no scan starts at /");
}

launches.forgetAgentLaunches();

await finish();
