/**
 * The background-agent task count, spelled once.
 *
 * `agent-dock` counts the agents this session launched and publishes the label
 * under one status key; `zen-chrome` reads that key back out of the footer data
 * and lets it into the bottom rule instead of the footer row. Two extensions,
 * one string — a count published under a key nobody renders is unrepresentable.
 *
 * The key is a *claim*, not a message: whoever renders it also has to hide it
 * from the ordinary footer, or the same fact is on screen twice.
 *
 * The label is only ever published while an agent is running, which is why the
 * chrome may light it for as long as it is drawn: on this chrome the light
 * means something is happening, and here being on screen is that.
 */

/** Status key the task count is published under. Read by `zen-chrome`'s bottom rule. */
export const AGENT_TASK_STATUS_KEY = "agents";

/**
 * `1 task ↓` / `3 tasks ↓`, or undefined at zero tasks, where nothing is drawn.
 *
 * The arrow is the affordance, not decoration: `↓` at an empty prompt is what
 * opens the list. No dot between the count and the arrow — they are one label.
 */
export function formatAgentTaskCount(count: number): string | undefined {
	if (!Number.isFinite(count)) return undefined;
	const tasks = Math.floor(count);
	if (tasks < 1) return undefined;
	return `${tasks} ${tasks === 1 ? "task" : "tasks"} ↓`;
}
