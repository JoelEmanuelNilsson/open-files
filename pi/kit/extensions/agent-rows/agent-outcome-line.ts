/**
 * What a finished agent is allowed to say about itself in one line.
 *
 *     ⎿  Done · 45 tools · 12.3k out · $0.12 · 11m 21s
 *     ⎿  Failed · ENOENT: no such file or directory
 *
 * The four facts Joel asked for (issues/31 (d)): how many tools, how much
 * work, how expensive, how long. The work is the tokens the agent *wrote*.
 * The context size it ended on is on the record and in the notification the
 * model reads, not here: a row printing two token numbers makes its reader do
 * arithmetic to find the one that means work.
 *
 * One spelling, shared by the two places an agent's outcome is drawn: the tool
 * row of a blocking `Agent` call, and the completion notice that arrives when a
 * background one lands. They are the same fact and must not be two sentences.
 *
 * The duration is not in the text. It is the receipt's `· 2.4s` suffix, which
 * `result.ts` already owns and drops first on a narrow pane, spelled by the
 * transcript's own `formatDuration` — so the kit says how long something took in
 * exactly one way. Money is spelled by `lib/agent-spend.ts` for the same reason.
 *
 * Every unit is pluralised on its own count: `1 tool`, `2 tools`. A clause whose
 * count is zero is not written at all — `0 tools` reads as a fact worth
 * reporting, and it is not.
 */

import { formatSpendUsd } from "../../lib/agent-spend.ts";

/** Terminal statuses the engine reports on a record, plus the two live ones. */
export type AgentStatus = "completed" | "steered" | "error" | "stopped" | "aborted" | "background" | "queued" | "running";

/** Everything the outcome line reads. A zero or missing count is left out of the line. */
export interface AgentOutcome {
	status: string;
	toolUses: number;
	/** Tokens the agent wrote: the work it did, which no cached re-read inflates. */
	outputTokens?: number;
	/** Dollars the run cost, spelled by {@link formatSpendUsd}. */
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

/** The lead word for a terminal status: what happened, in one word. */
export function agentStatusLead(status: string): string {
	switch (status) {
		case "error":
			return "Failed";
		case "stopped":
			return "Stopped";
		case "aborted":
			return "Aborted";
		case "steered":
			return "Wrapped up";
		default:
			return "Done";
	}
}

/** Whether this outcome is drawn in the error colour and keeps its row. */
export function agentOutcomeFailed(status: string): boolean {
	return status === "error" || status === "aborted";
}

/**
 * The whole line, minus the gutter and minus the duration.
 *
 * A failure says why instead of saying how much: the first line of the error is
 * the thing that was looked for, and the tool and token counts of a run that
 * did not finish are not a result. A `stopped` run is a human's decision rather
 * than a fault, so it keeps its counts.
 */
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
