import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { renderAgentSpendTree } from "../../lib/agents/agent-spend.ts";
import { notice } from "../../lib/process/human-notice.ts";
import { createSessionScope } from "../../lib/session/session-scope.ts";
import { agentRuntimeOf } from "../../lib/agents/agent-runtime-seam.ts";
import { AGENT_TASK_STATUS_KEY, formatAgentTaskCount } from "../../lib/agents/agent-task-count.ts";
import { workflowRunsOf } from "../../lib/workflow/workflow-run-store.ts";
import { AGENT_LIFECYCLE_CHANNELS, AGENT_PROGRESS_CHANNEL, AgentTaskRegistry, isWorkflowRunTask } from "./agent-task-registry.ts";
import { showWorkflowRunView } from "./workflow-run-view.ts";
import { promptFocusOf } from "../../lib/session/prompt-focus.ts";
import { promptTargetOf } from "../../lib/session/prompt-target.ts";
import { agentFocusTarget } from "./agent-focus-target.ts";
import { ROW_FRAME_MS, showBackgroundTasksView } from "./background-tasks-view.ts";
import { ModalRepaint } from "./modal-repaint.ts";
import { agentSpendTreeOf, assistantCostUsd } from "./session-spend.ts";
import { readPromptEditorKeyState, shouldOpenTasksList, tasksLabelKey } from "./open-tasks-on-down-key.ts";

const ENABLED = (process.env.PI_AGENT_DOCK ?? "").toLowerCase() !== "off";

const PROBE_WIDGET_KEY = "agent-dock";

const STOP_REPLY_TIMEOUT_MS = 5_000;


export default function (pi: ExtensionAPI) {
	if (!ENABLED) return;

	const scope = createSessionScope(pi);
	const registry = new AgentTaskRegistry();
	let context: ExtensionContext | undefined;
	let sessionId = "";
	let tui: TUI | undefined;
	let unbindInput: (() => void) | undefined;
	let modalOpen = false;
	const modal = new ModalRepaint(ROW_FRAME_MS);
	let stopRequestSeq = 0;
	let ownDollars = 0;

	function publishTaskCount(): void {
		if (!context) return;
		try {
			context.ui.setStatus(AGENT_TASK_STATUS_KEY, formatAgentTaskCount(registry.liveCount()));
		} catch {
		}
	}

	function repaint(): void {
		if (modalOpen) modal.paint();
		else tui?.requestRender();
	}

	for (const [channel, kind] of AGENT_LIFECYCLE_CHANNELS) {
		pi.events.on(channel, (payload) => {
			if (!registry.applyLifecycleEvent(kind, payload, Date.now())) return;
			publishTaskCount();
			repaint();
		});
	}

	pi.events.on(AGENT_PROGRESS_CHANNEL, (payload) => {
		if (registry.applyProgressEvent(payload, Date.now())) repaint();
	});

	pi.events.on("workflow:progress", () => repaint());

	function stopAgentTask(id: string): void {
		if (!registry.markStopRequested(id)) return;
		repaint();
		const requestId = `agent-dock-${++stopRequestSeq}-${Date.now()}`;
		let settled = false;
		const abandonStop = (reason: string | undefined) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			if (!registry.markStopRequested(id, false)) return;
			if (reason) context?.ui.notify(`Stop refused: ${reason}`, "warning");
			repaint();
		};
		const unsubscribe = pi.events.on(`subagents:rpc:stop:reply:${requestId}`, (reply) => {
			// SAFETY: the stop RPC replies with { success, error } or null; every field is read through a typeof check
			const envelope = reply as { success?: unknown; error?: unknown } | null;
			if (envelope?.success === true) {
				settled = true;
				unsubscribe();
				return;
			}
			abandonStop(typeof envelope?.error === "string" ? envelope.error : "no reason given");
		});
		scope.timeout(STOP_REPLY_TIMEOUT_MS, () => abandonStop(undefined));
		pi.events.emit("subagents:rpc:stop", { requestId, agentId: id });
	}

	function focusAgent(taskId: string, name: string): void {
		const focus = promptFocusOf(sessionId);
		const runtime = agentRuntimeOf(sessionId);
		if (focus === undefined || runtime === undefined) {
			context?.ui.notify("The agent view needs side-chat's prompt focus and the agent engine on this seat.", "warning");
			return;
		}
		focus.focus(
			agentFocusTarget({
				runtime,
				taskId,
				name,
				task: () => registry.get(taskId),
				notify: (message, level) => context?.ui.notify(message, level),
			}),
		);
	}

	async function runTasksModal(ctx: ExtensionContext): Promise<void> {
		let selectedId: string | undefined;
		for (;;) {
			const exit = await showBackgroundTasksView(
				ctx,
				{
					tasks: () => registry.list(),
					runOf: (id) => workflowRunsOf(sessionId).byTaskId(id),
					stop: stopAgentTask,
					selectedId,
					mainRow: () => (promptTargetOf(sessionId)?.kind === "agent" ? (ctx.isIdle() ? "idle" : "working") : undefined),
				},
				(refresh) => modal.attach(refresh, () => registry.liveCount() > 0),
			);
			modal.detach();
			if (exit.kind === "closed") return;
			if (exit.kind === "main") {
				promptFocusOf(sessionId)?.exit();
				return;
			}
			selectedId = exit.id;
			const chosen = registry.get(exit.id);
			if (chosen !== undefined && isWorkflowRunTask(chosen)) {
				const runId = chosen.runId;
				await showWorkflowRunView(
					ctx,
					{
						run: () => (runId === undefined ? undefined : workflowRunsOf(sessionId).get(runId)),
						agentTask: (taskId) => registry.get(taskId),
						stopRun: () => stopAgentTask(exit.id),
						stopAgent: stopAgentTask,
					},
					(refresh) => modal.attach(refresh, () => registry.liveCount() > 0),
				);
				modal.detach();
				continue;
			}
			if (chosen?.parentId !== undefined) {
				ctx.ui.notify("A nested agent's conversation can't be opened here; x in the list stops it.", "warning");
				continue;
			}
			const name = chosen?.name ?? "";
			if (name === "") {
				ctx.ui.notify("This agent has no name to follow, so it cannot be focused.", "warning");
				continue;
			}
			focusAgent(exit.id, name);
			return;
		}
	}

	function openTasksModal(): void {
		if (!context || modalOpen) return;
		modalOpen = true;
		const ctx = context;
		runTasksModal(ctx)
			.catch((error) => {
				try {
					ctx.ui.notify(`Tasks did not open: ${error instanceof Error ? error.message : String(error)}`, "error");
				} catch {}
			})
			.finally(() => {
				modalOpen = false;
				modal.detach();
			});
	}

	function handleTerminalInput(data: string): { consume?: boolean } | undefined {
		if (!context) return undefined;
		const key = tasksLabelKey(data);
		if (key !== "down") return undefined;
		// SAFETY: focusedComponent is optional on pi's TUI; the value stays unknown and is shape-checked by readPromptEditorKeyState
		const focused = (tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		const open = shouldOpenTasksList({
			key,
			editor: readPromptEditorKeyState(focused),
			liveTaskCount: registry.liveCount(),
			agentFocused: promptTargetOf(sessionId)?.kind === "agent",
			modalOpen,
		});
		if (!open) return undefined;
		openTasksModal();
		return { consume: true };
	}

	pi.on("session_start", (_event, sessionContext) => {
		if (sessionContext.mode !== "tui") return;
		context = sessionContext;
		sessionId = sessionContext.sessionManager.getSessionId();
		registry.clear();
		ownDollars = 0;
		unbindInput?.();
		unbindInput = sessionContext.ui.onTerminalInput(handleTerminalInput);
		sessionContext.ui.setWidget(
			PROBE_WIDGET_KEY,
			(widgetTui) => {
				tui = widgetTui;
				return { render: () => [], invalidate: () => {} };
			},
			{ placement: "belowEditor" },
		);
		publishTaskCount();
	});

	pi.on("message_end", (event) => {
		// SAFETY: message_end events carry message; assistantCostUsd checks its shape
		ownDollars += assistantCostUsd((event as { message?: unknown }).message);
	});

	pi.registerCommand("stats", {
		description: "What this session has spent: the seat, each agent it launched, and the total",
		handler: async (_args, commandContext) => {
			const lines = renderAgentSpendTree(agentSpendTreeOf(registry.list(), ownDollars, registry.trimmedSpend()));
			const body = ownDollars <= 0 && registry.list().length === 0 && registry.trimmedSpend().agents === 0 ? "This session has spent nothing yet." : lines.join("\n");
			notice(commandContext, body, "info");
		},
	});

	pi.on("session_shutdown", () => {
		unbindInput?.();
		unbindInput = undefined;
		context = undefined;
		tui = undefined;
	});
}
