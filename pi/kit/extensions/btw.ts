/**
 * btw — a side chat that sees the main conversation but does not pollute it.
 *
 * `/btw <question>` asks immediately, `/btw` opens the popover. The side thread
 * runs in an in-memory session seeded with the current branch's context and the
 * live system prompt, with read-only tools. Nothing it says enters the main
 * context unless you close the popover and choose to inject a summary.
 *
 * The thread is persisted as custom entries, so it survives /reload and resume.
 *
 * The side thread runs in a real AgentSession with pi's *default* resource
 * loader. That matters for two reasons, both learned the hard way:
 *
 *   1. Provider patches live in extensions and hook agent-pipeline events
 *      (`before_provider_request`). A hand-rolled `modelRegistry.complete()`
 *      never fires them, and on Claude subscription auth the request comes back
 *      400: "Third-party apps now draw from your extra usage". The default
 *      loader loads those extensions, so the side session is patched like any
 *      other turn.
 *   2. Same loader, same cwd, same tools means the same cached prefix as the
 *      main session, so a BTW question is a cache read plus one short message
 *      rather than a fresh cache write of the whole conversation.
 *
 * Loading every extension into a child session would also load *ours* — widgets
 * rebinding, probes firing, btw itself recursing. SIDE_FLAG marks the child so
 * pi-kit extensions stand down inside it; btw uses it to install a write gate
 * instead, which is what keeps the side thread read-only.
 *
 * Started as mitsupi's btw.ts.
 */

import {
	buildSessionContext,
	createAgentSession,
	getMarkdownTheme,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { isSideSession, markSideSession } from "../lib/side-flag.ts";
import {
	Container,
	Input,
	Markdown,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

const THREAD_ENTRY = "btw-thread-entry";
const RESET_ENTRY = "btw-thread-reset";

/**
 * Both prompts ride in the user message, never in the system prompt. Changing
 * the system prompt would change the cached prefix and cost a full cache write
 * of the entire conversation on every question.
 */
const SIDE_PROMPT = [
	"[BTW side channel] Answer this out of band. It is a side question from the user",
	"about the conversation so far, and your answer will not enter the main thread.",
	"Answer from the conversation context. Do not call tools, and do not modify files.",
	"Be direct and practical.",
].join(" ");

const SUMMARY_PROMPT = [
	"[BTW side channel] Summarize the side conversation below for handoff into the main",
	"conversation. Keep decisions, findings, risks, and next actions. Output only the",
	"summary. Do not call tools.",
].join(" ");

/** Tools that change things. The side thread may look, never touch. */
const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch"]);

type Theme = ExtensionContext["ui"]["theme"];

type BtwTurn = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	usage?: AssistantMessage["usage"];
};

type OverlayRuntime = {
	handle?: OverlayHandle;
	refresh?: () => void;
	close?: () => void;
	finish?: () => void;
	setDraft?: (value: string) => void;
	closed?: boolean;
};

type SideSession = {
	session: AgentSession;
	modelKey: string;
	unsubscribe: () => void;
};

type ToolCallInfo = {
	toolName: string;
	args: string;
	status: "running" | "done" | "error";
};

function lastAssistant(session: AgentSession): AssistantMessage | null {
	for (let i = session.state.messages.length - 1; i >= 0; i--) {
		const message = session.state.messages[i];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return null;
}

function textOf(parts: AssistantMessage["content"]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => (part as { text: string }).text)
		.join("\n")
		.trim();
}

/**
 * The main conversation verbatim, then the side thread. Verbatim matters: this
 * is the prefix the provider has already cached for the main session.
 */
function baseMessages(ctx: ExtensionContext, thread: BtwTurn[]): Message[] {
	const messages: Message[] = [];

	try {
		messages.push(
			...buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
	} catch {
		// An unreadable branch just means the side chat starts without context.
	}

	for (const turn of thread) {
		messages.push(
			{ role: "user", content: [{ type: "text", text: turn.question }], timestamp: turn.timestamp },
			{
				role: "assistant",
				content: [{ type: "text", text: turn.answer }],
				provider: turn.provider,
				model: turn.model,
				api: ctx.model?.api ?? "anthropic-messages",
				usage: turn.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: turn.timestamp,
			} as AssistantMessage,
		);
	}

	return messages;
}

class BtwOverlay extends Container implements Focusable {
	private readonly input = new Input();
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly getTranscript: (width: number, theme: Theme) => string[],
		private readonly getStatus: () => string,
		private readonly onSubmit: (value: string) => Promise<void>,
		private readonly onDismiss: () => Promise<void>,
		private readonly onFailure: (error: unknown) => void,
	) {
		super();
		this.input.onSubmit = (value) => this.startOverlayTask(() => this.onSubmit(value));
		this.input.onEscape = () => this.startOverlayTask(() => this.onDismiss());
	}

	/**
	 * A keystroke has no caller to return a failure to. Node's default is
	 * `--unhandled-rejections=throw` and pi installs no handler, so a promise
	 * that escapes a keystroke does not print an error, it kills pi — which is
	 * what a side session that failed to build did from the submit callback.
	 * Every async thing this overlay starts is started here, sync throw and
	 * rejection alike, so the failure reaches the user instead of the process.
	 */
	private startOverlayTask(work: () => Promise<void>): void {
		try {
			work().catch((error: unknown) => this.onFailure(error));
		} catch (error) {
			this.onFailure(error);
		}
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "selectCancel")) {
			this.startOverlayTask(() => this.onDismiss());
			return;
		}
		this.input.handleInput(data);
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	private frame(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		const edge = this.theme.fg("borderMuted", "│");
		return `${edge}${truncated}${" ".repeat(padding)}${edge}`;
	}

	private border(innerWidth: number, edge: "top" | "bottom"): string {
		const [left, right] = edge === "top" ? ["┌", "┐"] : ["└", "┘"];
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	override render(width: number): string[] {
		const dialogWidth = Math.max(56, Math.min(width, Math.floor(width * 0.9)));
		const innerWidth = Math.max(40, dialogWidth - 2);
		const rows = process.stdout.rows ?? 30;
		const height = Math.max(16, Math.min(30, Math.floor(rows * 0.75)));
		const transcriptHeight = Math.max(6, height - 7);

		const transcript = this.getTranscript(innerWidth, this.theme).slice(-transcriptHeight);
		const padding = Math.max(0, transcriptHeight - transcript.length);

		const wasFocused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(innerWidth)[0] ?? "";
		this.input.focused = wasFocused;

		const divider = this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
		const lines = [
			this.border(innerWidth, "top"),
			this.frame(this.theme.fg("accent", this.theme.bold(" BTW side chat ")), innerWidth),
			this.frame(this.theme.fg("dim", " Separate thread. Nothing here reaches the main chat."), innerWidth),
			divider,
			...transcript.map((line) => this.frame(line, innerWidth)),
			...Array.from({ length: padding }, () => this.frame("", innerWidth)),
			divider,
			this.frame(this.theme.fg("warning", this.getStatus()), innerWidth),
			`${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`,
			this.frame(this.theme.fg("dim", " Enter submit · Esc close"), innerWidth),
			this.border(innerWidth, "bottom"),
		];

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	// Inside btw's own child session: no overlay, no thread, no recursion. Just
	// the gate that keeps the side thread from writing to the tree.
	if (isSideSession()) {
		pi.on("tool_call", (event) => {
			if (!WRITE_TOOLS.has(event.toolName)) return;
			return { block: true, reason: "BTW side chat is read-only. Report what you would change instead." };
		});
		return;
	}

	let thread: BtwTurn[] = [];
	let pendingQuestion: string | null = null;
	let pendingAnswer = "";
	let pendingError: string | null = null;
	let pendingToolCalls: ToolCallInfo[] = [];
	let busy = false;
	let status = "Ready";
	let draft = "";
	let overlay: OverlayRuntime | null = null;
	let side: SideSession | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;

	const markdownTheme = getMarkdownTheme();

	const modelKey = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none");

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	function markdownLines(text: string, width: number): string[] {
		if (!text) return [];
		try {
			return new Markdown(text, 0, 0, markdownTheme).render(width);
		} catch {
			return text.split("\n");
		}
	}

	function transcriptLines(width: number, theme: Theme): string[] {
		if (thread.length === 0 && !pendingQuestion && !pendingAnswer && !pendingError) {
			return [theme.fg("dim", "No BTW messages yet. Type a question below.")];
		}

		const lines: string[] = [];
		for (const turn of thread.slice(-6)) {
			lines.push(
				theme.fg("accent", theme.bold("You: ")) + truncateToWidth(turn.question.split("\n")[0], width - 5, "…"),
			);
			lines.push("", ...markdownLines(turn.answer, width), "");
		}

		if (pendingQuestion) {
			lines.push(
				theme.fg("accent", theme.bold("You: ")) +
					truncateToWidth(pendingQuestion.split("\n")[0], width - 5, "…"),
			);
			if (pendingError) lines.push(theme.fg("error", `✗ ${pendingError}`));
			else if (pendingAnswer) lines.push("", ...markdownLines(pendingAnswer, width));
			else lines.push(theme.fg("dim", "…"));
		}

		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines;
	}

	function sync(): void {
		overlay?.refresh?.();
	}

	function setStatus(next: string, throttled = false): void {
		status = next;
		if (!throttled) {
			sync();
			return;
		}
		if (refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			sync();
		}, 16);
	}

	function dismissOverlay(): void {
		overlay?.close?.();
		overlay = null;
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}

	function setDraft(value: string): void {
		draft = value;
		overlay?.setDraft?.(value);
	}

	function clearPending(): void {
		pendingQuestion = null;
		pendingAnswer = "";
		pendingError = null;
		busy = false;
	}

	async function resetThread(persist = true): Promise<void> {
		thread = [];
		clearPending();
		setDraft("");
		setStatus("Ready");
		if (persist) pi.appendEntry(RESET_ENTRY, { timestamp: Date.now() });
		sync();
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		thread = [];
		clearPending();
		status = "Ready";
		draft = "";

		const branch = ctx.sessionManager.getBranch();
		let resetAt = -1;
		branch.forEach((entry, index) => {
			if (entry.type === "custom" && entry.customType === RESET_ENTRY) resetAt = index;
		});

		for (const entry of branch.slice(resetAt + 1)) {
			if (entry.type !== "custom" || entry.customType !== THREAD_ENTRY) continue;
			const turn = entry.data as BtwTurn | undefined;
			if (turn?.question && turn.answer) thread.push(turn);
		}

		sync();
	}

	/**
	 * The child session. Default resource loader so provider patches apply; the
	 * side flag keeps pi-kit from waking up inside it. Messages are seeded with
	 * the main branch verbatim, which is also what makes the prefix cache-hit.
	 */
	async function createSide(ctx: ExtensionContext): Promise<SideSession | null> {
		if (!ctx.model) return null;

		markSideSession(true);
		try {
			// The session manager is the canonical request history (pi ≥ 0.87;
			// assigning `agent.state.messages` no longer reaches the provider), so
			// the seed goes in before the session is built, the way a resume does.
			const sessionManager = SessionManager.inMemory(ctx.cwd);
			for (const message of baseMessages(ctx, thread)) sessionManager.appendMessage(message);

			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				sessionManager,
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
			});

			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				if (!busy || !pendingQuestion) return;

				switch (event.type) {
					case "message_start":
					case "message_update":
					case "message_end": {
						const message = (event as { message?: unknown }).message;
						const text =
							message && typeof message === "object" && (message as { role?: string }).role === "assistant"
								? textOf((message as AssistantMessage).content ?? [])
								: "";
						if (text) {
							pendingAnswer = text;
							pendingError = null;
						}
						setStatus(event.type === "message_end" ? "Finalizing…" : "Streaming…", true);
						return;
					}
					case "tool_execution_start": {
						const call = event as { toolName?: string; args?: unknown };
						const args = call.args as Record<string, unknown> | undefined;
						const hint =
							typeof args?.command === "string"
								? truncateToWidth(args.command.split("\n")[0], 50, "…")
								: typeof args?.path === "string"
									? args.path
									: "";
						pendingToolCalls.push({ toolName: call.toolName ?? "tool", args: hint, status: "running" });
						setStatus(`Running ${call.toolName ?? "tool"}…`, true);
						return;
					}
					case "tool_execution_end": {
						const call = event as { toolName?: string; isError?: boolean };
						const running = pendingToolCalls.find(
							(entry) => entry.toolName === call.toolName && entry.status === "running",
						);
						if (running) running.status = call.isError ? "error" : "done";
						setStatus("Streaming…", true);
						return;
					}
					default:
						return;
				}
			});

			return { session, modelKey: modelKey(ctx), unsubscribe };
		} finally {
			markSideSession(false);
		}
	}

	async function ensureSide(ctx: ExtensionContext): Promise<SideSession | null> {
		if (side && side.modelKey === modelKey(ctx)) return side;
		await disposeSide();
		side = await createSide(ctx);
		return side;
	}

	async function disposeSide(): Promise<void> {
		const current = side;
		side = null;
		if (!current) return;
		try {
			current.unsubscribe();
			await current.session.abort();
		} catch {
			// Teardown is best effort.
		}
		current.session.dispose();
	}

	/** The one way a popover failure reaches the user: the status line, then a notification. */
	function reportOverlayFailure(ctx: ExtensionContext | ExtensionCommandContext, error: unknown): void {
		setStatus("BTW hit an error.");
		notify(ctx as ExtensionContext, error instanceof Error ? error.message : String(error), "error");
	}

	async function ensureOverlay(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) return;

		if (overlay?.handle) {
			overlay.handle.setHidden(false);
			overlay.handle.focus();
			overlay.refresh?.();
			return;
		}

		const runtime: OverlayRuntime = {};
		const close = () => {
			if (runtime.closed) return;
			runtime.closed = true;
			runtime.handle?.hide();
			if (overlay === runtime) overlay = null;
			runtime.finish?.();
		};
		runtime.close = close;
		overlay = runtime;

		void ctx.ui
			.custom<void>(
				async (tui, theme, keybindings, done) => {
					runtime.finish = () => done();

					const component = new BtwOverlay(
						tui,
						theme,
						keybindings,
						(width, activeTheme) => {
							try {
								return transcriptLines(width, activeTheme);
							} catch (error) {
								return [activeTheme.fg("error", String(error))];
							}
						},
						() => status,
						(value) => submit(ctx, value),
						() => closeFlow(ctx),
						(error) => reportOverlayFailure(ctx, error),
					);

					component.focused = true;
					component.setDraft(draft);
					runtime.setDraft = (value) => component.setDraft(value);
					runtime.refresh = () => {
						component.focused = runtime.handle?.isFocused() ?? false;
						tui.requestRender();
					};
					runtime.close = () => {
						draft = component.getDraft();
						close();
					};

					if (runtime.closed) done();
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						minWidth: 72,
						maxHeight: "78%",
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) close();
					},
				},
			)
			.catch((error: unknown) => {
				if (overlay === runtime) overlay = null;
				reportOverlayFailure(ctx, error);
			});
	}

	async function summarize(ctx: ExtensionContext, turns: BtwTurn[]): Promise<string> {
		const runtime = await ensureSide(ctx);
		if (!runtime) throw new Error("No active model selected.");

		const transcript = turns
			.map((turn) => `User: ${turn.question.trim()}\nAssistant: ${turn.answer.trim()}`)
			.join("\n\n---\n\n");

		await runtime.session.prompt(`${SUMMARY_PROMPT}\n\n${transcript}`, { source: "extension" });
		const response = lastAssistant(runtime.session);
		if (!response) throw new Error("Summary finished without a response.");
		if (response.stopReason === "error") throw new Error(response.errorMessage || "Summary failed.");
		return textOf(response.content) || "(no summary generated)";
	}

	async function injectSummary(ctx: ExtensionContext): Promise<void> {
		if (thread.length === 0) {
			notify(ctx, "No BTW thread to summarize.", "warning");
			return;
		}

		setStatus("Summarizing…");
		try {
			const summary = await summarize(ctx, thread);
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			await resetThread();
			notify(ctx, "Injected BTW summary into the main chat.", "info");
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function closeFlow(ctx: ExtensionContext): Promise<void> {
		dismissOverlay();
		if (!ctx.hasUI || thread.length === 0) return;

		const choice = await ctx.ui.select("Close BTW:", ["Keep side thread", "Inject summary into main chat"]);
		if (choice === "Inject summary into main chat") await injectSummary(ctx);
	}

	async function ask(ctx: ExtensionContext, question: string): Promise<void> {
		if (!ctx.model) {
			setStatus("No active model selected.");
			notify(ctx, "No active model selected.", "error");
			return;
		}

		if (busy) {
			notify(ctx, "BTW is still working on the previous message.", "warning");
			return;
		}

		busy = true;
		pendingQuestion = question;
		pendingAnswer = "";
		pendingError = null;
		pendingToolCalls = [];
		setStatus("Thinking…");

		// Building the side session is part of answering, so it fails like any
		// other step: inside the try, with the question already pending, so the
		// popover shows the error under it instead of a spinner that never moves.
		try {
			const runtime = await ensureSide(ctx);
			if (!runtime) throw new Error("Unable to create the BTW side session.");

			await runtime.session.prompt(`${SIDE_PROMPT}\n\n${question}`, { source: "extension" });

			const response = lastAssistant(runtime.session);
			if (!response) throw new Error("BTW finished without a response.");
			if (response.stopReason === "aborted") throw new Error("BTW request aborted.");
			if (response.stopReason === "error") throw new Error(response.errorMessage || "BTW request failed.");

			const answer = textOf(response.content) || "(no text response)";
			const turn: BtwTurn = {
				question,
				answer,
				timestamp: Date.now(),
				provider: ctx.model.provider,
				model: ctx.model.id,
				usage: response.usage,
			};
			thread.push(turn);
			pi.appendEntry(THREAD_ENTRY, turn);

			pendingQuestion = null;
			pendingAnswer = "";
			pendingToolCalls = [];
			setStatus("Ready for the next side question.");
		} catch (error) {
			pendingError = error instanceof Error ? error.message : String(error);
			setStatus("BTW request failed.");
			notify(ctx, pendingError, "error");
		} finally {
			busy = false;
			sync();
		}
	}

	async function submit(ctx: ExtensionContext | ExtensionCommandContext, raw: string): Promise<void> {
		const question = raw.trim();
		if (!question) {
			setStatus("Enter a question first.");
			return;
		}
		setDraft("");
		await ask(ctx, question);
	}

	pi.registerCommand("btw", {
		description: "Side chat that sees the main context. `/btw <text>` asks, `/btw` opens the popover.",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (!question) {
				if (thread.length > 0 && ctx.hasUI) {
					const choice = await ctx.ui.select("BTW side chat:", ["Continue previous thread", "Start fresh"]);
					if (choice === "Continue previous thread") {
						setStatus("Continuing BTW thread.");
						await ensureOverlay(ctx);
					} else if (choice === "Start fresh") {
						await resetThread();
						await ensureOverlay(ctx);
					}
					return;
				}
				await resetThread();
				await ensureOverlay(ctx);
				return;
			}

			await ensureOverlay(ctx);
			await ask(ctx, question);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_shutdown", async () => {
		await disposeSide();
		dismissOverlay();
	});
}
