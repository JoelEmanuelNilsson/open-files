import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { CallHeader, headerPaints } from "../../lib/transcript/call-header.ts";
import { ResultRow, resultPaints } from "../../lib/transcript/result-row.ts";
import { formatCallDuration } from "../../lib/transcript/call-summary.ts";
import { agentOutcomeFailed, agentOutcomeLine } from "./agent-outcome-line.ts";

/** The engine's `NotificationDetails`, restated to the fields this row reads. */
export interface SubagentNotificationDetails {
	id?: string;
	description?: string;
	status?: string;
	toolUses?: number;
	outputTokens?: number;
	totalCost?: number;
	durationMs?: number;
	error?: string;
	resultPreview?: string;
	others?: SubagentNotificationDetails[];
}

interface CustomMessage {
	details?: unknown;
}

function appendNoticeRows(into: Container, details: SubagentNotificationDetails, theme: Theme, expanded: boolean): void {
	const status = details.status ?? "completed";
	const failed = agentOutcomeFailed(status);
	const line = agentOutcomeLine({
		status,
		toolUses: details.toolUses ?? 0,
		outputTokens: details.outputTokens ?? 0,
		costUsd: details.totalCost ?? 0,
		error: details.error,
	});

	const state = failed ? "error" : "done";
	const header = new CallHeader();
	header.set({ state, name: "Agent", argument: details.description ?? "", clipEnd: "tail", expanded }, headerPaints(theme, state));
	into.addChild(header);

	const preview = (details.resultPreview ?? "").trimEnd();
	const row = new ResultRow();
	row.set(
		{
			summary: failed ? null : { kind: "note", text: line, tone: "muted" },
			body: failed ? [line] : expanded && preview !== "" ? preview.split("\n") : undefined,
			error: failed,
			duration: formatCallDuration(details.durationMs ?? 0),
			expanded,
		},
		resultPaints(theme),
	);
	into.addChild(row);
}

export function renderSubagentNotification(message: CustomMessage, options: { expanded: boolean }, theme: Theme): Container | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null) return undefined;
	// SAFETY: details was checked to be a non-null object; fields are read defensively below
	const first = details as SubagentNotificationDetails;
	const all = [first, ...(Array.isArray(first.others) ? first.others : [])];
	const container = new Container();
	let drawn = 0;
	for (const one of all) {
		if (typeof one !== "object" || one === null) continue;
		if (drawn > 0) container.addChild(new Spacer(1));
		appendNoticeRows(container, one, theme, options.expanded === true);
		drawn++;
	}
	return container;
}
