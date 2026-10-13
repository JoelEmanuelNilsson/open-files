import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runContextCommand } from "./context-command.ts";
import { InitialCaptureState } from "./initial-capture.ts";
import { buildOwnedSystemPrompt } from "../../lib/wire/owned-prompt.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	let ownedPrompt: string | undefined;

	pi.on("before_agent_start", (event) => {
		if (capture.snapshot !== undefined) return;
		ownedPrompt = buildOwnedSystemPrompt(event.systemPromptOptions);
		capture.prepare(event.systemPromptOptions);
	});

	pi.on("context", (event, ctx) => {
		if (capture.snapshot !== undefined) return;
		const baselineMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
		capture.finalize({
			systemPrompt: ownedPrompt ?? ctx.getSystemPrompt(),
			messages: event.messages,
			baselineMessages,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			origin: "real-turn",
		});
	});

	pi.registerCommand("context", {
		description: "Inspect context usage",
		handler: (_args, ctx) => runContextCommand(ctx, { pi, capture }),
	});
}

