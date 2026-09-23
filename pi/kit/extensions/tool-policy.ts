/**
 * tool-policy — the half of the tool layer that runs at call time: no scan gets
 * to start at `/` or `$HOME`, and no seat runs a tool it does not carry.
 *
 * The seat check is what makes the wire cut a guard rather than an
 * advertisement. Every tool stays registered on every seat, so leaving one out
 * of `payload.tools` only hides it: a model that saw it on an earlier turn, or
 * guesses the name, reaches `execute` anyway. Same rule both times
 * (`lib/tool-policy.ts`'s `carriesTool`), so the payload and the refusal cannot
 * disagree.
 *
 * `tool_call` fires before any tool's `execute`, so the scan guard covers the
 * kit's own `bash` (`extensions/bash.ts`), which is the only tool on any seat
 * that can still walk a tree (map C6). Bash's deadline is that tool's business:
 * it defaults and clamps `timeout` itself, from the same constants its
 * description is written from (`lib/bash.ts`), so the two cannot drift into a
 * lie.
 *
 * The handler is total, and totality is the whole point twice over. A throw here
 * used to mean pi ran the tool anyway — a guard that fails *open* on exactly the
 * malformed input it was written for; as of pi 0.86 a throw *blocks* the call
 * instead (`docs/extensions.md`: "tool_call errors block the tool"), so the same
 * defect now refuses work the seat is entitled to. Neither is acceptable and
 * neither is reachable: both name readers take `unknown` and lower it
 * themselves (`lib/tool-policy.ts`), so there is no input left that throws, and
 * the `catch` is the backstop rather than the design.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notice } from "../lib/notice.ts";
import { toolSeatOf } from "../lib/seat.ts";
import { scanRefusal, seatRefusal } from "../lib/tool-policy.ts";

export default function toolPolicy(pi: ExtensionAPI) {
	const home = homedir();

	pi.on("tool_call", (event, ctx) => {
		try {
			const refused = seatRefusal(event.toolName, toolSeatOf(ctx.sessionManager.getSessionId()));
			if (refused !== undefined) return { block: true, reason: refused };
			const input = event.input as Record<string, unknown> | undefined;
			const reason = scanRefusal(event.toolName, input, { home });
			if (reason !== undefined) return { block: true, reason };
			return undefined;
		} catch (error) {
			notice(ctx, `tool-policy: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
	});
}
