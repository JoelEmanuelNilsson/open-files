/**
 * agent-dock — the background agents this session is waiting on, as a count in
 * the bottom rule and a modal behind `↓`.
 *
 *     ╰─ main ──────────────── 2 tasks ↓ ───── 1m 12s ████⣿⣿ 31.4% ─╯
 *
 * The count is published as one status (`lib/agent-task-count.ts`) and
 * `zen-chrome` lets that key into the rule instead of the footer row, so the
 * whole feature costs zero rows: nothing at zero tasks, no hint row, and the
 * arrow in the label is the only affordance there is.
 *
 * `↓` at an empty prompt opens the list in the prompt box's place
 * (`open-tasks-on-down-key.ts` owns the key and the reason). Inside it, Enter
 * opens one agent's conversation in a box
 * (`agent-conversation-box.ts`), `x` stops one over the engine's RPC bus,
 * Esc leaves. Leaving the box comes back to the list, on the same row.
 *
 * Enter on a **workflow run** opens a different view — the run's phases and
 * their agents (`workflow-run-view.ts`), and one agent from there. A run is not
 * a conversation: it has no session of its own, and the thing worth reading is
 * the tree, so the two views are two shapes rather than one shape with a
 * branch in it. The run's own agents are not rows in the list at all; they are
 * rows in that view.
 *
 * The box follows the child's live session, taken off the runtime seam
 * (`lib/agent-runtime-seam.ts`), and anything typed into it goes back through
 * `AgentRuntime.send`, which is the only place that knows whether the child
 * needs a prompt or a steer.
 *
 * Three things about the seams, because none of them is the obvious choice:
 *
 * - **The key is an input listener, not a shortcut.** `pi.registerShortcut`
 *   runs through the editor's `onExtensionShortcut` and swallows the key
 *   unconditionally when it matches (`custom-editor.js:24-27`), so binding `↓`
 *   there would take the arrow away from editing. An input listener can look
 *   first and decline.
 * - **The widget draws nothing.** It exists because a widget factory is the
 *   only place pi hands an extension the `TUI` object, and the TUI is the only
 *   way to ask which component holds the keyboard — the test that stops `↓`
 *   being stolen from a dialog. `widgetContainerBelow` has `minSize: 0`
 *   (`interactive-mode.js:676`), so a widget that renders no lines costs no row.
 * - **Nothing here spawns agents.** The dock reads the engine's lifecycle
 *   events (`extensions/agent-engine.ts`) and calls its stop RPC; the `Agent`
 *   tool and its rows belong elsewhere. One owner per surface.
 *
 * It also owns `/stats`, the cost rollup C15 asks for — the seat's own dollars
 * and one branch per agent. The command lives here because the money lives
 * here: the same lifecycle events that make the count carry `usage.cost.total`,
 * and a second reader of those events would be a second answer to the same
 * question. Dollars are a proxy for quota; the allowance itself is `/quota`'s
 * business (`lib/quota-meter.ts`, published by `extensions/wire.ts`), because
 * only the extension holding the response headers can see it.
 *
 * `PI_AGENT_DOCK=off` turns the whole extension off.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { renderAgentSpendTree } from "../../lib/agent-spend.ts";
import { notice } from "../../lib/notice.ts";
import { createSessionScope } from "../../lib/session-scope.ts";
import { agentRuntimeOf } from "../../lib/agent-runtime-seam.ts";
import { AGENT_TASK_STATUS_KEY, formatAgentTaskCount } from "../../lib/agent-task-count.ts";
import { workflowRunsOf } from "../../lib/workflow-runs.ts";
import { AGENT_LIFECYCLE_CHANNELS, AGENT_PROGRESS_CHANNEL, AgentTaskRegistry, isWorkflowRunTask } from "./agent-task-registry.ts";
import { showWorkflowRunView } from "./workflow-run-view.ts";
import { showAgentConversationBox } from "./agent-conversation-box.ts";
import { ROW_FRAME_MS, showBackgroundTasksView } from "./background-tasks-view.ts";
import { ModalRepaint } from "./modal-repaint.ts";
import { agentSpendTreeOf, assistantCostUsd } from "./session-spend.ts";
import { readPromptEditorKeyState, shouldOpenTasksList, tasksLabelKey } from "./open-tasks-on-down-key.ts";

/** `PI_AGENT_DOCK=off` removes the count, the key and the modal. */
const ENABLED = (process.env.PI_AGENT_DOCK ?? "").toLowerCase() !== "off";

/** Widget key for the focus probe. It renders nothing; see the header. */
const PROBE_WIDGET_KEY = "agent-dock";

/**
 * How long a `stopping…` row waits for the bus to answer before it goes back to
 * `running`. A session with no engine seat has no handler on that channel and
 * would otherwise leave the row claiming a stop that nobody heard.
 */
const STOP_REPLY_TIMEOUT_MS = 5_000;


export default function (pi: ExtensionAPI) {
	if (!ENABLED) return;

	const scope = createSessionScope(pi);
	const registry = new AgentTaskRegistry();
	let context: ExtensionContext | undefined;
	/** This seat's session id, the key its `AgentRuntime` is published under. */
	let sessionId = "";
	let tui: TUI | undefined;
	let unbindInput: (() => void) | undefined;
	let modalOpen = false;
	/**
	 * The open overlay's repaint clock. It runs at the wave's frame rate only
	 * while the task list is open with a live child, and stops itself on the frame
	 * after the last one settles; see `modal-repaint.ts`.
	 */
	const modal = new ModalRepaint(ROW_FRAME_MS);
	let stopRequestSeq = 0;
	/**
	 * Dollars this seat's own assistant messages have cost, accumulated as they
	 * settle. pi prices each one and there is no running total to read back, so
	 * the sum is kept here — and reset with the registry, because a `/new`,
	 * `/resume` or `/fork` is a different conversation and did not spend this.
	 */
	let ownDollars = 0;

	/** Push the current count into the status pi's footer data holds. */
	function publishTaskCount(): void {
		if (!context) return;
		try {
			context.ui.setStatus(AGENT_TASK_STATUS_KEY, formatAgentTaskCount(registry.liveCount()));
		} catch {
			// The session is going away; a status is not worth a thrown handler.
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

	// Progress never moves a task between states, so the count cannot have moved.
	pi.events.on(AGENT_PROGRESS_CHANNEL, (payload) => {
		if (registry.applyProgressEvent(payload, Date.now())) repaint();
	});

	// A run's tree moves without any agent's status moving: a phase begins, a log
	// line lands. The fold is the `Workflow` tool's (`lib/workflow-runs.ts`); this
	// is only the repaint that puts it on screen.
	pi.events.on("workflow:progress", () => repaint());

	/**
	 * Ask the engine to stop one agent.
	 *
	 * Fire and forget with one exception: a refusal is surfaced, because a stop
	 * that silently did nothing is worse than no stop key at all.
	 */
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

	/**
	 * The list, then the box for the chosen task, then the list again on that
	 * row — until the list is closed. One loop, so the two overlays never overlap
	 * and neither has to know the other exists.
	 */
	async function runTasksModal(ctx: ExtensionContext): Promise<void> {
		let selectedId: string | undefined;
		for (;;) {
			const exit = await showBackgroundTasksView(
				ctx,
				// The model is on the task itself: every lifecycle payload carries it
				// (`lib/agent-runtime.ts`, `lifecyclePayload`), so there is nothing to
				// look up and nothing to poll.
				{ tasks: () => registry.list(), runOf: (id) => workflowRunsOf(sessionId).byTaskId(id), stop: stopAgentTask, selectedId },
				// The one overlay that animates, and only while something is running.
				(refresh) => modal.attach(refresh, () => registry.liveCount() > 0),
			);
			modal.detach();
			if (exit.kind === "closed") return;
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
					// A run's rows carry durations and idle ages that move on their own,
					// so this view claims frames while anything in the session is live.
					(refresh) => modal.attach(refresh, () => registry.liveCount() > 0),
				);
				modal.detach();
				continue;
			}
			const runtime = agentRuntimeOf(sessionId);
			const name = registry.get(exit.id)?.name;
			await showAgentConversationBox(
				ctx,
				{
					task: () => registry.get(exit.id),
					// Re-read every render: the run goes away when the agent settles, and
					// that is what puts the final answer on screen in its place.
					session: () => runtime?.liveRun(exit.id),
					// `send` picks prompt or steer from the run's own state, so the box
					// never holds a method that could be the wrong one for it.
					send:
						runtime !== undefined && name !== undefined && name !== ""
							? async (text: string) => {
									await runtime.send(name, text, false);
								}
							: undefined,
					cwd: ctx.cwd,
				},
				// No claim on frames: the box has nothing that moves, and its feed
				// arrives as events.
				(refresh) => modal.attach(refresh),
			);
			modal.detach();
		}
	}

	function openTasksModal(): void {
		if (!context || modalOpen) return;
		modalOpen = true;
		const ctx = context;
		runTasksModal(ctx)
			// A modal that could not open is not worth a thrown handler, but it is
			// worth saying: silence here reads exactly like a key that did nothing.
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

	/**
	 * `↓`, and nothing else. Everything this handler cannot prove ends in
	 * `undefined`, which hands the key straight back to pi.
	 */
	function handleTerminalInput(data: string): { consume?: boolean } | undefined {
		if (!context) return undefined;
		const key = tasksLabelKey(data);
		// The common case costs one comparison: not `↓`.
		if (key !== "down") return undefined;
		const focused = (tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		const open = shouldOpenTasksList({
			key,
			editor: readPromptEditorKeyState(focused),
			liveTaskCount: registry.liveCount(),
			modalOpen,
		});
		if (!open) return undefined;
		openTasksModal();
		return { consume: true };
	}

	// pi's resetExtensionUI wipes statuses, widgets and input listeners on every
	// session rebind, so everything this extension puts on screen is re-applied
	// here rather than at load.
	pi.on("session_start", (_event, sessionContext) => {
		// Only the seat with a screen: a subagent runs this same file in this same
		// process and has no dock to draw.
		if (sessionContext.mode !== "tui") return;
		context = sessionContext;
		sessionId = sessionContext.sessionManager.getSessionId();
		// A `/new`, `/resume` or `/fork` is a different conversation, and the
		// agents the last one launched are not this one's tasks.
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

	// The seat's own spend. Every assistant message, on every seat: a headless
	// session still costs money, and `/stats` on the seat that
	// ran it should say so.
	pi.on("message_end", (event) => {
		ownDollars += assistantCostUsd((event as { message?: unknown }).message);
	});

	pi.registerCommand("stats", {
		description: "What this session has spent: the seat, each agent it launched, and the total",
		handler: async (_args, commandContext) => {
			const lines = renderAgentSpendTree(agentSpendTreeOf(registry.list(), ownDollars));
			// `renderAgentSpendTree` writes an empty amount for a zero, so a seat that
			// has spent nothing renders one bare word. Say it in a sentence instead.
			const body = ownDollars <= 0 && registry.list().length === 0 ? "This session has spent nothing yet." : lines.join("\n");
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
