import {
	type BashToolDetails,
	createBashToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { Container, Text } from "@earendil-works/pi-tui";
import { BACKGROUND_NOTIFICATION, completionNotice, describeTask } from "../../lib/tools/background-task-notification.ts";
import { ENDED_WITH_SESSION_NOTICE } from "../../lib/tools/bash-result-notices.ts";
import { backgroundHint, BASH_DESCRIPTION, bashParams } from "../../lib/tools/bash-tool.ts";
import { notice } from "../../lib/process/human-notice.ts";
import { ensurePrivateDir } from "../../lib/process/kit-state-dir.ts";
import { backgroundDir } from "../../lib/tools/background-task-log.ts";
import { deliveredBackgroundTask, endBackgroundTasksOf, heldLogPaths, reofferHeldBackgroundTasks, stashTasksEndedWithSession, takeTasksEndedWithSession } from "../../lib/tools/background-tasks.ts";
import { sweepStaleLogs } from "../../lib/tools/log-sweep.ts";
import { childSeatOf, isChildSeat } from "../../lib/session/seat-identity.ts";
import { createSessionScope } from "../../lib/session/session-scope.ts";
import { registerAbortBoundedTool } from "../../lib/tools/tool-abort-bound.ts";
import { receipt } from "../../lib/transcript/tool-receipt.ts";
import { transcriptEnabled } from "../../lib/transcript/tool-row.ts";
import { type BackgroundNoticeDetails, renderBackgroundNotice } from "./background-notice-row.ts";
import { createBashExecution } from "./bash-execution.ts";

// biome-ignore lint/suspicious/noExplicitAny: matching pi's own `AnyToolDefinition` shape for inference only
type RenderState = ReturnType<typeof createBashToolDefinition> extends ToolDefinition<any, any, infer S> ? S : never;


export default function bash(pi: ExtensionAPI) {
	const scope = createSessionScope(pi);
	let seat: "main" | "agent" | "unattended" | undefined;

	const vanilla = createBashToolDefinition(process.cwd());
	const execution = createBashExecution({ scope, seat: () => seat, notify });

	function rows(): Pick<ToolDefinition<typeof bashParams, BashToolDetails | undefined, RenderState>, "renderShell" | "renderCall" | "renderResult"> {
		if (transcriptEnabled()) return receipt("bash");
		const renderResult = vanilla.renderResult;
		return {
			renderCall: vanilla.renderCall,
			renderResult: renderResult
				? (result, renderOptions, theme, context) => {
						const component = renderResult(result, renderOptions, theme, context);
						if ((seat === undefined || seat === "main") && renderOptions.isPartial && !context.isError && component instanceof Container) {
							component.addChild(new Text(theme.fg("muted", `\n${backgroundHint()}`), 0, 0));
						}
						return component;
					}
				: undefined,
		};
	}

	function define() {
		const definition: ToolDefinition<typeof bashParams, BashToolDetails | undefined, RenderState> = {
			name: "bash",
			label: "bash",
			description: BASH_DESCRIPTION,
			parameters: bashParams,
			promptGuidelines: vanilla.promptGuidelines,
			execute: execution.execute,
			...rows(),
		};
		return definition;
	}

	function notify(content: string, details: BackgroundNoticeDetails, label: string): "turned" | "appended" | "failed" {
		try {
			const message = { customType: BACKGROUND_NOTIFICATION, content, display: true, details };
			if (scope.startTurn(message)) return "turned";
			pi.sendMessage(message, { triggerTurn: false });
			return "appended";
		} catch (error) {
			notice(undefined, `bash: ${label} — could not notify: ${error instanceof Error ? error.message : String(error)}`, "error");
			return "failed";
		}
	}

	registerAbortBoundedTool(pi, define(), () => "The command may still be running, since its kill did not settle; check for it with ps before running it again.");

	if (transcriptEnabled()) pi.registerMessageRenderer(BACKGROUND_NOTIFICATION, renderBackgroundNotice);

	pi.on("before_agent_start", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const headless = ctx.mode === "print" || ctx.mode === "json";
		seat = childSeatOf(sessionId)?.receivesTaskNotices === true ? "agent" : headless || isChildSeat(event.systemPromptOptions, process.argv, sessionId) ? "unattended" : "main";
	});

	function reportTasksEndedWithSession(sessionId: string): void {
		const unsent = takeTasksEndedWithSession(sessionId).filter((task) => {
			const content = task.how === "killed-with-owner" ? `${completionNotice(task)}\n${ENDED_WITH_SESSION_NOTICE}` : completionNotice(task);
			return notify(content, { id: task.id, command: task.command, exitCode: task.exitCode, signal: task.signal, logPath: task.logPath, durationMs: task.durationMs }, describeTask(task)) === "failed";
		});
		stashTasksEndedWithSession(sessionId, unsent);
	}

	pi.on("agent_start", (_event, ctx) => {
		reportTasksEndedWithSession(ctx.sessionManager.getSessionId());
		reofferHeldBackgroundTasks(ctx.sessionManager.getSessionId());
	});

	pi.on("message_end", (event, ctx) => {
		const { message } = event;
		if (message.role !== "custom" || message.customType !== BACKGROUND_NOTIFICATION) return;
		// SAFETY: messages with customType BACKGROUND_NOTIFICATION are only emitted by this extension with BackgroundNoticeDetails details
		const details = message.details as BackgroundNoticeDetails;
		if (details.stalled !== true && details.id !== undefined) deliveredBackgroundTask(ctx.sessionManager.getSessionId(), details.id);
	});

	pi.registerShortcut("ctrl+b", {
		description: "Move running bash commands to the background",
		handler: (ctx) => {
			const moved = execution.backgroundAll();
			ctx.ui.notify(moved === 0 ? "bash: nothing is running in the foreground" : `bash: ${moved} command${moved === 1 ? "" : "s"} moved to the background`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		reportTasksEndedWithSession(ctx.sessionManager.getSessionId());
		void sweepStaleLogs({ backgroundDir: ensurePrivateDir(backgroundDir()), tmpDir: tmpdir(), held: heldLogPaths() }).catch(() => {});
	});

	pi.on("session_shutdown", (event, ctx) => {
		execution.killAll();
		const ended = endBackgroundTasksOf(ctx.sessionManager.getSessionId());
		if (event.reason !== "quit") stashTasksEndedWithSession(ctx.sessionManager.getSessionId(), ended);
	});
}
