import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, type EventBus, type ExtensionAPI, type ExtensionContext, getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { agentIsSettled, type AgentRecord, readAgentRegistry, AGENT_RECORD_ENTRY } from "../../lib/agents/agent-registry.ts";
import { AGENT_NOTIFICATION_TYPE, deliveredAgentTaskIds } from "../../lib/agents/agent-notification.ts";
import { type AgentProcessDeps, AgentRuntime, type SeatPort, startableTypes } from "../../lib/agents/agent-runtime.ts";
import { AgentAddressRefused, AgentSendRefused, AgentSpawnRefused, AgentStopRefused, refuseToolCall } from "../../lib/agents/agent-refusals.ts";
import { forgetAgentRuntime, publishAgentRuntime } from "../../lib/agents/agent-runtime-seam.ts";
import { completionNotice } from "../../lib/tools/background-task-notification.ts";
import { backgroundTasksOf, otherSessionHoldsBackgroundTask, readBackgroundTask, stopBackgroundTask } from "../../lib/tools/background-tasks.ts";
import { registerAbortBoundedTool } from "../../lib/tools/tool-abort-bound.ts";
import {
	AGENT_TOOL_NAMES,
	agentParamsFor,
	agentToolDescription,
	LIST_AGENTS_DESCRIPTION,
	SEND_MESSAGE_DESCRIPTION,
	TASK_OUTPUT_DEFAULT_TIMEOUT_MS,
	TASK_OUTPUT_MAX_TIMEOUT_MS,
	TASK_STOP_DESCRIPTION,
	taskOutputDescription,
} from "../../lib/agents/agent-tool-text.ts";
import { type AgentType, loadAgentTypes } from "../../lib/agents/agent-type-files.ts";
import { type AgentNotification } from "../../lib/agents/agent-task-notification.ts";
import { AgentWaitBoard } from "../../lib/agents/agent-wait-board.ts";
import { agentHoldText, agentListRow, agentStartedText, agentToolDetailsOf, deliveryText, endedAgentStopText, interruptedWaitText, messageSentText, renderTranscript, textResult } from "./agent-tool-replies.ts";
import { listAgentsParams, sendMessageParams } from "./agent-tool-schemas.ts";
import { taskOutputCallOf, type TaskOutputDetails, taskOutputParams, taskStopCallOf, type TaskStopDetails, taskStopParams } from "../../lib/agents/task-tool-calls.ts";
import { processExec } from "../../lib/agents/agent-worktree.ts";
import { newestInFamily } from "../../lib/models/model-family.ts";
import { notice } from "../../lib/process/human-notice.ts";
import { childSeatOf, seatCarriesWorkflows } from "../../lib/session/seat-identity.ts";
import { createSessionScope } from "../../lib/session/session-scope.ts";
import type { ReplyId } from "../../lib/agents/reply-formats.ts";
import { promptTargetClaimsInput } from "../../lib/session/prompt-target.ts";

const CHILD_EXTENSIONS_OVERRIDE = process.env.PI_AGENT_CHILD_EXTENSIONS?.split(":").filter((entry) => entry !== "");

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
	const scope = createSessionScope(pi);
	let runtime: AgentRuntime | undefined;
	let startFailure: string | undefined;
	const refuseNotReady = (): never =>
		refuseToolCall(startFailure === undefined ? "Agent engine is not ready: no session yet." : `Agent engine failed to start for this session: ${startFailure}. /reload starts it again.`);
	let sessionId = "";
	function declareTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>, stillRunning?: (params: Static<TParams>) => string): void {
		registerAbortBoundedTool(pi, tool, stillRunning);
	}
	const loadedTypes = loadAgentTypes(join(getAgentDir(), "agents"));
	const types: AgentType[] = loadedTypes.types;
	let startable: AgentType[] = types;

	async function childLoader(options: { cwd: string; systemPrompt: string | undefined; context: AgentType["context"]; eventBus: EventBus }) {
		const loader = new DefaultResourceLoader({
			cwd: options.cwd,
			eventBus: options.eventBus,
			agentDir: getAgentDir(),
			noPromptTemplates: true,
			noThemes: true,
			...(options.context === "none" ? { noContextFiles: true, noSkills: true, appendSystemPromptOverride: () => [] } : {}),
			...(CHILD_EXTENSIONS_OVERRIDE !== undefined
				? { noExtensions: true, additionalExtensionPaths: CHILD_EXTENSIONS_OVERRIDE, noSkills: true, noContextFiles: true }
				: {}),
			...(options.systemPrompt !== undefined ? { systemPromptOverride: () => options.systemPrompt } : {}),
		});
		await loader.reload();
		return loader;
	}

	function buildRuntime(ctx: ExtensionContext): AgentRuntime {
		const seat = childSeatOf(sessionId);
		const records = readAgentRegistry(ctx.sessionManager.getEntries(), sessionId).values();
		const port: SeatPort = {
			sessionId,
			sessionFile: ctx.sessionManager.getSessionFile(),
			sessionDir: ctx.sessionManager.getSessionDir(),
			depth: seat?.depth ?? 0,
			role: seat?.role ?? "main",
			types: startable,
			model: () => ctx.model,
			resolveModel: (spec) => resolveModelSpec(ctx, spec),
			exactModel: (provider, id) => ctx.modelRegistry.getAvailable().find((model) => model.provider === provider && model.id === id),
			// SAFETY: ModelRegistry.runtime is not in pi's public type; the value is passed on as unknown and checked by its consumer
			modelRuntime: (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime,
			persist: (record) => pi.appendEntry(AGENT_RECORD_ENTRY, record),
			emit: (channel, payload) => pi.events.emit(channel, payload),
			deliver,
			hasPendingInput: () => ctx.hasPendingMessages(),
			log: (message, level) => notice(ctx, message, level),
		};
		const deps: AgentProcessDeps = { cwd: ctx.cwd, agentDir: getAgentDir(), exec: processExec, childLoader, waitBoard: new AgentWaitBoard() };
		return new AgentRuntime(deps, port, records);
	}

	function deliver(notification: AgentNotification): boolean {
		return scope.startTurn({ customType: AGENT_NOTIFICATION_TYPE, content: notification.content, display: true, details: notification.details });
	}
	scope.onTurnsReopen(() => runtime?.offerUnread());

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		const child = childSeatOf(sessionId);
		if (child !== undefined) {
			startable = startableTypes(types, child.agentTypes);
			registerAgentTool(describedWorkflows);
			registerTaskOutputTool();
		}
		for (const problem of loadedTypes.problems) {
			if (ctx.hasUI) ctx.ui.notify(`agent-engine: ${problem.source}: ${problem.reason}`, "warning");
		}
		try {
			runtime = buildRuntime(ctx);
		} catch (error) {
			startFailure = error instanceof Error ? error.message : String(error);
			notice(ctx, `agent-engine: the agent runtime failed to start for this session: ${startFailure}. /reload starts it again.`, "error");
			return;
		}
		publishAgentRuntime(sessionId, runtime);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const workflows = seatCarriesWorkflows(ctx.sessionManager.getSessionId());
		if (workflows !== describedWorkflows) {
			describedWorkflows = workflows;
			registerAgentTool(workflows);
		}
		const seen = deliveredAgentTaskIds(ctx.sessionManager.getEntries());
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

	pi.on("agent_start", () => runtime?.offerUnread());

	pi.on("input", (event, ctx) => {
		if (event.streamingBehavior !== undefined && !promptTargetClaimsInput(ctx.sessionManager.getSessionId(), event)) runtime?.interruptWaits(event.source);
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		if (runtime === undefined) return;
		forgetAgentRuntime(sessionId);
		await runtime.retire("shutdown");
	});

	pi.events.on("subagents:rpc:stop", (payload) => {
		// SAFETY: the stop RPC payload is read only through typeof checks on both fields
		const request = payload as { requestId?: unknown; agentId?: unknown } | null;
		if (typeof request?.requestId !== "string" || typeof request.agentId !== "string") return;
		const reply = (envelope: { success: true } | { success: false; error: string }) => {
			if (!scope.signal.aborted) pi.events.emit(`subagents:rpc:stop:reply:${request.requestId}`, envelope);
		};
		if (runtime === undefined) {
			reply({ success: false, error: "Agent not found" });
			return;
		}
		if (runtime.registry.byTaskId(request.agentId) === undefined && runtime.registry.byName(request.agentId) === undefined) {
			if (!runtime.forwardStop(request.requestId, request.agentId)) reply({ success: false, error: "Agent not found" });
			return;
		}
		runtime
			.stop(request.agentId, "dock")
			.then(() => reply({ success: true }))
			.catch((error: unknown) => reply({ success: false, error: error instanceof Error ? error.message : String(error) }));
	});

	function registerAgentTool(workflows: boolean): void {
		if (startable.length === 0) return;
		const agentParams = agentParamsFor(startable.map((type) => type.name));
		declareTool({
			name: AGENT_TOOL_NAMES.AGENT,
			label: "Agent",
			description: agentToolDescription(startable, workflows),
			parameters: agentParams,
			async execute(toolCallId, params, signal) {
				if (runtime === undefined) return refuseNotReady();
				let record: AgentRecord;
				try {
					record = await runtime.spawn({
						description: params.description,
						prompt: params.prompt,
						...(params.subagent_type !== undefined ? { subagentType: params.subagent_type } : {}),
						...(params.name !== undefined ? { name: params.name } : {}),
						...(params.model !== undefined ? { model: params.model } : {}),
						...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
						...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
						...(params.isolation !== undefined ? { isolation: params.isolation } : {}),
						// SAFETY: params.reply is schema-validated to a ReplyId literal by the tool parameters
						...(params.reply !== undefined ? { reply: params.reply as ReplyId } : {}),
						toolCallId,
						signal,
					});
				} catch (error) {
					if (error instanceof AgentSpawnRefused || error instanceof AgentAddressRefused) return refuseToolCall(error.message);
					throw error;
				}
				return { content: [{ type: "text", text: agentStartedText(record) }], details: agentToolDetailsOf(record, "background") };
			},
		}, (params) => `The start of agent "${params.description}" is abandoned when its pending step returns: it will not run, and ListAgents shows it stopped.`);
	}
	registerAgentTool(false);
	let describedWorkflows = false;

	declareTool({
		name: AGENT_TOOL_NAMES.SEND_MESSAGE,
		label: "SendMessage",
		description: SEND_MESSAGE_DESCRIPTION,
		parameters: sendMessageParams,
		async execute(toolCallId, params, signal) {
			if (runtime === undefined) return refuseNotReady();
			try {
				const sent = await runtime.send(params.to, params.message, params.interrupt === true, "seat", toolCallId, signal);
				return { content: [{ type: "text", text: messageSentText(sent.kind, sent.record) }], details: agentToolDetailsOf(sent.record) };
			} catch (error) {
				if (error instanceof AgentSendRefused || error instanceof AgentSpawnRefused || error instanceof AgentAddressRefused) return refuseToolCall(error.message);
				throw error;
			}
		},
	}, (params) => `If the message was resuming "${params.to}", the resume is abandoned when its pending step returns and the message is not delivered.`);

	declareTool({
		name: AGENT_TOOL_NAMES.LIST_AGENTS,
		label: "ListAgents",
		description: LIST_AGENTS_DESCRIPTION,
		parameters: listAgentsParams,
		async execute() {
			if (runtime === undefined) return refuseNotReady();
			const records = runtime.registry.all();
			if (records.length === 0) return textResult("No agents this session.");
			const now = Date.now();
			return textResult(records.map((record) => agentListRow(record, now, runtime?.holdOf(record.taskId))).join("\n"));
		},
	});

	function noTaskOfYours(id: number, verb: "read" | "stop"): never {
		const mine = backgroundTasksOf(sessionId).map((task) => task.id);
		const another = otherSessionHoldsBackgroundTask(sessionId, id) ? ` A task ${id} belongs to another session; it is not yours to ${verb}.` : "";
		return refuseToolCall(`No background task ${id} of yours.${another} Your running tasks: ${mine.length === 0 ? "none" : mine.join(", ")}.`);
	}

	async function readTask(id: number, waitMs: number, signal: AbortSignal | undefined) {
		const reading = readBackgroundTask(sessionId, id, waitMs, signal);
		if (reading === undefined) return noTaskOfYours(id, "read");
		const read = await reading;
		switch (read.state) {
			case "noticed":
				return textResult<TaskOutputDetails>(`Task ${id} has ended; its result is queued for your conversation and arrives on its own — do not wait again.`, { kind: "task", id, outcome: "noticed" });
			case "owner-ended":
				return textResult<TaskOutputDetails>(`Task ${id} was ended with your session; its result is in the session's end report.`, { kind: "task", id, outcome: "owner-ended" });
			case "finished":
				return textResult<TaskOutputDetails>(completionNotice(read.task), { kind: "task", id, outcome: "finished", exitCode: read.task.exitCode, signal: read.task.signal });
			case "running":
			case "timed-out":
			case "aborted": {
				const { task } = read;
				const head = read.state === "timed-out" ? `Timed out: task ${id}` : `Task ${id}`;
				return textResult<TaskOutputDetails>(`${head} is still running after ${Math.round(task.durationMs / 1000)}s: \`${task.command}\`\nOutput so far:\n${task.tail === "" ? "No output." : task.tail}\nFull log at: ${task.logPath}`, { kind: "task", id, outcome: read.state });
			}
			default: {
				const unhandled: never = read;
				return unhandled;
			}
		}
	}

	function registerTaskOutputTool(): void {
		declareTool({
			name: AGENT_TOOL_NAMES.TASK_OUTPUT,
			label: "TaskOutput",
			description: taskOutputDescription(startable),
			parameters: taskOutputParams,
			async execute(_toolCallId, params, signal) {
				if (runtime === undefined) return refuseNotReady();
				const call = taskOutputCallOf(params);
				if (call.kind === "invalid") return refuseToolCall("Give `names` (agents) or `task` (your own background bash task number), not both.");
				const timeout = Math.min(TASK_OUTPUT_MAX_TIMEOUT_MS, Math.max(0, params.timeout ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS));
				if (call.kind === "task") return readTask(call.id, params.block === false ? 0 : timeout, signal);
				const asked = call.names;
				try {
					runtime.checkAddressable(asked);
				} catch (error) {
					if (error instanceof AgentAddressRefused) return refuseToolCall(error.message);
					throw error;
				}
				const block = params.block !== false;
				const wait = block ? await runtime.wait(asked, timeout, signal) : { outcome: { kind: "settled" as const }, done: 0, of: asked.length, unknown: asked.filter((name) => runtime?.byAddress(name) === undefined) };
				const addressed = () => [...new Map(asked.flatMap((address) => runtime?.byAddress(address) ?? []).map((record) => [record.taskId, record])).values()];
				const lines: string[] = [];
				if (wait.unknown.length > 0) lines.push(`Unknown agents: ${wait.unknown.join(", ")} — run ListAgents to see targets.`);
				if (wait.outcome.kind === "interrupted") lines.push(interruptedWaitText(wait.outcome.by, wait.done, wait.of));
				if (wait.outcome.kind === "timeout") lines.push(`timed out — ${wait.done} of ${wait.of} done`);
				const batch = runtime.takeUnread(asked.length > 0 ? asked : undefined, (notification) => {
					lines.push(notification.content);
				}, "tool");
				const still = (asked.length > 0 ? addressed().filter((record) => !agentIsSettled(record.status)) : runtime.registry.live()).map((record) => {
					const hold = runtime?.holdOf(record.taskId);
					return hold === undefined ? record.name : `${record.name} (${agentHoldText(hold, Date.now())})`;
				});
				if (batch === undefined && still.length > 0) lines.push(`Still running: ${still.join(", ")}.`);
				const allUnknown = asked.length > 0 && wait.unknown.length === asked.length;
				if (batch === undefined && still.length === 0 && !allUnknown) {
					const taken = (asked.length > 0 ? addressed() : runtime.registry.all()).filter((record) => agentIsSettled(record.status) && record.readBy !== undefined);
					lines.push(
						taken.length > 0
							? [`Nothing unread. Each of these reached a reader once (C7); pass \`transcript: true\` to read one again:`, ...taken.map((record) => `${record.name} · ${record.status} · ${deliveryText(record, Date.now())}`)].join("\n")
							: "Nothing to report: no agent of yours is running or has an unread result.",
					);
				}
				if (params.transcript === true) {
					const named = batch !== undefined ? [batch.details.id, ...(batch.details.others ?? []).map((other) => other.id)].flatMap((taskId) => runtime?.registry.byTaskId(taskId) ?? []) : asked.length > 0 ? addressed() : runtime.registry.all().filter((record) => agentIsSettled(record.status));
					for (const record of named) {
						if (record.sessionFile !== undefined) lines.push(`\n## Transcript of ${record.name}\n${renderTranscript(record.sessionFile)}`);
					}
				}
				return textResult<TaskOutputDetails>(lines.join("\n"), { kind: "agents", batch: batch?.details });
			},
		});
	}
	registerTaskOutputTool();

	declareTool({
		name: AGENT_TOOL_NAMES.TASK_STOP,
		label: "TaskStop",
		description: TASK_STOP_DESCRIPTION,
		parameters: taskStopParams,
		exposure: "deferred",
		async execute(_toolCallId, params) {
			if (runtime === undefined) return refuseNotReady();
			const call = taskStopCallOf(params);
			if (call.kind === "invalid") return refuseToolCall("Give exactly one of `name` (an agent) or `task` (your own background bash task number).");
			if (call.kind === "task") {
				const { id } = call;
				const stop = stopBackgroundTask(sessionId, id);
				if (stop === undefined) return noTaskOfYours(id, "stop");
				switch (stop.at) {
					case "stopping":
						return textResult<TaskStopDetails>(`Stopping background task ${id}; its notification follows.`, { kind: "task", id, outcome: "stopping" });
					case "in-conversation":
						return textResult<TaskStopDetails>(`Background task ${id} already ended; its result is in your conversation.`, { kind: "task", id, outcome: "in-conversation" });
					case "ended":
						return textResult<TaskStopDetails>(`Background task ${id} already ended:\n${completionNotice(stop.result)}`, { kind: "task", id, outcome: "ended", exitCode: stop.result.exitCode, signal: stop.result.signal });
				}
			}
			const { name } = call;
			try {
				const record = await runtime.stop(name, "TaskStop");
				const kept = record.result ? `\nResult so far:\n${record.result}` : "";
				return { content: [{ type: "text", text: `Stopped ${record.name}.${kept}` }], details: { kind: "agents", agent: agentToolDetailsOf(record) } satisfies TaskStopDetails };
			} catch (error) {
				if (error instanceof AgentStopRefused && error.reason === "not-running") {
					const ended = runtime.byAddress(name);
					if (ended !== undefined) return refuseToolCall(endedAgentStopText(error.status === undefined ? ended : { ...ended, status: error.status }, Date.now()));
				}
				if (error instanceof AgentStopRefused || error instanceof AgentAddressRefused) return refuseToolCall(error.message);
				throw error;
			}
		},
	}, (params) => `"${params.name ?? params.task}" is still stopping in the background and will finish stopping; TaskOutput reports it once it has.`);

}
