/**
 * The registry behind the dock's count: lifecycle and progress payloads folded
 * into task rows, driven with the real event orders the engine produces —
 * `created → started → completed` for a background `Agent` call and
 * `started → completed` for an RPC spawn, which emits no `created` at all.
 * **The count is a lie the moment a settled agent still counts.**
 *
 *   node test/agent-ui/agent-task-registry.test.mjs
 */

import { check, eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const registryModule = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/agent-task-registry.ts`);

console.log("agent-task-registry: the registry behind the count");
{
	const { AgentTaskRegistry, parseAgentLifecyclePayload, parseAgentProgressPayload, AGENT_LIFECYCLE_CHANNELS, AGENT_PROGRESS_CHANNEL, SETTLED_TASK_LIMIT, SETTLED_TASK_GRACE_MS } = registryModule;

	eq("the five channels are the vendor's, plus the resume", AGENT_LIFECYCLE_CHANNELS.map(([channel]) => channel), [
		"subagents:created",
		"subagents:started",
		"subagents:completed",
		"subagents:failed",
		"subagents:resumed",
	]);

	eq("progress rides its own channel, because it carries no status", AGENT_PROGRESS_CHANNEL, "subagents:progress");
	eq("a payload with no id is not an agent", parseAgentLifecyclePayload({ type: "explore" }), undefined);
	eq("a non-object payload is not an agent", parseAgentLifecyclePayload("a1"), undefined);
	eq("an empty id is not an id", parseAgentLifecyclePayload({ id: "" }), undefined);
	eq("a number field arriving as a string is dropped, not coerced",
		parseAgentLifecyclePayload({ id: "a1", toolUses: "12" }).toolUses, undefined);

	const registry = new AgentTaskRegistry();
	// The `Agent` tool's background branch: created, then started, then done.
	registry.applyLifecycleEvent("created", { id: "a1", type: "worker", description: "audit the wire" }, 1_000);
	eq("a created agent is queued and counted", [registry.liveCount(), registry.get("a1").status], [1, "queued"]);
	registry.applyLifecycleEvent("started", { id: "a1", type: "worker", description: "audit the wire" }, 2_000);
	eq("a started agent is running and still counted", [registry.liveCount(), registry.get("a1").status], [1, "running"]);

	// An RPC spawn emits no `subagents:created` — its first event is `started`.
	registry.applyLifecycleEvent("started", { id: "a2", type: "explore", description: "map the kit" }, 2_500);
	eq("an agent first seen at started is a task all the same", registry.liveCount(), 2);

	registry.applyLifecycleEvent(
		"completed",
		{ id: "a1", type: "worker", description: "audit the wire", result: "all clear", toolUses: 45, durationMs: 681_000 },
		9_000,
	);
	eq("a settled agent leaves the count", registry.liveCount(), 1);
	eq("its answer is kept for the modal", registry.get("a1").result, "all clear");
	eq("so is what it cost", [registry.get("a1").toolUses, registry.get("a1").durationMs], [45, 681_000]);

	registry.applyLifecycleEvent("started", { id: "a1" }, 10_000);
	eq("a late started never resurrects a settled agent", [registry.liveCount(), registry.get("a1").status], [1, "completed"]);

	// A `SendMessage` resume, on its own channel: one agent, one row, for the
	// agent's whole life. The old row asserting `completed` while it ran is the
	// fault this replaces.
	registry.applyLifecycleEvent("resumed", { id: "a1" }, 10_500);
	eq("a resume revives the agent's own row rather than adding a second", [registry.liveCount(), registry.get("a1").status, registry.list().length], [2, "running", 2]);
	eq("and the previous run's answer goes: a running agent has none", [registry.get("a1").result, registry.get("a1").settledAt], [undefined, undefined]);
	registry.applyLifecycleEvent("completed", { id: "a1", result: "clear again" }, 10_800);
	eq("the resumed run settles into the same row", [registry.liveCount(), registry.get("a1").result], [1, "clear again"]);

	registry.applyLifecycleEvent("failed", { id: "a2", status: "stopped", error: "watchdog: aborted after 15m" }, 11_000);
	eq("a failure settles too", [registry.liveCount(), registry.get("a2").status], [0, "failed"]);
	eq("the vendor's outcome word is kept", registry.get("a2").outcome, "stopped");
	eq("the reason is kept", registry.get("a2").error, "watchdog: aborted after 15m");
	eq("a description already seen survives a payload that omits it", registry.get("a2").description, "map the kit");

	eq("live first, then the most recently settled", registry.list().map((task) => task.id), ["a2", "a1"]);

	// Stopping.
	registry.applyLifecycleEvent("started", { id: "a3", description: "long one" }, 12_000);
	check("a stop is noted", registry.markStopRequested("a3") === true);
	check("asking twice changes nothing", registry.markStopRequested("a3") === false);
	check("a settled agent cannot be stopped", registry.markStopRequested("a1") === false);
	registry.applyLifecycleEvent("failed", { id: "a3", error: "aborted" }, 13_000);
	eq("a stop that landed is no longer pending", registry.get("a3").stopRequested, false);

	// The settled list is bounded; the live count never is.
	const many = new AgentTaskRegistry();
	for (let i = 0; i < SETTLED_TASK_LIMIT + 5; i++) {
		many.applyLifecycleEvent("started", { id: `b${i}`, description: `task ${i}` }, 1_000 + i);
		many.applyLifecycleEvent("completed", { id: `b${i}`, result: "done" }, 2_000 + i);
	}
	// Twenty-five landing together: nothing is trimmed yet, because a row nobody
	// has had a chance to see must not vanish while `ListAgents` still lists it.
	eq("a row inside the grace is never trimmed, whatever the limit says", many.list().length, SETTLED_TASK_LIMIT + 5);
	many.applyLifecycleEvent("started", { id: "late" }, 2_000 + SETTLED_TASK_GRACE_MS + 1_000);
	many.applyLifecycleEvent("completed", { id: "late", result: "done" }, 2_000 + SETTLED_TASK_GRACE_MS + 1_000);
	eq("settled tasks are capped once the grace has passed", many.list().length, SETTLED_TASK_LIMIT);
	eq("the newest survive", many.list()[0].id, "late");
	many.clear();
	eq("a new conversation owns no earlier agents", [many.list().length, many.liveCount()], [0, 0]);

	// C15's per-agent dollars. The engine reports the whole run as a pi `Usage`
	// on the settling event, so `usage.cost.total` is the one number to read and
	// the flat `tokens` view beside it is a different question (display tokens,
	// cacheRead excluded).
	eq("an agent's dollars come off usage.cost.total",
		parseAgentLifecyclePayload({ id: "c1", usage: { input: 1, cost: { total: 0.4213 } } }).costUsd, 0.4213);
	eq("a run that spent nothing reports no usage, and no cost", parseAgentLifecyclePayload({ id: "c1" }).costUsd, undefined);
	eq("an unpriced model is not a free one", parseAgentLifecyclePayload({ id: "c1", usage: { cost: {} } }).costUsd, undefined);
	eq("a cost arriving as a string is dropped, not coerced",
		parseAgentLifecyclePayload({ id: "c1", usage: { cost: { total: "0.42" } } }).costUsd, undefined);

	const priced = new AgentTaskRegistry();
	priced.applyLifecycleEvent("started", { id: "c1", type: "worker", description: "price the fork", model: "anthropic/claude-fable-5-1" }, 1_000);
	eq("a running agent has spent nothing it can report", priced.get("c1").costUsd, undefined);
	priced.applyLifecycleEvent("completed", { id: "c1", usage: { cost: { total: 0.42 } }, durationMs: 2_400 }, 5_000);
	eq("and keeps it once settled — a settled row is never blank", priced.get("c1").model, "anthropic/claude-fable-5-1");
	eq("the settled agent carries its dollars", priced.get("c1").costUsd, 0.42);
	// The model is on every payload (`lifecyclePayload`), so the dock's model
	// column is filled from `subagents:created` on and stays filled once settled.
	eq("the model is read off the payload", parseAgentLifecyclePayload({ id: "c1", model: "anthropic/claude-fable-5-1" }).model, "anthropic/claude-fable-5-1");
	eq("a payload with no model leaves it unset", parseAgentLifecyclePayload({ id: "c1" }).model, undefined);
	eq("a live agent already names its model", priced.get("c1").model, "anthropic/claude-fable-5-1");
	priced.applyLifecycleEvent("failed", { id: "c2", usage: { cost: { total: 0.03 } }, error: "boom" }, 6_000);
	eq("a failed agent spent money too", priced.get("c2").costUsd, 0.03);

	// The name rides every payload (`lifecyclePayload`) and is what `SendMessage`
	// addresses, so the box can only talk to a child if the dock kept it.
	eq("the engine's name for the agent is read off the payload", parseAgentLifecyclePayload({ id: "d1", name: "worker-2" }).name, "worker-2");
	const named = new AgentTaskRegistry();
	named.applyLifecycleEvent("started", { id: "d1", name: "worker-2", type: "worker" }, 1_000);
	eq("a task carries the name the box sends to", named.get("d1").name, "worker-2");
	named.applyLifecycleEvent("completed", { id: "d1" }, 2_000);
	eq("a payload that omits the name never loses it", named.get("d1").name, "worker-2");
	eq("a payload with no name leaves it empty rather than absent", new AgentTaskRegistry().applyLifecycleEvent("started", { id: "d2" }, 1) && undefined, undefined);

	// Live counts: `toolUses` lives in the run's memory and reaches the record
	// only at settle, so without progress a running row's count is always zero.
	eq("progress with no id is not progress", parseAgentProgressPayload({ toolUses: 3 }), undefined);
	eq("a progress count arriving as a string is dropped, not coerced", parseAgentProgressPayload({ id: "e1", toolUses: "3" }).toolUses, undefined);
	const live = new AgentTaskRegistry();
	live.applyLifecycleEvent("started", { id: "e1", name: "worker-3", toolUses: 0 }, 1_000);
	eq("a running agent starts with nothing to show", [live.get("e1").toolUses, live.get("e1").lastActivityAt], [0, undefined]);
	check("progress moves the row", live.applyProgressEvent({ id: "e1", toolUses: 4, lastActivityAt: 5_000 }, 5_000) === true);
	eq("the count and the moment of the last step are the row's", [live.get("e1").toolUses, live.get("e1").lastActivityAt], [4, 5_000]);
	eq("progress never moves a task between states", [live.get("e1").status, live.liveCount()], ["running", 1]);
	check("the same progress twice is not a repaint", live.applyProgressEvent({ id: "e1", toolUses: 4, lastActivityAt: 5_000 }, 5_000) === false);
	check("progress for an agent this dock never saw is dropped", live.applyProgressEvent({ id: "zz", toolUses: 9 }, 6_000) === false);
	live.applyLifecycleEvent("completed", { id: "e1", toolUses: 5, durationMs: 9_000 }, 9_000);
	check("progress still in flight cannot walk a settled agent's counts back", live.applyProgressEvent({ id: "e1", toolUses: 2, lastActivityAt: 10_000 }, 10_000) === false);
	eq("a settled agent keeps the count the engine recorded", live.get("e1").toolUses, 5);
}

console.log("\nagent-task-registry: the agents a task launched");
{
	const { AgentTaskRegistry, parseAgentLifecyclePayload, SETTLED_TASK_LIMIT, SETTLED_TASK_GRACE_MS } = registryModule;
	eq("a forwarded payload names the task that launched it", parseAgentLifecyclePayload({ id: "g1", parentId: "w1" }).parentId, "w1");
	eq("a seat's own child has no parent", parseAgentLifecyclePayload({ id: "w1" }).parentId, undefined);
	const nested = new AgentTaskRegistry();
	nested.applyLifecycleEvent("started", { id: "w1" }, 1_000);
	nested.applyLifecycleEvent("started", { id: "g1", parentId: "w1" }, 1_001);
	eq("the list carries the nested agent, under its parent's id", nested.list().map((task) => [task.id, task.parentId]), [["w1", undefined], ["g1", "w1"]]);
	eq("the count is the agents this seat waits on: its own, not theirs", nested.liveCount(), 1);
	nested.applyLifecycleEvent("completed", { id: "g1" }, 1_002);
	nested.applyLifecycleEvent("completed", { id: "g1", parentId: "elsewhere" }, 1_003);
	eq("a later payload keeps the parent the first one named", nested.get("g1").parentId, "w1");

	const crowd = new AgentTaskRegistry();
	crowd.applyLifecycleEvent("started", { id: "own" }, 0);
	crowd.applyLifecycleEvent("completed", { id: "own", usage: { cost: { total: 1 } } }, 0);
	for (let i = 0; i < SETTLED_TASK_LIMIT + 5; i++) {
		const at = (i + 1) * SETTLED_TASK_GRACE_MS * 2;
		crowd.applyLifecycleEvent("started", { id: `n${i}`, parentId: "own" }, at);
		crowd.applyLifecycleEvent("completed", { id: `n${i}`, usage: { cost: { total: 1 } } }, at);
	}
	check("nested agents never trim a seat's own row off the list", crowd.get("own") !== undefined);
	eq("they are trimmed among themselves", crowd.list().filter((task) => task.parentId !== undefined).length, SETTLED_TASK_LIMIT);
	eq("and their dollars stay out of the seat's trimmed spend", crowd.trimmedSpend(), { agents: 0, dollars: 0 });
}

await finish();
