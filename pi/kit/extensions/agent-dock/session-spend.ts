/**
 * What this session has spent, as `/stats` reports it: the seat's own dollars
 * and one branch per agent it launched.
 *
 * Two readers, because the two halves arrive on different events and neither
 * can be derived from the other. The seat's own spend accumulates off
 * `message_end` — pi prices every assistant message and puts the number on
 * `usage.cost.total`. An agent's spend arrives once, whole, on the lifecycle
 * event that settles it (`extensions/agent-dock/agent-task-registry.ts`), which
 * is why a running agent contributes nothing and its row says `running` rather
 * than claiming `$0.00`.
 *
 * Scope, per C15: dollars on the dock row and a rollup here. **Nothing
 * model-facing** — no prompt, tool description or tail ever quotes a number
 * from this module. An agent told what it costs starts optimising for the meter
 * instead of the job.
 *
 * And dollars are a proxy, not the bill: Joel is on a subscription, so this is
 * only useful as a *ratio* between choices (fork versus brief, Opus versus
 * Haiku, high thinking versus medium). The allowance that actually runs out is
 * the server's, and only `lib/quota-meter.ts` can see it.
 */

import type { AgentSpendRow, AgentSpendTree } from "../../lib/agent-spend.ts";
import type { AgentTask } from "./agent-task-registry.ts";
import { isLiveAgentTask } from "./agent-task-registry.ts";

/**
 * Longest label a branch may carry before it is clipped.
 *
 * One column short of `lib/agent-spend.ts`'s amount column, so the longest
 * label still leaves a space before its dollars instead of running into them.
 */
export const SPEND_LABEL_LIMIT = 25;

/**
 * What pi charged for one assistant message, or `0` for anything that is not
 * one.
 *
 * Zero, not undefined: this is a term in a running sum, and a sum has no use
 * for "unknown". A model with no pricing data reports no cost and adds nothing,
 * which is the honest arithmetic — the total is what is *known* to have been
 * spent, and `renderAgentSpendTree` renders a zero total as nothing at all
 * rather than as `$0.00`.
 */
export function assistantCostUsd(message: unknown): number {
	if (typeof message !== "object" || message === null) return 0;
	const record = message as { role?: unknown; usage?: unknown };
	if (record.role !== "assistant") return 0;
	if (typeof record.usage !== "object" || record.usage === null) return 0;
	const cost = (record.usage as { cost?: unknown }).cost;
	if (typeof cost !== "object" || cost === null) return 0;
	const total = (cost as { total?: unknown }).total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

/** `worker price the fork`, clipped. The id stands in when the events named neither. */
function spendLabelOf(task: AgentTask): string {
	const label = [task.type, task.description].filter((part) => part !== "").join(" ").trim();
	if (label === "") return task.id;
	return label.length <= SPEND_LABEL_LIMIT ? label : `${label.slice(0, SPEND_LABEL_LIMIT - 1)}…`;
}

/**
 * The tree `/stats` renders: the seat, then the agents in the order the
 * registry hands them over.
 *
 * Order is the registry's — live first, then most recently settled — because
 * that is the order the dock modal shows and the two must not disagree about
 * the same session.
 */
export function agentSpendTreeOf(tasks: readonly AgentTask[], ownDollars: number): AgentSpendTree {
	const agents: AgentSpendRow[] = tasks.map((task) => ({
		label: spendLabelOf(task),
		dollars: task.costUsd ?? 0,
		live: isLiveAgentTask(task),
	}));
	return { ownDollars, agents };
}
