import { SessionManager } from "@earendil-works/pi-coding-agent";
import { agentIsSettled, type AgentRecord } from "../../lib/agents/agent-registry.ts";
import { formatSpendUsd } from "../../lib/agents/agent-spend.ts";
import type { AgentToolDetails } from "../../lib/agents/agent-tool-text.ts";
import type { AgentHold } from "../../lib/agents/agent-runtime.ts";


const MAX_TRANSCRIPT_CHARS = 20_000;

/** An agent record as the `details` of a tool result. */
export function agentToolDetailsOf(record: AgentRecord, status: string = record.status): AgentToolDetails {
	return {
		displayName: record.type,
		description: record.description,
		subagentType: record.type,
		toolUses: record.toolUses,
		outputTokens: record.outputTokens,
		costUsd: record.costUsd,
		status,
		agentId: record.taskId,
		name: record.name,
		...(record.error !== undefined ? { error: record.error } : {}),
	};
}

/** A plain text tool result, typed the way pi's `AgentToolResult` wants it (`details` present, undefined). */
export function textResult<TDetails>(text: string, details?: TDetails): { content: Array<{ type: "text"; text: string }>; details: TDetails | undefined } {
	return { content: [{ type: "text", text }], details };
}

function formatAge(sinceMs: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - sinceMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function firstLine(text: string | undefined): string {
	return (text ?? "").split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

export function deliveryText(record: AgentRecord, now: number): string {
	const clock = record.readAt === undefined ? "" : ` at ${new Date(record.readAt).toISOString().slice(11, 19)} (${formatAge(record.readAt, now)} ago)`;
	const where = record.sessionFile === undefined ? "" : ` · whole result: ${record.sessionFile}`;
	const phrase =
		record.readBy === "conversation"
			? `delivered to your conversation${clock}`
			: record.readBy === "handed"
				? "queued for your conversation; it arrives on its own before your next step — do not wait again"
				: record.readBy === "tool"
					? `returned to you by TaskOutput${clock}`
					: "consumed by the workflow that spawned it; it never enters your conversation";
	return `${phrase}${where}`;
}

export function endedAgentStopText(record: AgentRecord, now: number): string {
	const verdict = record.readBy === undefined ? "its result has not reached you yet — it arrives on its own" : deliveryText(record, now);
	return `Agent "${record.name}" already ended (${record.status}); ${verdict}.`;
}

/** The `Agent` tool's answer to a spawn: the run is in the background, and how its result arrives. */
export function agentStartedText(record: AgentRecord): string {
	return [
		"Agent started in background.",
		`Name: ${record.name}`,
		`Task ID: ${record.taskId}`,
		`Type: ${record.type}`,
		`Description: ${record.description}`,
		...(record.branch !== undefined ? [`Branch: ${record.branch}`] : []),
		"Its result is delivered to you when it lands (the dock shows ✓). Use TaskOutput only if you need it before you can continue.",
	].join("\n");
}

/** `SendMessage`'s answer, by how the message reached the agent. */
export function messageSentText(kind: "queued" | "interrupted" | "resumed", record: AgentRecord): string {
	return kind === "queued"
		? `Sent to ${record.name}; it reads the message at its next step.`
		: kind === "interrupted"
			? `Interrupted ${record.name}; it continues with your message now.`
			: `${record.name} resumed from its transcript with your message (task ${record.taskId}). It reports again when done.`;
}

/** What holds an idle agent and its last reply: `idle 12m on 2 agents · last reply: …`. */
export function agentHoldText(hold: AgentHold, now: number): string {
	const holder = hold.agents > 0 ? ` on ${hold.agents} agent${hold.agents === 1 ? "" : "s"}` : "";
	const last = firstLine(hold.lastText);
	return `idle ${formatAge(hold.idleSince, now)}${holder}${last === "" ? "" : ` · last reply: ${last}`}`;
}

/** One `ListAgents` row: name, type, status, clock, spend once settled, what holds it idle, and the first line of its result. */
export function agentListRow(record: AgentRecord, now: number, hold?: AgentHold): string {
	const settled = agentIsSettled(record.status);
	const clock = settled && record.completedAt !== undefined ? `ran ${formatAge(record.startedAt, record.completedAt)}` : formatAge(record.startedAt, now);
	const spend = settled ? formatSpendUsd(record.costUsd) : "";
	const unread = settled && record.readBy === undefined ? " (unread)" : "";
	const last = hold === undefined ? firstLine(record.result ?? record.error) : agentHoldText(hold, now);
	return [`${record.name} · ${record.type} · ${record.status}${unread}`, clock, spend, last].filter((part) => part !== "").join(" · ");
}

export function renderTranscript(sessionFile: string): string {
	try {
		const manager = SessionManager.open(sessionFile);
		const lines: string[] = [];
		for (const entry of manager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : message.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n");
				lines.push(`user: ${text}`);
			} else if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "text" && block.text.trim()) lines.push(`assistant: ${block.text}`);
					if (block.type === "toolCall") lines.push(`tool: ${block.name}(${JSON.stringify(block.arguments ?? {}).slice(0, 200)})`);
				}
			}
		}
		const text = lines.join("\n");
		if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
		return `[transcript truncated: ${text.length} characters, the last ${MAX_TRANSCRIPT_CHARS} kept. The whole of it is \`${sessionFile}\`.]\n\n${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`;
	} catch (error) {
		return `(transcript unavailable: ${error instanceof Error ? error.message : String(error)})`;
	}
}

/** Ticket 09's wording for a wait Joel cut short. */
export function interruptedWaitText(by: string, done: number, of: number): string {
	return `interrupted by ${by} — ${done} of ${of} done`;
}
