import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBuiltinToolRows } from "./builtin-tool-overrides.ts";
import { forgetResults, forgetRows, noteResult, regroup, stopTicking, ungroup } from "../../lib/transcript/tool-rollup.ts";
import { quiesce, transcriptEnabled } from "../../lib/transcript/tool-row.ts";

function replan(ctx: ExtensionContext, live = false, streaming?: unknown): void {
	try {
		const entries = ctx.sessionManager.buildContextEntries();
		// SAFETY: buildContextEntries returns session entries; only the optional message field is read
		const last = entries[entries.length - 1] as { message?: unknown } | undefined;
		if (streaming && last?.message !== streaming) {
			// SAFETY: streaming is the in-flight message; a message entry carries it the same way regroup reads other entries
			entries.push({ type: "message", message: streaming } as never);
		}
		regroup(entries, live);
	} catch {
	}
}

function callsIn(message: { content?: unknown }): number {
	const content = message.content;
	if (!Array.isArray(content)) return 0;
	// SAFETY: content blocks are objects with a string type tag; the optional chaining tolerates anything else
	return content.filter((block) => (block as { type?: string })?.type === "toolCall").length;
}

export default function (pi: ExtensionAPI) {
	if (!transcriptEnabled()) return;

	registerBuiltinToolRows(pi);

	let owns = false;

	let streamed = 0;
	pi.on("message_start", () => {
		streamed = 0;
	});
	pi.on("message_update", (event, ctx) => {
		if (!owns || event.message.role !== "assistant") return;
		const calls = callsIn(event.message);
		if (calls === streamed) return;
		streamed = calls;
		replan(ctx, true, event.message);
	});
	pi.on("message_end", (event, ctx) => {
		if (owns && event.message.role === "assistant") replan(ctx, true, event.message);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!owns) return;
		noteResult(event.toolCallId, event.isError === true);
		replan(ctx, true);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!owns) return;
		quiesce();
		stopTicking();
		replan(ctx);
	});

	pi.on("agent_start", () => {
		if (owns) forgetResults();
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!owns) return;
		forgetRows();
		replan(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (!owns) return;
		forgetRows();
		replan(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		owns = true;
		forgetRows();
		replan(ctx);
	});

	pi.on("session_shutdown", () => {
		if (!owns) return;
		owns = false;
		ungroup();
	});
}
