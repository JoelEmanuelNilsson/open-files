import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { CallHeader, headerPaints, stateOf } from "../../lib/transcript/call-header.ts";
import { outputLines, outputPreview, PREVIEW_LINES, ResultRow, resultPaints } from "../../lib/transcript/result-row.ts";
import { BLANK, type RenderContext, startClock, stopClock, watchInFlightRow } from "../../lib/transcript/tool-row.ts";
import type { AgentNotificationDetails } from "../../lib/agents/agent-task-notification.ts";
import type { AgentToolDetails } from "../../lib/agents/agent-tool-text.ts";
import { type TaskEndDetails, taskOutputCallOf, type TaskOutputDetails, taskStopCallOf, type TaskStopDetails } from "../../lib/agents/task-tool-calls.ts";
import { backgroundStatus } from "../../lib/tools/background-task-notification.ts";
import { launchBadgeOf, launchBatchOf, launchRoleOf, noteLaunchOutcome, noteLaunchRow } from "./agent-launch-group.ts";
import { LaunchLine, launchLinePaints } from "./agent-launch-line.ts";
import { agentOutcomeFailed, agentOutcomeLine } from "./agent-outcome-line.ts";


function argsOf(context: RenderContext): Record<string, unknown> {
	// SAFETY: context.args was checked to be a non-null object in this expression
	return typeof context.args === "object" && context.args !== null ? (context.args as Record<string, unknown>) : {};
}

function stringArg(context: RenderContext, field: string): string {
	const value = argsOf(context)[field];
	return typeof value === "string" ? value : "";
}

function detailsOf(result: AgentToolResult<unknown>): Partial<AgentToolDetails> | undefined {
	const details = result.details;
	// SAFETY: details was checked to be a non-null object; Partial makes every field optional
	return typeof details === "object" && details !== null ? (details as Partial<AgentToolDetails>) : undefined;
}

function textOf(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const block of result.content) if (block.type === "text") parts.push(block.text);
	return parts.join("\n");
}

function header(name: string, argument: string, theme: Theme, context: RenderContext): Component {
	const state = stateOf(context);
	const component = context.lastComponent instanceof CallHeader ? context.lastComponent : new CallHeader();
	component.set({ state, name, argument, clipEnd: "tail", expanded: context.expanded }, headerPaints(theme, state));
	return component;
}

interface ResultLine {
	text: string;
	failed: boolean;
	hidden?: number;
	body?: string[];
	preview?: string[];
}

function gutter(line: ResultLine, theme: Theme, context: RenderContext): Component {
	if (line.text === "" && !line.body?.length && !line.preview?.length) return BLANK;
	const row = context.lastComponent instanceof ResultRow ? context.lastComponent : new ResultRow();
	row.set(
		{
			summary: line.failed || line.preview ? null : { kind: "note", text: line.text, tone: "muted" },
			preview: line.preview,
			hidden: line.hidden,
			body: line.failed ? [line.text, ...(line.body ?? [])] : line.preview ? undefined : line.body,
			error: line.failed,
			duration: stopClock(context),
			expanded: context.expanded,
		},
		resultPaints(theme),
	);
	return row;
}

function agentResultLine(result: AgentToolResult<unknown>, context: RenderContext): ResultLine {
	const details = detailsOf(result);
	const text = textOf(result);
	const status = details?.status;
	if (context.isError || !status) {
		const reason = text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "Failed";
		return { text: `Failed · ${reason}`, failed: true };
	}
	if (status === "background" || status === "queued") {
		return { text: "Running in background", failed: false };
	}
	if (status === "running") return { text: "", failed: false };

	const line = agentOutcomeLine({
		status,
		toolUses: details?.toolUses ?? 0,
		outputTokens: details?.outputTokens ?? 0,
		costUsd: details?.costUsd ?? 0,
		error: details?.error,
	});
	const body = text.trim() === "" ? undefined : text.trimEnd().split("\n");
	return { text: line, failed: agentOutcomeFailed(status), body };
}

function renderAgentCall(_args: unknown, theme: Theme, context: RenderContext): Component {
	startClock(context);
	watchInFlightRow(context);
	noteLaunchRow(context);

	const role = launchRoleOf(context);
	if (role === "hidden") return BLANK;
	if (role === "block") {
		const batch = launchBatchOf(context.toolCallId);
		const line = context.lastComponent instanceof LaunchLine ? context.lastComponent : new LaunchLine();
		const settled = batch?.settled === true;
		line.set({ outcomes: batch?.outcomes ?? [], calls: batch?.calls ?? [], settled }, launchLinePaints(theme, settled));
		return line;
	}
	return header("Agent", stringArg(context, "description"), theme, context);
}

function renderAgentResult(
	result: AgentToolResult<unknown>,
	options: { isPartial: boolean; expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	const settled = !options.isPartial;
	if (settled) {
		const details = detailsOf(result);
		noteLaunchOutcome(context.toolCallId, {
			status: context.isError ? "error" : (details?.status ?? "completed"),
			displayName: launchBadgeOf(details?.displayName ?? stringArg(context, "subagent_type")),
			description: details?.description ?? stringArg(context, "description"),
		});
	}
	const role = launchRoleOf(context);
	if (role !== "row") return BLANK;
	if (!settled) return BLANK;
	return gutter(agentResultLine(result, context), theme, context);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

function callRow(name: string, argument: (context: RenderContext) => string) {
	return (_args: unknown, theme: Theme, context: RenderContext): Component => {
		startClock(context);
		watchInFlightRow(context);
		return header(name, argument(context), theme, context);
	};
}

function resultRow(line: (result: AgentToolResult<unknown>, context: RenderContext) => ResultLine) {
	return (result: AgentToolResult<unknown>, options: { isPartial: boolean; expanded: boolean }, theme: Theme, context: RenderContext): Component => {
		if (options.isPartial) return BLANK;
		if (context.isError) return gutter({ text: firstLine(textOf(result)) || "Failed", failed: true }, theme, context);
		return gutter(line(result, context), theme, context);
	};
}

function listAgentsLine(result: AgentToolResult<unknown>): ResultLine {
	const rows = outputLines(textOf(result));
	const agents = rows.filter((row) => row.includes(" · ")).length;
	if (agents === 0) return { text: firstLine(textOf(result)) || "No agents this session.", failed: false };
	return { text: `${agents} agent${agents === 1 ? "" : "s"}`, failed: false, body: rows };
}

function unreachable(value: never): never {
	throw new Error(`unhandled form ${JSON.stringify(value)}`);
}

type ReadTaskOutputDetails = Exclude<TaskOutputDetails, { kind: "agents" }> | { kind: "agents"; batch: Partial<AgentNotificationDetails> | undefined };

type ReadTaskStopDetails = Exclude<TaskStopDetails, { kind: "agents" }> | { kind: "agents"; agent: Partial<AgentToolDetails> | undefined };

function writtenDetails<T extends { kind: string }>(result: AgentToolResult<unknown>, before: (details: object | undefined) => T): T {
	const { details } = result;
	if (typeof details !== "object" || details === null) return before(undefined);
	// SAFETY: the \"kind\" discriminator is present, which only AgentToolDetails producers set
	return "kind" in details ? (details as T) : before(details);
}

function taskEndLine(details: TaskEndDetails, prefix: string): ResultLine {
	return { text: `${prefix}${backgroundStatus(details)}`, failed: false };
}

function taskOutputLine(result: AgentToolResult<unknown>, context: RenderContext): ResultLine {
	const details = writtenDetails<ReadTaskOutputDetails>(result, (batch) => ({ kind: "agents", batch }));
	switch (details.kind) {
		case "agents":
			return batchLine(details.batch, result, context);
		case "task":
			switch (details.outcome) {
				case "finished":
					return taskEndLine(details, "");
				case "running":
				case "aborted":
					return { text: "Still running", failed: false };
				case "timed-out":
					return { text: "Timed out · still running", failed: false };
				case "noticed":
					return { text: "Ended · its result is queued for your conversation", failed: false };
				case "owner-ended":
					return { text: "Ended with your session", failed: false };
				default:
					return unreachable(details);
			}
		default:
			return unreachable(details);
	}
}

function batchLine(first: Partial<AgentNotificationDetails> | undefined, result: AgentToolResult<unknown>, context: RenderContext): ResultLine {
	if (first === undefined) return { text: firstLine(textOf(result)) || "Nothing to report", failed: false };
	const all = [first, ...(Array.isArray(first.others) ? first.others : [])];
	const rows: string[] = [];
	for (const one of all) {
		const outcome = agentOutcomeLine({
			status: one.status ?? "completed",
			toolUses: one.toolUses ?? 0,
			outputTokens: one.outputTokens ?? 0,
			costUsd: one.totalCost ?? 0,
			error: one.error,
		});
		rows.push(`${one.name ?? "Agent"} · ${outcome}`);
		if (context.expanded && one.resultPreview) rows.push(...one.resultPreview.trimEnd().split("\n").map((line) => `  ${line}`));
	}
	const { lines, hidden } = context.expanded ? { lines: rows, hidden: 0 } : outputPreview(rows.join("\n"), PREVIEW_LINES);
	return { text: lines[0] ?? "", failed: false, preview: lines, hidden };
}

function taskStopLine(result: AgentToolResult<unknown>): ResultLine {
	const details = writtenDetails<ReadTaskStopDetails>(result, (agent) => ({ kind: "agents", agent }));
	switch (details.kind) {
		case "agents":
			return stoppedAgentLine(details.agent, result);
		case "task":
			switch (details.outcome) {
				case "stopping":
					return { text: "Stopping", failed: false };
				case "in-conversation":
					return { text: "Already ended", failed: false };
				case "ended":
					return taskEndLine(details, "Already ended · ");
				default:
					return unreachable(details);
			}
		default:
			return unreachable(details);
	}
}

function stoppedAgentLine(details: Partial<AgentToolDetails> | undefined, result: AgentToolResult<unknown>): ResultLine {
	const status = details?.status ?? "stopped";
	const line = agentOutcomeLine({
		status,
		toolUses: details?.toolUses ?? 0,
		outputTokens: details?.outputTokens ?? 0,
		costUsd: details?.costUsd ?? 0,
		error: details?.error,
	});
	return { text: line, failed: agentOutcomeFailed(status), body: outputLines(textOf(result)) };
}

/** The three render fields of a tool definition. */
export type ToolRenderers = Pick<ToolDefinition<any, any, any>, "renderShell" | "renderCall" | "renderResult">;

export function agentRowSlots(): Record<string, ToolRenderers> {
	return {
		Agent: { renderShell: "self", renderCall: renderAgentCall, renderResult: renderAgentResult },
		SendMessage: {
			renderShell: "self",
			renderCall: callRow("SendMessage", (context) => stringArg(context, "to")),
			renderResult: resultRow((result) => ({ text: firstLine(textOf(result)) || "Sent", failed: false })),
		},
		ListAgents: { renderShell: "self", renderCall: callRow("ListAgents", () => ""), renderResult: resultRow(listAgentsLine) },
		TaskOutput: {
			renderShell: "self",
			renderCall: callRow("TaskOutput", (context) => {
				const call = taskOutputCallOf(context.args);
				switch (call.kind) {
					case "agents":
						return call.names.join(", ");
					case "task":
						return `task ${call.id}`;
					case "invalid":
						return "";
					default:
						return unreachable(call);
				}
			}),
			renderResult: resultRow(taskOutputLine),
		},
		TaskStop: {
			renderShell: "self",
			renderCall: callRow("TaskStop", (context) => {
				const call = taskStopCallOf(context.args);
				switch (call.kind) {
					case "agents":
						return call.name;
					case "task":
						return `task ${call.id}`;
					case "invalid":
						return "";
					default:
						return unreachable(call);
				}
			}),
			renderResult: resultRow(taskStopLine),
		},
	};
}
