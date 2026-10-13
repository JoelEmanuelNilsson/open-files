import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ownsTurnClock } from "../lib/session/turn-clock.ts";

const SKETCHYBAR = process.env.PI_BAR_LIGHT_BIN ?? "/opt/homebrew/bin/sketchybar";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_BAR_LIGHT === "off") return;

	pi.on("agent_settled", (_event, ctx) => {
		if (!ownsTurnClock(ctx)) return;
		execFile(SKETCHYBAR, ["--trigger", "agent_done"], () => {});
	});
}
