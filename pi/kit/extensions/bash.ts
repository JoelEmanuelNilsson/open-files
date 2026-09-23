/**
 * bash — the kit's own `bash` tool: pi's tool with the process taken over.
 *
 * pi's `createBashToolDefinition(cwd, { operations })` takes the process as a
 * parameter — `exec(command, cwd, { onData, signal, timeout, env })` resolving
 * to an exit code — and keeps everything else: the output accumulator, the
 * truncation and temp file, the streaming partial render with its ticking
 * `Elapsed` line. This file supplies only `exec`, from a {@link Run} built per
 * call, and registers the result under the built-in's name so it replaces it
 * (`docs/extensions.md`, "override built-in tools").
 *
 * What the process side changes, and why (`lib/bash.ts` has the words):
 *
 *   - **A timeout moves the command to the background; it does not kill it.**
 *     `exec` stops feeding pi's accumulator and resolves; pi formats the output
 *     so far as a normal result; the wrapper appends "still running, task N,
 *     log at <path>"; the process runs on, writing the same log; and its exit
 *     is delivered as a `<background-task-notification>` through the session
 *     scope's `startTurn` — so a finished command wakes an idle session and
 *     queues behind a busy one.
 *     `run_in_background: true` is the same move at t=0, and `ctrl+b` is the
 *     same move on demand. Claude Code's three triggers, one mechanism.
 *   - **Every run logs from the start.** stdout and stderr go to pi's `onData`
 *     *and* to a `0600` file, so a move to the background loses nothing: the
 *     output so far is already there. A run that finishes in the foreground
 *     unlinks its log; pi's own truncation temp file is the record for those.
 *   - **A child seat keeps the kill.** A subagent's session ends with its task,
 *     so a late notification has nowhere to land: there, the timeout is pi's
 *     timeout (`Command timed out after N seconds`) and a call that asks for
 *     the background is refused with the remedy. The seat is known at
 *     `before_agent_start` (`lib/seat.ts`) and decides *behaviour only*: the
 *     tool is registered once, with one description and one schema, because
 *     the tools array is the front of the cached prefix and a seat-shaped
 *     variant of any tool costs a child its parent's tools+system entry
 *     (map C4). What differs by seat is said in the description, not carved
 *     out of the schema.
 *   - **A non-zero exit is reported, not thrown.** pi's bash fails the call on
 *     the last exit code, which is the whole verdict one process has to give;
 *     a chain's last link is a probe as often as it is a failure. The rule is
 *     `exitCodeNotice` in `lib/bash.ts`: the code is taken from the settled
 *     run, pi is handed a clean exit, and the number goes on the end of the
 *     result text where the model reads it.
 *   - **Nothing outlives the call, and nothing outlives the session.** When a
 *     shell exits leaving its process group populated — work the model
 *     detached with `&` or `nohup`, outside the mechanism above, where no
 *     notification can ever reach it — the group is killed and the result says
 *     so. The true limit: a process that leaves the group (`setsid`, `ssh -f`,
 *     `docker`, some build daemons) is outside anything this can reach.
 *     `session_shutdown` kills every group still registered; herdr owns
 *     anything meant to last.
 *
 *   - **One registrar per tool.** The transcript extension owns the rows of
 *     every built-in by re-registering them, and two extensions cannot claim
 *     one name. So this file registers bash and *borrows* the transcript's
 *     receipt (`transcript/receipt.ts`) for its rows when that extension is
 *     on, and falls back to pi's own render with a `ctrl+b` hint under it when
 *     it is off. Execution and rendering, one definition.
 *
 * The scan-refusal guard in `tool-policy.ts` still runs first: `tool_call`
 * fires before any tool's `execute`, owned or not, so a `find /` is refused
 * before this file ever sees it.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, statSync, unlinkSync, writeSync } from "node:fs";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BashOperations,
	type BashToolDetails,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getShellConfig,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	BACKGROUND_NOTIFICATION,
	type BackgroundTrigger,
	backgroundDir,
	backgroundHint,
	backgroundStatus,
	backgroundedText,
	BASH_DEFAULT_TIMEOUT_SEC,
	BASH_DESCRIPTION,
	BASH_MAX_TIMEOUT_SEC,
	type BashParams,
	bashParams,
	CHILD_REFUSAL,
	completionNotice,
	commandEnv,
	describeTask,
	exitCodeNotice,
	killedNotice,
	logPathFor,
	looksLikePrompt,
	openLog,
	orphanNotice,
	ORPHAN_CONFIRM_MS,
	readLogTail,
	resolveTimeoutSec,
	type SettledTask,
	STALL_CHECK_INTERVAL_MS,
	STALL_TAIL_BYTES,
	STALL_THRESHOLD_MS,
	stallNotice,
	wantsBackground,
} from "../lib/bash.ts";
import { notice } from "../lib/notice.ts";
import { isChildSeat } from "../lib/seat.ts";
import { createSessionScope, type SessionScope } from "../lib/session-scope.ts";
import { jsonArgumentCoercionFor } from "../lib/tool-argument-coercion.ts";
import { ensurePrivateDir } from "../lib/state-dir.ts";
import { CallHeader, headerPaints } from "./transcript/header.ts";
import { receipt } from "./transcript/receipt.ts";
import { ResultRow, resultPaints } from "./transcript/result.ts";
import { transcriptEnabled } from "./transcript/row.ts";
import { formatDuration } from "./transcript/summary.ts";

/** pi's grace after `exit` for output a descendant is still writing (`utils/child-process.js`). */
const EXIT_STDIO_GRACE_MS = 100;

const ORPHAN_POLL_MS = 100;

/** The window a surviving group is watched for, in milliseconds. Shortened by tests. */
const orphanConfirmMs = (): number => {
	const requested = Number(process.env.PI_KIT_ORPHAN_CONFIRM_MS);
	return Number.isFinite(requested) && requested >= 0 ? requested : ORPHAN_CONFIRM_MS;
};

const groupAlive = (pgid: number): boolean => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};

const groupSize = (pgid: number): number | undefined => {
	try {
		const out = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const count = out.split("\n").filter((line) => line.trim() !== "").length;
		return count === 0 ? undefined : count;
	} catch {
		// No `pgrep`, or the group went away between the check and the count: a
		// missing number is better than a made-up one.
		return undefined;
	}
};

/**
 * Kill whatever a shell left behind in its own process group, once it is clear
 * the survivors are not merely shutting down. Undefined when there were none.
 */
async function sweepOrphans(pgid: number | undefined, confirmMs: number): Promise<string | undefined> {
	if (pgid === undefined || process.platform === "win32") return undefined;
	const deadline = Date.now() + confirmMs;
	while (groupAlive(pgid)) {
		if (Date.now() >= deadline) {
			const count = groupSize(pgid);
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// Gone in the moment between the count and the kill.
			}
			return orphanNotice(count);
		}
		// A raw timer: killing a leftover process group must finish after the session ends; it touches no pi or ctx.
		await new Promise((resolve) => setTimeout(resolve, Math.min(ORPHAN_POLL_MS, Math.max(confirmMs, 1))));
	}
	return undefined;
}

type ExecOptions = Parameters<BashOperations["exec"]>[2];
/** pi's private render state, reached through the definition that owns it. */
// biome-ignore lint/suspicious/noExplicitAny: matching pi's own `AnyToolDefinition` shape for inference only
type RenderState = ReturnType<typeof createBashToolDefinition> extends ToolDefinition<any, any, infer S> ? S : never;
type ExecResult = Awaited<ReturnType<BashOperations["exec"]>>;

interface RunSpec {
	readonly id: number;
	readonly command: string;
	readonly logPath: string;
	/** False on a child seat: the timeout kills, and nothing may detach. */
	readonly mayBackground: boolean;
	/** Holds the run's timeout and stall clock, so neither outlives the session. */
	readonly scope: SessionScope;
	/** Where a run reports when it ends or stalls out of the foreground. */
	readonly onSettled: (run: Run, exitCode: number | null, signal: NodeJS.Signals | null) => void;
	readonly onStalled: (run: Run, tail: string) => void;
}

/**
 * One command's process, from spawn to exit. Foreground until {@link detach},
 * background after; the process itself never notices the difference.
 */
class Run {
	readonly id: number;
	readonly command: string;
	readonly logPath: string;
	readonly startedAt = Date.now();
	/** Set once, by whichever trigger moved the run out of the foreground. */
	trigger: BackgroundTrigger | undefined;
	/** Set when the shell exited leaving processes in its group, which were then killed. */
	orphans: string | undefined;
	#child: ChildProcess | undefined;
	#fd: number | undefined;
	#exited = false;
	#finished = false;
	#timedOut = false;
	#aborted = false;
	#timeoutSec: number | undefined;
	#outcome: { code: number | null; signal: NodeJS.Signals | null; error: Error | undefined } | undefined;
	#onData: ExecOptions["onData"] | undefined;
	#settle: ((result: ExecResult | Error) => void) | undefined;
	#cancelTimeout: (() => void) | undefined;
	#grace: ReturnType<typeof setTimeout> | undefined;
	#cancelStall: (() => void) | undefined;
	#lastGrowthAt = 0;
	#lastSize = 0;
	#stallNotified = false;
	readonly #spec: RunSpec;

	constructor(spec: RunSpec) {
		this.#spec = spec;
		this.id = spec.id;
		this.command = spec.command;
		this.logPath = spec.logPath;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	get exited(): boolean {
		return this.#exited;
	}

	/** The signal that ended the run, if one did. Null on a normal exit. */
	get signal(): NodeJS.Signals | null {
		return this.#outcome?.signal ?? null;
	}

	/** pi's `BashOperations.exec`, bound. Resolves when the foreground wait is over: exit, or detach. */
	readonly exec = (command: string, cwd: string, options: ExecOptions): Promise<ExecResult> =>
		new Promise<ExecResult>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			this.#onData = options.onData;
			this.#settle = (result) => {
				this.#settle = undefined;
				this.#onData = undefined;
				options.signal?.removeEventListener("abort", onAbort);
				if (result instanceof Error) reject(result);
				else resolve(result);
			};
			const shell = getShellConfig();
			const fromStdin = shell.commandTransport === "stdin";
			this.#fd = openLog(this.logPath);
			const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
				cwd,
				env: commandEnv(options.env),
				// Own process group, so a kill reaches the command's whole tree rather
				// than a shell that has already forked away from it.
				detached: process.platform !== "win32",
				stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			this.#child = child;
			if (fromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			child.stdout?.on("data", this.#data);
			child.stderr?.on("data", this.#data);
			child.on("error", (error) => this.#exit(null, null, error));
			child.on("exit", (code, signal) => this.#exit(code, signal));

			const onAbort = () => {
				this.#aborted = true;
				this.kill();
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			this.#timeoutSec = options.timeout;
			if (options.timeout !== undefined) {
				this.#cancelTimeout = this.#spec.scope.timeout(options.timeout * 1000, () => {
					this.#cancelTimeout = undefined;
					if (this.#spec.mayBackground) this.detach("timeout");
					else {
						this.#timedOut = true;
						this.kill();
					}
				});
			}
		});

	/**
	 * Leave the foreground. The exec promise resolves with the output so far
	 * as a clean result; the process, its log, and its exit notice carry on.
	 * False when there was no foreground to leave.
	 */
	detach(trigger: BackgroundTrigger): boolean {
		if (this.trigger !== undefined || this.#exited || this.#settle === undefined) return false;
		this.trigger = trigger;
		this.#clearTimeout();
		this.#lastGrowthAt = Date.now();
		this.#lastSize = this.#size();
		this.#cancelStall = this.#spec.scope.interval(STALL_CHECK_INTERVAL_MS, () => this.#checkStall());
		this.#settle({ exitCode: 0 });
		return true;
	}

	/** Kill the whole process group. Safe to call on a run that is already gone. */
	kill(): void {
		const pid = this.#child?.pid;
		if (pid === undefined || this.#exited) return;
		try {
			if (process.platform === "win32") this.#child?.kill("SIGKILL");
			else process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone between the exit event and here.
		}
	}

	readonly #data = (chunk: Buffer): void => {
		if (this.#fd !== undefined) {
			try {
				writeSync(this.#fd, chunk);
			} catch {
				// A full disk is not a reason to lose the foreground stream.
			}
		}
		this.#onData?.(chunk);
		// Output still arriving after exit: hold the streams open for it.
		if (this.#exited && !this.#finished) this.#armGrace();
	};

	#exit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#outcome = { code, signal, error };
		this.#clearTimeout();
		this.#cancelStall?.();
		this.#cancelStall = undefined;
		this.#armGrace();
	}

	/**
	 * Same rule as pi's `waitForChildProcess`: a descendant may still be writing
	 * to the pipe after the shell exits, so wait for it to fall idle rather than
	 * cutting it mid-write.
	 */
	#armGrace(): void {
		if (this.#grace !== undefined) clearTimeout(this.#grace);
		// A raw timer: a run shutdown killed still closes its pipes and log; `settled` then drops it before any pi call.
		this.#grace = setTimeout(() => this.#finish(), EXIT_STDIO_GRACE_MS);
	}

	#finish(): void {
		if (this.#finished || this.#outcome === undefined) return;
		this.#finished = true;
		this.#grace = undefined;
		this.#child?.stdout?.destroy();
		this.#child?.stderr?.destroy();
		if (this.#fd !== undefined) closeSync(this.#fd);
		this.#fd = undefined;
		// The sweep runs before the result is handed over, not after, so its one
		// line reaches whichever of the two channels this run ends on.
		void this.#sweep().then(() => this.#report());
	}

	async #sweep(): Promise<void> {
		// A run we killed ourselves has no orphans to report, only its own tree
		// on its way out.
		if (this.#aborted || this.#timedOut) return;
		this.orphans = await sweepOrphans(this.#child?.pid, orphanConfirmMs());
	}

	#report(): void {
		if (this.#outcome === undefined) return;
		const { code, signal, error } = this.#outcome;
		const settle = this.#settle;
		if (settle !== undefined) {
			if (error !== undefined) settle(error);
			else if (this.#aborted) settle(new Error("aborted"));
			else if (this.#timedOut) settle(new Error(`timeout:${this.#timeoutSec}`));
			else settle({ exitCode: code });
		}
		this.#spec.onSettled(this, error === undefined ? code : null, signal);
	}

	#clearTimeout(): void {
		this.#cancelTimeout?.();
		this.#cancelTimeout = undefined;
	}

	#size(): number {
		try {
			return statSync(this.logPath).size;
		} catch {
			return this.#lastSize;
		}
	}

	#checkStall(): void {
		if (this.#stallNotified || this.#exited) return;
		const size = this.#size();
		const now = Date.now();
		if (size !== this.#lastSize) {
			this.#lastSize = size;
			this.#lastGrowthAt = now;
			return;
		}
		if (now - this.#lastGrowthAt < STALL_THRESHOLD_MS) return;
		const tail = readLogTail(this.logPath, STALL_TAIL_BYTES);
		if (!looksLikePrompt(tail)) return;
		this.#stallNotified = true;
		this.#spec.onStalled(this, tail);
	}
}

/** pi's result with one more sentence on the end of its text. */
function withTrailingText(result: AgentToolResult<BashToolDetails | undefined>, text: string): AgentToolResult<BashToolDetails | undefined> {
	const content = [...result.content];
	const last = content[content.length - 1];
	if (last?.type === "text") content[content.length - 1] = { ...last, text: `${last.text.trimEnd()}\n\n${text}` };
	else content.push({ type: "text", text });
	return { ...result, content };
}

/** What a `<background-task-notification>` carries beside its text. */
interface NoticeDetails {
	id?: number;
	command?: string;
	exitCode?: number | null;
	signal?: string | null;
	logPath?: string;
	durationMs?: number;
	stalled?: boolean;
}

/**
 * Both notices, in one row.
 *
 *     ● Bash(npm test)
 *       ⎿  Done · task 4 · 12.3s
 *
 * With no renderer the notice draws its own XML in pi's custom-message box
 * (issues/31 (b)). The text is still the model's, untouched — only the drawing
 * is here — so `ctrl+o` adds the one thing the row drops and a reader wants:
 * where the output went.
 *
 * A stall is not painted as a failure. The detector is a guess about a prompt
 * (`lib/bash.ts`), and the process is still running.
 */
function renderNotice(message: { details?: unknown }, options: { expanded: boolean }, theme: Theme): Container | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null) return undefined;
	const notice = details as NoticeDetails;
	const stalled = notice.stalled === true;
	const status = stalled ? "Waiting for input" : backgroundStatus({ exitCode: notice.exitCode ?? null, signal: notice.signal ?? null });
	const failed = !stalled && status !== "Done";
	const line = notice.id === undefined ? status : `${status} · task ${notice.id}`;

	const container = new Container();
	const state = failed ? "error" : "done";
	const header = new CallHeader();
	header.set({ state, name: "Bash", argument: notice.command ?? "", clipEnd: "tail", expanded: options.expanded }, headerPaints(theme, state));
	container.addChild(header);

	const row = new ResultRow();
	const log = options.expanded && notice.logPath !== undefined ? [`Log: ${notice.logPath}`] : undefined;
	row.set(
		{
			summary: failed ? null : { kind: "note", text: line, tone: "muted" },
			body: failed ? [line, ...(log ?? [])] : log,
			error: failed,
			duration: formatDuration(notice.durationMs ?? 0),
			expanded: options.expanded,
		},
		resultPaints(theme),
	);
	container.addChild(row);
	return container;
}

export default function bash(pi: ExtensionAPI) {
	const scope = createSessionScope(pi);
	const runs = new Map<number, Run>();
	let seat: "main" | "child" | undefined;
	let nextId = 1;

	/** pi's definition, for the prompt metadata an override does not inherit, and its renderers. */
	const vanilla = createBashToolDefinition(process.cwd());

	/**
	 * The rows. The transcript's receipt when that extension is on — it draws
	 * every tool in the kit and this one wears the same two lines — and pi's own
	 * render with the `ctrl+b` hint under it otherwise.
	 */
	function rows(): Pick<ToolDefinition<typeof bashParams, BashToolDetails | undefined, RenderState>, "renderShell" | "renderCall" | "renderResult"> {
		if (transcriptEnabled()) return receipt("bash");
		const renderResult = vanilla.renderResult;
		return {
			renderCall: vanilla.renderCall,
			renderResult: renderResult
				? (result, renderOptions, theme, context) => {
						const component = renderResult(result, renderOptions, theme, context);
						// pi rebuilds its container on every render, so the hint is re-added
						// each time and disappears with the partial state it belongs to.
						if (seat !== "child" && renderOptions.isPartial && !context.isError && component instanceof Container) {
							component.addChild(new Text(theme.fg("muted", `\n${backgroundHint()}`), 0, 0));
						}
						return component;
					}
				: undefined,
		};
	}

	function define() {
		const definition: ToolDefinition<typeof bashParams, BashToolDetails | undefined, RenderState> = {
			name: "bash",
			label: "bash",
			description: BASH_DESCRIPTION,
			parameters: bashParams,
			prepareArguments: jsonArgumentCoercionFor(bashParams),
			promptSnippet: vanilla.promptSnippet,
			promptGuidelines: vanilla.promptGuidelines,
			execute,
			...rows(),
		};
		return definition;
	}

	async function execute(
		toolCallId: string,
		params: BashParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<BashToolDetails | undefined>> {
		const child = seat === "child";
		// A main seat backgrounds what outlives the foreground, so a longer
		// `timeout` there buys nothing; a child, which cannot, keeps the budget.
		const timeoutSec = resolveTimeoutSec(params.timeout, child ? BASH_MAX_TIMEOUT_SEC : BASH_DEFAULT_TIMEOUT_SEC);
		const requested = wantsBackground(params);
		if (requested && child) throw new Error(CHILD_REFUSAL);

		const id = nextId++;
		const dir = ensurePrivateDir(backgroundDir());
		const run = new Run({
			id,
			command: params.command,
			logPath: logPathFor(dir, ctx.sessionManager.getSessionId(), id),
			mayBackground: !child,
			scope,
			onSettled: settled,
			onStalled: stalled,
		});
		runs.set(id, run);

		let exitCode = 0;
		const base = createBashToolDefinition(ctx.cwd, {
			operations: {
				exec: async (command, cwd, execOptions) => {
					const pending = run.exec(command, cwd, execOptions);
					if (requested) run.detach("requested");
					const settled = await pending;
					// pi fails the call on any non-zero code (`harness/tools/bash.js`).
					// The rule at `exitCodeNotice` says that code is ours to report, so it
					// is taken here and pi is handed a clean exit. Anything that is not a
					// number without a signal — a shape we do not understand — goes through
					// untouched and stays an error: the older, redder behaviour.
					//
					// A signal death has no exit code, and pi throws on one ("Command
					// terminated without an exit code", 0.86.0). `killedNotice` below is
					// what reports that kill, so pi is handed a clean exit here too.
					if (settled.exitCode === null && run.signal !== null) return { ...settled, exitCode: 0 };
					if (typeof settled.exitCode !== "number" || settled.exitCode === 0) return settled;
					exitCode = settled.exitCode;
					return { ...settled, exitCode: 0 };
				},
			},
		});
		const result = await base.execute(toolCallId, { command: params.command, timeout: timeoutSec }, signal, onUpdate, ctx);
		const killed = run.signal;
		const trailers = [
			run.trigger !== undefined
				? backgroundedText(run, run.trigger, timeoutSec)
				: killed !== null
					? killedNotice(killed)
					: exitCode === 0
						? undefined
						: exitCodeNotice(exitCode),
			run.orphans,
		].filter((line) => line !== undefined);
		return trailers.length === 0 ? result : withTrailingText(result, trailers.join("\n\n"));
	}

	function settled(run: Run, exitCode: number | null, signal: NodeJS.Signals | null): void {
		if (!runs.delete(run.id)) return;
		if (run.trigger === undefined) {
			// A foreground run's record is pi's result; the log was insurance.
			try {
				unlinkSync(run.logPath);
			} catch {
				// Already gone, or never created: nothing to tidy.
			}
			return;
		}
		// A background run that ends after the scopes close and before this file's own
		// shutdown handler clears `runs` (quit's settle wait, say) reports to no one.
		if (scope.signal.aborted) return;
		const task: SettledTask = {
			id: run.id,
			command: run.command,
			logPath: run.logPath,
			exitCode,
			signal,
			durationMs: Date.now() - run.startedAt,
			tail: readLogTail(run.logPath),
		};
		const content = run.orphans === undefined ? completionNotice(task) : `${completionNotice(task)}\n${run.orphans}`;
		notify(content, { id: task.id, command: task.command, exitCode, signal, logPath: task.logPath, durationMs: task.durationMs }, describeTask(task));
	}

	function stalled(run: Run, tail: string): void {
		notify(stallNotice(run, tail, run.pid), { id: run.id, command: run.command, logPath: run.logPath, stalled: true }, `task ${run.id}: stalled — ${run.command}`);
	}

	function notify(content: string, details: NoticeDetails, label: string): void {
		try {
			const message = { customType: BACKGROUND_NOTIFICATION, content, display: true, details };
			// Refused before this runtime's first user turn or while a user prompt starts:
			// appended, so the model reads it on its next turn. Limit: an idle session is
			// not woken.
			if (!scope.startTurn(message, { deliverAs: "followUp" })) pi.sendMessage(message, { triggerTurn: false });
		} catch (error) {
			notice(undefined, `bash: ${label} — could not notify: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	/** Every foreground run, moved. Returns how many moved. */
	function backgroundAll(): number {
		let moved = 0;
		for (const run of runs.values()) if (run.detach("user")) moved++;
		return moved;
	}

	pi.registerTool(define());

	// Same switch as the rows: `PI_TRANSCRIPT=off` gives the notice back to pi.
	if (transcriptEnabled()) pi.registerMessageRenderer(BACKGROUND_NOTIFICATION, renderNotice);

	// The seat decides behaviour, never the schema: one definition is registered
	// once, and this only records which seat is executing it.
	pi.on("before_agent_start", (event, ctx) => {
		seat = isChildSeat(event.systemPromptOptions, process.argv, ctx.sessionManager.getSessionId()) ? "child" : "main";
	});

	pi.registerShortcut("ctrl+b", {
		description: "Move running bash commands to the background",
		handler: (ctx) => {
			const moved = backgroundAll();
			ctx.ui.notify(moved === 0 ? "bash: nothing is running in the foreground" : `bash: ${moved} command${moved === 1 ? "" : "s"} moved to the background`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		for (const run of runs.values()) run.kill();
		runs.clear();
	});
}
