import { existsSync, realpathSync, statSync } from "node:fs";
import { SHORT_TTL_MS } from "../cache/cache-window.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, InputSource, ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AgentSessionRuntime, createAgentSession, createAgentSessionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENT_NOTIFICATION_TYPE } from "./agent-notification.ts";
import { forgetSessionStopping, isSessionStopping, liveAgentCount, liveAgentsOf, markAgentLive, markAgentSettled, markSessionStopping, watchLiveAgentsOf } from "./agent-live-runs.ts";
import { AgentRegistry, type AgentReadBy, type AgentRecord, type AgentStatus, type StopCause, agentIsSettled, agentNameOf, mintAgentTaskId } from "./agent-registry.ts";
import { agentSpendUsd } from "./agent-spend.ts";
import { replyDetailPath, type ReplyId, replyProblem } from "./reply-formats.ts";
import { type AgentFilesMode, type AgentRole, renderChildFirstMessage, roleOfType, roleUsesReplyFormats } from "./agent-role-tails.ts";
import { AGENT_DEPTH_CAP, AGENT_TOOL_NAMES, DEFAULT_AGENT_TYPE, DEPTH_LIMIT_ERROR, SONNET_MEDIUM_ONLY_REFUSAL, STRUCTURED_OUTPUT_TOOL_NAME, WORKFLOW_TOOL_NAME, coldResumeText, parentMessageText, thinkingLevelError, UP_CHANNEL_LINE } from "./agent-tool-text.ts";
import { type EndedTask, endBackgroundTasksOf } from "../tools/background-tasks.ts";
import { killedWithAgentNotice } from "../tools/bash-result-notices.ts";
import { compactAtFor, familyOf } from "../models/model-family.ts";
import { type AgentType, CHILD_THINKING, isAgentThinkingLevel } from "./agent-type-files.ts";
import type { AgentWaitBoard, AgentWaitOutcome } from "./agent-wait-board.ts";
import { type AgentWorktree, createAgentWorktree, reattachAgentWorktree, settleAgentWorktree, type WorktreeExec, worktreeReportLine } from "./agent-worktree.ts";
import { childSeatOf, declareChildSeat, type EngineChildSeat, forgetChildSeat, seatCarriesWorkflows } from "../session/seat-identity.ts";
import { toolActivityLine } from "./tool-activity-line.ts";
import { childReport } from "./agent-child-report.ts";
import { descendantStoppers } from "./agent-live-runs.ts";
import { AgentAddressRefused, AgentSendRefused, AgentSpawnRefused, AgentStartCancelled, AgentStopRefused } from "./agent-refusals.ts";
import { awaitUnlessAborted } from "../tools/tool-abort-bound.ts";
import { type AgentNotification, batchNotification } from "./agent-task-notification.ts";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";


export const AGENT_PROGRESS_CHANNEL = "subagents:progress";

const NESTED_AGENT_CHANNELS = ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed", "subagents:resumed", AGENT_PROGRESS_CHANNEL];

const PROGRESS_MIN_INTERVAL_MS = 1000;

const QUIET_POLL_MS = 5000;

const SIBLING_STAGGER_STEP_MS = 1000;

const SIBLING_STAGGER_CAP_MS = 5000;

/** What the runtime needs from the process: nothing here may reach a session's `pi` or `ctx`. */
export interface AgentProcessDeps {
	readonly cwd: string;
	readonly agentDir: string;
	readonly exec: WorktreeExec;
	readonly childLoader: (options: { cwd: string; systemPrompt: string | undefined; context: AgentType["context"]; eventBus: EventBus }) => Promise<ResourceLoader>;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly waitBoard: AgentWaitBoard;
}

/** One session of the seat, as the runtime reaches it: valid from that session's start until its shutdown handlers return. */
export interface SeatPort {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly sessionDir: string;
	readonly depth: number;
	readonly role: "main" | AgentRole;
	readonly types: readonly AgentType[];
	readonly persist: (record: AgentRecord) => void;
	readonly emit: (channel: string, payload: unknown) => void;
	readonly deliver: (notification: AgentNotification) => boolean;
	readonly log: (message: string, level: "info" | "warning" | "error") => void;
	readonly hasPendingInput: () => boolean;
	readonly model: () => Model<Api> | undefined;
	readonly resolveModel: (spec: string) => Model<Api> | undefined;
	readonly exactModel: (provider: string, id: string) => Model<Api> | undefined;
	readonly modelRuntime: unknown;
}

type SeatFacts = Pick<SeatPort, "sessionId" | "sessionFile" | "sessionDir" | "depth" | "role">;

type SeatLink = { readonly state: "attached"; readonly port: SeatPort } | { readonly state: "retired"; readonly facts: SeatFacts };

const RETIRE_BOUND_MS = 2000;
const RELEASE_STEP_BOUND_MS = 2000;
const WORKTREE_SETTLE_BOUND_MS = 60_000;

/** Run one release step until it returns, throws, or `boundMs` passes; a throw or a time-out comes back as a failure line, never as a throw. */
async function runReleaseStep(step: string, act: () => unknown, boundMs = RELEASE_STEP_BOUND_MS): Promise<string | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timedOut = new Promise<string>((resolve) => {
			// raw-timer: the bound must hold whatever the runtime's injected sleep does
			timer = setTimeout(() => resolve(`${step} did not finish within ${boundMs / 1000} s`), boundMs);
		});
		return await Promise.race([Promise.resolve().then(act).then(() => undefined), timedOut]);
	} catch (thrown) {
		try {
			return `${step} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
		} catch {
			return `${step} failed`;
		}
	} finally {
		clearTimeout(timer);
	}
}

/** The seat as a run started outside the runtime sees it; every member goes through the runtime's link. */
export interface LinkedSeat {
	readonly sessionId: string;
	readonly cwd: string;
	readonly depth: number;
	model(): Model<Api> | undefined;
	emit(channel: string, payload: unknown): void;
	log(message: string, level: "info" | "warning" | "error"): void;
}

/** What `Agent` accepts, after the tool's schema. */
export interface SpawnRequest {
	readonly description: string;
	readonly prompt: string;
	readonly subagentType?: string;
	readonly name?: string;
	readonly model?: string;
	readonly isolation?: "worktree";
	readonly cwd?: string;
	readonly reply?: ReplyId;
	readonly toolCallId?: string;
	readonly thinking?: string;
	readonly workflowChild?: boolean;
	readonly onFirstPrompt?: () => void;
	readonly signal?: AbortSignal;
}

type RunPhase = { readonly at: "starting" } | { readonly at: "running" } | { readonly at: "stopping" } | { readonly at: "settling"; readonly outcome: RunOutcome } | { readonly at: "settled" } | { readonly at: "cut off" };

interface LiveRun {
	readonly taskId: string;
	session: AgentSession | undefined;
	sessionRuntime: AgentSessionRuntime | undefined;
	worktree: AgentWorktree | undefined;
	stopAsked: StopCause | undefined;
	stopSignal: (() => void) | undefined;
	firstTurnDone: boolean;
	quietWatchers: Set<() => void>;
	silent: boolean;
	inbox: Array<{ readonly text: string; readonly message: string; readonly source: InputSource }>;
	lastText: string;
	idleSince: number | undefined;
	toolUses: number;
	totalTokens: number;
	outputTokens: number;
	replySteered: boolean;
	killedTasks: EndedTask[];
	readonly ended: Promise<void>;
	readonly end: () => void;
	phase: RunPhase;
}

/** What holds a live child idle, read by `ListAgents` and `TaskOutput`. */
export interface AgentHold {
	readonly idleSince: number;
	readonly agents: number;
	readonly lastText: string;
}

function isUnread(record: AgentRecord): boolean {
	return agentIsSettled(record.status) && record.readBy === undefined && record.status !== "lost" && !record.workflowChild;
}

function runIsLive(run: LiveRun): boolean {
	return run.phase.at === "running" || run.phase.at === "stopping";
}

interface RunOutcome {
	readonly status: AgentStatus;
	readonly error: string | undefined;
	readonly result: string | undefined;
}

function childSeatFrom(record: AgentRecord, parentSessionId: string, type: AgentType | undefined): EngineChildSeat {
	return {
		name: record.name,
		role: roleOfType(record.type),
		depth: record.depth,
		parentSessionId,
		agentTypes: agentTypesOf(type),
		workflowChild: record.workflowChild,
		workflows: (record.workflows ?? seatCarriesWorkflows(parentSessionId)) && (type?.tools === undefined || type.tools.some((entry) => entry.name === WORKFLOW_TOOL_NAME)),
		prompt: type?.prompt ? { kind: "own" } : { kind: "inherit" },
		receivesTaskNotices: true,
	};
}

/** The agent types a type's `Agent(...)` entry names; undefined when the entry is bare or the type has no tools list (every type), empty when its list has no `Agent`. */
export function agentTypesOf(type: AgentType | undefined): readonly string[] | undefined {
	if (type?.tools === undefined) return undefined;
	const entry = type.tools.find((candidate) => candidate.name === AGENT_TOOL_NAMES.AGENT);
	return entry === undefined ? [] : entry.agentTypes;
}

/** The types a seat may start, given its `agentTypes` (undefined: every type). */
export function startableTypes(all: readonly AgentType[], agentTypes: readonly string[] | undefined): AgentType[] {
	return agentTypes === undefined ? [...all] : all.filter((type) => agentTypes.includes(type.name));
}

export function childToolNames(type: AgentType | undefined, seat: Pick<EngineChildSeat, "workflows" | "workflowChild">): string[] | undefined {
	if (type?.tools === undefined) return seat.workflowChild ? [`+${STRUCTURED_OUTPUT_TOOL_NAME}`] : undefined;
	const names = type.tools
		.flatMap((entry) => (entry.name === AGENT_TOOL_NAMES.AGENT ? Object.values(AGENT_TOOL_NAMES) : [entry.name]))
		.filter((name) => name !== WORKFLOW_TOOL_NAME || seat.workflows);
	return [...new Set(seat.workflowChild ? [...names, STRUCTURED_OUTPUT_TOOL_NAME] : names)];
}

type ChildPromptSources = Pick<ResourceLoader, "getSkills" | "getAgentsFiles" | "getSystemPrompt" | "getAppendSystemPrompt">;

function promptSourcesOf(loader: ResourceLoader): ChildPromptSources {
	const skills = loader.getSkills();
	const agentsFiles = loader.getAgentsFiles();
	const systemPrompt = loader.getSystemPrompt();
	const appendSystemPrompt = loader.getAppendSystemPrompt();
	return { getSkills: () => skills, getAgentsFiles: () => agentsFiles, getSystemPrompt: () => systemPrompt, getAppendSystemPrompt: () => appendSystemPrompt };
}

function withPromptSources(loader: ResourceLoader, sources: ChildPromptSources): ResourceLoader {
	return {
		getExtensions: () => loader.getExtensions(),
		getPrompts: () => loader.getPrompts(),
		getThemes: () => loader.getThemes(),
		getSystemPromptSource: () => loader.getSystemPromptSource(),
		getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
		extendResources: (paths) => loader.extendResources(paths),
		reload: (options) => loader.reload(options),
		...sources,
	};
}

export function agentLifecyclePayload(record: AgentRecord, runId?: string): Record<string, unknown> {
	return {
		id: record.taskId,
		name: record.name,
		type: record.type,
		description: record.description,
		model: record.model,
		...(runId !== undefined ? { runId } : {}),
		workflowChild: record.workflowChild,
		status: record.status,
		toolUses: record.toolUses,
		durationMs: record.completedAt !== undefined ? record.completedAt - record.startedAt : 0,
		...(record.result !== undefined ? { result: record.result } : {}),
		...(record.error !== undefined ? { error: record.error } : {}),
		usage: { cost: { total: record.costUsd } },
	};
}

/** What a {@link AgentRuntime.watchProgress} watcher is told: tokens streamed, a turn ended, a compaction began or ended, or a tool call started or ended, by call id. */
export type AgentProgressEvent = { readonly type: "message_update" | "turn_end" | "compaction_start" | "compaction_end" } | { readonly type: "tool_execution_start" | "tool_execution_end"; readonly toolCallId: string };

export class AgentRuntime {
	readonly registry: AgentRegistry;
	readonly waits: AgentWaitBoard;
	readonly host: LinkedSeat;
	readonly #deps: AgentProcessDeps;
	#link: SeatLink;
	readonly #runs = new Map<string, LiveRun>();
	readonly #childToolDefinitions = new Map<string, ToolDefinition>();
	readonly #promptSources = new Map<string, ChildPromptSources>();
	readonly #progressWatchers = new Map<string, Set<(event: AgentProgressEvent) => void>>();
	readonly #claims = new Set<{ readonly taskIds: ReadonlySet<string> | undefined }>();
	readonly #nestedOwners = new Map<string, EventBus>();
	#retiring: StopCause | undefined;
	#retirement: Promise<void> | undefined;
	#inputBy = "Joel";

	constructor(deps: AgentProcessDeps, port: SeatPort, records: Iterable<AgentRecord>) {
		this.#deps = deps;
		this.#link = { state: "attached", port };
		this.registry = new AgentRegistry((record) => this.#persist(record), records);
		this.waits = deps.waitBoard;
		const facts = () => this.#facts();
		this.host = {
			get sessionId() {
				return facts().sessionId;
			},
			get depth() {
				return facts().depth;
			},
			cwd: deps.cwd,
			model: () => this.#port("the seat's model").model(),
			emit: (channel, payload) => this.#emit(channel, payload),
			log: (message, level) => this.#log(message, level),
		};
	}

	#facts(): SeatFacts {
		const link = this.#link;
		if (link.state !== "attached") return link.facts;
		const { sessionId, sessionFile, sessionDir, depth, role } = link.port;
		return { sessionId, sessionFile, sessionDir, depth, role };
	}

	#port(what: string): SeatPort {
		const link = this.#link;
		if (link.state === "attached") return link.port;
		throw new Error(`agent runtime of session ${link.facts.sessionId} is retired: ${what} needs a session attached`);
	}

	#persist(record: AgentRecord): void {
		const link = this.#link;
		if (link.state === "attached") link.port.persist(record);
	}

	#emit(channel: string, payload: unknown): void {
		const link = this.#link;
		if (link.state === "attached") link.port.emit(channel, payload);
	}

	#deliver(notification: AgentNotification): boolean {
		const link = this.#link;
		return link.state === "attached" && link.port.deliver(notification);
	}

	#log(message: string, level: "info" | "warning" | "error"): void {
		const link = this.#link;
		if (link.state !== "attached") return;
		try {
			link.port.log(message, level);
		} catch {}
	}

	#logReleaseFailures(run: LiveRun, failures: readonly (string | undefined)[]): void {
		const name = this.registry.byTaskId(run.taskId)?.name ?? run.taskId;
		for (const failure of failures) if (failure !== undefined) this.#log(`agent ${name}: ${failure}`, "error");
	}

	retire(by: StopCause): Promise<void> {
		this.#retirement ??= this.#retire(by);
		return this.#retirement;
	}

	async #retire(by: StopCause): Promise<void> {
		this.#retiring = by;
		const bound = this.#timer(RETIRE_BOUND_MS);
		const foreign = [...liveAgentsOf(this.#facts().sessionId)].filter((taskId) => !this.#runs.has(taskId)).map((taskId) => descendantStoppers().get(taskId)?.());
		const runs = [...this.#runs.values()];
		void Promise.all(runs.map((run) => this.#stopRun(run, by))).catch(() => {});
		await Promise.race([Promise.allSettled([...runs.map((run) => run.ended), ...foreign]), bound.elapsed]);
		bound.clear();
		await Promise.all(
			runs.map(async (run) => {
				const phase = run.phase;
				if (phase.at === "settled") return;
				run.phase = { at: "cut off" };
				let failure: string | undefined;
				try {
					failure = await runReleaseStep("record write", () => {
						const record = this.registry.byTaskId(run.taskId);
						if (record === undefined) return;
						const outcome = phase.at === "settling" ? phase.outcome : this.#outcomeKillingTasks(run, "stopped", undefined);
						this.publishSettled(this.registry.put(this.#endedRecord(record, run, outcome)));
					});
				} finally {
					this.#releaseSlot(run);
				}
				this.#logReleaseFailures(run, [failure]);
			}),
		);
		this.#link = { state: "retired", facts: this.#facts() };
	}

	#outcomeKillingTasks(run: LiveRun, status: AgentStatus, error: string | undefined): RunOutcome {
		const session = run.session;
		const ended = [...run.killedTasks, ...(session === undefined ? [] : endBackgroundTasksOf(session.sessionId))];
		const report = session === undefined ? undefined : childReport(session, run.lastText);
		const notices = [
			...(ended.length === 0 ? [] : [killedWithAgentNotice(ended)]),
			...(run.inbox.length === 0 ? [] : [[`${run.inbox.length} queued message${run.inbox.length === 1 ? "" : "s"} not delivered — the agent ended before reading ${run.inbox.length === 1 ? "it" : "them"}:`, ...run.inbox.map((queued) => `- ${queued.message.split("\n")[0]}`)].join("\n")]),
		];
		return { status, error, result: notices.length === 0 ? report : [report ?? "", ...notices].join("\n\n").trim() };
	}

	#updateRecord(taskId: string, change: Partial<Omit<AgentRecord, "readBy" | "readAt">>): void {
		const current = this.registry.byTaskId(taskId);
		if (current !== undefined) this.registry.put({ ...current, ...change });
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}

	#timer(ms: number): { readonly elapsed: Promise<void>; readonly clear: () => void } {
		if (this.#deps.sleep !== undefined) return { elapsed: this.#deps.sleep(ms), clear: () => {} };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const elapsed = new Promise<void>((resolve) => {
			// raw-timer: the runtime lives on its SeatLink, not one session's scope, and is retired at shutdown
			timer = setTimeout(resolve, ms);
		});
		return { elapsed, clear: () => clearTimeout(timer) };
	}

	#firstPromptDelayMs(run: LiveRun): number {
		let siblings = 0;
		for (const ahead of this.#runs.values()) {
			if (ahead === run) break;
			if (!ahead.firstTurnDone) siblings++;
		}
		return siblings > 0 ? Math.min(siblings * SIBLING_STAGGER_STEP_MS, SIBLING_STAGGER_CAP_MS) : 0;
	}

	async #stagger(run: LiveRun, ms: number): Promise<void> {
		const timer = this.#timer(ms);
		await Promise.race([timer.elapsed, new Promise<void>((resolve) => (run.stopSignal = resolve))]);
		timer.clear();
		run.stopSignal = undefined;
	}

	#markStopping(run: LiveRun, by: StopCause): void {
		if (!runIsLive(run)) return;
		run.phase = { at: "stopping" };
		run.stopSignal?.();
		if (run.session !== undefined) run.killedTasks.push(...endBackgroundTasksOf(run.session.sessionId));
		this.#updateRecord(run.taskId, { stoppedBy: by });
		this.#log(`agent ${this.registry.byTaskId(run.taskId)?.name ?? run.taskId}: stopping — asked by ${by}`, "info");
	}

	#stopRun(run: LiveRun, by: StopCause): Promise<void> {
		if (run.phase.at === "starting") {
			run.stopAsked ??= by;
			return Promise.resolve();
		}
		const session = run.session;
		if (!runIsLive(run) || session === undefined) return Promise.resolve();
		this.#markStopping(run, by);
		markSessionStopping(session.sessionId);
		this.#stopDescendants(session.sessionId);
		return session.abort();
	}

	#openSlot(taskId: string, silent: boolean): LiveRun {
		let end = () => {};
		const ended = new Promise<void>((resolve) => (end = resolve));
		const run: LiveRun = {
			taskId,
			session: undefined,
			sessionRuntime: undefined,
			worktree: undefined,
			stopAsked: undefined,
			stopSignal: undefined,
			firstTurnDone: false,
			quietWatchers: new Set(),
			silent,
			inbox: [],
			lastText: "",
			idleSince: undefined,
			toolUses: 0,
			totalTokens: 0,
			outputTokens: 0,
			replySteered: false,
			killedTasks: [],
			ended,
			end,
			phase: { at: "starting" },
		};
		this.#runs.set(taskId, run);
		markAgentLive(this.#facts().sessionId, taskId);
		descendantStoppers().set(taskId, () => this.#stopRun(run, "cascade").then(() => run.ended, () => run.ended));
		return run;
	}

	async #release(run: LiveRun, write: (worktreeLine: string | undefined) => void): Promise<void> {
		const failures: (string | undefined)[] = [];
		try {
			descendantStoppers().delete(run.taskId);
			const worktree = run.worktree;
			let worktreeLine: string | undefined;
			if (worktree !== undefined) {
				const settleFailure = await runReleaseStep("worktree settle", async () => (worktreeLine = worktreeReportLine(await settleAgentWorktree(this.#deps.exec, worktree))), WORKTREE_SETTLE_BOUND_MS);
				if (settleFailure !== undefined) worktreeLine = `${settleFailure}; kept at ${worktree.path}`;
				failures.push(settleFailure);
			}
			const writeFailure = run.phase.at === "cut off" ? undefined : await runReleaseStep("record write", () => write(worktreeLine));
			if (run.phase.at !== "cut off") run.phase = { at: "settled" };
			const stepFailures = [
				writeFailure,
				await runReleaseStep("runtime dispose", () => run.sessionRuntime?.dispose()),
				await runReleaseStep("seat forget", () => {
					const childSessionId = this.registry.byTaskId(run.taskId)?.sessionId;
					if (childSessionId === undefined) return;
					forgetChildSeat(childSessionId);
					forgetSessionStopping(childSessionId);
				}),
			];
			failures.push(...stepFailures);
			const first = stepFailures.find((failure) => failure !== undefined);
			const current = this.registry.byTaskId(run.taskId);
			if (first !== undefined && current !== undefined) {
				const settled = agentIsSettled(current.status) ? current : { ...current, status: "error" as const, error: first, completedAt: this.#now() };
				const reported = { ...settled, result: `${settled.result ?? ""}\n\n${first}`.trim() };
				failures.push(await runReleaseStep("record write", () => this.registry.put(reported)));
				if (writeFailure !== undefined) failures.push(await runReleaseStep("settle notice", () => this.publishSettled(reported)));
			}
		} finally {
			this.#releaseSlot(run);
		}
		this.#logReleaseFailures(run, failures);
	}

	#releaseSlot(run: LiveRun): void {
		try {
			descendantStoppers().delete(run.taskId);
			if (this.#runs.get(run.taskId) === run) this.#runs.delete(run.taskId);
			markAgentSettled(this.#facts().sessionId, run.taskId);
		} finally {
			run.end();
		}
	}

	async #abandon(run: LiveRun, thrown: unknown): Promise<void> {
		await this.#release(run, (worktreeLine) => {
			const current = this.registry.byTaskId(run.taskId);
			if (current === undefined) return;
			const at = this.#now();
			const failed = this.registry.put({ ...current, status: thrown instanceof AgentStartCancelled ? "stopped" : "error", error: thrown instanceof Error ? thrown.message : String(thrown), result: worktreeLine, completedAt: at, readBy: "spawner", readAt: at });
			this.#emit("subagents:failed", agentLifecyclePayload(failed));
		});
	}

	#throwIfStartCancelled(run: LiveRun, name: string, signal: AbortSignal | undefined): void {
		if (signal?.aborted || run.phase.at === "cut off") throw new AgentStartCancelled(name);
	}

	holdOf(taskId: string): AgentHold | undefined {
		const run = this.#runs.get(taskId);
		if (run === undefined || !runIsLive(run) || run.idleSince === undefined || run.session === undefined) return undefined;
		const sessionId = run.session.sessionId;
		return {
			idleSince: run.idleSince,
			agents: liveAgentsOf(sessionId).size,
			lastText: run.lastText,
		};
	}

	liveRun(taskId: string): AgentSession | undefined {
		return this.#runs.get(taskId)?.session;
	}

	childToolDefinition(name: string): ToolDefinition | undefined {
		return this.#childToolDefinitions.get(name);
	}

	watchProgress(taskId: string, onProgress: (event: AgentProgressEvent) => void): () => void {
		const watchers = this.#progressWatchers.get(taskId) ?? new Set<(event: AgentProgressEvent) => void>();
		this.#progressWatchers.set(taskId, watchers);
		watchers.add(onProgress);
		return () => {
			watchers.delete(onProgress);
			if (watchers.size === 0) this.#progressWatchers.delete(taskId);
		};
	}


	#claimed(taskId: string): boolean {
		for (const claim of this.#claims) if (claim.taskIds === undefined || claim.taskIds.has(taskId)) return true;
		return false;
	}

	unread(): AgentRecord[] {
		return this.registry
			.all()
			.filter(isUnread)
			.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
	}

	takeUnread(addresses: readonly string[] | undefined, hand: (notification: AgentNotification) => boolean | void, by: AgentReadBy): AgentNotification | undefined {
		const addressed = addresses === undefined ? this.unread() : [...new Map(addresses.flatMap((address) => this.byAddress(address) ?? []).map((record) => [record.taskId, record])).values()].filter(isUnread);
		return this.#take(this.#wholeUnits(addressed), hand, by);
	}

	takeForTurn(seen: (taskId: string) => boolean, hand: (notification: AgentNotification) => void): AgentNotification | undefined {
		const at = this.#now();
		const missing: AgentRecord[] = [];
		for (const record of this.registry.all()) {
			if (record.readBy !== "handed") continue;
			if (!seen(record.taskId)) {
				missing.push(record);
				continue;
			}
			this.registry.markHandedSeen(record.name, record.taskId, at);
		}
		const records = [...this.unread(), ...missing].sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
		return this.#take(records, hand, "conversation", at);
	}

	#wholeUnits(records: readonly AgentRecord[]): AgentRecord[] {
		const alone = records.filter((record) => !this.#batches(record.type));
		const live = this.registry.live();
		const ready = [...new Set(records.filter((record) => this.#batches(record.type)).map((record) => record.type))].filter((type) => !live.some((record) => record.type === type));
		return [...alone, ...this.unread().filter((record) => ready.includes(record.type))];
	}

	#batches(typeName: string): boolean {
		const link = this.#link;
		return link.state === "attached" && link.port.types.some((type) => type.name === typeName && type.delivery === "batch");
	}

	#take(records: readonly AgentRecord[], hand: (notification: AgentNotification) => boolean | void, by: AgentReadBy, when?: number): AgentNotification | undefined {
		const at = when ?? this.#now();
		if (records.length === 0) return undefined;
		const notification = batchNotification(records, at, by);
		return this.registry.consume(records, by, at, () => hand(notification)) ? notification : undefined;
	}

	#seatChain(): string[] {
		const names: string[] = [];
		let sessionId: string | undefined = this.#facts().sessionId;
		for (let hop = 0; hop <= AGENT_DEPTH_CAP && sessionId !== undefined; hop++) {
			const seat = childSeatOf(sessionId);
			if (seat === undefined) break;
			names.push(seat.name);
			sessionId = seat.parentSessionId;
		}
		return names;
	}

	checkAddressable(names: readonly string[]): void {
		for (const name of names) this.#refuseSelfOrAncestor(name);
	}

	#refuseSelfOrAncestor(name: string): void {
		const [own, ...ancestors] = this.#seatChain();
		if (name === own) {
			throw new AgentAddressRefused("self", `"${name}" is this seat's own name: an agent can neither be named after you nor addressed as you. Run ListAgents to see the agents you started.`);
		}
		if (ancestors.includes(name)) {
			throw new AgentAddressRefused("ancestor", `"${name}" is a seat above you in the agent tree, not an agent you started. ${UP_CHANNEL_LINE} Run ListAgents to see the agents you started.`);
		}
	}

	async spawn(request: SpawnRequest): Promise<AgentRecord> {
		if (this.#retiring !== undefined) throw new AgentSpawnRefused("retiring", "The seat is shutting down: no agent can start now.");
		const port = this.#port("spawning an agent");
		if (port.depth >= AGENT_DEPTH_CAP) throw new AgentSpawnRefused("depth", DEPTH_LIMIT_ERROR);
		const typeName = request.subagentType ?? DEFAULT_AGENT_TYPE;
		const type = port.types.find((candidate) => candidate.name === typeName);
		if (type === undefined && typeName !== DEFAULT_AGENT_TYPE) {
			throw new AgentSpawnRefused("unknown-type", `Unknown subagent_type "${typeName}". Available: ${port.types.map((t) => t.name).join(", ") || "(none on disk)"}.`);
		}
		const role: AgentRole = roleOfType(typeName);
		const model = this.#resolveChildModel(port, request.model ?? type?.model);
		if (model === undefined) throw new AgentSpawnRefused("no-model", `No model for agent type "${typeName}"${request.model ? ` (asked for "${request.model}")` : ""}. Enable one in settings or pick another.`);
		const asked = request.thinking ?? type?.thinking ?? this.#childThinking();
		if (!isAgentThinkingLevel(asked)) throw new AgentSpawnRefused("thinking", thinkingLevelError(asked));
		if ((request.thinking !== undefined || request.model !== undefined) && familyOf(model.id) === "sonnet" && asked !== "medium") throw new AgentSpawnRefused("thinking", SONNET_MEDIUM_ONLY_REFUSAL);
		const thinking: ThinkingLevel = clampThinkingLevel(model, asked);
		const name = agentNameOf(request.name) ?? this.registry.nextName(typeName);
		this.#refuseSelfOrAncestor(name);
		const depth = port.depth + 1;
		if (request.cwd !== undefined) {
			if (request.isolation === "worktree") throw new AgentSpawnRefused("cwd", "cwd and isolation are exclusive: one names a worktree, the other makes one.");
			if (!existsSync(request.cwd)) throw new AgentSpawnRefused("cwd", `cwd ${request.cwd} does not exist.`);
			const probe = await this.#deps.exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd: request.cwd, timeout: 5000 }).catch((error: unknown) => ({ code: 1, stdout: "", stderr: String(error) }));
			const [top, gitDir, commonDir] = probe.stdout.trim().split("\n");
			if (probe.code !== 0 || realpathSync(top) !== realpathSync(request.cwd) || realpathSync(gitDir) === realpathSync(commonDir)) {
				throw new AgentSpawnRefused("cwd", `cwd ${request.cwd} is not the top of a linked git worktree; only that is accepted (not the main checkout, a subdirectory or a plain directory).`);
			}
			if (this.#retiring !== undefined) throw new AgentSpawnRefused("retiring", "The seat is shutting down: no agent can start now.");
		}

		const run = this.#openSlot(mintAgentTaskId(), request.workflowChild === true);
		try {
			if (request.isolation === "worktree") {
				try {
					run.worktree = await createAgentWorktree(this.#deps.exec, this.#deps.cwd, name);
				} catch (error) {
					throw new AgentSpawnRefused("worktree", error instanceof Error ? error.message : String(error));
				}
			}
			const worktree = run.worktree;
			const cwd = worktree?.path ?? request.cwd ?? this.#deps.cwd;
			const files: AgentFilesMode = worktree ? { kind: "worktree", branch: worktree.branch, path: worktree.path } : { kind: "shared" };
			const sessionManager = SessionManager.create(cwd, port.sessionDir, port.sessionFile !== undefined ? { parentSession: port.sessionFile } : {});
			const childSessionId = sessionManager.getSessionId();
			const liveCount = liveAgentCount();
			const record = this.registry.put({
				name,
				taskId: run.taskId,
				ownerSessionId: this.#facts().sessionId,
				type: typeName,
				description: request.description,
				status: "queued",
				stoppedBy: undefined,
				depth,
				sessionFile: sessionManager.getSessionFile(),
				sessionId: childSessionId,
				cwd,
				branch: worktree?.branch,
				model: `${model.provider}/${model.id}`,
				thinking,
				result: undefined,
				error: undefined,
				readBy: undefined,
				readAt: undefined,
				toolUses: 0,
				costUsd: 0,
				totalTokens: 0,
				outputTokens: 0,
				startedAt: this.#now(),
				completedAt: undefined,
				toolCallId: request.toolCallId,
				workflowChild: request.workflowChild === true,
				workflows: seatCarriesWorkflows(port.sessionId),
				brief: request.prompt,
				laterMessages: [],
			});
			const seat = childSeatFrom(record, port.sessionId, type);
			declareChildSeat(childSessionId, seat);
			this.#emit("subagents:created", agentLifecyclePayload(record));

			const workflowChild = request.workflowChild === true;
			const replyDir = workflowChild || !roleUsesReplyFormats(role) || process.env.PI_KIT_REPLY_FORMATS === "off" ? undefined : replyDetailPath(this.#deps.cwd, this.#facts().sessionId.slice(0, 8), name);
			const facts = { role, name, depth, liveCount, files, workflowChild, ...(replyDir !== undefined ? { replyDir } : {}), ...(request.reply !== undefined ? { reply: request.reply } : {}) };
			const firstMessage = renderChildFirstMessage(facts, request.prompt);
			this.#throwIfStartCancelled(run, name, request.signal);
			const sessionRuntime = await this.#createChildRuntime({
				sessionManager,
				cwd,
				model,
				thinking,
				systemPrompt: type?.prompt ? type.prompt : undefined,
				type,
				seat,
				taskId: run.taskId,
				sessionName: `${name}#${run.taskId.slice(1, 7)}`,
				modelRuntime: port.modelRuntime,
			});
			run.sessionRuntime = sessionRuntime;
			this.#throwIfStartCancelled(run, name, request.signal);
			await this.#start(run, name, sessionRuntime.session, firstMessage, request.signal, request.onFirstPrompt, replyDir === undefined ? undefined : { dir: replyDir, override: request.reply });
			return this.registry.byTaskId(run.taskId) ?? record;
		} catch (thrown) {
			await this.#abandon(run, thrown);
			throw thrown;
		}
	}

	async #createChildRuntime(spec: {
		sessionManager: SessionManager;
		cwd: string;
		model: Model<Api>;
		thinking: ThinkingLevel;
		systemPrompt: string | undefined;
		type: AgentType | undefined;
		seat: EngineChildSeat;
		taskId: string;
		sessionName: string;
		modelRuntime: unknown;
	}): Promise<AgentSessionRuntime> {
		const { childLoader, agentDir } = this.#deps;
		const modelRuntime = spec.modelRuntime;
		return createAgentSessionRuntime(
			async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
				declareChildSeat(sessionManager.getSessionId(), spec.seat);
				const eventBus = createEventBus();
				for (const channel of NESTED_AGENT_CHANNELS) {
					eventBus.on(channel, (payload) => {
						if (typeof payload !== "object" || payload === null) return;
						// SAFETY: payload was checked to be a non-null object on the previous line
						const { name: _seatScopedName, ...fields } = payload as Record<string, unknown>;
						if (typeof fields.id === "string") {
							if (channel === "subagents:completed" || channel === "subagents:failed") this.#nestedOwners.delete(fields.id);
							else if (channel !== AGENT_PROGRESS_CHANNEL) this.#nestedOwners.set(fields.id, eventBus);
						}
						this.#emit(channel, { ...fields, parentId: fields.parentId ?? spec.taskId });
					});
				}
				const read = await childLoader({ cwd, systemPrompt: spec.systemPrompt, context: spec.type?.context ?? "full", eventBus });
				const pinned = this.#promptSources.get(spec.taskId);
				const loader = pinned === undefined ? read : withPromptSources(read, pinned);
				const tools = childToolNames(spec.type, spec.seat);
				const files = SettingsManager.create(cwd, agentDir);
				const compactAt = compactAtFor(spec.model.id, spec.type?.compactAt);
				const compaction = compactAt === undefined ? { enabled: false } : { enabled: true, reserveTokens: Math.max(0, spec.model.contextWindow - compactAt), keepRecentTokens: files.getCompactionKeepRecentTokens(spec.model) };
				const settingsManager = SettingsManager.inMemory({ ...files.getSettings(), compaction });
				const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
					cwd,
					agentDir,
					settingsManager,
					...(tools !== undefined ? { tools } : {}),
					model: spec.model,
					thinkingLevel: spec.thinking,
					sessionManager,
					resourceLoader: loader,
					...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
					// SAFETY: modelRuntime is opaque to this module; it is forwarded unchanged from the host that created it
					...(modelRuntime !== undefined ? { modelRuntime: modelRuntime as never } : {}),
				});
				session.setSessionName(spec.sessionName);
				return {
					session,
					extensionsResult,
					...(modelFallbackMessage !== undefined ? { modelFallbackMessage } : {}),
					services: { cwd, agentDir, modelRuntime: session.modelRuntime, settingsManager: session.settingsManager, resourceLoader: loader, diagnostics: [] },
					diagnostics: [],
				};
			},
			{ cwd: spec.cwd, agentDir, sessionManager: spec.sessionManager },
		);
	}

	forwardStop(requestId: string, agentId: string): boolean {
		const owner = this.#nestedOwners.get(agentId);
		if (owner === undefined) return false;
		const replyChannel = `subagents:rpc:stop:reply:${requestId}`;
		const unsubscribe = owner.on(replyChannel, (reply) => {
			unsubscribe();
			this.#emit(replyChannel, reply);
		});
		owner.emit("subagents:rpc:stop", { requestId, agentId });
		return true;
	}

	#resolveChildModel(port: SeatPort, spec: string | undefined): Model<Api> | undefined {
		if (spec === undefined || spec.trim() === "") return port.model();
		return port.resolveModel(spec.trim());
	}

	#childThinking(): ThinkingLevel {
		return CHILD_THINKING;
	}

	async #start(run: LiveRun, name: string, session: AgentSession, prompt: string, signal: AbortSignal | undefined, onFirstPrompt?: () => void, reply?: { readonly dir: string; readonly override: ReplyId | undefined }): Promise<void> {
		run.session = session;
		let lastProgressAt = 0;
		const publishProgress = (force: boolean, activity?: string) => {
			const at = this.#now();
			if (!force && at - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
			lastProgressAt = at;
			this.#emit(AGENT_PROGRESS_CHANNEL, { id: run.taskId, name, toolUses: run.toolUses, totalTokens: run.totalTokens, lastActivityAt: at, ...(activity !== undefined ? { activity } : {}) });
		};
		const listener = (event: AgentSessionEvent) => {
			if (event.type === "agent_start" && run.phase.at === "stopping") void session.abort();
			if (event.type === "agent_start") {
				run.idleSince = undefined;
			}
			if (event.type === "tool_execution_start") run.toolUses++;
			if (event.type === "message_end" && event.message.role === "assistant") run.firstTurnDone = true;
			const progress: AgentProgressEvent | undefined =
				event.type === "message_update" || event.type === "turn_end" || event.type === "compaction_start" || event.type === "compaction_end"
					? { type: event.type }
					: event.type === "tool_execution_start" || event.type === "tool_execution_end"
						? { type: event.type, toolCallId: event.toolCallId }
						: undefined;
			if (progress !== undefined) for (const watcher of this.#progressWatchers.get(run.taskId) ?? []) watcher(progress);
			if (event.type === "message_end" && event.message.role === "assistant" && run.phase.at !== "stopping") {
				// SAFETY: assistant message_end events carry the optional usage shape declared here; every field is read optionally
				const usage = (event.message as { usage?: { output?: number; totalTokens?: number; cost?: { total?: number } } }).usage;
				if (usage !== undefined && (usage.totalTokens ?? 0) > 0) run.totalTokens = usage.totalTokens ?? 0;
				run.outputTokens += usage?.output ?? 0;
				const text = event.message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
				if (text) run.lastText = text;
			}
			publishProgress(
				event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "message_end",
				event.type === "tool_execution_start" ? toolActivityLine(event.toolName, event.args) : undefined,
			);
		};
		const unsubscribe = session.subscribe(listener);
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
			},
		});
		if (!this.#promptSources.has(run.taskId)) this.#promptSources.set(run.taskId, promptSourcesOf(session.resourceLoader));
		if (signal?.aborted || run.phase.at === "cut off") {
			unsubscribe();
			throw new AgentStartCancelled(name);
		}
		for (const tool of session.getAllTools()) {
			const definition = session.getToolDefinition(tool.name);
			if (definition !== undefined) this.#childToolDefinitions.set(tool.name, definition);
		}
		run.phase = { at: "running" };
		const stopBy = run.stopAsked ?? this.#retiring;
		if (stopBy !== undefined) this.#markStopping(run, stopBy);
		this.#updateRecord(run.taskId, { status: "running" });
		const started = this.registry.byTaskId(run.taskId);
		if (started !== undefined) this.#emit("subagents:started", agentLifecyclePayload(started));

		void (async () => {
			let error: string | undefined;
			try {
				const stagger = this.#firstPromptDelayMs(run);
				if (stagger > 0) await this.#stagger(run, stagger);
				if (run.phase.at !== "stopping") {
					onFirstPrompt?.();
					await session.prompt(prompt);
				}
				for (;;) {
					const next = run.phase.at === "stopping" ? undefined : run.inbox.shift();
					if (next !== undefined) {
						await session.prompt(next.text, { source: next.source });
						continue;
					}
					await this.#waitUntilQuiet(run, session);
					if (run.inbox.length === 0 && run.phase.at !== "stopping" && reply !== undefined && !run.replySteered) {
						const problem = replyProblem(run.lastText, reply.override, reply.dir);
						if (problem !== undefined) {
							run.replySteered = true;
							await session.prompt(problem);
							continue;
						}
					}
					if (run.inbox.length === 0 || run.phase.at === "stopping") break;
				}
			} catch (thrown) {
				error = thrown instanceof Error ? thrown.message : String(thrown);
			} finally {
				unsubscribe();
			}
			await this.#settle(run, session, error);
		})().catch((thrown: unknown) => this.#abandon(run, thrown));
	}

	async #waitUntilQuiet(run: LiveRun, session: AgentSession): Promise<void> {
		let releasedByPoll = false;
		for (;;) {
			await session.waitForIdle();
			if (run.inbox.length > 0 && run.phase.at !== "stopping") return;
			const agentsHold = liveAgentsOf(session.sessionId).size > 0;
			if (!agentsHold && session.isIdle) {
				if (releasedByPoll) this.#log(`agent ${this.registry.byTaskId(run.taskId)?.name ?? run.taskId}: the quiet loop was released by its ${QUIET_POLL_MS}ms backstop poll, not by an event — a settle went unannounced`, "warning");
				return;
			}
			const now = this.#now();
			run.idleSince = session.isIdle ? (run.idleSince ?? now) : undefined;
			releasedByPoll = await new Promise<boolean>((resolve) => {
				// raw-timer: the runtime lives on its SeatLink, not one session's scope, and is retired at shutdown
				const timer = setTimeout(() => finish(true), QUIET_POLL_MS);
				// SAFETY: Node timers expose unref; other hosts return a number, which the optional call skips
				(timer as { unref?: () => void }).unref?.();
				const wake = () => finish(false);
				const offSession = session.subscribe((event) => {
					if (event.type === "agent_settled") wake();
				});
				const offSeam = watchLiveAgentsOf(session.sessionId, wake);
				run.quietWatchers.add(wake);
				function finish(byPoll: boolean) {
					clearTimeout(timer);
					offSession();
					offSeam();
					run.quietWatchers.delete(wake);
					resolve(byPoll);
				}
			});
		}
	}

	async #settle(run: LiveRun, session: AgentSession, thrown: string | undefined): Promise<void> {
		if (run.phase.at === "cut off") return this.#release(run, () => {});
		const last = session.messages[session.messages.length - 1];
		const stopReason = last?.role === "assistant" ? last.stopReason : undefined;
		// SAFETY: errorMessage exists on pi's assistant messages but is missing from the union member narrowed here
		const errorMessage = last?.role === "assistant" ? (last as { errorMessage?: string }).errorMessage : undefined;
		let status: AgentStatus = "completed";
		let error: string | undefined = thrown;
		if (run.phase.at === "stopping") {
			status = "stopped";
		} else if (thrown !== undefined || stopReason === "error") {
			status = "error";
			error = error ?? errorMessage ?? "the model returned an error";
		} else if (stopReason === "aborted") {
			status = "error";
			error = errorMessage ?? "aborted";
		}
		const outcome = this.#outcomeKillingTasks(run, status, error);
		run.phase = { at: "settling", outcome };
		await this.#release(run, (worktreeLine) => {
			const base = this.registry.byTaskId(run.taskId);
			if (base === undefined) return;
			const result = worktreeLine === undefined ? outcome.result : `${outcome.result ?? ""}\n\n${worktreeLine}`.trim();
			this.publishSettled(this.registry.put(this.#endedRecord(base, run, { ...outcome, result })));
		});
	}

	#endedRecord(base: AgentRecord, run: LiveRun, outcome: RunOutcome): AgentRecord {
		const at = this.#now();
		return {
			...base,
			status: outcome.status,
			result: outcome.result,
			error: outcome.error,
			toolUses: run.toolUses,
			costUsd: agentSpendUsd(base),
			totalTokens: run.totalTokens,
			outputTokens: run.outputTokens,
			completedAt: at,
			readBy: run.silent ? "spawner" : undefined,
			readAt: run.silent ? at : undefined,
		};
	}

	publishSettled(settled: AgentRecord): void {
		markAgentSettled(this.#facts().sessionId, settled.taskId);
		this.#emit(settled.status === "completed" ? "subagents:completed" : "subagents:failed", agentLifecyclePayload(settled));
		this.waits.notify();
		this.#offer(settled);
	}

	offerUnread(): void {
		for (const record of this.unread()) {
			const current = this.registry.byTaskId(record.taskId);
			if (current !== undefined) this.#offer(current);
		}
	}

	#offer(settled: AgentRecord): void {
		if (settled.readBy !== undefined || this.#claimed(settled.taskId)) return;
		if (this.registry.byName(settled.name)?.taskId !== settled.taskId) return;
		if (isSessionStopping(this.#facts().sessionId)) return;
		const taskIds = this.#wholeUnits([settled]).filter((record) => !this.#claimed(record.taskId)).map((record) => record.taskId);
		this.takeUnread(taskIds, (notification) => this.#deliver(notification), "handed");
	}

	byAddress(nameOrTaskId: string): AgentRecord | undefined {
		return this.registry.byName(nameOrTaskId) ?? this.registry.byTaskId(nameOrTaskId);
	}

	async wait(names: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<{ outcome: AgentWaitOutcome; done: number; of: number; unknown: string[] }> {
		this.checkAddressable(names);
		const unknown = names.filter((name) => this.byAddress(name) === undefined);
		const named = names.flatMap((name) => this.byAddress(name) ?? []);
		const batchTypes = new Set(named.filter((record) => this.#batches(record.type)).map((record) => record.type));
		const batchmates = [...this.registry.live(), ...this.unread()].filter((record) => batchTypes.has(record.type));
		const known = [...new Set([...named, ...batchmates].map((record) => record.taskId))];
		const watched = known.length > 0 ? known : [...new Set([...this.registry.live().map((record) => record.taskId), ...this.unread().map((record) => record.taskId)])];
		const settledCount = () => watched.filter((taskId) => agentIsSettled(this.registry.byTaskId(taskId)?.status ?? "completed")).length;
		const condition =
			known.length > 0
				? () => settledCount() === known.length
				: () => this.#wholeUnits(this.unread()).length > 0 || this.registry.live().length === 0;
		const link = this.#link;
		if (link.state === "attached" && link.port.hasPendingInput() && !condition()) {
			return { outcome: { kind: "interrupted", by: this.#inputBy }, done: settledCount(), of: watched.length, unknown };
		}
		const claim = { taskIds: known.length > 0 ? new Set(known) : undefined };
		this.#claims.add(claim);
		try {
			const outcome = await this.waits.wait(condition, timeoutMs, signal);
			return { outcome, done: settledCount(), of: watched.length, unknown };
		} finally {
			this.#claims.delete(claim);
		}
	}

	interruptWaits(source: InputSource): void {
		const chain = this.#seatChain();
		this.#inputBy = source === "extension" && chain.length > 0 ? `your parent (${chain[1] ?? "the main session"})` : "Joel";
		this.waits.interrupt(this.#inputBy);
	}

	async send(name: string, message: string, interrupt: boolean, from: "Joel" | "seat", toolCallId?: string, signal?: AbortSignal): Promise<{ kind: "queued" | "interrupted" | "resumed"; record: AgentRecord }> {
		this.#refuseSelfOrAncestor(name);
		const found = this.byAddress(name);
		if (found === undefined) {
			const upChannel = this.#seatChain().length > 0 ? ` ${UP_CHANNEL_LINE}` : "";
			throw new AgentSendRefused("unknown-agent", `No agent named "${name}" among the agents you started.${upChannel} Run ListAgents to see targets.`);
		}
		const taskId = found.taskId;
		const text = from === "seat" ? parentMessageText(this.#seatChain()[0] ?? "the main session", message) : message;
		const sender = from === "seat" ? (this.#seatChain()[0] ?? "main") : "Joel";
		const source: InputSource = from === "seat" ? "extension" : "interactive";
		for (let run = this.#runs.get(taskId); run !== undefined; run = this.#runs.get(taskId)) {
			if (run.phase.at === "starting" || run.phase.at === "running") {
				const session = run.session;
				if (interrupt || session === undefined || !session.isStreaming) {
					run.inbox.push({ text, message, source });
					for (const wake of run.quietWatchers) wake();
					this.#recordLaterMessage(taskId, sender, message);
					const record = this.registry.byTaskId(taskId) ?? found;
					if (!interrupt) return { kind: "queued", record };
					void session?.abort().catch((thrown: unknown) => this.#log(`agent ${name}: the interrupt's abort failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`, "warning"));
					return { kind: "interrupted", record };
				}
				await session.steer(text, undefined, { source });
				this.#recordLaterMessage(taskId, sender, message);
				return { kind: "queued", record: this.registry.byTaskId(taskId) ?? found };
			}
			if ((await awaitUnlessAborted(run.ended, signal)) === "aborted") {
				throw new AgentSendRefused("cancelled", `The message to "${name}" was cancelled while the agent was finishing; it was not delivered.`);
			}
		}
		const record = this.registry.byTaskId(taskId) ?? found;
		if (from === "seat") {
			const idleMs = this.#now() - this.#lastRequestAt(record);
			if (idleMs > SHORT_TTL_MS) throw new AgentSendRefused("cold", coldResumeText(record.name, idleMs));
		}
		const resumed = await this.#resume(record, text, toolCallId, signal);
		this.#recordLaterMessage(taskId, sender, message);
		return { kind: "resumed", record: this.registry.byTaskId(taskId) ?? resumed };
	}

	#recordLaterMessage(taskId: string, from: string, text: string): void {
		const current = this.registry.byTaskId(taskId);
		if (current !== undefined) this.#updateRecord(taskId, { laterMessages: [...current.laterMessages, { from, text, at: this.#now() }] });
	}

	async followUp(name: string, message: string): Promise<{ kind: "queued" | "interrupted" | "resumed"; record: AgentRecord }> {
		this.#refuseSelfOrAncestor(name);
		const record = this.byAddress(name);
		const run = record === undefined ? undefined : this.#runs.get(record.taskId);
		const session = run?.phase.at === "running" ? run.session : undefined;
		if (record === undefined || session === undefined || !session.isStreaming) return this.send(name, message, false, "Joel");
		await session.followUp(message);
		this.#recordLaterMessage(record.taskId, "Joel", message);
		return { kind: "queued", record };
	}

	#lastRequestAt(record: AgentRecord): number {
		if (record.completedAt !== undefined) return record.completedAt;
		if (record.sessionFile !== undefined && existsSync(record.sessionFile)) return statSync(record.sessionFile).mtimeMs;
		return record.startedAt;
	}

	async #resume(record: AgentRecord, message: string, toolCallId: string | undefined, signal: AbortSignal | undefined): Promise<AgentRecord> {
		if (this.#retiring !== undefined) throw new AgentSendRefused("retiring", `The seat is shutting down: agent "${record.name}" cannot be resumed now.`);
		if (record.sessionFile === undefined || !existsSync(record.sessionFile)) {
			throw new AgentSendRefused("no-transcript", `Agent "${record.name}" has no transcript on disk to resume from.`);
		}
		const port = this.#port("resuming an agent");
		const slash = record.model.indexOf("/");
		const model = slash > 0 ? port.exactModel(record.model.slice(0, slash), record.model.slice(slash + 1)) : undefined;
		if (model === undefined) throw new AgentSendRefused("no-model", `No model to resume "${record.name}" on (${record.model}).`);
		const sessionManager = SessionManager.open(record.sessionFile, port.sessionDir);
		const type = port.types.find((candidate) => candidate.name === record.type);
		const seat = childSeatFrom(record, port.sessionId, type);
		const thinking: ThinkingLevel = clampThinkingLevel(model, record.thinking ?? type?.thinking ?? this.#childThinking());
		const run = this.#openSlot(record.taskId, record.workflowChild);
		try {
			const resumed = this.registry.put({
				...record,
				thinking,
				toolCallId,
				status: "queued",
				stoppedBy: undefined,
				result: undefined,
				error: undefined,
				readBy: undefined,
				readAt: undefined,
				toolUses: 0,
				costUsd: 0,
				totalTokens: 0,
				outputTokens: 0,
				startedAt: this.#now(),
				completedAt: undefined,
			});
			this.#emit("subagents:resumed", agentLifecyclePayload(resumed));
			if (record.branch !== undefined) run.worktree = await reattachAgentWorktree(this.#deps.exec, this.#deps.cwd, record.cwd, record.branch);
			this.#throwIfStartCancelled(run, record.name, signal);
			const sessionRuntime = await this.#createChildRuntime({
				sessionManager,
				cwd: record.cwd,
				model,
				thinking,
				systemPrompt: type?.prompt || undefined,
				type,
				seat,
				taskId: resumed.taskId,
				sessionName: `${record.name}#${resumed.taskId.slice(1, 7)}`,
				modelRuntime: port.modelRuntime,
			});
			run.sessionRuntime = sessionRuntime;
			this.#throwIfStartCancelled(run, record.name, signal);
			await this.#start(run, record.name, sessionRuntime.session, message, signal);
			return this.registry.byTaskId(record.taskId) ?? resumed;
		} catch (thrown) {
			await this.#abandon(run, thrown);
			throw thrown;
		}
	}

	async stop(nameOrTaskId: string, by: StopCause): Promise<AgentRecord> {
		this.#refuseSelfOrAncestor(nameOrTaskId);
		const record = this.byAddress(nameOrTaskId);
		if (record === undefined) throw new AgentStopRefused("unknown-agent", `No agent named "${nameOrTaskId}".`);
		const run = this.#runs.get(record.taskId);
		if (run?.phase.at === "settling") {
			const { status } = run.phase.outcome;
			throw new AgentStopRefused("not-running", `Agent "${record.name}" is not running (${status}).`, status);
		}
		if (run === undefined || run.phase.at === "settled" || run.phase.at === "cut off") {
			const foreign = agentIsSettled(record.status) ? undefined : descendantStoppers().get(record.taskId);
			if (foreign === undefined) throw new AgentStopRefused("not-running", `Agent "${record.name}" is not running (${record.status}).`);
			await foreign();
			return this.registry.byTaskId(record.taskId) ?? record;
		}
		await this.#stopRun(run, by);
		await run.ended;
		return this.registry.byTaskId(record.taskId) ?? record;
	}

	#stopDescendants(ownerSessionId: string): void {
		for (const taskId of liveAgentsOf(ownerSessionId)) {
			const stopper = descendantStoppers().get(taskId);
			if (stopper !== undefined) void stopper();
		}
	}
}
