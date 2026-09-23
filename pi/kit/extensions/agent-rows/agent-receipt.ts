/**
 * The engine's five tools, drawn as receipts.
 *
 *     ● Agent(where the parser lives)
 *       ⎿  Running in background
 *
 *     ● TaskOutput(quota-docs, quota-measured)
 *       ⎿  quota-docs · Done · 12 tools · 4.5k out · $0.12
 *          quota-measured · Failed · watchdog: aborted after 15m
 *
 * pi draws a tool it has no renderer for as `▸ Agent  desc` inside its own
 * padded box — three blank lines per row, and a different glyph vocabulary
 * from every other row in the transcript.
 *
 * This is the transcript's own components, not a copy of them: `CallHeader`
 * from `transcript/header.ts` and `ResultRow` from `transcript/result.ts`, with
 * the same dot, the same five-column gutter, the same `· 2.4s` past the same
 * floor. Nothing here re-derives a colour or a glyph.
 *
 * The rows are claimed rather than registered — see `lib/claim-tool-rows.ts` — so
 * the engine (`extensions/agent-engine.ts`) keeps the execute, the schema, the
 * description and the prompt guidelines, and nothing here can change what the
 * model sees.
 *
 * `watch` and `quiesce` in `transcript/row.ts` are the pair that turns a call
 * cut off mid-run into a hollow `○`, and they meet through the process-scoped
 * `transcript/planner-state.ts` rather than a map at module scope, so these
 * rows are quiesced by the same `quiesce()` `transcript/index.ts` calls even
 * though pi loaded this file with its own jiti. A row only goes hollow when no
 * result arrives at all: an interrupted `Agent` is answered with a `Stopped`
 * outcome, so that row settles with a receipt instead.
 */

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolRowSlots } from "../../lib/claim-tool-rows.ts";
import { CallHeader, headerPaints, stateOf } from "../transcript/header.ts";
import { outputLines, outputPreview, PREVIEW_LINES, ResultRow, resultPaints } from "../transcript/result.ts";
import { BLANK, type RenderContext, startClock, stopClock, watch } from "../transcript/row.ts";
import { launchBatchOf, launchRoleOf, noteLaunchOutcome, noteLaunchRow } from "./agent-launch-group.ts";
import { LaunchLine, launchLinePaints } from "./agent-launch-line.ts";
import { agentOutcomeFailed, agentOutcomeLine } from "./agent-outcome-line.ts";

/** The engine's `AgentDetails`, restated to the fields a row reads. */
interface AgentDetails {
	displayName?: string;
	description?: string;
	subagentType?: string;
	toolUses?: number;
	outputTokens?: number;
	costUsd?: number;
	status?: string;
	agentId?: string;
	error?: string;
}

function argsOf(context: RenderContext): Record<string, unknown> {
	return typeof context.args === "object" && context.args !== null ? (context.args as Record<string, unknown>) : {};
}

function stringArg(context: RenderContext, field: string): string {
	const value = argsOf(context)[field];
	return typeof value === "string" ? value : "";
}

function detailsOf(result: AgentToolResult<unknown>): AgentDetails | undefined {
	const details = result.details;
	return typeof details === "object" && details !== null ? (details as AgentDetails) : undefined;
}

function textOf(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const block of result.content) if (block.type === "text") parts.push(block.text);
	return parts.join("\n");
}

/** `● Agent(where the parser lives)` — the transcript's header, with our name in it. */
function header(name: string, argument: string, theme: Theme, context: RenderContext): Component {
	const state = stateOf(context);
	const component = context.lastComponent instanceof CallHeader ? context.lastComponent : new CallHeader();
	component.set({ state, name, argument, clipEnd: "tail", expanded: context.expanded }, headerPaints(theme, state));
	return component;
}

interface ResultLine {
	/** The words beside the gutter. Empty draws no line at all. */
	text: string;
	failed: boolean;
	/** Lines of payload the head line is not showing. */
	hidden?: number;
	/** The whole payload, drawn under the gutter when the row is open. */
	body?: string[];
	/**
	 * An agent's answer shown as the transcript's head preview: the first lines
	 * stand where the summary would, and `ResultRow` counts the rest in its own
	 * `… +N lines (ctrl+o to expand)` footer.
	 *
	 * A preview and a body are the same text, so a row carrying one carries
	 * neither the other nor a summary — that is what printed the first line twice
	 * the moment the row was opened.
	 */
	preview?: string[];
}

/** `⎿  Done · 45 tools · 142.1k tokens · 11m 21s` — the transcript's result row. */
function gutter(line: ResultLine, theme: Theme, context: RenderContext): Component {
	if (line.text === "" && !line.body?.length && !line.preview?.length) return BLANK;
	const row = context.lastComponent instanceof ResultRow ? context.lastComponent : new ResultRow();
	row.set(
		{
			// A failure puts its words in `body`, because that is the field
			// `ResultRow` paints in the error colour and elides from the head.
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

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * What the launch says about itself once it lands.
 *
 * A pre-execution failure — pi blocked the call, or the arguments would not
 * validate — arrives as `isError` with no status at all, so the reason is the
 * result text rather than an outcome.
 */
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
	// A blocking call returns the agent's whole answer, which is what `ctrl+o`
	// opens. The head line stays the outcome either way.
	const body = text.trim() === "" ? undefined : text.trimEnd().split("\n");
	return { text: line, failed: agentOutcomeFailed(status), body };
}

function renderAgentCall(_args: unknown, theme: Theme, context: RenderContext): Component {
	startClock(context);
	watch(context);
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
			displayName: details?.displayName ?? stringArg(context, "subagent_type") ?? "Agent",
			description: details?.description ?? stringArg(context, "description"),
		});
	}
	// The launch block draws its head and its tree from the call slot, so the
	// speaker's result slot has nothing left to add and the members have nothing
	// at all.
	const role = launchRoleOf(context);
	if (role !== "row") return BLANK;
	if (!settled) return BLANK;
	return gutter(agentResultLine(result, context), theme, context);
}

// ---------------------------------------------------------------------------
// SendMessage, ListAgents, TaskOutput, TaskStop
// ---------------------------------------------------------------------------

/** The engine's batch `details`, restated to the fields `TaskOutput` reads. */
interface BatchDetails {
	name?: string;
	status?: string;
	toolUses?: number;
	outputTokens?: number;
	totalCost?: number;
	error?: string;
	resultPreview?: string;
	others?: BatchDetails[];
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** `● TaskStop(quota-docs)` — a header, its name, and one argument off the call. */
function callRow(name: string, argument: (context: RenderContext) => string) {
	return (_args: unknown, theme: Theme, context: RenderContext): Component => {
		startClock(context);
		watch(context);
		return header(name, argument(context), theme, context);
	};
}

/**
 * A result slot for a tool whose answer is one line.
 *
 * The error branch is shared because all four fail the same way: the engine's
 * refusals throw, and pi hands the message back as the result text.
 */
function resultRow(line: (result: AgentToolResult<unknown>, context: RenderContext) => ResultLine) {
	return (result: AgentToolResult<unknown>, options: { isPartial: boolean; expanded: boolean }, theme: Theme, context: RenderContext): Component => {
		if (options.isPartial) return BLANK;
		if (context.isError) return gutter({ text: firstLine(textOf(result)) || "Failed", failed: true }, theme, context);
		return gutter(line(result, context), theme, context);
	};
}

/** `⎿  3 agents`, with the roster under `ctrl+o`. */
function listAgentsLine(result: AgentToolResult<unknown>): ResultLine {
	const rows = outputLines(textOf(result));
	// Every roster row carries ` · ` separators; the empty answer is one sentence.
	const agents = rows.filter((row) => row.includes(" · ")).length;
	if (agents === 0) return { text: firstLine(textOf(result)) || "No agents this session.", failed: false };
	return { text: `${agents} agent${agents === 1 ? "" : "s"}`, failed: false, body: rows };
}

/**
 * One line per agent whose result this call collected.
 *
 * Never the result text: that is the engine's `<task-notification>` XML, which
 * is the model's to read and was the whole of this row before ticket 31. The
 * agents' own words are in `details`, and `ctrl+o` is where they are drawn.
 */
function taskOutputLine(result: AgentToolResult<unknown>, context: RenderContext): ResultLine {
	const details = result.details;
	const first = typeof details === "object" && details !== null ? (details as BatchDetails) : undefined;
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

/** `⎿  Stopped · 12 tools · 4.5k out · $0.12`, with whatever the run had written under it. */
function taskStopLine(result: AgentToolResult<unknown>): ResultLine {
	const details = detailsOf(result);
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

// ---------------------------------------------------------------------------

/** The tool names this kit draws rows for. */
export const SUBAGENT_TOOL_NAMES = ["Agent", "SendMessage", "ListAgents", "TaskOutput", "TaskStop"] as const;

/**
 * The claim, ready for `claimToolRows`.
 *
 * `renderShell: "self"` on all five: pi's default is a `Box` with a column of
 * padding and a blank line either side, and a two-line receipt inside it is five
 * lines of mostly nothing.
 *
 * All five tools, because a tool pi has no renderer for prints its result text
 * whole — and four of these answer with fielded XML the model reads and nobody
 * should have to (issues/31 (a)). `test/renderers.mjs` fails when a sixth
 * arrives without a row.
 */
export function agentRowSlots(): Record<string, ToolRowSlots> {
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
				const names = argsOf(context).names;
				return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string").join(", ") : "";
			}),
			renderResult: resultRow(taskOutputLine),
		},
		TaskStop: { renderShell: "self", renderCall: callRow("TaskStop", (context) => stringArg(context, "name")), renderResult: resultRow(taskStopLine) },
	};
}
