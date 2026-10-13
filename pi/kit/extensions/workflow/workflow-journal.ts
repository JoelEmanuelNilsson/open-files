import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import type { AgentThinkingLevel } from "../../lib/agents/agent-type-files.ts";

/** The `agent()` options that decide the cache key; `label` and `phase` are display-only. */
export interface WorkflowCacheKeyOptions {
	readonly schema?: unknown;
	readonly model?: string;
	readonly thinking?: AgentThinkingLevel;
	readonly type?: string;
	readonly isolation?: "worktree";
	readonly cwd?: string;
}

/** sha256 over the prompt and the key options, as a hex string. */
export function workflowCacheKey(prompt: string, options: WorkflowCacheKeyOptions): string {
	const material = JSON.stringify([prompt, options.schema ?? null, options.model ?? null, options.thinking ?? null, options.type ?? null, options.isolation ?? null, ...(options.cwd !== undefined ? [options.cwd] : [])]);
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
	// SAFETY: parsed was narrowed to a non-null object above
	const record = parsed as Record<string, unknown>;
	if (record.type === "failed" || typeof record.key !== "string" || !("result" in record)) return undefined;
	if (typeof record.after !== "number" || !Number.isInteger(record.after) || record.after < 0) return undefined;
	// SAFETY: after is validated above; the remaining record fields are written only by this journal's append
	return record as unknown as WorkflowJournalRecord;
}

export class WorkflowJournal {
	readonly #fd: number;
	readonly #prior: WorkflowJournalIndex;
	readonly #replayed = new Map<number, number>();
	#frontier = 0;
	readonly #mappedAfter: number[] = [];
	#written = 0;
	#liveFinished = false;
	#cached = 0;

	constructor(file: string, prior: WorkflowJournalIndex = new Map()) {
		this.#fd = openSync(file, "a");
		this.#prior = prior;
	}

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

	get written(): number {
		return this.#written;
	}

	append(record: WorkflowJournalRecord): void {
		this.#liveFinished = true;
		this.#write(record);
	}

	appendFailed(key: string): void {
		this.#liveFinished = true;
		const failure: WorkflowJournalFailure = { type: "failed", key };
		this.#write(failure);
	}

	replaySummary(): string {
		return `${this.#cached} cached`;
	}

	close(): void {
		try {
			closeSync(this.#fd);
		} catch {
		}
	}

	#write(line: WorkflowJournalRecord | WorkflowJournalFailure): void {
		writeSync(this.#fd, `${JSON.stringify(line)}\n`);
		this.#written++;
	}
}
