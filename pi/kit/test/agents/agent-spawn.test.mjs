/**
 * Spawning agents, offline: a worker in the background, the lifecycle payloads
 * the dock reads, the live view of a running child, names that mean the
 * caller, auto-names, the depth cap and no fork. Every session is a real pi
 * `AgentSession` on `support/agent-engine-seat.mjs`'s scripted provider.
 */

import { check, finish } from "../support/check-harness.mjs";
import { SessionManager, call, jiti, lastUserText, mainSeat, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

// ---------------------------------------------------------------------------
// Spawn a worker: background by default, result delivered the moment it lands
// ---------------------------------------------------------------------------
{
	console.log("\nspawn a worker");
	const seat = await mainSeat();
	scriptFor("start a worker", [[call("Agent", { description: "count files", prompt: "Count the files.", subagent_type: "worker", name: "counter" })], [text("started it")]]);
	scriptFor("Count the files.", [[text("There are 42 files.")]]);
	await seat.session.prompt("start a worker");
	await seat.session.waitForIdle();
	const launch = seat.toolResults()[0];
	check("Agent returns at once with the name and task id", launch !== undefined && /Name: counter\nTask ID: a[0-9a-f]{12}\n/.test(launch.content[0].text), launch?.content[0]?.text);
	check("the tool result's details are the rows' contract", launch?.details?.status === "background" && launch.details.subagentType === "worker" && launch.details.description === "count files" && typeof launch.details.agentId === "string", JSON.stringify(launch?.details));
	const settled = await until(() => seat.events.some((e) => e.channel === "subagents:completed"));
	check("the child ran to completion in the background", settled);
	// Released, the child's session shuts down, so no timer or turn of its extensions outlives it.
	const lives = globalThis.__childScopes;
	const closed = await until(() => lives !== undefined && lives.opened.size > 0 && [...lives.opened].every((id) => lives.closed.has(id)), 2000);
	check("and releasing it closes its extensions' session scopes", closed, JSON.stringify({ opened: [...(lives?.opened ?? [])], closed: [...(lives?.closed ?? [])] }));
	const [created, started, completed] = seat.events;
	check("events: created, started, completed — same id, type, description", created?.channel === "subagents:created" && started?.channel === "subagents:started" && completed?.channel === "subagents:completed" && created.id === completed.id && created.type === "worker" && created.description === "count files", JSON.stringify(seat.events.map((e) => e.channel)));
	check("completed carries the whole result, a status field and usage.cost.total", completed?.result === "There are 42 files." && completed.status === "completed" && typeof completed.usage?.cost?.total === "number");
	// Ticket 09, ruled 2026-09-04: a worker's result needs a decision, so it does
	// not sit in the dock waiting for Joel to type — it opens a turn of its own.
	const delivered = await until(() => seat.customs().length > 0, 5000);
	await seat.session.waitForIdle();
	const notice = seat.customs()[0];
	check("a worker delivers on its own the moment it lands, with no prompt from Joel", delivered && notice?.customType === "subagent-notification" && notice.content.includes("<task-notification>") && notice.content.includes("<result>There are 42 files.</result>"), notice?.content?.slice(0, 200));
	check("its details are the rows' notice shape", notice?.details?.status === "completed" && notice.details.description === "count files" && notice.details.resultPreview === "There are 42 files.");
	check("and it closes with the act-on-this-or-stop line", notice?.content.trimEnd().endsWith("Act on this or stop. Don't summarise it back, don't re-read what the child read, don't re-verify what it reports as verified. Ending your turn silently is allowed and expected."), notice?.content?.slice(-120));
	check("the model was handed it in a turn Joel did not start", requests.some((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("<task-notification>"))));
	const childRequest = requests.find((r) => lastUserText({ messages: r.messages }).includes("Count the files."));
	check("the child's first user message opens with the worker tail", childRequest !== undefined && lastUserText({ messages: childRequest.messages }).startsWith("<sub_agent_context>\nYou are a **worker** named `counter`, depth 1 of 4. 1 agents are live."), childRequest && lastUserText({ messages: childRequest.messages }).slice(0, 120));
	check("and carries the shared-directory line", childRequest !== undefined && lastUserText({ messages: childRequest.messages }).includes("You share this directory with other agents."));
	const parentRequest = requests.find((r) => lastUserText({ messages: r.messages }) === "start a worker");
	const carried = (request) => (request?.tools ?? []).map((t) => t.name).sort().join();
	check("a type file with no tools list takes pi's selection: the child holds what its parent holds, less the deferred TaskStop", carried(childRequest) === "Agent,ListAgents,SendMessage,TaskOutput,bash,edit,read,write" && carried(parentRequest) === `${carried(childRequest)},TaskStop`.split(",").sort().join(), carried(childRequest));

	// Delivered once (C7): a later turn finds nothing left to drain.
	scriptFor("what did it say", [[text("42 files.")]]);
	await seat.session.prompt("what did it say");
	await seat.session.waitForIdle();
	check("a result already delivered is not delivered again by the next turn", seat.customs().length === 1, String(seat.customs().length));
	const entries = seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record");
	check("the registry is in the session file, latest status last", entries.length >= 3 && entries[entries.length - 1].data.status === "completed" && entries[entries.length - 1].data.readBy === "conversation", entries.map((e) => e.data.status).join());
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// The four lifecycle payloads the dock reads
//
// `agent-dock` and `agent-rows` were written against these keys (C1). The
// model is one of them: without it the dock's model column is blank, which is
// exactly what a reader saw after the vendor lookup it used to come from was
// deleted. A key more or a key fewer here is a contract change nobody asked for.
// ---------------------------------------------------------------------------
{
	console.log("\nthe lifecycle payloads the dock reads");
	const seat = await mainSeat();
	scriptFor("watch it think", [[call("Agent", { description: "think slowly", prompt: "Think slowly.", subagent_type: "worker", name: "thinker" })], [text("started it")]]);
	scriptFor("Think slowly.", [{ content: [text("Done thinking.")], delay: 800 }]);
	await seat.session.prompt("watch it think");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:started"));
	const started = seat.events.find((e) => e.channel === "subagents:started");
	check("a started event names the model the child runs on — the dock's blank column", started.model === "scripted/scripted-1", started.model);
	check("with the name, type and description the registry holds", started.name === "thinker" && started.type === "worker" && started.description === "think slowly", JSON.stringify({ name: started.name, type: started.type, description: started.description }));

	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 8000);
	const done = seat.events.find((e) => e.channel === "subagents:completed");
	check("a settled event carries the duration the dock row prints instead of `done`", typeof done.durationMs === "number" && done.durationMs > 0, done.durationMs);
	check("it still names the model, so a settled row is not blank either", done.model === "scripted/scripted-1", done.model);
	check("and it charged for the run it watched", done.usage.cost.total > 0);

	const keysOf = (channel) => Object.keys(seat.events.find((e) => e.channel === channel)).filter((key) => key !== "channel").sort().join(",");
	const BASE = "description,durationMs,id,model,name,status,toolUses,type,usage,workflowChild".split(",").sort().join(",");
	check("subagents:created keeps its ten fields", keysOf("subagents:created") === BASE, keysOf("subagents:created"));
	check("subagents:started keeps the same ten", keysOf("subagents:started") === BASE, keysOf("subagents:started"));
	// Ticket 59: without this on the wire the dock cannot tell a workflow's agent
	// from one the seat launched, and a twenty-item run puts twenty-one rows in a
	// list of "agents this seat is waiting on".
	check("every payload says whether the agent belongs to a workflow", seat.events.every((e) => typeof e.workflowChild === "boolean"));
	check("and a plain `Agent` child says it does not", started.workflowChild === false, String(started.workflowChild));
	check("subagents:completed adds the result and nothing else", keysOf("subagents:completed") === `${BASE},result`.split(",").sort().join(","), keysOf("subagents:completed"));
	check("no payload ever grew an `outcome`: the dock reads `status`", seat.events.every((e) => e.outcome === undefined));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// What the dock can see of a child while it runs
//
// Joel, 2026-09-05: "I can only see that we say it is running." The two facts
// that fixes it are here: the seat publishes the child's live session, so the
// box can draw its tool calls and talk to it, and the run emits its tool count
// and the moment of its last step, which otherwise reach the record only when
// the child settles — a running row would count zero tools forever.
// ---------------------------------------------------------------------------
{
	console.log("\nthe live view of a running child");
	const { agentRuntimeOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime-seam.ts`);
	const { AGENT_PROGRESS_CHANNEL } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const seat = await mainSeat();
	const progress = [];
	seat.bus.on(AGENT_PROGRESS_CHANNEL, (payload) => progress.push(payload));
	scriptFor("watch it work", [[call("Agent", { description: "grind away", prompt: "Grind away.", name: "grinder" })], [text("started it")]]);
	scriptFor("Grind away.", [{ delay: 200, content: [call("ListAgents", {})] }, { delay: 400, content: [text("Ground.")] }]);
	await seat.session.prompt("watch it work");
	await seat.session.waitForIdle();
	const runtime = agentRuntimeOf(seat.session.sessionManager.getSessionId());
	check("the seat publishes its runtime for the dock to read", runtime !== undefined);
	await until(() => seat.events.some((e) => e.channel === "subagents:started"));
	const taskId = seat.events.find((e) => e.channel === "subagents:started").id;
	const child = runtime?.liveRun(taskId);
	check("a running child hands over a live session", child !== undefined && typeof child.subscribe === "function" && typeof child.getToolDefinition === "function" && Array.isArray(child.messages), String(child === undefined));
	check("with the conversation the box draws from", child?.messages.some((m) => m.role === "user"), JSON.stringify(child?.messages.map((m) => m.role)));

	await until(() => progress.some((p) => p.toolUses > 0), 8000);
	const step = progress.find((p) => p.toolUses > 0);
	check("progress names the task and the agent the dock would send to", step?.id === taskId && step.name === "grinder", JSON.stringify(step));
	check("and carries the tool count the record does not have yet", step.toolUses === 1, JSON.stringify(step));
	check("with the moment of that step, so a row can say how stale it is", typeof step.lastActivityAt === "number" && Math.abs(Date.now() - step.lastActivityAt) < 60_000, String(step.lastActivityAt));
	const record = () => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === "grinder").map((e) => e.data).at(-1);
	check("which the record itself still says nothing about", record()?.toolUses === 0, String(record()?.toolUses));

	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 8000);
	check("the settled run is no longer live to the dock", runtime?.liveRun(taskId) === undefined);
	check("and the record has the count the progress events were tracking", record()?.toolUses === 1, String(record()?.toolUses));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A name never means the caller or a seat above it
//
// On 2026-09-03 a seat called `worker-1` ran `TaskOutput ["worker-1"]` and was
// told "Still running: worker-1": it had matched its own child, named after
// itself by the collision. Unique auto names close that door; a caller can
// still *choose* the name, so both the spawn and the address are refused.
// ---------------------------------------------------------------------------
{
	console.log("\na name that means the caller or an ancestor");
	const seat = await mainSeat();
	scriptFor("nest three deep", [[call("Agent", { description: "papa job", prompt: "Be papa.", name: "papa" })], [text("started papa")]]);
	scriptFor("Be papa.", [
		[call("Agent", { description: "twin job", prompt: "Never runs.", name: "papa" })],
		[call("TaskOutput", { names: ["papa"], block: false })],
		[call("Agent", { description: "kid job", prompt: "Be the kid.", name: "kid" })],
		[text("papa done")],
	]);
	scriptFor("Be the kid.", [[call("SendMessage", { to: "papa", message: "hi grandad" })], [call("Agent", { description: "impostor", prompt: "Never runs.", name: "papa" })], [text("kid done")]]);
	await seat.session.prompt("nest three deep");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "papa"), 15000);
	const recordsIn = (file) => SessionManager.open(file).getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data);
	const resultsIn = (file) => SessionManager.open(file).getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult").map((e) => e.message.content.map((b) => b.text).join(""));
	const papa = recordsIn(seat.session.sessionFile).filter((r) => r.name === "papa").at(-1);
	const papaResults = resultsIn(papa.sessionFile);
	check("a seat cannot name an agent after itself", papaResults[0]?.includes('"papa" is this seat\'s own name'), papaResults[0]);
	check("the refusal points at ListAgents", papaResults[0]?.includes("Run ListAgents to see the agents you started."), papaResults[0]);
	check("and cannot wait on its own name either", papaResults[1]?.includes('"papa" is this seat\'s own name'), papaResults[1]);
	const kid = recordsIn(papa.sessionFile).filter((r) => r.name === "kid").at(-1);
	const kidResults = resultsIn(kid.sessionFile);
	check("a grandchild cannot message a seat above it", kidResults[0]?.includes('"papa" is a seat above you in the agent tree, not an agent you started.'), kidResults[0]);
	check("nor name its own child after one", kidResults[1]?.includes('"papa" is a seat above you in the agent tree'), kidResults[1]);
	check("no impostor was ever started: papa's record is still the one the main seat holds", recordsIn(papa.sessionFile).every((r) => r.name !== "papa"), recordsIn(papa.sessionFile).map((r) => r.name).join());
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Auto-generated names are unique across the whole tree, not per seat
// ---------------------------------------------------------------------------
{
	console.log("\nauto-names under nesting and fan-out");
	const seat = await mainSeat();
	scriptFor("fan out and nest", [
		[call("Agent", { description: "branch a", prompt: "Nest deeper." }), call("Agent", { description: "branch b", prompt: "Stay shallow." })],
		[text("spawned two")],
	]);
	scriptFor("Nest deeper.", [[call("Agent", { description: "inner", prompt: "Innermost." })], [text("nested")]]);
	scriptFor("Innermost.", [[text("bottom")]]);
	scriptFor("Stay shallow.", [[text("shallow")]]);
	await seat.session.prompt("fan out and nest");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 8000);
	const recordsOf = (file) => SessionManager.open(file).getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => e.data);
	const top = recordsOf(seat.session.sessionFile);
	const topNames = [...new Set(top.map((r) => r.name))];
	check("two siblings spawned without names get two names", topNames.length === 2, topNames.join());
	const nested = top.find((r) => r.description === "branch a");
	const inner = [...new Set(recordsOf(nested.sessionFile).map((r) => r.name))];
	check("the nested seat auto-named its own child", inner.length === 1, inner.join());
	check("a grandchild's auto name collides with no name above it", !topNames.includes(inner[0]), `${topNames.join()} vs ${inner.join()}`);
	check("the names stay short and human-addressable, no hex ids (C2)", [...topNames, ...inner].every((name) => /^worker-\d+$/.test(name)), [...topNames, ...inner].join());
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Depth: four levels run, the fifth is refused with the ruled text
// ---------------------------------------------------------------------------
{
	console.log("\ndepth cap");
	const seat = await mainSeat();
	scriptFor("go deeper 0", [[call("Agent", { description: "depth 1", prompt: "go deeper 1", name: "d1" })], [text("started")]]);
	for (const d of [1, 2, 3, 4]) {
		scriptFor(`go deeper ${d}`, [[call("Agent", { description: `depth ${d + 1}`, prompt: `go deeper ${d + 1}`, name: `d${d + 1}` })], [text(`level ${d} done`)]]);
	}
	await seat.session.prompt("go deeper 0");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "d1"), 15000);
	const refused = requests.find((r) => r.messages.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("Agent depth limit (4) reached. Do the task yourself.")));
	check("a depth-5 spawn errors with the ruled text", refused !== undefined);
	const tails = requests.map((r) => lastUserText({ messages: r.messages })).filter((t) => t.includes("You are a **worker** named `d4`"));
	check("the depth-4 child's tail says depth 4 of 4", tails.some((t) => t.includes("depth 4 of 4")), tails[0]?.slice(0, 100));
	const completed = seat.events.filter((e) => e.channel === "subagents:completed");
	check("every level reported up: four completions, the seat's own child and three beneath it", completed.filter((e) => e.parentId === undefined).length === 1 && completed.filter((e) => e.parentId !== undefined).length === 3, JSON.stringify(completed.map((e) => [e.description, e.parentId])));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// An explorer is its own role: read-only tail, no edit, write or delegation
// ---------------------------------------------------------------------------
{
	console.log("\nspawn an explorer");
	const seat = await mainSeat();
	scriptFor("start an explorer", [[call("Agent", { description: "find things", prompt: "Find the things.", subagent_type: "explore", name: "finder" })], [text("started it")]]);
	scriptFor("Find the things.", [[text("Found.")]]);
	await seat.session.prompt("start an explorer");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed"));
	const childRequest = requests.find((r) => lastUserText({ messages: r.messages }).includes("Find the things."));
	const first = childRequest === undefined ? "" : lastUserText({ messages: childRequest.messages });
	check("the explorer's first message opens with the explorer tail", first.startsWith("<sub_agent_context>\nYou are an **explorer** named `finder`, depth 1 of 4."), first.slice(0, 120));
	check("and does not tell it to share the directory", !first.includes("You share this directory") && first.includes("You are read-only:"));
	const carriedByExplorer = childRequest === undefined ? [] : childRequest.tools.map((t) => t.name);
	check("its tools carry Edit and Write for its detail directory, and no delegation", carriedByExplorer.includes("read") && carriedByExplorer.includes("edit") && carriedByExplorer.includes("write") && ["Agent", "SendMessage", "TaskOutput", "TaskStop", "Workflow"].every((n) => !carriedByExplorer.includes(n)), carriedByExplorer.join());
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// The fork is dead (ticket 29 §3): "fork" is just an unknown type now
// ---------------------------------------------------------------------------
{
	console.log("\nno fork");
	const seat = await mainSeat();
	scriptFor("fork it", [[text("About to do it."), call("Agent", { description: "do the thing", prompt: "Do the thing.", subagent_type: "fork" })], [text("no fork, then")]]);
	await seat.session.prompt("fork it");
	await seat.session.waitForIdle();
	const refusal = seat.toolResults()[0]?.content[0].text ?? "";
	// The schema enum refuses it before the runtime does; either way no child starts and "fork" is not offered.
	check("a spawn asking for a fork is refused as an unknown type", /subagent_type/.test(refusal) && !refusal.includes('or "fork"'), refusal);
	check("no child session was started for it", !seat.events.some((e) => e.channel === "subagents:created"));
	seat.session.dispose();
}

await finish();
