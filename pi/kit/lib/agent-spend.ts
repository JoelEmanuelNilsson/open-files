/**
 * What this session's work cost, in dollars — one spelling of money for the
 * dock row and for `/stats`, so the two can never disagree about the same
 * agent.
 *
 * Dollars are a proxy, not the bill. Joel is on a subscription: the money is
 * priced off `pi/models.json` and is only useful as a *ratio* between choices
 * (fork versus brief, Opus versus Haiku, high versus medium thinking). The
 * quota that actually runs out is the server's, and only `lib/quota-meter.ts`
 * can see it. Both instruments exist because neither answers the other's
 * question.
 *
 * Scope, per C15: a tree rollup in `/stats`, which Joel opens deliberately, a
 * settled agent's cost on its `ListAgents` row, which only the model reads —
 * money as diagnosis — and a finished agent's transcript row, which Joel reads
 * beside how long it took (issues/31 (d)). **Never on a dock row**: a task row answers "how long is
 * this taking", and a `· $0.42` was put there once and rejected. No prompt and
 * no role tail ever quotes a number from here either: an agent told what *it*
 * costs starts optimising for the meter instead of the job.
 *
 * The rollup is only ever as complete as the events it was fed: a subagent
 * reports its usage when it *finishes* (`subagents:completed` / `:failed`), so
 * a running agent contributes nothing to the total and its row says `running`
 * rather than claiming `$0.00`. That is the honest reading, and it is why the
 * total is "spent so far", not "spent".
 */

/** How much one row of the tree cost, and whether that number is final. */
export interface AgentSpendRow {
	/** What the row is called, e.g. `worker Research: prices`. Already shortened by the caller. */
	readonly label: string;
	/** Dollars this agent has reported. Zero while it is still running. */
	readonly dollars: number;
	/** True while the agent is queued or running, so its cost is not final. */
	readonly live: boolean;
}

/** The seat and the top-level agents it launched. Nested children report through their owner. */
export interface AgentSpendTree {
	/** Dollars this seat's own assistant messages cost. */
	readonly ownDollars: number;
	readonly agents: readonly AgentSpendRow[];
}

/**
 * Column the dollar amounts start at, so the tree reads as a table rather than
 * a ragged list. A longer label pushes its own amount right instead of
 * reflowing every other row.
 */
const SPEND_LABEL_WIDTH = 26;

/**
 * Dollars as the dock and `/stats` write them: `$1.24`, `$1,234.50`,
 * `<$0.01` for real-but-tiny spend, and the empty string for nothing.
 *
 * Sub-cent spend gets its own token rather than `$0.00`, because `$0.00` reads
 * as "free" and the whole point of the meter is that nothing is. Nothing at all
 * — a zero, or a model with no pricing data — renders as nothing, so a row is
 * never decorated with a number that was never measured.
 */
export function formatSpendUsd(dollars: number | undefined): string {
	if (dollars === undefined || !Number.isFinite(dollars) || dollars <= 0) return "";
	if (dollars < 0.005) return "<$0.01";
	return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `label` padded to the amount column, then the amount. */
function spendLine(label: string, right: string): string {
	return `${label.padEnd(SPEND_LABEL_WIDTH)}${right}`.trimEnd();
}

/**
 * The `/stats` body: the seat, one branch per top-level agent, then the total.
 *
 * A seat that launched nothing is one line — a tree with no branches is a list
 * of one, and a `total` that repeats the only row above it is noise.
 */
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
