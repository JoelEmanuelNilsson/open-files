/** Status key the task count is published under. Read by `zen-chrome`'s bottom rule. */
export const AGENT_TASK_STATUS_KEY = "agents";

export function formatAgentTaskCount(count: number): string | undefined {
	if (!Number.isFinite(count)) return undefined;
	const tasks = Math.floor(count);
	if (tasks < 1) return undefined;
	return `${tasks} ${tasks === 1 ? "task" : "tasks"} ↓`;
}
