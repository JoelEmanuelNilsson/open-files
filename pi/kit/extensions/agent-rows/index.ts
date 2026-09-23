/**
 * agent-rows — the kit draws the agent engine's rows.
 *
 *     ● 3 background agents launched (↓ to manage)
 *       ├─ Explore  where the parser lives
 *       ├─ Agent    write the missing tests
 *       └─ Agent    audit the error paths
 *
 *     ● Agent(where the parser lives)
 *       ⎿  Done · 45 tools · 142.1k tokens · 11m 21s
 *
 *     ● Result(where the parser lives)
 *       ⎿  The parser is in src/lex/parse.ts
 *          It is called from two places.
 *          Both of them are in the CLI.
 *          … +18 lines (ctrl+o to expand)
 *
 * Two surfaces, two grammars, without this: a tool pi has no renderer for
 * draws `▸ Agent  desc` inside pi's padded box — three blank lines per row —
 * and a custom message with no renderer draws four lines in a shape no other
 * row uses. A turn that launched five agents and collected two of them spent
 * about forty lines saying it.
 *
 * **Nothing here changes what the model sees.** The engine
 * (`extensions/agent-engine.ts`) keeps every tool: its execute, its parameter
 * schema, its description, its prompt guidelines, and the `<task-notification>`
 * text of the completion message. Two narrow seams carry the whole extension:
 *
 * - `lib/claim-tool-rows.ts` claims the `Agent` *row* by name, inside pi's
 *   `ToolExecutionComponent`, without registering the tool. Registering it
 *   would have been the only other way — pi resolves one definition per name,
 *   first registration wins, whole — and that would have meant re-implementing
 *   the tool to change two lines of paint.
 * - `pi.registerMessageRenderer("subagent-notification", …)` draws the notice.
 *   That one *is* first-wins, and the kit registers the only one.
 *
 * The launch rollup is `agent-launch-group.ts`: a run of consecutive `Agent`
 * calls in one assistant message is planned as a batch, the first row speaks for
 * all of them, and the rest draw nothing. Same mechanism the transcript uses for
 * a run of reads, and the same rules — `ctrl+o` and a click on the line open it,
 * and anything that would still tell you something (a blocking call, a failure)
 * dissolves the batch back into rows.
 *
 * `PI_AGENT_ROWS=off` gives every one of these rows back to pi's own drawing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimToolRows } from "../../lib/claim-tool-rows.ts";
import { notice } from "../../lib/notice.ts";
import { transcriptEnabled } from "../transcript/row.ts";
import { forgetAgentLaunches, planAgentLaunches } from "./agent-launch-group.ts";
import { renderSubagentNotification, SUBAGENT_NOTIFICATION_TYPE } from "./agent-completion-notice.ts";
import { agentRowSlots } from "./agent-receipt.ts";

function off(name: string): boolean {
	return (process.env[name] ?? "").toLowerCase() === "off";
}

export default function (pi: ExtensionAPI) {
	// One switch for one visual system: `PI_TRANSCRIPT=off` puts pi's own rows
	// back everywhere, and these rows are made of the transcript's components.
	if (!transcriptEnabled() || off("PI_AGENT_ROWS")) return;

	pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, renderSubagentNotification);

	/**
	 * Whether this session is the one whose rows are on screen.
	 *
	 * The claim is a patch on a prototype and the seats live on the process, so
	 * both outlive this runtime. pi runs subagents in this process and they shut
	 * down all session long; none of this is theirs to take down.
	 */
	let owns = false;
	let release: (() => void) | undefined;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		owns = true;
		forgetAgentLaunches();
		try {
			release = claimToolRows(agentRowSlots());
		} catch (err) {
			// pi's row component changed shape. The rows stay pi's own, which is a
			// worse transcript and a working one; `test/agent-rows.mjs` is where
			// this is supposed to be caught.
			notice(ctx, `[agent-rows] ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	});

	// pi creates a row for every call in a batch as its arguments stream, so the
	// plan is redone as each new call appears — not per token, which is what
	// `message_update` otherwise means.
	let streamed = 0;
	pi.on("message_start", () => {
		streamed = 0;
	});
	pi.on("message_update", (event) => {
		if (!owns || event.message.role !== "assistant") return;
		const calls = callsIn(event.message);
		if (calls === streamed) return;
		streamed = calls;
		planAgentLaunches(event.message);
	});
	pi.on("message_end", (event) => {
		if (owns && event.message.role === "assistant") planAgentLaunches(event.message);
	});

	// pi rebuilds every row from the session when it compacts, forks or walks the
	// tree, so the components the seats point at are gone. The plan is rebuilt by
	// the next streamed message; a batch that has already settled draws its line
	// from the session's own rows, which pi redraws itself.
	pi.on("session_compact", () => {
		if (owns) forgetAgentLaunches();
	});
	pi.on("session_tree", () => {
		if (owns) forgetAgentLaunches();
	});

	pi.on("session_shutdown", () => {
		if (!owns) return;
		owns = false;
		release?.();
		release = undefined;
		forgetAgentLaunches();
	});
}

/**
 * How far along a message's tool calls are: the count, plus how many of them
 * have finished streaming their arguments. The launch tree names a call the
 * moment its arguments close, so that moment has to replan as much as a new
 * call does; a token that changes neither number changes nothing here.
 */
function callsIn(message: { content?: unknown }): number {
	const content = message.content;
	if (!Array.isArray(content)) return 0;
	let calls = 0;
	let closed = 0;
	for (const value of content) {
		const block = value as { type?: string; partialJson?: unknown; partialArgs?: unknown; n?: unknown } | null;
		if (block?.type !== "toolCall") continue;
		calls += 1;
		if (block.partialJson === undefined && block.partialArgs === undefined && block.n === undefined) closed += 1;
	}
	return calls * 1024 + closed;
}
