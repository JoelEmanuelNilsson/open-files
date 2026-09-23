/**
 * Side mode: `/btw` or alt+s toggles an in-memory side thread under main's chat.
 * Plain prompts go to it; slash commands and `!bash` still act on main; Esc stops
 * the side answer or leaves, and never aborts main. While main compacts, a side
 * submit is held in the editor: pi would queue it for main without an `input` event.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, type TUI } from "@earendil-works/pi-tui";

import { isSideModeOn, setSideMode, sideModeClaimsInput } from "../../lib/side-mode.ts";
import { focusedPromptEditor, SideScreen } from "./side-screen.ts";
import { SideThread } from "./side-session.ts";

const PROBE_WIDGET_KEY = "side-chat-probe";

/** Side mode for the main seat: the `/btw` command, alt+s, input routing and Esc. */
export default function sideChat(pi: ExtensionAPI): void {
	let mainSessionId = "";
	let context: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let screen: SideScreen | undefined;
	let thread: SideThread | undefined;
	// pi's AgentSession.isCompacting (agent-session.js:928) is not on ctx; these events bracket it (:1891/:1941,
	// :2178/:2227, :511 on failure, tree :2899/:3006). An aborted tree nav sends no end event, so agent_start also clears.
	let mainCompacting = false;

	const notify = (message: string, level: "info" | "warning" | "error"): void => {
		if (context?.hasUI) context.ui.notify(message, level);
	};
	const report = (error: unknown): void => notify(`side thread: ${error instanceof Error ? error.message : String(error)}`, "error");

	function enter(): void {
		if (context === undefined || screen === undefined || tui === undefined) {
			notify("side mode needs the interactive screen", "warning");
			return;
		}
		const drift = screen.enter(tui, context.ui.theme);
		if (drift !== undefined) {
			notify(`side mode refused: ${drift}`, "warning");
			return;
		}
		setSideMode(mainSessionId, true);
		tui.requestRender();
	}

	function leave(): void {
		if (thread?.busy) void thread.abort().catch(report);
		setSideMode(mainSessionId, false);
		screen?.leave();
		tui?.requestRender();
	}

	function dropThread(): void {
		const dropped = thread;
		thread = undefined;
		screen?.attach(undefined);
		void dropped?.dispose().catch(report);
	}

	function submit(text: string, images: ImageContent[] | undefined, ctx: ExtensionContext): void {
		if (thread?.busy) {
			void thread.steer(text, images).catch(report);
			return;
		}
		const model = ctx.model;
		if (model === undefined) {
			notify("side thread: no model selected", "error");
			return;
		}
		thread ??= new SideThread(
			{
				cwd: ctx.cwd,
				sessionId: mainSessionId,
				// SAFETY: see side-session.ts — pi's registry facade hides its runtime; it is passed through untouched.
				modelRuntime: (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime,
			},
			(session) => screen?.attach(session),
		);
		const messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
		screen?.setWaiting(true);
		void thread
			.ask(text, images, { model, thinkingLevel: pi.getThinkingLevel(), messages })
			.catch(report)
			.finally(() => screen?.setWaiting(false));
	}

	function handleTerminalInput(data: string): { consume: true } | undefined {
		if (isKeyRelease(data) || !isSideModeOn(mainSessionId) || tui === undefined) return undefined;
		const editor = focusedPromptEditor(tui);
		if (editor === undefined || editor.isShowingAutocomplete()) return undefined;
		const followUpKey = editor.keybindings.matches(data, "app.message.followUp");
		const submitKey = !followUpKey && editor.keybindings.matches(data, "tui.input.submit");
		if (mainCompacting && context?.isIdle() === false && (followUpKey || submitKey)) {
			const text = editor.getExpandedText().trim();
			const { line, col } = editor.getCursor();
			const bashCommand = (text.startsWith("!!") ? text.slice(2) : text.slice(1)).trim();
			// Enter after `\` is pi's newline, and Enter on `!cmd` runs bash on main ahead of pi's compaction queue (interactive-mode.js:2587-2604).
			const enterStaysMain = submitKey && ((editor.getLines()[line] ?? "")[col - 1] === "\\" || (text.startsWith("!") && bashCommand !== ""));
			if (text !== "" && !enterStaysMain && sideModeClaimsInput(mainSessionId, { text, source: "interactive" })) {
				notify("Main is compacting — send again when it's done.", "warning");
				return { consume: true };
			}
		}
		if (editor.keybindings.matches(data, "app.interrupt")) {
			if (thread?.busy) void thread.abort().catch(report);
			else leave();
			return { consume: true };
		}
		// The input event cannot tell ctrl+q from Enter (its streamingBehavior is main's), so the follow-up key is caught here.
		if (thread?.busy && followUpKey) {
			const text = editor.getExpandedText().trim();
			if (text === "" || !sideModeClaimsInput(mainSessionId, { text, source: "interactive" })) return undefined;
			editor.addToHistory(text);
			editor.setText("");
			void thread.followUp(text).catch(report);
			return { consume: true };
		}
		return undefined;
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
				if (isSideModeOn(mainSessionId)) leave();
				else enter();
				return;
			}
			if (!isSideModeOn(mainSessionId)) enter();
			if (isSideModeOn(mainSessionId)) submit(text, undefined, ctx);
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Toggle side mode",
		handler: (ctx) => {
			context = ctx;
			if (isSideModeOn(mainSessionId)) leave();
			else enter();
		},
	});

	pi.on("input", (event, ctx) => {
		if (!sideModeClaimsInput(mainSessionId, event)) return undefined;
		submit(event.text, event.images, ctx);
		return { action: "handled" };
	});

	const compacting = (on: boolean) => (): void => {
		mainCompacting = on;
	};
	pi.on("session_before_compact", compacting(true));
	pi.on("session_before_tree", compacting(true));
	pi.on("session_compact", compacting(false));
	pi.on("session_compact_failed", compacting(false));
	pi.on("session_tree", compacting(false));
	pi.on("agent_start", compacting(false));

	pi.on("session_start", (_event, ctx) => {
		mainSessionId = ctx.sessionManager.getSessionId();
		context = ctx;
		// Subagents load this file too; only the seat with a screen has side mode.
		if (ctx.mode !== "tui") return;
		screen = new SideScreen(ctx.cwd);
		// pi's resetExtensionUI drops input listeners and widgets on every rebind.
		ctx.ui.onTerminalInput(handleTerminalInput);
		ctx.ui.setWidget(
			PROBE_WIDGET_KEY,
			(widgetTui) => {
				tui = widgetTui;
				return { render: () => [], invalidate: () => {} };
			},
			{ placement: "belowEditor" },
		);
	});

	// /new, /resume and /fork end this session first: the side thread belongs to it.
	pi.on("session_shutdown", () => {
		dropThread();
		// A ctx outlives its session only to throw; late failures of the dropped thread go unreported.
		context = undefined;
		setSideMode(mainSessionId, false);
		screen?.leave();
		screen = undefined;
		tui = undefined;
	});
}
