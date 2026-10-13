import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createSessionScope } from "../../lib/session/session-scope.ts";
import { resolveDeadlineMs } from "../../lib/session/silence-deadline.ts";
import { resolveMode, Watchdog } from "./silence-watchdog.ts";
import { abortReason, isFailedAssistant, warnMessage } from "./watchdog-message.ts";

export default function (pi: ExtensionAPI) {
	const scope = createSessionScope(pi);
	const deadlineMs = resolveDeadlineMs(process.env.PI_WATCHDOG_MS);
	const forcedMode = process.env.PI_WATCHDOG_MODE;
	let watchdog: Watchdog | undefined;
	let pendingReason: string | undefined;

	pi.registerEntryRenderer<{ text?: string }>("watchdog", (entry, _options, theme) =>
		new Text(theme.fg("error", entry.data?.text ?? "watchdog fired"), 0, 0),
	);

	function ensure(ctx: ExtensionContext): Watchdog | undefined {
		if (watchdog) return watchdog;
		const mode = resolveMode(ctx.mode, forcedMode);
		if (mode === "off") return undefined;
		watchdog = new Watchdog({
			deadlineMs,
			mode,
			now: () => Date.now(),
			schedule: (delayMs, fire) => scope.timeout(delayMs, fire),
			act: (action) => {
				if (ctx.isIdle()) {
					watchdog?.stop();
					return;
				}
				if (action.kind === "warn") {
					const text = warnMessage(action, deadlineMs, mode);
					if (ctx.mode === "tui") ctx.ui.notify(text, "warning");
					else pi.appendEntry("watchdog", { text });
					return;
				}
				const text = abortReason(action, deadlineMs);
				pi.appendEntry("watchdog", { text });
				if (ctx.mode === "tui") ctx.ui.notify(text, "error");
				pendingReason = text;
				ctx.abort();
			},
		});
		return watchdog;
	}

	pi.on("agent_start", (_event, ctx) => {
		pendingReason = undefined;
		ensure(ctx)?.start();
	});
	pi.on("agent_settled", () => watchdog?.stop());
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload" || ctx.isIdle()) return;
		const dog = ensure(ctx);
		if (dog === undefined) return;
		dog.start();
		const branch = ctx.sessionManager.getBranch();
		const answered = new Set<string>();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message.role === "toolResult") answered.add(message.toolCallId);
			if (message.role !== "assistant") continue;
			for (const block of message.content) if (block.type === "toolCall" && !answered.has(block.id)) dog.toolStart(block.id, block.name);
			break;
		}
	});

	pi.on("agent_end", () => watchdog?.touch());
	pi.on("turn_start", () => watchdog?.touch());
	pi.on("turn_end", () => watchdog?.touch());
	pi.on("message_start", () => watchdog?.touch());
	pi.on("message_update", () => watchdog?.touch());
	pi.on("tool_execution_start", (event) => watchdog?.toolStart(event.toolCallId, event.toolName));
	pi.on("tool_execution_update", () => watchdog?.touch());
	pi.on("tool_execution_end", (event) => watchdog?.toolEnd(event.toolCallId));

	pi.on("message_end", (event) => {
		watchdog?.touch();
		const reason = pendingReason;
		if (reason === undefined || !isFailedAssistant(event.message)) return;
		pendingReason = undefined;
		return { message: { ...event.message, stopReason: "error" as const, errorMessage: reason } };
	});
}
