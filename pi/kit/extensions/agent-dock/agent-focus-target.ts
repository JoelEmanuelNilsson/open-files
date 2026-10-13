import { existsSync, statSync } from "node:fs";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AgentSession, buildSessionContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../../lib/agents/agent-registry.ts";
import type { AgentRuntime } from "../../lib/agents/agent-runtime.ts";
import type { ConversationSource, FocusTarget, FocusTheme } from "../../lib/session/prompt-focus.ts";
import { type AgentTask, isLiveAgentTask } from "./agent-task-registry.ts";
import { taskStatusText } from "./background-tasks-view.ts";

/** The runtime surface the agent view uses, so tests can hand it a fake. */
export type AgentFocusRuntime = Pick<AgentRuntime, "liveRun" | "send" | "followUp" | "childToolDefinition"> & {
	readonly registry: Pick<AgentRuntime["registry"], "byTaskId">;
};

/** What the agent view needs from the dock. */
export interface AgentFocusDeps {
	readonly runtime: AgentFocusRuntime;
	readonly taskId: string;
	readonly name: string;
	readonly task: () => AgentTask | undefined;
	readonly notify: (message: string, level: "info" | "warning" | "error") => void;
}

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function transcriptOnDisk(sessionFile: string | undefined): AgentMessage[] | undefined {
	if (sessionFile === undefined || !existsSync(sessionFile) || statSync(sessionFile).size === 0) return undefined;
	try {
		const manager = SessionManager.open(sessionFile);
		return buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
	} catch {
		return undefined;
	}
}

/** A settled agent's conversation from its session file, or its result or error as one answer when there is no transcript on disk. */
export function settledAgentSource(
	record: Pick<AgentRecord, "sessionFile" | "result" | "error">,
	toolDefinition: (name: string) => ToolDefinition | undefined,
): ConversationSource {
	const answer = record.error ?? record.result ?? "";
	const messages: AgentMessage[] = transcriptOnDisk(record.sessionFile) ?? (answer === "" ? [] : [
		{ role: "assistant", content: [{ type: "text", text: answer }], api: "anthropic-messages", provider: "", model: "", usage: NO_USAGE, stopReason: "stop", timestamp: 0 },
	]);
	return { messages, subscribe: () => () => {}, getToolDefinition: toolDefinition };
}

/** The line under a settled agent's feed: `✓ done`, `■ stopped` or `✗ <first line of the error>`, in the dock's words. */
export function settledAgentStatusLine(task: AgentTask, theme: FocusTheme): string {
	const detail = taskStatusText(task);
	if (task.status === "completed") return theme.fg("success", "✓ done") + (detail !== "" && detail !== "done" ? theme.fg("dim", ` · ${detail}`) : "");
	if (task.outcome === "stopped" || task.outcome === "aborted") return theme.fg("warning", `■ ${detail}`);
	const firstLine = task.error?.split("\n").find((line) => line.trim() !== "")?.trim();
	return theme.fg("error", `✗ ${firstLine ?? detail}`);
}

function userTextOf(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

interface QueuedAgentMessage {
	readonly text: string;
	readonly into: ConversationSource;
	readonly after: number;
}

/** One background agent, by task id, as a prompt target for the prompt focus controller. */
export function agentFocusTarget(deps: AgentFocusDeps): FocusTarget {
	const { runtime, taskId, name } = deps;
	let lastLive: AgentSession | undefined;
	let fromDisk: ConversationSource | undefined;
	let queued: QueuedAgentMessage[] = [];
	const description = deps.task()?.description ?? runtime.registry.byTaskId(taskId)?.description ?? "";

	const liveSession = (): AgentSession | undefined => (runtime.registry.byTaskId(taskId) === undefined ? undefined : runtime.liveRun(taskId));

	const source = (): ConversationSource | undefined => {
		const live = liveSession();
		if (live !== undefined) lastLive = live;
		if (lastLive !== undefined) return lastLive;
		const record = runtime.registry.byTaskId(taskId);
		if (record === undefined) return undefined;
		fromDisk ??= settledAgentSource(record, (tool) => runtime.childToolDefinition(tool));
		return fromDisk;
	};

	return {
		target: { kind: "agent", name },
		placement: "replace",
		marker: { text: description === "" ? `<AGENT ${name}>` : `<AGENT ${name} · ${description}>`, color: "accent" },
		source,
		statusLines: (theme, waiting) => {
			const task = deps.task();
			const settled = task !== undefined && !isLiveAgentTask(task);
			const current = source();
			queued = queued.filter(
				(entry) => !settled && entry.into === current && !entry.into.messages.slice(entry.after).some((message) => userTextOf(message) === entry.text),
			);
			const lines: string[] = [];
			if (settled) lines.push(` ${settledAgentStatusLine(task, theme)}`);
			else if (waiting) lines.push(` ${theme.fg("dim", "…")}`);
			for (const entry of queued) lines.push(` ${theme.fg("dim", `↳ queued: ${entry.text.replace(/\s+/g, " ")}`)}`);
			return lines;
		},
		submit: (text, images, how) => {
			if (images !== undefined && images.length > 0) {
				return { kind: "refused", reason: `Nothing sent to ${name}: an agent takes text only. The text is back in the editor; the images were not sent.` };
			}
			if (runtime.registry.byTaskId(taskId) === undefined) {
				return { kind: "refused", reason: `Nothing sent to ${name}: this session's agent engine does not hold it. The text is back in the editor.` };
			}
			const live = liveSession();
			const delivery = how === "followUp" ? runtime.followUp(taskId, text) : runtime.send(taskId, text, false, "Joel");
			delivery.catch((error: unknown) => {
				queued = queued.filter((entry) => entry.text !== text);
				deps.notify(`${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
			if (live?.isStreaming !== true) return { kind: "sent" };
			queued.push({ text, into: live, after: live.messages.length });
			return { kind: "queued" };
		},
		takesFollowUpKey: () => liveSession()?.isStreaming === true,
		interrupt: () => "leave",
		leave: () => {},
	};
}
