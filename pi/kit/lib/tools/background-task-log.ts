import { chmodSync, closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../process/kit-state-dir.ts";

export function backgroundDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	if (env.PI_KIT_BACKGROUND_DIR) return env.PI_KIT_BACKGROUND_DIR;
	return join(stateDir(env, home), "background");
}

export const logPathFor = (dir: string, sessionId: string, id: number, startedAtMs: number): string => join(dir, `${sessionId}-${id}-${startedAtMs}.log`);

export function openLog(path: string): number {
	const fd = openSync(path, "a", 0o600);
	chmodSync(path, 0o600);
	return fd;
}

/** Output a bounded log keeps from the start of a command; the marker for the dropped middle follows it. */
export const LOG_HEAD_BYTES = 8 << 20;

const MARKER_PROBE_BYTES = 64;

/** A log's first and last characters and its length in characters; `head` and `tail` overlap when the log is short. */
export interface LogEnds {
	readonly chars: number;
	readonly droppedBytes: number;
	readonly head: string;
	readonly tail: string;
}

const LOG_READ_CHUNK_BYTES = 1 << 20;

/** Read a whole log in chunks, keeping only its first `headChars` and last `tailChars` characters. */
export function readLogEnds(path: string, headChars: number, tailChars: number): LogEnds {
	const decoder = new TextDecoder();
	const buffer = Buffer.alloc(LOG_READ_CHUNK_BYTES);
	let chars = 0;
	let head = "";
	let tail = "";
	let droppedBytes = 0;
	const fd = openSync(path, "r");
	try {
		const marker = Buffer.alloc(MARKER_PROBE_BYTES);
		droppedBytes = Number(/^\n\[\.\.\. (\d+) bytes omitted/.exec(marker.toString("utf8", 0, readSync(fd, marker, 0, marker.length, LOG_HEAD_BYTES)))?.[1] ?? 0);
		for (let read = readSync(fd, buffer); ; read = readSync(fd, buffer)) {
			const text = read === 0 ? decoder.decode() : decoder.decode(buffer.subarray(0, read), { stream: true });
			chars += text.length;
			if (head.length < headChars) head += text.slice(0, headChars - head.length);
			tail = (tail + text).slice(-tailChars);
			if (read === 0) break;
		}
	} finally {
		closeSync(fd);
	}
	return { chars, droppedBytes, head, tail };
}

const TAIL_MAX_CHARS = 4_000;
const TAIL_MAX_LINES = 60;

/** The tail of a log, bounded, with a note when there is more above it. */
export function readLogTail(path: string, maxChars = TAIL_MAX_CHARS, maxLines = TAIL_MAX_LINES): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		if (size === 0) return "";
		const from = Math.max(0, size - maxChars * 4);
		const buffer = Buffer.alloc(size - from);
		fd = openSync(path, "r");
		const read = readSync(fd, buffer, 0, buffer.length, from);
		return boundedTail(buffer.subarray(0, read).toString("utf8"), from > 0, maxChars, maxLines);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The last {@link TAIL_MAX_LINES} lines of `text`, then the last {@link TAIL_MAX_CHARS} chars. */
export function boundedTail(text: string, alreadyClipped = false, maxChars = TAIL_MAX_CHARS, maxLines = TAIL_MAX_LINES): string {
	const trimmed = text.replace(/\n+$/, "");
	const lines = trimmed.split("\n");
	let clipped = alreadyClipped;
	let tail = trimmed;
	if (lines.length > maxLines) {
		clipped = true;
		tail = lines.slice(-maxLines).join("\n");
	}
	if (tail.length > maxChars) {
		clipped = true;
		tail = tail.slice(tail.length - maxChars);
	}
	return clipped ? `[earlier output omitted — read the log file for all of it]\n${tail}` : tail;
}
