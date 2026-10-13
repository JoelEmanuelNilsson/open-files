import { readFileSync } from "node:fs";
import { readAgentRuns, type AgentRecord } from "./agent-registry.ts";

function entryCostUsd(entry: { message?: { usage?: { cost?: { total?: unknown } } }; usage?: { cost?: { total?: unknown } } }): number {
	const total = (entry.message?.usage ?? entry.usage)?.cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

export function agentSpendUsd(agent: Pick<AgentRecord, "sessionId" | "sessionFile">): number {
	if (agent.sessionFile === undefined) return 0;
	let text: string;
	try {
		text = readFileSync(agent.sessionFile, "utf8");
	} catch {
		return 0;
	}
	const entries = text.split("\n").flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
	const own = entries.reduce((sum, entry) => sum + entryCostUsd(entry), 0);
	return [...readAgentRuns(entries, agent.sessionId).values()].reduce((sum, child) => sum + agentSpendUsd(child), own);
}

/** How much one row of the tree cost, and whether that number is final. */
export interface AgentSpendRow {
	readonly label: string;
	readonly dollars: number;
	readonly live: boolean;
}

/** The seat and the top-level agents it launched. Nested children report through their owner. */
export interface AgentSpendTree {
	readonly ownDollars: number;
	readonly agents: readonly AgentSpendRow[];
}

const SPEND_LABEL_WIDTH = 26;

export function formatSpendUsd(dollars: number | undefined): string {
	if (dollars === undefined || !Number.isFinite(dollars) || dollars <= 0) return "";
	if (dollars < 0.005) return "<$0.01";
	return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function spendLine(label: string, right: string): string {
	return `${label.padEnd(SPEND_LABEL_WIDTH)}${right}`.trimEnd();
}

export function renderAgentSpendTree(tree: AgentSpendTree): string[] {
	const lines = [spendLine("main", formatSpendUsd(tree.ownDollars))];
	if (tree.agents.length === 0) return lines;

	for (const [index, agent] of tree.agents.entries()) {
		const stem = index === tree.agents.length - 1 ? "└ " : "├ ";
		const right = agent.live ? "running" : formatSpendUsd(agent.dollars);
		lines.push(spendLine(`${stem}${agent.label}`, right));
	}

	const total = tree.agents.reduce((sum, agent) => sum + agent.dollars, tree.ownDollars);
	lines.push("", spendLine("total", formatSpendUsd(total)));
	return lines;
}
