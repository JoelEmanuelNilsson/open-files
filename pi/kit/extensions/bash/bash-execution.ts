import { readFileSync, unlinkSync } from "node:fs";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BashToolDetails,
	createBashToolDefinition,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { backgroundDir, logPathFor, readLogEnds } from "../../lib/tools/background-task-log.ts";
import { adoptBackgroundTask, type BackgroundTaskHandle, nextBackgroundTaskId, type NoticeSink } from "../../lib/tools/background-tasks.ts";
import { completionNotice, describeTask, stallNotice } from "../../lib/tools/background-task-notification.ts";
import { backgroundedText, cutBashOutput, exitCodeNotice, killedNotice, UNATTENDED_REFUSAL } from "../../lib/tools/bash-result-notices.ts";
import { BASH_DEFAULT_TIMEOUT_SEC, BASH_FAILURE_EXCERPT_CHARS, BASH_MAX_TIMEOUT_SEC, type BashParams, resolveTimeoutSec, wantsBackground } from "../../lib/tools/bash-tool.ts";
import { ensurePrivateDir } from "../../lib/process/kit-state-dir.ts";
import type { SessionScope } from "../../lib/session/session-scope.ts";
import { notice } from "../../lib/process/human-notice.ts";
import type { BackgroundNoticeDetails } from "./background-notice-row.ts";
import { BashRun } from "./bash-process.ts";

/** What the bash tool's calls need from the extension that registers them. */
export interface BashExecutionDeps {
	readonly scope: SessionScope;
	readonly seat: () => "main" | "agent" | "unattended" | undefined;
	readonly notify: (content: string, details: BackgroundNoticeDetails, label: string) => "turned" | "appended" | "failed";
}

/** The bash tool's `execute`, and the handles on its runs that `ctrl+b`, delivery and shutdown need. */
export interface BashExecution {
	readonly execute: (
		toolCallId: string,
		params: BashParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
		ctx: ExtensionToolContext,
	) => Promise<AgentToolResult<BashToolDetails | undefined>>;
	readonly backgroundAll: () => number;
	readonly killAll: () => void;
}

function withTrailingText(result: AgentToolResult<BashToolDetails | undefined>, text: string): AgentToolResult<BashToolDetails | undefined> {
	const content = [...result.content];
	const last = content[content.length - 1];
	if (last?.type === "text") content[content.length - 1] = { ...last, text: `${last.text.trimEnd()}\n\n${text}` };
	else content.push({ type: "text", text });
	return { ...result, content };
}

function withClaudeCodeOutput(result: AgentToolResult<BashToolDetails | undefined>, logPath: string, failed: boolean): AgentToolResult<BashToolDetails | undefined> {
	let cut: string | undefined;
	let whole = "";
	try {
		cut = cutBashOutput(readLogEnds(logPath, BASH_FAILURE_EXCERPT_CHARS, BASH_FAILURE_EXCERPT_CHARS), failed, logPath);
		if (cut === undefined) whole = readFileSync(logPath, "utf8");
	} catch {
		return result;
	}
	if (cut === undefined) removeLog(logPath);
	if (result.details?.fullOutputPath !== undefined) removeLog(result.details.fullOutputPath);
	return {
		...result,
		content: [{ type: "text", text: cut ?? (whole || "(no output)") }],
		details: cut === undefined ? undefined : { fullOutputPath: logPath },
	};
}

function removeLog(path: string): void {
	try {
		unlinkSync(path);
	} catch {
	}
}

/** One extension instance's bash calls; task ids come from the registry, per session. */
export function createBashExecution({ scope, seat, notify }: BashExecutionDeps): BashExecution {
	const runs = new Map<number, BashRun>();

	async function execute(
		toolCallId: string,
		params: BashParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<BashToolDetails | undefined>> {
		const mayBackground = seat() !== "unattended";
		const timeoutSec = resolveTimeoutSec(params.timeout, mayBackground ? BASH_DEFAULT_TIMEOUT_SEC : BASH_MAX_TIMEOUT_SEC);
		const requested = wantsBackground(params);
		if (requested && !mayBackground) throw new Error(UNATTENDED_REFUSAL);
		const sessionId = ctx.sessionManager.getSessionId();

		const id = nextBackgroundTaskId(sessionId);
		let handle: BackgroundTaskHandle | undefined;
		const dir = ensurePrivateDir(backgroundDir());
		const run = new BashRun({
			id,
			command: params.command,
			logPath: logPathFor(dir, sessionId, id, Date.now()),
			mayBackground,
			scope,
			onBackground: (moved) => {
				handle = background(moved, sessionId);
			},
			onSettled: (_run, end) => {
				runs.delete(id);
				handle?.finished(end);
			},
			onStalled: stalled,
		});

		let exitCode = 0;
		const base = createBashToolDefinition(ctx.cwd, {
			operations: {
				exec: async (command, cwd, execOptions) => {
					const pending = run.exec(command, cwd, execOptions);
					if (run.pid !== undefined) runs.set(id, run);
					if (requested) run.detach("requested");
					const settled = await pending;
					if (settled.exitCode === null && run.signal !== null) return { ...settled, exitCode: 0 };
					if (typeof settled.exitCode !== "number" || settled.exitCode === 0) return settled;
					exitCode = settled.exitCode;
					return { ...settled, exitCode: 0 };
				},
			},
		});
		let piResult: AgentToolResult<BashToolDetails | undefined>;
		try {
			piResult = await base.execute(toolCallId, { command: params.command, timeout: timeoutSec }, signal, onUpdate, ctx);
		} catch (error) {
			if (run.trigger === undefined) removeLog(run.logPath);
			throw error;
		}
		const killed = run.signal;
		const result = run.trigger === undefined ? withClaudeCodeOutput(piResult, run.logPath, exitCode !== 0 || killed !== null) : piResult;
		const trailers = [
			run.trigger !== undefined
				? backgroundedText(run, run.trigger, timeoutSec, seat() === "agent")
				: killed !== null
					? killedNotice(killed)
					: undefined,
			exitCode === 0 ? undefined : exitCodeNotice(exitCode),
			run.leftBehind,
		].filter((line) => line !== undefined);
		return trailers.length === 0 ? result : withTrailingText(result, trailers.join("\n\n"));
	}

	function background(run: BashRun, owner: string): BackgroundTaskHandle {
		runs.delete(run.id);
		const notice: NoticeSink = (task) => {
			if (scope.leaving) return "not-now";
			const content = run.leftBehind === undefined ? completionNotice(task) : `${completionNotice(task)}\n${run.leftBehind}`;
			const details = { id: task.id, command: task.command, exitCode: task.exitCode, signal: task.signal, logPath: task.logPath, durationMs: task.durationMs };
			const delivery = notify(content, details, describeTask(task));
			return delivery === "failed" ? "not-now" : delivery;
		};
		return adoptBackgroundTask(owner, { id: run.id, command: run.command, logPath: run.logPath }, run, notice, run.startedAt);
	}

	function stalled(run: BashRun, tail: string): void {
		notify(stallNotice(run, tail, run.pid), { id: run.id, command: run.command, logPath: run.logPath, stalled: true }, `task ${run.id}: stalled — ${run.command}`);
	}

	function backgroundAll(): number {
		let moved = 0;
		for (const run of runs.values()) if (run.detach("user")) moved++;
		return moved;
	}

	function killAll(): void {
		for (const run of runs.values()) run.kill();
		runs.clear();
	}

	return { execute, backgroundAll, killAll };
}
