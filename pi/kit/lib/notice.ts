/**
 * notice — the one door a message to the human goes through, and the reason a
 * child seat can no longer paint over the frame.
 *
 * The incident (issues/40): a headless child seat ran `console.log` for a model
 * warning. A child has no UI of its own, but it shares the process — and the
 * terminal — with the seat that does, so those bytes landed under the TUI's
 * renderer, which owns the screen and never learned they arrived. The frame
 * stayed smeared until something else forced a full repaint. Every
 * `if (ctx.hasUI) notify else console.log` in the kit was the same hole; the
 * dedupe next to any one of them only changed how often it opened.
 *
 * The seam: while a TUI owns the screen, nothing writes to stdout. A seat with
 * a UI claims the screen once ({@link claimScreen}) and publishes its own
 * `notify`; a seat without one hands its message to that claim instead of the
 * terminal, so a child's notice arrives *in* the parent's transcript rather
 * than across it.
 *
 * With no claim — print mode, a test, a bare script — the message goes to
 * {@link noticeSinkPath}, a private file, and to no process stream at all. It
 * used to go to stderr, on the reasoning that stderr is the diagnostics channel
 * and never the program's answer. That reasoning has no seat in this harness:
 * a seat with no UI and no claim is, by construction, somebody's child, and its
 * streams are a capture buffer. On 2026-09-07 a `pi -p` seat's cache-break
 * warning went to stderr, a parent's bash tool folded it into a tool result,
 * and the sentence rode every request of that session to the provider. Both
 * streams of a headless seat belong to whoever spawned it, so the kit writes to
 * neither and no diagnostic it *chooses* to emit can enter a payload.
 *
 * Two things it does not choose still can, and neither is fixable from here:
 * pi prints an uncaught throw out of extension code itself
 * (`print-mode.js`, `console.error("Extension error (path): ...")`), so a
 * kit stack trace still reaches a headless seat's stderr with pi's wording
 * around it; and `terminalWrite`'s bytes are capturable under a pty. Both are
 * narrow and stated rather than papered over: totality on every path here is
 * what keeps the first one theoretical.
 *
 * The sink is a file rather than silence because a diagnostic nobody can find
 * is the other way to lose it: `/trace` prints the directory, and the day's log
 * is one `cat` away.
 *
 * {@link terminalWrite} is the one exception, and it is not a message: escape
 * sequences addressed to a terminal emulator, written only when one is
 * attached. It lives here so that "no kit file writes to a process stream" can
 * be a grep with a single exempt file rather than a rule each call site has to
 * remember.
 *
 * The claim lives on `globalThis`, not in a module variable, for the same
 * reason `lib/seat.ts`'s does: every child session builds its own resource
 * loader, and a module re-evaluated per loader would give each seat a private
 * copy of the fact it is supposed to share.
 *
 * {@link noticeOnce} rides the same seam because "tell the human once" has the
 * same failure: a set held in an extension closure means once *per instance*,
 * and ~20 fanned-out children are ~20 instances. The keys are process-wide.
 */

import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { shared } from "./shared.ts";
import { ensurePrivateDir, pruneOlderThan, stateDir } from "./state-dir.ts";

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

const host = (): Record<string, unknown> => globalThis as Record<string, unknown>;

/**
 * Declare that this seat's UI owns the terminal, and publish where a headless
 * seat's notices should go instead of stdout. Returns the release.
 *
 * Last claim wins: one process draws one frame, so a second claim is a
 * handover (a reload, a fork), never a second screen.
 */
export function claimScreen(notify: Notify): () => void {
	host()[SCREEN_SEAM] = notify;
	return () => {
		if (host()[SCREEN_SEAM] === notify) delete host()[SCREEN_SEAM];
	};
}

/** Whether some seat in this process is currently painting a TUI. */
export function screenIsOwned(): boolean {
	return typeof host()[SCREEN_SEAM] === "function";
}

/**
 * Say something to the human, from any seat. Never writes to stdout while a
 * TUI owns the screen — that is the whole point of the module.
 *
 * Total, on every path. Callers say things from inside pi's hooks, and pi
 * answers a throw in a hook by carrying on without whatever that hook was
 * there to do — in `wire`'s case by sending pi's own payload, unattributed.
 * A message to the human may never be worth that, so a UI that throws is
 * treated exactly like a UI that is gone: fall through to the next sink.
 */
export function notice(ctx: NoticeContext | undefined, message: string, level: NoticeLevel = "info"): void {
	if (ctx?.hasUI === true) {
		try {
			ctx.ui.notify(message, level);
			return;
		} catch {
			// Mid-teardown, or a frame that is already unmounted. The screen owner
			// below is the same seat's other door, and the notice log is behind it.
		}
	}
	const owner = host()[SCREEN_SEAM];
	if (typeof owner === "function") {
		try {
			(owner as Notify)(message, level);
			return;
		} catch {
			// The owning seat's UI is gone mid-teardown. Falling through to the file
			// loses the frame at worst; there is no frame left to lose.
		}
	}
	appendNoticeLine(message, level);
}

/** How long a day's notices are kept, matching the wire trace's week. */
const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The directory the notice log lives in, one file per day. */
export function noticeSinkDir(): string {
	return join(stateDir(), "notices");
}

/** Today's notice log: `$XDG_STATE_HOME/pi-kit/notices/<YYYY-MM-DD>.log`. */
export function noticeSinkPath(): string {
	return join(noticeSinkDir(), `${new Date().toISOString().slice(0, 10)}.log`);
}

/** Whether this process has already swept the old logs. Housekeeping is per run, not per line. */
let swept = false;

/**
 * Append one line to the notice log — the sink of last resort, and the only
 * one that outlives the frame it was written for.
 *
 * The line goes down before anything else happens, and the week's sweep runs
 * after it in a `catch` of its own: pruning is housekeeping, and housekeeping
 * that can lose the message it was tidying up around has the priorities
 * backwards.
 */
function appendNoticeLine(message: string, level: NoticeLevel): void {
	try {
		ensurePrivateDir(noticeSinkDir());
		const path = noticeSinkPath();
		appendFileSync(path, `${new Date().toISOString()} ${process.pid} ${level} ${message}\n`, { mode: 0o600 });
		// `appendFileSync`'s mode only applies on creation; a file left by an
		// earlier umask is made private here rather than at the next audit.
		chmodSync(path, 0o600);
	} catch {
		// Nowhere left to say it. Not a stream: that is the whole point of this
		// module, and a diagnostic is never worth breaking the rule it enforces.
	}
	if (swept) return;
	swept = true;
	try {
		pruneOlderThan(noticeSinkDir(), NOTICE_RETENTION_MS);
	} catch {
		// A log that outstays its week is residue, not a fault worth reporting.
	}
}

/**
 * {@link notice}, but at most once per `key` for the life of the process —
 * across every seat in it, which is what an extension closure cannot do.
 * Returns whether the message was delivered.
 */
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

const onceKeys = (): Set<string> => shared(ONCE_SEAM, () => new Set<string>());

/**
 * Bytes for the terminal emulator itself — a bell, an OSC notification — and
 * the only writes the kit makes to a process stream.
 *
 * They are not a message and no sink can stand in for them: an emulator either
 * reads them or nothing does. Two conditions, both checked rather than
 * assumed, because this function is the one hole in "the kit writes to no
 * process stream" and a hole that only a comment keeps narrow is not narrow.
 *
 * An emulator has to be there: with stdout piped the other end is not a
 * terminal but a capture buffer belonging to whoever spawned this seat — the
 * buffer this module exists to keep the kit out of.
 *
 * And the bytes have to be control, not prose. A caller reaching for this to
 * print a sentence would put kit-authored text on stdout on every developer's
 * terminal, past every test, which is exactly the leak; a sequence that starts
 * with neither ESC nor BEL is not addressed to an emulator at all, so it is
 * dropped rather than written. Dropping a malformed bell costs nothing.
 *
 * The narrow limit worth stating: `isTTY` answers "is a terminal device on the
 * other end", not "is a human watching". Under a pty — `script`, tmux, a pane
 * something else is reading — it is true and these bytes are capturable. That
 * is the one remaining path from kit bytes to another process's buffer, and it
 * carries control sequences only.
 */
export function terminalWrite(sequence: string): void {
	if (process.stdout.isTTY !== true) return;
	if (!sequence.startsWith("\u001b") && !sequence.startsWith("\u0007")) return;
	process.stdout.write(sequence);
}
