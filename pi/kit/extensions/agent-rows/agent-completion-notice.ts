/**
 * A background agent has landed, said in one row.
 *
 *     ● Agent(where the parser lives)
 *       ⎿  Done · 45 tools · 12.3k out · $0.12 · 11m 21s
 *
 *     ● Agent(audit the error paths)
 *       ⎿  Failed · watchdog: aborted after 15m of silence
 *
 * The engine sends this as a custom message with `customType:
 * "subagent-notification"`. With no renderer it draws in pi's default grammar:
 * a boxed custom message, four lines where the transcript spends two, in a
 * shape no other row here uses. The kit registers a renderer for that
 * `customType` and, because
 * `registerMessageRenderer` is first-wins in load order
 * (`extensions/runner.js`, `getMessageRenderer`), and the kit registers the
 * only renderer for this type.
 *
 * **Only the drawing is ours.** The message the engine sends
 * (`lib/agent-runtime.ts`) is the message the model reads, unchanged: the
 * `<task-notification>` XML, its `<result>` and its `<usage>` block. Nothing
 * here is re-sent, nothing is consumed, and there is no second copy of that
 * text to drift.
 *
 * A group notification carries the first agent in `details` and the rest in
 * `details.others`, so it draws one pair of lines per agent, in order, with a
 * blank line between them — the same margin `renderShell: "self"` gives every
 * tool row, and without it three finished agents read as one six-line block.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { CallHeader, headerPaints } from "../transcript/header.ts";
import { ResultRow, resultPaints } from "../transcript/result.ts";
import { formatDuration } from "../transcript/summary.ts";
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

/** The custom message type a finished background agent is announced on. */
export const SUBAGENT_NOTIFICATION_TYPE = "subagent-notification";

interface CustomMessage {
	details?: unknown;
}

/**
 * The two lines one finished agent gets, appended to `into`.
 *
 * The header wears the settled dot — `success` or `error` — rather than the
 * running dim, because a notice only ever describes work that is over.
 */
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
			duration: formatDuration(details.durationMs ?? 0),
			expanded,
		},
		resultPaints(theme),
	);
	into.addChild(row);
}

/**
 * The renderer to hand `pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, …)`.
 *
 * Returns `undefined` when the message carries no details, which is pi's signal
 * to fall back — ours is the only renderer pi resolved, so pi draws its default
 * custom-message box and the text is still on screen. A renderer must never throw: pi catches it and falls
 * back too, but it would take the notice's shape with it silently.
 */
export function renderSubagentNotification(message: CustomMessage, options: { expanded: boolean }, theme: Theme): Container | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null) return undefined;
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
