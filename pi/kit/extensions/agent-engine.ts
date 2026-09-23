/**
 * agent-engine — the owned agent engine's seat in pi: the five tools under
 * Claude Code's names (`Agent`, `SendMessage`, `ListAgents`, `TaskOutput`,
 * `TaskStop`; ticket 12), the registry read back at session start, the
 * yield-on-input hook, the next-turn delivery of results, and the dock's
 * stop request. This is the harness's only agent engine (map C1); it keeps
 * the four `subagents:*` events and the `Agent` argument/`details` shape the
 * UI was written against, so `agent-dock` and `agent-rows` read it unchanged
 * (ticket 05 §6).
 *
 * Every seat registers the same five tools with the same text: the refusals —
 * depth 4, an unknown type, a thinking level that does not exist — happen when
 * the tool runs, never by removing it. Which of them reach the wire is one
 * question asked once, by seat, in `lib/tool-policy.ts`: a worker carries none.
 *
 * The engine loads in every child session too, because a child is a seat:
 * it reads its own declaration off `lib/seat.ts` to learn its name, depth
 * and role, and runs its own runtime for its own children. A child's loader
 * is the seat's own extension set, unfiltered — which is what keeps every
 * seat's registry identical, and what makes a child without the wire
 * extension impossible to ask for.
 *
 * The mechanism here; the words are ticket 12's (`lib/agent-tool-text.ts`,
 * `lib/agent-role-tails.ts`), and the type files are ticket 21's.
 */

import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, type ExtensionAPI, type ExtensionContext, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentIsSettled, AgentRegistry, type AgentRecord, readAgentRegistry, AGENT_RECORD_ENTRY } from "../lib/agent-registry.ts";
import { AGENT_NOTIFICATION_TYPE, AgentAddressRefused, type AgentNotification, AgentRuntime, AgentSendRefused, AgentSpawnRefused, AgentStopRefused, MAX_REPORT_CHARS } from "../lib/agent-runtime.ts";
import { claimParkedAgentRuntime, isSessionHandoffAnnounced, parkAgentRuntime } from "../lib/agent-runtime-handover.ts";
import { forgetAgentRuntime, publishAgentRuntime } from "../lib/agent-runtime-seam.ts";
import { formatSpendUsd } from "../lib/agent-spend.ts";
import { jsonArgumentCoercionFor } from "../lib/tool-argument-coercion.ts";
import {
	AGENT_MODEL_ALIASES,
	AGENT_PARAMS,
	AGENT_TOOL_NAMES,
	agentToolDescription,
	LIST_AGENTS_DESCRIPTION,
	SEND_MESSAGE_DESCRIPTION,
	SEND_MESSAGE_PARAMS,
	TASK_OUTPUT_DEFAULT_TIMEOUT_MS,
	TASK_OUTPUT_DESCRIPTION,
	TASK_OUTPUT_MAX_TIMEOUT_MS,
	TASK_OUTPUT_PARAMS,
	TASK_STOP_DESCRIPTION,
	TASK_STOP_PARAMS,
} from "../lib/agent-tool-text.ts";
import { AGENT_THINKING_LEVELS, type AgentType, loadAgentTypes } from "../lib/agent-types.ts";
import { interruptedWaitText } from "../lib/agent-wait.ts";
import { newestInFamily } from "../lib/model-family.ts";
import { notice } from "../lib/notice.ts";
import { childSeatOf, seatCarriesWorkflows } from "../lib/seat.ts";

/**
 * `PI_AGENT_CHILD_EXTENSIONS`: a `:`-separated list of extension paths that
 * children load *instead of* the seat's discovered set. Unset in production;
 * the suite sets it so a child under test loads the engine and nothing else.
 * Read once, like the kit's other `PI_*` overrides.
 */
const CHILD_EXTENSIONS_OVERRIDE = process.env.PI_AGENT_CHILD_EXTENSIONS?.split(":").filter((entry) => entry !== "");

/**
 * A string with a closed set of values, as `{"type":"string","enum":[…]}`.
 * TypeBox's `Union` of `Literal`s says the same thing as an `anyOf` of one
 * `const` each — four times the tokens on the wire for the same constraint.
 * An empty set is no constraint: an empty `enum` is not a schema.
 */
function stringEnum(values: readonly string[], description: string) {
	return Type.Unsafe<string>({ type: "string", description, ...(values.length > 0 ? { enum: [...values] } : {}) });
}

/**
 * The `Agent` schema, built once the types on disk are known: `subagent_type`
 * is an enum of their names, so the valid set is in the schema and nowhere in
 * prose, and a misspelling is refused before the runtime sees it. The runtime
 * check (`AgentRuntime.spawn`) stays for the paths that bypass this schema.
 */
function agentParamsFor(typeNames: readonly string[]) {
	return Type.Object({
		description: Type.String({ description: AGENT_PARAMS.description }),
		prompt: Type.String({ description: AGENT_PARAMS.prompt }),
		subagent_type: Type.Optional(stringEnum(typeNames, AGENT_PARAMS.subagent_type)),
		name: Type.Optional(Type.String({ description: AGENT_PARAMS.name })),
		model: Type.Optional(stringEnum(AGENT_MODEL_ALIASES, AGENT_PARAMS.model)),
		thinking: Type.Optional(stringEnum(AGENT_THINKING_LEVELS, AGENT_PARAMS.thinking)),
		isolation: Type.Optional(Type.Literal("worktree", { description: AGENT_PARAMS.isolation })),
		max_turns: Type.Optional(Type.Number({ description: AGENT_PARAMS.max_turns })),
	});
}

const sendMessageParams = Type.Object({
	to: Type.String({ description: SEND_MESSAGE_PARAMS.to }),
	message: Type.String({ description: SEND_MESSAGE_PARAMS.message }),
	interrupt: Type.Optional(Type.Boolean({ description: SEND_MESSAGE_PARAMS.interrupt, default: false })),
});

const listAgentsParams = Type.Object({});

const taskOutputParams = Type.Object({
	names: Type.Optional(Type.Array(Type.String(), { description: TASK_OUTPUT_PARAMS.names })),
	block: Type.Optional(Type.Boolean({ description: TASK_OUTPUT_PARAMS.block, default: true })),
	timeout: Type.Optional(Type.Number({ description: TASK_OUTPUT_PARAMS.timeout, default: TASK_OUTPUT_DEFAULT_TIMEOUT_MS, minimum: 0, maximum: TASK_OUTPUT_MAX_TIMEOUT_MS })),
	transcript: Type.Optional(Type.Boolean({ description: TASK_OUTPUT_PARAMS.transcript })),
});

const taskStopParams = Type.Object({
	name: Type.String({ description: TASK_STOP_PARAMS.name }),
});

/** `agent-rows`' `AgentDetails` on an `Agent` tool result (ticket 05 §6, the second contract). */
interface AgentToolDetails {
	displayName: string;
	description: string;
	subagentType: string;
	toolUses: number;
	/** What the agent wrote, and what that cost: the row's "how much work, how expensive" (issues/31 (d)). */
	outputTokens: number;
	costUsd: number;
	status: string;
	agentId: string;
	name: string;
	error?: string;
}

function detailsOf(record: AgentRecord, status: string = record.status): AgentToolDetails {
	return {
		displayName: record.type,
		description: record.description,
		subagentType: record.type,
		toolUses: record.toolUses,
		outputTokens: record.outputTokens,
		costUsd: record.costUsd,
		status,
		agentId: record.taskId,
		name: record.name,
		...(record.error !== undefined ? { error: record.error } : {}),
	};
}

/** A plain text tool result, typed the way pi's `AgentToolResult` wants it (`details` present, undefined). */
function textResult<TDetails>(text: string, details?: TDetails): { content: Array<{ type: "text"; text: string }>; details: TDetails | undefined } {
	return { content: [{ type: "text", text }], details };
}

function formatAge(sinceMs: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - sinceMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function firstLine(text: string | undefined): string {
	return (text ?? "").split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * The task ids whose notification the harness can *see* in this seat's session
 * file — the fact that used to be inferred from a bit set at hand-off.
 */
function deliveredTaskIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== AGENT_NOTIFICATION_TYPE) continue;
		const text = typeof entry.content === "string" ? entry.content : entry.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) ids.add(match[1] as string);
	}
	return ids;
}

/**
 * What a seat may truthfully say about where a taken result is, read off
 * {@link AgentRecord.readBy} rather than inferred from one bit.
 */
function deliveryText(record: AgentRecord, now: number): string {
	const clock = record.readAt === undefined ? "" : ` at ${new Date(record.readAt).toISOString().slice(11, 19)} (${formatAge(record.readAt, now)} ago)`;
	const where = record.sessionFile === undefined ? "" : ` · whole result: ${record.sessionFile}`;
	const phrase =
		record.readBy === "conversation"
			? `delivered to your conversation${clock}`
			: record.readBy === "handed"
				? "queued for your conversation; it arrives on its own when this turn ends — do not wait again"
				: record.readBy === "tool"
					? `returned to you by TaskOutput${clock}`
					: "consumed by the workflow that spawned it; it never enters your conversation";
	return `${phrase}${where}`;
}

/**
 * What `TaskStop` says about a run that has already ended: which verdict it
 * reached and where that verdict went.
 *
 * "is not running (error)" reads like an unknown name; on 2026-09-05 a seat was
 * told it about a run whose error was that second's news, and went looking for
 * the run rather than reading the verdict (issues/56).
 */
function endedAgentStopText(record: AgentRecord, now: number): string {
	const verdict = record.readBy === undefined ? "its result has not reached you yet — it arrives on its own" : deliveryText(record, now);
	return `Agent "${record.name}" already ended (${record.status}); ${verdict}.`;
}

/**
 * An expected refusal, handed to pi the one way it marks a tool result as an
 * error: by throwing. A returned `isError` is ignored by pi's runner (its
 * docs: "Returning a value never sets the error flag"). The runtime's own
 * seam keeps refusals as tagged values; this is the translation at pi's edge.
 */
function refuse(message: string): never {
	throw new Error(message);
}

/**
 * A `provider/id`, alias or bare id resolved against the models the seat can
 * use, through {@link newestInFamily} and nothing else. A `provider/` prefix
 * narrows the search to that provider.
 *
 * There is no substring or prefix fallback (issues/40): one answered `sonnet`
 * with `claude-sonnet-4-5` and `luna` with `gpt-5.6-luna`, whatever sorted
 * first. A spec the catalog cannot rank resolves to nothing, and a family two
 * providers carry is refused with both named, never picked.
 */
function resolveModelSpec(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	const slash = spec.indexOf("/");
	const provider = slash > 0 ? spec.slice(0, slash) : undefined;
	const bare = slash > 0 ? spec.slice(slash + 1) : spec;
	const available = ctx.modelRegistry.getAvailable().filter((model) => provider === undefined || model.provider === provider);
	const answer = newestInFamily(bare, available);
	if (answer.kind === "ambiguous") {
		const names = answer.candidates.map((model) => `${model.provider}/${model.id}`).join(" and ");
		throw new AgentSpawnRefused("no-model", `Model "${spec}" is ambiguous: ${names} both match. Name one with its provider prefix.`);
	}
	return answer.kind === "found" ? answer.model : undefined;
}

export default function agentEngine(pi: ExtensionAPI) {
	let runtime: AgentRuntime | undefined;
	let sessionId = "";
	// Read once, when the seat starts: the `Agent` description is part of the
	// cached prefix and must not change per request (C21: rendered at session
	// start). A type file edited mid-session is read by the next session.
	const loadedTypes = loadAgentTypes(join(getAgentDir(), "agents"));
	const types: AgentType[] = loadedTypes.types;

	/** The child's loader: the seat's own extension set, the type's body as the custom prompt. */
	async function childLoader(options: { cwd: string; systemPrompt: string | undefined }) {
		const loader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			noPromptTemplates: true,
			noThemes: true,
			...(CHILD_EXTENSIONS_OVERRIDE !== undefined
				? { noExtensions: true, additionalExtensionPaths: CHILD_EXTENSIONS_OVERRIDE, noSkills: true, noContextFiles: true }
				: {}),
			...(options.systemPrompt !== undefined ? { systemPromptOverride: () => options.systemPrompt } : {}),
		});
		await loader.reload();
		return loader;
	}

	/**
	 * The seat's runtime: a new one, or — after a handoff (map C23) — the
	 * outgoing session's runtime re-hosted here, so the agents it holds live
	 * keep running and settle into this session's registry and file.
	 */
	async function buildRuntime(ctx: ExtensionContext): Promise<AgentRuntime> {
		const seat = childSeatOf(sessionId);
		const registry = new AgentRegistry((record) => pi.appendEntry(AGENT_RECORD_ENTRY, record), readAgentRegistry(ctx.sessionManager.getEntries(), sessionId).values());
		const host = buildHost(ctx, seat);
		const parked = claimParkedAgentRuntime(ctx.sessionManager.getSessionFile());
		if (parked === undefined) return new AgentRuntime(host, registry);
		await parked.rehost(host, registry);
		return parked;
	}

	function buildHost(ctx: ExtensionContext, seat: ReturnType<typeof childSeatOf>): ConstructorParameters<typeof AgentRuntime>[0] {
		return (
			{
				sessionId,
				sessionFile: ctx.sessionManager.getSessionFile(),
				sessionDir: ctx.sessionManager.getSessionDir(),
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				depth: seat?.depth ?? 0,
				role: seat?.role ?? "main",
				types,
				model: () => ctx.model,
				resolveModel: (spec) => resolveModelSpec(ctx, spec),
				modelRuntime: (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime,
				persist: (record) => pi.appendEntry(AGENT_RECORD_ENTRY, record),
				emit: (channel, payload) => pi.events.emit(channel, payload),
				deliver,
				exec: (command, args, options) => pi.exec(command, args, options),
				hasPendingInput: () => ctx.hasPendingMessages(),
				childLoader,
				log: (message, level) => notice(ctx, message, level),
			}
		);
	}

	// Ticket 09's whole delivery mechanism, in one call: pi's `isStreaming`
	// decides which of the two shapes this is, so the kit never asks whether the
	// seat is busy. Mid-turn the message is a follow-up the model sees at its
	// next step; idle, it starts the turn.
	function deliver(notification: AgentNotification): void {
		pi.sendMessage(
			{ customType: AGENT_NOTIFICATION_TYPE, content: notification.content, display: true, details: notification.details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		for (const problem of loadedTypes.problems) {
			if (ctx.hasUI) ctx.ui.notify(`agent-engine: ${problem.source}: ${problem.reason}`, "warning");
		}
		runtime = await buildRuntime(ctx);
		// The `Workflow` tool (ticket 23) spawns through this runtime, so its
		// children are registry entries like any other.
		publishAgentRuntime(sessionId, runtime);
	});

	// A result can still be unread when a turn starts: an explorer whose batch is
	// waiting on a slow sibling, or one whose delivery raced the turn Joel typed.
	// It rides into this turn, in one message, marked read (C7).
	//
	// And this is the harness's only sighting of a delivery: the session file is
	// scanned for each handed result's notification, so `readBy` becomes
	// `conversation` because the text was *observed* there, and one that never
	// arrived is folded into this turn's message rather than lost.
	pi.on("before_agent_start", (_event, ctx) => {
		const workflows = seatCarriesWorkflows(ctx.sessionManager.getSessionId());
		if (workflows !== describedWorkflows) {
			describedWorkflows = workflows;
			registerAgentTool(workflows);
		}
		const seen = deliveredTaskIds(ctx);
		let message: { customType: string; content: string; display: boolean; details: unknown } | undefined;
		runtime?.takeForTurn(
			(taskId) => seen.has(taskId),
			(batch) => {
				message = { customType: AGENT_NOTIFICATION_TYPE, content: batch.content, display: true, details: batch.details };
			},
		);
		if (message === undefined) return undefined;
		return { message };
	});

	// Joel typed while a wait was in flight: the wait returns, the message goes
	// on as the steer pi was already queuing it as (ticket 09).
	pi.on("input", (event) => {
		if (event.streamingBehavior !== undefined) runtime?.interruptWaits("Joel");
		return undefined;
	});

	// A handoff parks the runtime for its continuation to claim; the runs stay
	// live. Anything else — `/new`, quit, resume, fork, reload — stops them: no
	// session that follows owns them. pi sends a handoff and `/new` the same
	// `reason: "new"`, so only continue-session's announcement tells them apart.
	pi.on("session_shutdown", (event) => {
		if (runtime === undefined) return;
		forgetAgentRuntime(sessionId);
		if (event.reason === "new" && isSessionHandoffAnnounced(sessionId) && parkAgentRuntime(event.targetSessionFile, runtime)) return;
		void runtime.retire("shutdown");
	});

	// The dock's stop button (ticket 05 §6): reply on the request's own channel.
	pi.events.on("subagents:rpc:stop", (payload) => {
		const request = payload as { requestId?: unknown; agentId?: unknown } | null;
		if (typeof request?.requestId !== "string" || typeof request.agentId !== "string") return;
		const reply = (envelope: { success: true } | { success: false; error: string }) => pi.events.emit(`subagents:rpc:stop:reply:${request.requestId}`, envelope);
		if (runtime === undefined) {
			reply({ success: false, error: "Agent not found" });
			return;
		}
		if (runtime.registry.byTaskId(request.agentId) === undefined && runtime.registry.byName(request.agentId) === undefined) return;
		runtime
			.stop(request.agentId, "dock")
			.then(() => reply({ success: true }))
			.catch((error: unknown) => reply({ success: false, error: error instanceof Error ? error.message : String(error) }));
	});

	// ---- Agent -------------------------------------------------------------------

	/**
	 * The ladder in this description names `Workflow` only where the seat carries
	 * it, and that answer is not known at registration: the launcher asks for it
	 * in `session_start` (`extensions/session-mode.ts`), and pi promises no order
	 * between two extensions. So the seat registers the plain words now and
	 * re-registers once at the start of its first turn if it turns out to carry
	 * workflows — before the payload is built, so the cached prefix is written
	 * from the words the seat keeps for the rest of its life.
	 */
	function registerAgentTool(workflows: boolean): void {
		const agentParams = agentParamsFor(types.map((type) => type.name));
		pi.registerTool({
			name: AGENT_TOOL_NAMES.AGENT,
			label: "Agent",
			description: agentToolDescription(types, workflows),
			parameters: agentParams,
			prepareArguments: jsonArgumentCoercionFor(agentParams),
			async execute(toolCallId, params) {
				if (runtime === undefined) return refuse("Agent engine is not ready: no session yet.");
				let record: AgentRecord;
				try {
					record = await runtime.spawn({
						description: params.description,
						prompt: params.prompt,
						...(params.subagent_type !== undefined ? { subagentType: params.subagent_type } : {}),
						...(params.name !== undefined ? { name: params.name } : {}),
						...(params.model !== undefined ? { model: params.model } : {}),
						...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
						...(params.isolation !== undefined ? { isolation: params.isolation } : {}),
						...(params.max_turns !== undefined ? { maxTurns: params.max_turns } : {}),
						toolCallId,
					});
				} catch (error) {
					if (error instanceof AgentSpawnRefused || error instanceof AgentAddressRefused) return refuse(error.message);
					throw error;
				}
				return {
					content: [
						{
							type: "text",
							text: [
								"Agent started in background.",
								`Name: ${record.name}`,
								`Task ID: ${record.taskId}`,
								`Type: ${record.type}`,
								`Description: ${record.description}`,
								...(record.branch !== undefined ? [`Branch: ${record.branch}`] : []),
								"Its result is delivered to you when it lands (the dock shows ✓). Use TaskOutput only if you need it before you can continue.",
							].join("\n"),
						},
					],
					details: detailsOf(record, "background"),
				};
			},
		});
	}
	registerAgentTool(false);
	/** Which words the `Agent` tool is registered with, so the re-registration happens once. */
	let describedWorkflows = false;

	// ---- SendMessage --------------------------------------------------------------

	pi.registerTool({
		name: AGENT_TOOL_NAMES.SEND_MESSAGE,
		label: "SendMessage",
		description: SEND_MESSAGE_DESCRIPTION,
		parameters: sendMessageParams,
		prepareArguments: jsonArgumentCoercionFor(sendMessageParams),
		async execute(toolCallId, params) {
			if (runtime === undefined) return refuse("Agent engine is not ready: no session yet.");
			try {
				// The resumed run's notification carries *this* call's id, so a new
				// result is never mistaken for a redelivery of the first run's.
				const sent = await runtime.send(params.to, params.message, params.interrupt === true, toolCallId);
				const text =
					sent.kind === "queued"
						? `Sent to ${sent.record.name}; it reads the message at its next step.`
						: sent.kind === "interrupted"
							? `Interrupted ${sent.record.name}; it continues with your message now.`
							: `${sent.record.name} resumed from its transcript with your message (task ${sent.record.taskId}). It reports again when done.`;
				return { content: [{ type: "text", text }], details: detailsOf(sent.record) };
			} catch (error) {
				if (error instanceof AgentSendRefused || error instanceof AgentSpawnRefused || error instanceof AgentAddressRefused) return refuse(error.message);
				throw error;
			}
		},
	});

	// ---- ListAgents ----------------------------------------------------------------

	pi.registerTool({
		name: AGENT_TOOL_NAMES.LIST_AGENTS,
		label: "ListAgents",
		description: LIST_AGENTS_DESCRIPTION,
		parameters: listAgentsParams,
		async execute() {
			if (runtime === undefined) return refuse("Agent engine is not ready: no session yet.");
			const records = runtime.registry.all();
			if (records.length === 0) return textResult("No agents this session.");
			const now = Date.now();
			const rows = records.map((record) => {
				const settled = agentIsSettled(record.status);
				// A live agent's clock runs from its start; a settled one's stops where
				// it stopped, so its row reports the run rather than how long ago it began.
				const clock = settled && record.completedAt !== undefined ? `ran ${formatAge(record.startedAt, record.completedAt)}` : formatAge(record.startedAt, now);
				// Dollars are here and nowhere else the model can see them: this is the
				// diagnostic surface (map C15). They are never on a dock row — Joel reads
				// time there and opens `/stats` when he wants money.
				const spend = settled ? formatSpendUsd(record.costUsd) : "";
				const unread = settled && record.readBy === undefined ? " (unread)" : "";
				const last = firstLine(record.result ?? record.error);
				return [`${record.name} · ${record.type} · ${record.status}${unread}`, clock, spend, last].filter((part) => part !== "").join(" · ");
			});
			return textResult(rows.join("\n"));
		},
	});

	// ---- TaskOutput ----------------------------------------------------------------

	pi.registerTool({
		name: AGENT_TOOL_NAMES.TASK_OUTPUT,
		label: "TaskOutput",
		description: TASK_OUTPUT_DESCRIPTION,
		parameters: taskOutputParams,
		prepareArguments: jsonArgumentCoercionFor(taskOutputParams),
		async execute(_toolCallId, params, signal) {
			if (runtime === undefined) return refuse("Agent engine is not ready: no session yet.");
			const names = params.names ?? [];
			try {
				runtime.checkAddressable(names);
			} catch (error) {
				if (error instanceof AgentAddressRefused) return refuse(error.message);
				throw error;
			}
			const timeout = Math.min(TASK_OUTPUT_MAX_TIMEOUT_MS, Math.max(0, params.timeout ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS));
			const block = params.block !== false;
			const wait = block ? await runtime.wait(names, timeout, signal) : { outcome: { kind: "settled" as const }, done: 0, of: names.length, unknown: names.filter((name) => runtime?.registry.byName(name) === undefined) };
			const lines: string[] = [];
			if (wait.unknown.length > 0) lines.push(`Unknown agents: ${wait.unknown.join(", ")} — run ListAgents to see targets.`);
			if (wait.outcome.kind === "interrupted") lines.push(interruptedWaitText(wait.outcome.by, wait.done, wait.of));
			if (wait.outcome.kind === "timeout") lines.push(`timed out — ${wait.done} of ${wait.of} done`);
			// Taken on the path that prints it: `takeUnread` marks the results read
			// only after their text is in the reply (C7).
			const batch = runtime.takeUnread(names.length > 0 ? names : undefined, (notification) => lines.push(notification.content), "tool");
			const still = names.length > 0 ? names.filter((name) => !agentIsSettled(runtime?.registry.byName(name)?.status ?? "completed")) : runtime.registry.live().map((record) => record.name);
			if (batch === undefined && still.length > 0) lines.push(`Still running: ${still.join(", ")}.`);
			// "Nothing" must mean nothing. A result read once (C7) is still a fact
			// about this seat's agents, and saying nothing about it is what made the
			// 2026-09-03 shakedown believe a completion had been lost.
			if (batch === undefined && still.length === 0) {
				const taken = (names.length > 0 ? names.map((name) => runtime?.registry.byName(name)) : runtime.registry.all()).filter((record): record is AgentRecord => record !== undefined && agentIsSettled(record.status) && record.readBy !== undefined);
				lines.push(
					taken.length > 0
						? [`Nothing unread. Each of these reached a reader once (C7); pass \`transcript: true\` to read one again:`, ...taken.map((record) => `${record.name} · ${record.status} · ${deliveryText(record, Date.now())}`)].join("\n")
						: "Nothing to report: no agent of yours is running or has an unread result.",
				);
			}
			// Outside the batch, deliberately: a result already read is exactly the one
			// a caller needs a way back to, and nesting this under "something was
			// unread" made the only escape hatch unreachable when it was wanted.
			if (params.transcript === true) {
				const named = batch !== undefined ? [batch.details.name, ...(batch.details.others ?? []).map((other) => other.name)] : names.length > 0 ? names : runtime.registry.all().filter((record) => agentIsSettled(record.status)).map((record) => record.name);
				for (const name of named) {
					const record = runtime.registry.byName(name);
					if (record?.sessionFile !== undefined) lines.push(`\n## Transcript of ${name}\n${renderTranscript(record.sessionFile)}`);
				}
			}
			return textResult(lines.join("\n"), batch?.details);
		},
	});

	// ---- TaskStop ------------------------------------------------------------------

	pi.registerTool({
		name: AGENT_TOOL_NAMES.TASK_STOP,
		label: "TaskStop",
		description: TASK_STOP_DESCRIPTION,
		parameters: taskStopParams,
		async execute(_toolCallId, params) {
			if (runtime === undefined) return refuse("Agent engine is not ready: no session yet.");
			try {
				const record = await runtime.stop(params.name, "TaskStop");
				const kept = record.result ? `\nResult so far:\n${record.result}` : "";
				return { content: [{ type: "text", text: `Stopped ${record.name}.${kept}` }], details: detailsOf(record) };
			} catch (error) {
				if (error instanceof AgentStopRefused && error.reason === "not-running") {
					const ended = runtime.registry.byName(params.name) ?? runtime.registry.byTaskId(params.name);
					if (ended !== undefined) return refuse(endedAgentStopText(ended, Date.now()));
				}
				if (error instanceof AgentStopRefused || error instanceof AgentAddressRefused) return refuse(error.message);
				throw error;
			}
		},
	});

}

/**
 * A child's conversation as lines: user and assistant text, tool calls by name,
 * bounded to {@link MAX_REPORT_CHARS}. The **tail** is what is kept: a caller
 * asking for a transcript is asking what the child did last, and an unbounded
 * one is the same context jump `boundReport` exists to stop (38's deletion 1,
 * refused — 51 §4 keeps this as the only way back to a delivered-once result).
 */
function renderTranscript(sessionFile: string): string {
	try {
		const manager = SessionManager.open(sessionFile);
		const lines: string[] = [];
		for (const entry of manager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : message.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n");
				lines.push(`user: ${text}`);
			} else if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "text" && block.text.trim()) lines.push(`assistant: ${block.text}`);
					if (block.type === "toolCall") lines.push(`tool: ${block.name}(${JSON.stringify(block.arguments).slice(0, 200)})`);
				}
			}
		}
		const text = lines.join("\n");
		if (text.length <= MAX_REPORT_CHARS) return text;
		return `[transcript truncated: ${text.length} characters, the last ${MAX_REPORT_CHARS} kept. The whole of it is \`${sessionFile}\`.]\n\n${text.slice(text.length - MAX_REPORT_CHARS)}`;
	} catch (error) {
		return `(transcript unavailable: ${error instanceof Error ? error.message : String(error)})`;
	}
}
