/**
 * bar-light — tell the status bar that an agent is waiting on you.
 *
 * One command on `agent_settled`:
 *
 *     sketchybar --trigger agent_done
 *
 * and the bar does the rest. ~/dotfiles/sketchybar/plugins/agent-light runs a
 * wave of colour across every item from left to right and then leaves the chip
 * at the head of the bar drifting along the same hue arc the chrome in this
 * kit uses, until you focus the terminal again.
 *
 * WHY NOT A NOTIFICATION. There is one already: extensions/notify.ts, which
 * picks OSC 777 under Ghostty. Inside herdr that sequence never reaches
 * Ghostty -- herdr parses it and draws its own toast, in its own window, which
 * is the window you are not looking at. That is not a bug to route around; a
 * notification is an *event*, and it is delivered to wherever the event
 * happened. "An agent is waiting" is a *state*, and a state wants a surface
 * that is visible from everywhere. The status bar is on every AeroSpace
 * workspace by construction. notify.ts stays for the sessions that are not
 * inside herdr, and the two do not overlap in practice.
 *
 * WHY `agent_settled` AND NOT `agent_end`. Same reason as notify.ts: a retry
 * or an auto-compaction is not the agent handing the turn back.
 *
 * THE LIMIT, STATED. This fires whenever a top-level turn settles, with no
 * minimum duration, because the question "did you see it happen" is answered
 * at the bar -- plugins/agent-light drops the trigger when the terminal is
 * already the front app. A duration floor here would answer a different
 * question, badly: a two-second turn you walked away from still leaves you
 * waiting for a light that never comes.
 *
 * Nothing here checks whether the bar is running. `--trigger` against a dead
 * socket exits non-zero and is ignored, which is the whole of the error
 * handling this needs: the bar not being there is not a pi problem.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSideSession } from "../lib/side-flag.ts";
import { ownsTurnClock } from "../lib/turn-clock.ts";

/** Absolute: pi may be started from a launchd context with no Homebrew PATH. */
const SKETCHYBAR = process.env.PI_BAR_LIGHT_BIN ?? "/opt/homebrew/bin/sketchybar";

export default function (pi: ExtensionAPI) {
	// A subagent finishing is not the agent handing the turn back to you.
	if (isSideSession()) return;
	if (process.env.PI_BAR_LIGHT === "off") return;

	pi.on("agent_settled", (_event, ctx) => {
		// pi runs subagents in-process on this same extension set, so the mode
		// alone cannot tell them apart from the session you are looking at. The
		// turn clock has exactly one owner; that owner is the one you are waiting
		// on. Same gate as notify.ts, for the same reason.
		if (!ownsTurnClock(ctx)) return;
		execFile(SKETCHYBAR, ["--trigger", "agent_done"], () => {});
	});
}
