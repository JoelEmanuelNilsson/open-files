import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { transcriptEnabled } from "../../lib/transcript/tool-row.ts";
import { forgetAgentLaunches, planAgentLaunches, toolCallStreamProgress } from "./agent-launch-group.ts";
import { renderSubagentNotification } from "./agent-completion-notice.ts";
import { AGENT_NOTIFICATION_TYPE } from "../../lib/agents/agent-notification.ts";
import { agentRowSlots } from "./agent-receipt.ts";
import { envSwitchOff } from "../../lib/transcript/env-switch.ts";

export default function (pi: ExtensionAPI) {
	if (!transcriptEnabled() || envSwitchOff("PI_AGENT_ROWS")) return;

	pi.registerMessageRenderer(AGENT_NOTIFICATION_TYPE, renderSubagentNotification);

	const rows = agentRowSlots();
	pi.registerToolRenderer((tool, next) => Object.hasOwn(rows, tool) ? rows[tool] : next());

	let owns = false;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		owns = true;
		forgetAgentLaunches();
	});

	let streamed = 0;
	pi.on("message_start", () => {
		streamed = 0;
	});
	pi.on("message_update", (event) => {
		if (!owns || event.message.role !== "assistant") return;
		const calls = toolCallStreamProgress(event.message);
		if (calls === streamed) return;
		streamed = calls;
		planAgentLaunches(event.message);
	});
	pi.on("message_end", (event) => {
		if (owns && event.message.role === "assistant") planAgentLaunches(event.message);
	});

	pi.on("session_compact", () => {
		if (owns) forgetAgentLaunches();
	});
	pi.on("session_tree", () => {
		if (owns) forgetAgentLaunches();
	});

	pi.on("session_shutdown", () => {
		if (!owns) return;
		owns = false;
		forgetAgentLaunches();
	});
}
