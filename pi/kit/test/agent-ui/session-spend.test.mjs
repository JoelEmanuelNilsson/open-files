/**
 * What the session spent, as `/stats` reports it: the seat's own dollars off
 * each assistant message, one branch per agent it launched, and the command
 * itself driven through the dock's entry.
 *
 *   node test/agent-ui/session-spend.test.mjs
 */

import { check, eq, finish } from "../support/check-harness.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const spend = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/session-spend.ts`);

// ---------------------------------------------------------------------------
// C15: a tree rollup in `/stats`, no money on a dock row, and nothing
// model-facing. The dollars are a proxy for quota, useful as a ratio
// between choices — the allowance itself is only ever the server's, and only
// `extensions/wire/quota-meter.ts` can see it.
console.log("session-spend: what the session spent");
{
	const { assistantCostUsd, agentSpendTreeOf, SPEND_LABEL_LIMIT } = spend;

	eq("an assistant message reports what pi charged for it",
		assistantCostUsd({ role: "assistant", usage: { cost: { total: 0.0123 } } }), 0.0123);
	eq("a user message costs the seat nothing", assistantCostUsd({ role: "user", usage: { cost: { total: 9 } } }), 0);
	eq("a message with no usage costs nothing", assistantCostUsd({ role: "assistant" }), 0);
	eq("an unpriced model costs nothing rather than NaN", assistantCostUsd({ role: "assistant", usage: { cost: {} } }), 0);
	eq("a non-message is not a charge", assistantCostUsd(undefined), 0);

	const tasks = [
		{ id: "a1", type: "worker", description: "price the fork", status: "completed", costUsd: 0.42 },
		{ id: "a2", type: "explore", description: "find the defect", status: "running", costUsd: undefined },
		{ id: "a3", type: "", description: "", status: "failed", costUsd: 0.08 },
	];
	const tree = agentSpendTreeOf(tasks, 2.41);
	eq("the seat's own spend is the root", tree.ownDollars, 2.41);
	eq("one branch per agent, in the order given", tree.agents.map((agent) => agent.label),
		["worker price the fork", "explore find the defect", "a3"]);
	eq("a running agent is live, and contributes nothing yet", [tree.agents[1].live, tree.agents[1].dollars], [true, 0]);
	eq("a settled agent is not live", tree.agents[0].live, false);
	eq("a failed agent still reports what it spent", tree.agents[2].dollars, 0.08);

	const long = agentSpendTreeOf([{ id: "a4", type: "worker", description: "x".repeat(80), status: "completed", costUsd: 1 }], 0);
	check("a long description is clipped so the amounts stay a column",
		long.agents[0].label.length <= SPEND_LABEL_LIMIT && long.agents[0].label.endsWith("…"), long.agents[0].label);

	const { renderAgentSpendTree } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-spend.ts`);
	const lines = renderAgentSpendTree(tree);
	check("the rollup reads as a table", lines[0] === "main                      $2.41" && lines.at(-1) === "total                     $2.91", JSON.stringify(lines));
}

console.log("\nsession-spend: agents the list has trimmed still count");
{
	const { AgentTaskRegistry, SETTLED_TASK_LIMIT, SETTLED_TASK_GRACE_MS } = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/agent-task-registry.ts`);
	const registry = new AgentTaskRegistry();
	const launched = SETTLED_TASK_LIMIT + 5;
	for (let index = 0; index < launched; index++) {
		const at = index * SETTLED_TASK_GRACE_MS * 2;
		registry.applyLifecycleEvent("started", { id: `t${index}`, type: "worker", description: `job ${index}` }, at);
		registry.applyLifecycleEvent("completed", { id: `t${index}`, usage: { cost: { total: 1 } } }, at);
	}
	registry.applyLifecycleEvent("started", { id: "c1", type: "worker", description: "child", workflowChild: true }, launched * SETTLED_TASK_GRACE_MS * 2);
	eq("the list keeps only its limit", registry.list().length, SETTLED_TASK_LIMIT);
	const tree = spend.agentSpendTreeOf(registry.list(), 0, registry.trimmedSpend());
	eq("the trimmed agents are one branch", tree.agents.at(-1).label, "5 earlier agents");
	eq("and the tree still sums every agent launched", tree.agents.reduce((sum, agent) => sum + agent.dollars, 0), launched);
	registry.clear();
	eq("a new conversation forgets the trimmed spend", registry.trimmedSpend().agents, 0);
	registry.applyLifecycleEvent("completed", { id: "own", type: "lead", description: "lead", usage: { cost: { total: 2 } } }, 0);
	registry.applyLifecycleEvent("completed", { id: "its", type: "worker", description: "its worker", parentId: "own", usage: { cost: { total: 3 } } }, 0);
	eq("/stats branches only on the agents this seat launched", spend.agentSpendTreeOf(registry.list(), 0).agents.map((agent) => agent.label), ["lead lead"]);
}

// ---------------------------------------------------------------------------
console.log("\nsession-spend: /stats, driven through the fake ExtensionAPI");
{
	const pi = fakeExtensionApi();
	const { commands } = pi;
	const emit = (channel, payload) => pi.api.events.emit(channel, payload);
	const notices = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "session-stats" },
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			notify: (message) => notices.push(message),
			theme: { fg: (_c, t) => t },
		},
	};
	await (await jiti.import(`${KIT_ROOT}/extensions/agent-dock/index.ts`, { default: true }))(pi.api);
	await pi.fire("session_start", {}, ctx);

	check("/stats is registered — pi has no such command of its own", commands.has("stats"));

	await commands.get("stats").handler("", ctx);
	eq("a session that has spent nothing says so", notices.at(-1).includes("nothing"), true);

	await pi.fire("message_end", { message: { role: "assistant", usage: { cost: { total: 0.2 } } } }, ctx);
	await pi.fire("message_end", { message: { role: "assistant", usage: { cost: { total: 0.05 } } } }, ctx);
	await pi.fire("message_end", { message: { role: "user", usage: { cost: { total: 99 } } } }, ctx);
	emit("subagents:started", { id: "a1", type: "worker", description: "price the fork" });
	emit("subagents:completed", { id: "a1", usage: { cost: { total: 0.42 } }, durationMs: 2_400 });
	emit("subagents:started", { id: "a2", type: "explore", description: "still going" });

	await commands.get("stats").handler("", ctx);
	const report = notices.at(-1);
	check("the seat's own turns are summed", report.includes("main") && report.includes("$0.25"), report);
	check("a settled agent is a branch with its dollars", report.includes("worker price the fork") && report.includes("$0.42"), report);
	check("a running agent says running, not $0.00", /still going\s+running/.test(report), report);
	check("the total is the seat plus its agents", report.includes("$0.67"), report);
	// C15: cost visibility only. The quota line is ticket 18's open question and
	// is not ruled, so `/stats` says nothing about the allowance.
	check("nothing here claims to know the quota", !report.includes("5h ") && !report.includes("7d "), report);

	await pi.fire("session_start", {}, ctx);
	await commands.get("stats").handler("", ctx);
	check("a new conversation starts from zero", notices.at(-1).includes("nothing"), notices.at(-1));
}

await finish();
