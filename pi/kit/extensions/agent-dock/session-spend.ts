import type { AgentSpendRow, AgentSpendTree } from "../../lib/agents/agent-spend.ts";
import type { AgentTask, TrimmedSpend } from "./agent-task-registry.ts";
import { isLiveAgentTask } from "./agent-task-registry.ts";

export const SPEND_LABEL_LIMIT = 25;

export function assistantCostUsd(message: unknown): number {
	if (typeof message !== "object" || message === null) return 0;
	// SAFETY: message was checked to be a non-null object; fields are read through typeof checks
	const record = message as { role?: unknown; usage?: unknown };
	if (record.role !== "assistant") return 0;
	if (typeof record.usage !== "object" || record.usage === null) return 0;
	// SAFETY: usage was checked to be a non-null object on the previous line
	const cost = (record.usage as { cost?: unknown }).cost;
	if (typeof cost !== "object" || cost === null) return 0;
	// SAFETY: cost was checked to be a non-null object on the previous line
	const total = (cost as { total?: unknown }).total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function spendLabelOf(task: AgentTask): string {
	const label = [task.type, task.description].filter((part) => part !== "").join(" ").trim();
	if (label === "") return task.id;
	return label.length <= SPEND_LABEL_LIMIT ? label : `${label.slice(0, SPEND_LABEL_LIMIT - 1)}…`;
}

export function agentSpendTreeOf(tasks: readonly AgentTask[], ownDollars: number, trimmed: TrimmedSpend = { agents: 0, dollars: 0 }): AgentSpendTree {
	const agents: AgentSpendRow[] = tasks.filter((task) => task.parentId === undefined).map((task) => ({
		label: spendLabelOf(task),
		dollars: task.costUsd ?? 0,
		live: isLiveAgentTask(task),
	}));
	if (trimmed.agents > 0) agents.push({ label: `${trimmed.agents} earlier ${trimmed.agents === 1 ? "agent" : "agents"}`, dollars: trimmed.dollars, live: false });
	return { ownDollars, agents };
}
