import { formatSpendUsd } from "../../lib/agents/agent-spend.ts";

/** Everything the outcome line reads. A zero or missing count is left out of the line. */
export interface AgentOutcome {
	status: string;
	toolUses: number;
	outputTokens?: number;
	costUsd?: number;
	error?: string;
}

/** `12.3k out`, `512 out` — the tokens an agent wrote. */
export function formatAgentOutputTokens(total: number): string {
	const rounded = Math.max(0, Math.round(total));
	if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M out`;
	if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1)}k out`;
	return `${rounded} out`;
}

/** `45 tools`, `1 tool`. The unit is the call, so it never dedupes. */
export function formatAgentToolUses(count: number): string {
	const rounded = Math.max(0, Math.round(count));
	return `${rounded} tool${rounded === 1 ? "" : "s"}`;
}

function agentStatusLead(status: string): string {
	switch (status) {
		case "error":
			return "Failed";
		case "stopped":
			return "Stopped";
		case "aborted":
			return "Aborted";
		default:
			return "Done";
	}
}

/** Whether this outcome is drawn in the error colour and keeps its row. */
export function agentOutcomeFailed(status: string): boolean {
	return status === "error" || status === "aborted";
}

export function agentOutcomeLine(outcome: AgentOutcome): string {
	const lead = agentStatusLead(outcome.status);
	if (outcome.status === "error") {
		const reason = (outcome.error ?? "").split("\n").find((line) => line.trim() !== "")?.trim();
		return reason ? `${lead} · ${reason}` : lead;
	}
	const clauses: string[] = [lead];
	if (outcome.toolUses > 0) clauses.push(formatAgentToolUses(outcome.toolUses));
	if ((outcome.outputTokens ?? 0) > 0) clauses.push(formatAgentOutputTokens(outcome.outputTokens ?? 0));
	const spend = formatSpendUsd(outcome.costUsd);
	if (spend !== "") clauses.push(spend);
	return clauses.join(" · ");
}
