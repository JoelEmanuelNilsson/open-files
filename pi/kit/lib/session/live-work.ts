import { liveAgentsOf } from "../agents/agent-live-runs.ts";
import { backgroundTasksOf } from "../tools/background-tasks.ts";
import { workflowRunsOf } from "../workflow/workflow-run-store.ts";

/** Counts of live work in `sessionId` as phrases such as `2 agents`; empty when a reload would end nothing. */
export function liveWorkOf(sessionId: string): string[] {
	return [
		[liveAgentsOf(sessionId).size, "agents"],
		[backgroundTasksOf(sessionId).length, "background tasks"],
		[workflowRunsOf(sessionId).list().filter((run) => run.status === "running").length, "workflow runs"],
	].flatMap(([count, label]) => (count === 0 ? [] : [`${count} ${label}`]));
}
