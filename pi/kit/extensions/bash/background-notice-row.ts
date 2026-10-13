import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { backgroundStatus } from "../../lib/tools/background-task-notification.ts";
import { formatCallDuration } from "../../lib/transcript/call-summary.ts";
import { CallHeader, headerPaints } from "../../lib/transcript/call-header.ts";
import { ResultRow, resultPaints } from "../../lib/transcript/result-row.ts";

/** What a `<background-task-notification>` carries beside its text. */
export interface BackgroundNoticeDetails {
	id?: number;
	command?: string;
	exitCode?: number | null;
	signal?: string | null;
	logPath?: string;
	durationMs?: number;
	stalled?: boolean;
}

export function renderBackgroundNotice(message: { details?: unknown }, options: { expanded: boolean }, theme: Theme): Container | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null) return undefined;
	// SAFETY: details was narrowed to a non-null object above; every field of BackgroundNoticeDetails is read through optional checks below
	const notice = details as BackgroundNoticeDetails;
	const stalled = notice.stalled === true;
	const status = stalled ? "Waiting for input" : backgroundStatus({ exitCode: notice.exitCode ?? null, signal: notice.signal ?? null });
	const failed = !stalled && status !== "Done";
	const line = notice.id === undefined ? status : `${status} · task ${notice.id}`;

	const container = new Container();
	const state = failed ? "error" : "done";
	const header = new CallHeader();
	header.set({ state, name: "Bash", argument: notice.command ?? "", clipEnd: "tail", expanded: options.expanded }, headerPaints(theme, state));
	container.addChild(header);

	const row = new ResultRow();
	const log = options.expanded && notice.logPath !== undefined ? [`Log: ${notice.logPath}`] : undefined;
	row.set(
		{
			summary: failed ? null : { kind: "note", text: line, tone: "muted" },
			body: failed ? [line, ...(log ?? [])] : log,
			error: failed,
			duration: formatCallDuration(notice.durationMs ?? 0),
			expanded: options.expanded,
		},
		resultPaints(theme),
	);
	container.addChild(row);
	return container;
}
