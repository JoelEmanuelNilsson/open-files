import { fileURLToPath } from "node:url";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { liveAgentsOf } from "../../lib/agents/agent-live-runs.ts";
import { readAgentRegistry } from "../../lib/agents/agent-registry.ts";
import { agentRuntimeOf } from "../../lib/agents/agent-runtime-seam.ts";
import { readLastRequest, replayHeaders } from "../../lib/wire/last-request.ts";
import { notice } from "../../lib/process/human-notice.ts";
import { childSeatOf, type EngineChildSeat } from "../../lib/session/seat-identity.ts";
import { backgroundTasksOf } from "../../lib/tools/background-tasks.ts";

const PINNED_TOKENS = 20_000;

const CHARS_PER_TOKEN = 4;

const PI_RECALL = fileURLToPath(new URL("../../bin/pi-recall.mjs", import.meta.url));

// SAFETY: the compaction planner reads only messages; the empty transcript has none
const EMPTY_TRANSCRIPT = { messages: [] } as unknown as TranscriptContext;

function summaryRequest(principal: string, compaction: number, customInstructions: string | undefined): string {
	const focus = customInstructions?.trim() ? `\n\n${principal} asked this summary to focus on: ${customInstructions.trim()}` : "";
	return `This is compaction ${compaction} of this session. Your context is about to be replaced by a summary you write now, followed by the most recent messages kept verbatim. Write that summary.

Respond with text only. Do not call tools: a tool call fails this request.

The harness puts ${principal}'s messages, verbatim, before your summary and the list of running agents and background tasks after it, so do not copy either. If an earlier compaction summary is in your context, carry forward everything in it that still holds.

Use these sections:

## Goal and constraints
What ${principal} asked for and every constraint and preference stated, in ${principal}'s terms.
## Decisions and why
Each decision taken, with its reason and evidence.
## Files
Files touched or decided on: path, what changed or was learned, and why it matters.
## Problems
Each problem found and its state: fixed (how), open, or blocked (on what).
## Done / in progress / left
What is finished, what was in progress at this moment, and what is left.
## Next step
The one next step, directly in line with ${principal}'s most recent explicit request, which you quote verbatim. It continues the work in progress; it does not start new work. If that request is done, say so and that the next step is to report to ${principal}.${focus}`;
}

function pinnedMessages(entries: readonly SessionEntry[]): string {
	let room = PINNED_TOKENS * CHARS_PER_TOKEN;
	const pinned: string[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		let text = typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
		if (text.trim() === "") continue;
		if (text.length > room) {
			if (pinned.length > 0) break;
			text = `${text.slice(0, room)}\n[cut: ${text.length - room} more characters]`;
		}
		room = Math.max(0, room - text.length);
		pinned.push(`[${entry.timestamp}]\n${text}`);
	}
	return `<user_messages>\nJoel's messages in this session, verbatim, newest first. They are the instructions in force.\n\n${pinned.join("\n\n")}\n</user_messages>`;
}

function childPin(seat: EngineChildSeat, sessionId: string): string | undefined {
	const record = agentRuntimeOf(seat.parentSessionId)?.registry.byName(seat.name);
	if (record?.sessionId !== sessionId || record.brief === undefined) return undefined;
	const parent = childSeatOf(seat.parentSessionId)?.name ?? "main";
	const brief = `<original_brief from="${parent}">\n${record.brief}\n</original_brief>`;
	if (record.laterMessages.length === 0) return brief;
	const later = record.laterMessages.toReversed().map((message) => `[${new Date(message.at).toISOString()}] from ${message.from}\n${message.text}`);
	return `${brief}\n\n<later_messages>\nMessages after the brief, verbatim, newest first. With the brief they are the instructions in force.\n\n${later.join("\n\n")}\n</later_messages>`;
}

function replayCoversBranch(leafId: string | null, entries: readonly SessionEntry[], firstKeptEntryId: string): boolean {
	const captured = entries.findIndex((entry) => entry.id === leafId);
	return captured !== -1 && entries.findIndex((entry) => entry.id === firstKeptEntryId) <= captured + 1;
}

function liveState(entries: readonly SessionEntry[], sessionId: string, sessionFile: string | undefined): string {
	const live = liveAgentsOf(sessionId);
	const lines = [...readAgentRegistry(entries, sessionId).values()]
		.filter((record) => live.has(record.taskId))
		.map((record) => `- agent ${record.name} (${record.type}) running: ${record.description}`);
	for (const task of backgroundTasksOf(sessionId)) lines.push(`- background task ${task.id} running: ${task.command} (log ${task.logPath})`);
	const recall = sessionFile === undefined ? "" : `\nEarlier detail, from before this compaction, is in ${sessionFile}; read it with ${PI_RECALL} ${sessionFile} list (then grep <regex>, show <n>).`;
	return `<live_state>${recall}\n${lines.length === 0 ? "Nothing is running." : `Running now; each reports into this session when it ends.\n${lines.join("\n")}`}\n</live_state>`;
}

export default function compaction(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const seat = childSeatOf(sessionId);
		const standDown = (reason: string): undefined => {
			const text = `compaction: ${reason}; pi's summariser writes the summary instead`;
			if (seat === undefined) notice(ctx, text, "warning");
			return undefined;
		};
		if (ctx.model === undefined) return standDown("no model to write the summary");
		if (event.reason === "overflow") return standDown("the context overflowed, and the last request is the one the provider rejected");
		const target = readLastRequest(sessionId, ctx.model);
		if (target === undefined) return standDown(`no request of this session on ${ctx.model.id} to replay`);
		const captured = target.payload.messages;
		if (!Array.isArray(captured)) return standDown("the captured request has no messages");
		if (!replayCoversBranch(target.leafId, event.branchEntries, event.preparation.firstKeptEntryId)) return standDown("the last request was not built from this branch, or entries after it would be dropped");
		const pin = seat === undefined ? pinnedMessages(event.branchEntries) : childPin(seat, sessionId);
		if (pin === undefined) return standDown(`no brief on record for ${seat?.name}`);
		const number = event.branchEntries.filter((entry) => entry.type === "compaction").length + 1;
		const payload = { ...target.payload, messages: [...captured, { role: "user", content: [{ type: "text", text: summaryRequest(seat === undefined ? "Joel" : "your parent", number, event.customInstructions) }] }] };
		const failed = (reason: string) => standDown(`the summary call failed (${reason})`);
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(target.model);
			const provider = ctx.modelRegistry.getProvider(target.model.provider);
			if (!auth.ok || provider === undefined) return failed("no credentials for the summary call");
			const stream = provider.stream(auth.baseUrl ? { ...target.model, baseUrl: auth.baseUrl } : target.model, EMPTY_TRANSCRIPT, {
				apiKey: auth.apiKey,
				headers: replayHeaders(target.headers, auth.headers),
				env: auth.env,
				sessionId,
				signal: event.signal,
				onPayload: () => payload,
			});
			for await (const streamed of stream) {
				if (event.signal.aborted) return undefined;
				if (streamed.type === "error") return failed(streamed.error.errorMessage ?? "no reason given");
				if (streamed.type !== "done") continue;
				if (streamed.message.stopReason !== "stop") return failed(`the call ended with ${streamed.message.stopReason}, not a finished summary`);
				const written = streamed.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
				if (written === "") return failed("the call returned no text");
				const summary = `${pin}\n\n${written}\n\n${liveState(event.branchEntries, sessionId, ctx.sessionManager.getSessionFile())}`;
				return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, usage: streamed.message.usage } };
			}
			return event.signal.aborted ? undefined : failed("the stream ended without a result");
		} catch (error) {
			return event.signal.aborted ? undefined : failed(error instanceof Error ? error.message : String(error));
		}
	});
}
