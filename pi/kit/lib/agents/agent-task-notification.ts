import type { AgentReadBy, AgentRecord } from "./agent-registry.ts";
import { DELIVERED_RESULT_INSTRUCTION } from "./agent-tool-text.ts";

/** One result, as the parent's conversation receives it. */
export interface AgentNotification {
	readonly content: string;
	readonly details: AgentNotificationDetails;
}

/** `agent-rows`' `SubagentNotificationDetails`, plus the agent's name. */
export interface AgentNotificationDetails {
	id: string;
	name: string;
	description: string;
	status: string;
	toolUses: number;
	totalTokens: number;
	outputTokens: number;
	totalCost: number;
	durationMs: number;
	waitedMs: number;
	error?: string;
	resultPreview?: string;
	others?: AgentNotificationDetails[];
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderTaskNotification(record: AgentRecord, now: number, by: AgentReadBy): string {
	const duration = record.completedAt !== undefined ? record.completedAt - record.startedAt : 0;
	return [
		"<task-notification>",
		`<task-id>${escapeXml(record.taskId)}</task-id>`,
		`<agent-name>${escapeXml(record.name)}</agent-name>`,
		record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
		`<status>${record.status}</status>`,
		`<summary>Agent "${escapeXml(record.description)}" ${record.status}${record.error ? `: ${escapeXml(record.error)}` : ""}</summary>`,
		record.sessionFile !== undefined ? `<session-file>${escapeXml(record.sessionFile)}</session-file>` : null,
		record.completedAt !== undefined ? `<settled-at>${new Date(record.completedAt).toISOString()}</settled-at>` : null,
		by === "handed" ? `<queued-at>${new Date(now).toISOString()}</queued-at>` : `<read-at>${new Date(now).toISOString()}</read-at>`,
		by !== "handed" && record.completedAt !== undefined ? `<settled-ago>${formatWaited(waitedMsOf(record, now))} before you read this</settled-ago>` : null,
		`<result>${escapeXml(record.result ?? "No output.")}</result>`,
		`<usage><total_tokens>${record.totalTokens}</total_tokens><output_tokens>${record.outputTokens}</output_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${duration}</duration_ms></usage>`,
		"</task-notification>",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

function waitedMsOf(record: AgentRecord, now: number): number {
	return record.completedAt === undefined ? 0 : Math.max(0, now - record.completedAt);
}

function formatWaited(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function notificationDetails(record: AgentRecord, now: number): AgentNotificationDetails {
	return {
		id: record.taskId,
		name: record.name,
		description: record.description,
		status: record.status,
		toolUses: record.toolUses,
		totalTokens: record.totalTokens,
		outputTokens: record.outputTokens,
		totalCost: record.costUsd,
		durationMs: record.completedAt !== undefined ? record.completedAt - record.startedAt : 0,
		waitedMs: waitedMsOf(record, now),
		...(record.error !== undefined ? { error: record.error } : {}),
		...(record.result !== undefined ? { resultPreview: record.result.length > 300 ? `${record.result.slice(0, 300)}…` : record.result } : {}),
	};
}

/** One message carrying every result in `records`, for a turn to read at once. */
export function batchNotification(records: readonly AgentRecord[], now: number, by: AgentReadBy): AgentNotification {
	const [first, ...rest] = records;
	if (first === undefined) throw new Error("batchNotification: no records");
	const details = notificationDetails(first, now);
	if (rest.length > 0) details.others = rest.map((record) => notificationDetails(record, now));
	const body = records.map((record) => renderTaskNotification(record, now, by)).join("\n\n");
	const header = records.length === 1 ? "" : `${records.length} agents finished.\n\n`;
	return { content: `${header}${body}\n\n${DELIVERED_RESULT_INSTRUCTION}`, details };
}
