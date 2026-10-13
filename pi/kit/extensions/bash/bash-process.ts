import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import { BoundedLog } from "../../lib/tools/bounded-log.ts";
import { readLogTail } from "../../lib/tools/background-task-log.ts";
import { looksLikePrompt, STALL_CHECK_INTERVAL_MS, STALL_TAIL_BYTES, STALL_THRESHOLD_MS } from "../../lib/tools/background-task-notification.ts";
import { type BackgroundTrigger, leftRunningEndedNotice, orphanNotice } from "../../lib/tools/bash-result-notices.ts";
import type { SessionScope } from "../../lib/session/session-scope.ts";
import type { TaskEnd, TaskProcess } from "../../lib/tools/background-tasks.ts";

const ORPHAN_CONFIRM_MS = 1_000;

const GROUP_POLL_MS = 1_000;

export function commandEnv(
	env: NodeJS.ProcessEnv | undefined,
	home: string = homedir(),
): NodeJS.ProcessEnv | undefined {
	const base = env ?? process.env;
	if (base.RIPGREP_CONFIG_PATH) return env;
	const rc = join(home, ".config", "ripgrep", "rc");
	if (!existsSync(rc)) return env;
	return { ...base, RIPGREP_CONFIG_PATH: rc };
}

const PI_FEED_MAX_BYTES = 4 << 20;

const EXIT_STDIO_GRACE_MS = 100;

const exitStdioGraceMs = (): number => {
	const requested = Number(process.env.PI_KIT_EXIT_STDIO_GRACE_MS);
	return Number.isFinite(requested) && requested >= 0 ? requested : EXIT_STDIO_GRACE_MS;
};

const ORPHAN_POLL_MS = 100;

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
		return undefined;
	}
};

// shared-state: per module copy by design: each copy that spawned a group kills its own at process exit
const liveGroups = new Set<number>();
process.once("exit", () => {
	for (const pgid of liveGroups) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
		}
	}
});

type ExecOptions = Parameters<BashOperations["exec"]>[2];
type ExecResult = Awaited<ReturnType<BashOperations["exec"]>>;

/** What a {@link BashRun} is told at birth: its identity, its seat rule, and the session it belongs to. */
export interface BashRunSpec {
	readonly scope: SessionScope;
	readonly onBackground: (run: BashRun) => void;
	readonly onSettled: (run: BashRun, end: TaskEnd) => void;
	readonly onStalled: (run: BashRun, tail: string) => void;
	readonly id: number;
	readonly command: string;
	readonly logPath: string;
	readonly mayBackground: boolean;
}

export class BashRun implements TaskProcess {
	readonly id: number;
	readonly command: string;
	readonly logPath: string;
	readonly startedAt = Date.now();
	trigger: BackgroundTrigger | undefined;
	leftBehind: string | undefined;
	#child: ChildProcess | undefined;
	#log: BoundedLog | undefined;
	#fed = 0;
	#exited = false;
	#exitedAt = 0;
	#lastDataAt = 0;
	#finished = false;
	#timedOut = false;
	#aborted = false;
	#killed = false;
	#adopted = false;
	#timeoutSec: number | undefined;
	#outcome: { code: number | null; signal: NodeJS.Signals | null; error: Error | undefined } | undefined;
	#onData: ExecOptions["onData"] | undefined;
	#settle: ((result: ExecResult | Error) => void) | undefined;
	#cancelTimeout: (() => void) | undefined;
	#watch: ReturnType<typeof setTimeout> | undefined;
	#cancelStall: (() => void) | undefined;
	#lastGrowthAt = 0;
	#lastSize = 0;
	#stallNotified = false;
	readonly #mayBackground: boolean;
	readonly #home: BashRunSpec;

	constructor(spec: BashRunSpec) {
		this.#mayBackground = spec.mayBackground;
		this.#home = spec;
		this.id = spec.id;
		this.command = spec.command;
		this.logPath = spec.logPath;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	get finished(): boolean {
		return this.#finished;
	}

	get signal(): NodeJS.Signals | null {
		return this.#outcome?.signal ?? null;
	}

	get exitedWith(): TaskEnd | undefined {
		const outcome = this.#outcome;
		return outcome === undefined ? undefined : { exitCode: outcome.error === undefined ? outcome.code : null, signal: outcome.signal };
	}

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
			this.#log = new BoundedLog(this.logPath);
			const shellArgs = fromStdin ? shell.args : [...shell.args, command];
			const child = spawn(process.platform === "win32" ? shell.shell : "/usr/bin/nice", process.platform === "win32" ? shellArgs : ["-n", "10", shell.shell, ...shellArgs], {
				cwd,
				env: commandEnv(options.env),
				detached: process.platform !== "win32",
				stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			this.#child = child;
			if (child.pid !== undefined && process.platform !== "win32") liveGroups.add(child.pid);
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
				this.#cancelTimeout = this.#home.scope.timeout(options.timeout * 1000, () => {
					this.#cancelTimeout = undefined;
					if (this.#mayBackground) this.detach("timeout");
					else {
						this.#timedOut = true;
						this.kill();
					}
				});
			}
		});

	detach(trigger: BackgroundTrigger): boolean {
		if (this.trigger !== undefined || this.#exited || this.#settle === undefined) return false;
		this.trigger = trigger;
		this.#clearTimeout();
		this.#armStall();
		this.#home.onBackground(this);
		this.#settle({ exitCode: 0 });
		return true;
	}

	kill(): boolean {
		const pid = this.#child?.pid;
		if (pid === undefined || this.#finished) return false;
		try {
			if (process.platform === "win32") {
				if (this.#child?.kill("SIGKILL") !== true) return false;
			} else process.kill(-pid, "SIGKILL");
		} catch {
			return false;
		}
		this.#killed = true;
		return true;
	}

	readonly #data = (chunk: Buffer): void => {
		try {
			this.#log?.write(chunk);
		} catch {
		}
		if (this.#fed < PI_FEED_MAX_BYTES) {
			this.#fed += chunk.length;
			this.#onData?.(chunk);
		}
		this.#lastDataAt = Date.now();
	};

	#exit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#exitedAt = Date.now();
		this.#outcome = { code, signal, error };
		this.#clearTimeout();
		this.#watchGroup(exitStdioGraceMs());
	}

	#watchGroup(delayMs: number): void {
		// raw-timer: a run shutdown killed still closes its pipes and log; `settled` then drops it before any pi call.
		this.#watch = setTimeout(() => this.#checkGroup(), delayMs);
	}

	#checkGroup(): void {
		const now = Date.now();
		const pgid = process.platform === "win32" ? undefined : this.#child?.pid;
		const populated = pgid !== undefined && groupAlive(pgid);
		const confirmed = now - this.#exitedAt >= orphanConfirmMs();
		if (!populated && (confirmed || now - this.#lastDataAt >= exitStdioGraceMs())) {
			this.#finish();
			return;
		}
		if (pgid !== undefined && populated && confirmed && !this.#killed && !this.#adopted) this.#leftRunning(pgid);
		this.#watchGroup(this.#adopted ? GROUP_POLL_MS : ORPHAN_POLL_MS);
	}

	#leftRunning(pgid: number): void {
		if (!this.#mayBackground) {
			this.leftBehind = orphanNotice(groupSize(pgid));
			this.kill();
			return;
		}
		this.#adopted = true;
		if (this.trigger !== undefined || this.#settle === undefined || this.#outcome === undefined) return;
		this.trigger = "orphans";
		this.#armStall();
		this.#home.onBackground(this);
		this.#settle({ exitCode: this.#outcome.code });
	}

	#finish(): void {
		if (this.#finished || this.#outcome === undefined) return;
		this.#finished = true;
		this.#watch = undefined;
		this.#cancelStall?.();
		this.#cancelStall = undefined;
		this.#child?.stdout?.destroy();
		this.#child?.stderr?.destroy();
		this.#log?.close();
		this.#log = undefined;
		if (this.#adopted) this.leftBehind = leftRunningEndedNotice(this.#exitedAt - this.startedAt);
		if (this.#child?.pid !== undefined) liveGroups.delete(this.#child.pid);
		this.#report();
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
		this.#home.onSettled(this, { exitCode: error === undefined ? code : null, signal: signal ?? (this.#killed ? "SIGKILL" : null) });
	}

	#armStall(): void {
		this.#lastGrowthAt = Date.now();
		this.#lastSize = this.#size();
		this.#cancelStall = this.#home.scope.interval(STALL_CHECK_INTERVAL_MS, () => this.#checkStall());
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
		if (this.#stallNotified || this.#finished) return;
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
		this.#home.onStalled(this, tail);
	}
}
