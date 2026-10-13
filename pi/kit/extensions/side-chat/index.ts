import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type FocusTarget, forgetPromptFocus, publishPromptFocus } from "../../lib/session/prompt-focus.ts";
import { promptTargetOf } from "../../lib/session/prompt-target.ts";
import { PromptFocusController } from "./prompt-focus-controller.ts";
import { SIDE_MARKER, SideThread } from "./side-session.ts";

const PROBE_WIDGET_KEY = "side-chat-probe";

/** Side mode for the main seat, and the host of its prompt focus: the `/btw` command, alt+s, input routing and Esc. */
export default function sideChat(pi: ExtensionAPI): void {
	let mainSessionId = "";
	let context: ExtensionContext | undefined;
	let focus: PromptFocusController | undefined;
	let thread: SideThread | undefined;

	const notify = (message: string, level: "info" | "warning" | "error"): void => {
		if (context?.hasUI) context.ui.notify(message, level);
	};
	const report = (error: unknown): void => notify(`side thread: ${error instanceof Error ? error.message : String(error)}`, "error");

	const sideTarget: FocusTarget = {
		target: { kind: "side" },
		placement: "below",
		marker: { text: SIDE_MARKER, color: "success" },
		source: () => thread?.session,
		statusLines: (theme, waiting) => (waiting ? [` ${theme.fg("dim", "…")}`] : []),
		submit: (text, images, how) => {
			if (thread?.busy) {
				void (how === "followUp" ? thread.followUp(text) : thread.steer(text, images)).catch(report);
				return { kind: "queued" };
			}
			const ctx = context;
			const model = ctx?.model;
			if (ctx === undefined || model === undefined) return { kind: "refused", reason: "side thread: no model selected" };
			thread ??= new SideThread(
				{
					cwd: ctx.cwd,
					sessionId: mainSessionId,
					// SAFETY: pi's ModelRegistry holds its runtime in a `runtime` field it does not export in types; the value is passed on as unknown
					modelRuntime: (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime,
				},
				() => focus?.refresh(),
			);
			const messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
			return { kind: "sent", settles: thread.ask(text, images, { model, thinkingLevel: pi.getThinkingLevel(), messages }).catch(report) };
		},
		takesFollowUpKey: () => thread?.busy === true,
		interrupt: () => {
			if (!thread?.busy) return "leave";
			void thread.abort().catch(report);
			return "handled";
		},
		leave: (why) => {
			if (why === "exit" && thread?.busy) void thread.abort().catch(report);
		},
	};

	function enterSideMode(): boolean {
		if (focus === undefined) {
			notify("side mode needs the interactive screen", "warning");
			return false;
		}
		return focus.focus(sideTarget);
	}

	function toggleSideMode(): void {
		if (promptTargetOf(mainSessionId)?.kind === "side") focus?.exit();
		else enterSideMode();
	}

	function dropThread(): void {
		const dropped = thread;
		thread = undefined;
		focus?.refresh();
		void dropped?.dispose().catch(report);
	}

	pi.registerCommand("btw", {
		description: "Side mode: `/btw` toggles, `/btw <text>` asks, `/btw clear` resets the side thread",
		handler: async (args, ctx) => {
			context = ctx;
			const text = args.trim();
			if (text === "clear") {
				dropThread();
				return;
			}
			if (text === "") {
				toggleSideMode();
				return;
			}
			if (promptTargetOf(mainSessionId)?.kind === "side" || enterSideMode()) focus?.submitToFocus(text, undefined);
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Toggle side mode",
		handler: (ctx) => {
			context = ctx;
			toggleSideMode();
		},
	});

	pi.on("input", (event, ctx) => {
		context = ctx;
		return focus?.handleInput(event);
	});

	const compacting = (on: boolean) => (): void => focus?.setMainCompacting(on);
	pi.on("session_before_compact", compacting(true));
	pi.on("session_before_tree", compacting(true));
	pi.on("session_compact", compacting(false));
	pi.on("session_compact_failed", compacting(false));
	pi.on("session_tree", compacting(false));
	pi.on("agent_start", compacting(false));

	pi.on("session_start", (_event, ctx) => {
		mainSessionId = ctx.sessionManager.getSessionId();
		context = ctx;
		if (ctx.mode !== "tui") return;
		const controller = new PromptFocusController(mainSessionId, ctx.cwd, {
			notify,
			isMainIdle: () => context?.isIdle() !== false,
			theme: () => context?.ui.theme,
		});
		focus = controller;
		publishPromptFocus(mainSessionId, controller);
		ctx.ui.onTerminalInput((data) => controller.handleTerminalInput(data));
		ctx.ui.setWidget(
			PROBE_WIDGET_KEY,
			(widgetTui) => {
				controller.bindTui(widgetTui);
				return { render: () => [], invalidate: () => {} };
			},
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", () => {
		dropThread();
		focus?.shutdown();
		forgetPromptFocus(mainSessionId);
		focus = undefined;
		context = undefined;
	});
}
