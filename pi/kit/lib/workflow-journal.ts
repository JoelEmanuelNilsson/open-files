/**
 * The workflow journal: one JSONL line per finished `agent()` call, in the
 * order the calls finished. A line is a result, or a `failed` line for a
 * child that died. Its position among the lines is its place in finish order.
 *
 * A call is keyed on its *content* (prompt and the options that change what
 * the child does), but content is not enough to serve it: a call can depend
 * on a side effect (a file, a worktree) rather than on text. So a result line
 * also records `after`, how many lines the run had written when that agent
 * started, and resume serves a result only when the agent would start in the
 * same world it started in before — the effects of every agent that had
 * finished before it:
 *
 *   - `take` serves the first unused prior result with the call's key whose
 *     `after` prior lines have all been replayed in this run, and only while
 *     no agent has run live and finished in this run. Anything else misses.
 *   - A replayed hit is journalled again with its prior `after` mapped onto
 *     this run's lines: one past the last line any prior line it waited on was
 *     journalled again as. So resuming a resumed run works, and two calls
 *     that never depended on each other still replay in either order.
 *   - A `failed` line is never replayed, so every agent that started after
 *     that death runs again (it may have seen the dead agent's partial
 *     effects); those that started before it still hit. An agent in flight
 *     when the run stopped wrote no line and constrains nothing.
 *   - A prior line with no `after` (an older journal) is never served.
 *
 * That is "the first edited call and everything after it runs live", with
 * "after" meaning happens-before rather than call order, so a pipeline whose
 * stages finished out of order still replays whole.
 *
 * `null` is never cached: a died child is a `failed` line, so a resumed run
 * re-runs it. The clock and the RNG are banned in scripts for this file's
 * sake: a prompt containing either changes its key every run.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import type { AgentThinkingLevel } from "./agent-types.ts";

/** The `agent()` options that decide the cache key; `label` and `phase` are display-only. */
export interface WorkflowCacheKeyOptions {
	readonly schema?: unknown;
	readonly model?: string;
	readonly thinking?: AgentThinkingLevel;
	readonly type?: string;
	readonly isolation?: "worktree";
}

/** sha256 over the prompt and the key options, as a hex string. */
export function workflowCacheKey(prompt: string, options: WorkflowCacheKeyOptions): string {
	const material = JSON.stringify([prompt, options.schema ?? null, options.model ?? null, options.thinking ?? null, options.type ?? null, options.isolation ?? null]);
	return createHash("sha256").update(material).digest("hex");
}

/** One `agent()` call as the journal sees it: its key and what a reader of the journal needs. */
export interface WorkflowJournalCall {
	readonly key: string;
	readonly label: string | undefined;
	readonly prompt: string;
	readonly phase?: string;
}

/** A result line; a child that died writes a {@link WorkflowJournalFailure} instead. */
export interface WorkflowJournalRecord extends WorkflowJournalCall {
	readonly result: unknown;
	/** How many lines the run had written when the agent started; for a replayed hit, its prior `after` in this run's lines. */
	readonly after: number;
}

/** The line a died child writes: a finish with no result, never replayed. */
export interface WorkflowJournalFailure {
	readonly type: "failed";
	readonly key: string;
}

/** A prior result line and its position in that run's finish order. */
export interface WorkflowJournalPriorRecord extends WorkflowJournalRecord {
	readonly position: number;
}

/** A prior journal's servable results, folded by key, each key's results in file order. */
export type WorkflowJournalIndex = Map<string, WorkflowJournalPriorRecord[]>;

/**
 * Read a prior run's journal. Every non-blank line holds a position, so a
 * `failed`, torn or `after`-less line still blocks the results that started
 * after it; only results that can be served are indexed.
 */
export function readWorkflowJournal(file: string): WorkflowJournalIndex {
	const index: WorkflowJournalIndex = new Map();
	if (!existsSync(file)) return index;
	let position = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const record = parseResultLine(line);
		if (record !== undefined) {
			const list = index.get(record.key) ?? [];
			list.push({ ...record, position });
			index.set(record.key, list);
		}
		position++;
	}
	return index;
}

function parseResultLine(line: string): WorkflowJournalRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.type === "failed" || typeof record.key !== "string" || !("result" in record)) return undefined;
	if (typeof record.after !== "number" || !Number.isInteger(record.after) || record.after < 0) return undefined;
	// SAFETY: the key, the result and a non-negative integer `after` were checked above; the rest is for readers.
	return record as unknown as WorkflowJournalRecord;
}

/**
 * The journal of one run: appends synchronously (a line is on disk before
 * `agent()` returns, so a kill loses nothing finished), and replays a prior
 * run's index when resuming.
 */
export class WorkflowJournal {
	readonly #fd: number;
	readonly #prior: WorkflowJournalIndex;
	/** Prior position → the line it was journalled again as. */
	readonly #replayed = new Map<number, number>();
	/** The lowest prior position not yet replayed: a prior result is servable when its `after` is at most this. */
	#frontier = 0;
	/** Per prior position below the frontier: one past the last line this run journalled it or any before it as. */
	readonly #mappedAfter: number[] = [];
	#written = 0;
	#liveFinished = false;
	#cached = 0;

	constructor(file: string, prior: WorkflowJournalIndex = new Map()) {
		this.#fd = openSync(file, "a");
		this.#prior = prior;
	}

	/** Serve `call` from the prior run and journal the hit, or return undefined: the call runs live. */
	take(call: WorkflowJournalCall): WorkflowJournalRecord | undefined {
		if (this.#liveFinished) return undefined;
		const list = this.#prior.get(call.key);
		const at = list?.findIndex((record) => record.after <= this.#frontier) ?? -1;
		if (list === undefined || at < 0) return undefined;
		const [hit] = list.splice(at, 1);
		if (hit === undefined) return undefined;
		const after = hit.after === 0 ? 0 : (this.#mappedAfter[hit.after - 1] ?? this.#written);
		this.#replayed.set(hit.position, this.#written);
		for (let line = this.#replayed.get(this.#frontier); line !== undefined; line = this.#replayed.get(this.#frontier)) {
			this.#mappedAfter[this.#frontier] = Math.max(this.#mappedAfter[this.#frontier - 1] ?? 0, line + 1);
			this.#frontier++;
		}
		this.#write({ ...call, result: hit.result, after });
		this.#cached++;
		return hit;
	}

	/** Lines written so far: a live agent's `after`, read when its child starts. */
	get written(): number {
		return this.#written;
	}

	/** Write a live agent's result. From here on nothing replays: this run's world has left the prior run's. */
	append(record: WorkflowJournalRecord): void {
		this.#liveFinished = true;
		this.#write(record);
	}

	/** Write the line for a live agent that died: no result, so resume re-runs it and everything that started after it. */
	appendFailed(key: string): void {
		this.#liveFinished = true;
		const failure: WorkflowJournalFailure = { type: "failed", key };
		this.#write(failure);
	}

	/** `N cached` — what a resumed run prints. */
	replaySummary(): string {
		return `${this.#cached} cached`;
	}

	close(): void {
		try {
			closeSync(this.#fd);
		} catch {
			// Already closed.
		}
	}

	#write(line: WorkflowJournalRecord | WorkflowJournalFailure): void {
		writeSync(this.#fd, `${JSON.stringify(line)}\n`);
		this.#written++;
	}
}
