import { closeSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { LOG_HEAD_BYTES, openLog } from "./background-task-log.ts";

const MIB = 1 << 20;

/** Output kept from the end of a command; the file grows to twice this before the oldest half is dropped. */
export const LOG_TAIL_BYTES = 8 * MIB;

/** The largest a log gets: head, a marker line under 128 bytes, and two tails. A chunk of output may overshoot it by its own size before the next compaction. */
export const LOG_MAX_BYTES = LOG_HEAD_BYTES + 128 + 2 * LOG_TAIL_BYTES;

/** The line that stands for the dropped middle. `readLogEnds` reads the count from where it starts, at {@link LOG_HEAD_BYTES}. */
export const omittedMarker = (dropped: number): string => `\n[... ${dropped} bytes omitted from the middle of this output to keep the log bounded ...]\n`;

/** An append-only log that drops its oldest middle bytes instead of growing without limit. */
export class BoundedLog {
	readonly #path: string;
	readonly #fd: number;
	#size = 0;
	#markerBytes = 0;
	#dropped = 0;

	constructor(path: string) {
		this.#path = path;
		this.#fd = openLog(path);
	}

	write(chunk: Uint8Array): void {
		for (let written = 0; written < chunk.length; ) written += writeSync(this.#fd, chunk, written);
		this.#size += chunk.length;
		if (this.#size > LOG_HEAD_BYTES + this.#markerBytes + 2 * LOG_TAIL_BYTES) this.#compact();
	}

	close(): void {
		closeSync(this.#fd);
	}

	#compact(): void {
		const tail = Buffer.alloc(LOG_TAIL_BYTES);
		const reader = openSync(this.#path, "r");
		try {
			for (let at = 0; at < tail.length; ) {
				const read = readSync(reader, tail, at, tail.length - at, this.#size - tail.length + at);
				if (read === 0) break;
				at += read;
			}
		} finally {
			closeSync(reader);
		}
		this.#dropped += this.#size - tail.length - LOG_HEAD_BYTES - this.#markerBytes;
		const marker = Buffer.from(omittedMarker(this.#dropped));
		ftruncateSync(this.#fd, LOG_HEAD_BYTES);
		writeSync(this.#fd, marker);
		writeSync(this.#fd, tail);
		this.#markerBytes = marker.length;
		this.#size = LOG_HEAD_BYTES + marker.length + tail.length;
	}
}
