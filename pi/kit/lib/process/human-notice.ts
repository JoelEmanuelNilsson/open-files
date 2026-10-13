import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { processShared } from "./process-shared-state.ts";
import { ensurePrivateDir, pruneOlderThan, stateDir } from "./kit-state-dir.ts";

/** What a notice can be. Matches pi's `ui.notify` levels. */
export type NoticeLevel = "info" | "warning" | "error";

/** Just enough of pi's context to route a notice — both `ExtensionContext` and `ExtensionCommandContext` satisfy it. */
export interface NoticeContext {
	readonly hasUI: boolean;
	readonly ui: { notify(message: string, type: NoticeLevel): void };
}

type Notify = (message: string, level: NoticeLevel) => void;

const SCREEN_SEAM = "__piKitScreenOwner";
const ONCE_SEAM = "__piKitNoticeOnce";

// SAFETY: globalThis is only used as a string-keyed bag of process-shared slots
const host = (): Record<string, unknown> => globalThis as Record<string, unknown>;

export function claimScreen(notify: Notify): () => void {
	host()[SCREEN_SEAM] = notify;
	return () => {
		if (host()[SCREEN_SEAM] === notify) delete host()[SCREEN_SEAM];
	};
}

export function notice(ctx: NoticeContext | undefined, message: string, level: NoticeLevel = "info"): void {
	try {
		if (ctx?.hasUI === true) {
			ctx.ui.notify(message, level);
			return;
		}
	} catch {
	}
	const owner = host()[SCREEN_SEAM];
	if (typeof owner === "function") {
		try {
			// SAFETY: owner passed the typeof function check above; Notify is the registered seam signature
			(owner as Notify)(message, level);
			return;
		} catch {
		}
	}
	appendNoticeLine(message, level);
}

const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The directory the notice log lives in, one file per day. */
export function noticeSinkDir(): string {
	return join(stateDir(), "notices");
}

/** Today's notice log: `$XDG_STATE_HOME/pi-kit/notices/<YYYY-MM-DD>.log`. */
export function noticeSinkPath(): string {
	return join(noticeSinkDir(), `${new Date().toISOString().slice(0, 10)}.log`);
}

// shared-state: a once-per-process sweep flag; a second copy only prunes the week-old logs once more, and pruning is idempotent
let swept = false;

function appendNoticeLine(message: string, level: NoticeLevel): void {
	try {
		ensurePrivateDir(noticeSinkDir());
		const path = noticeSinkPath();
		appendFileSync(path, `${new Date().toISOString()} ${process.pid} ${level} ${message}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
	} catch {
	}
	if (swept) return;
	swept = true;
	try {
		pruneOlderThan(noticeSinkDir(), NOTICE_RETENTION_MS);
	} catch {
	}
}

export function noticeOnce(ctx: NoticeContext | undefined, key: string, message: string, level: NoticeLevel = "info"): boolean {
	const seen = onceKeys();
	if (seen.has(key)) return false;
	seen.add(key);
	notice(ctx, message, level);
	return true;
}

/** Drop every remembered {@link noticeOnce} key. For tests; nothing in a live seat forgets. */
export function forgetNoticedKeys(): void {
	onceKeys().clear();
}

const onceKeys = (): Set<string> => processShared(ONCE_SEAM, () => new Set<string>());

export function terminalWrite(sequence: string): void {
	if (process.stdout.isTTY !== true) return;
	if (!sequence.startsWith("\u001b") && !sequence.startsWith("\u0007")) return;
	process.stdout.write(sequence);
}
