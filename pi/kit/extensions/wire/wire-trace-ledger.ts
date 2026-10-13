import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CacheUsage, cachedPrefix } from "../../lib/cache/cache-usage.ts";
import { pruneOlderThan, stateDir } from "../../lib/process/kit-state-dir.ts";
import type { BlockPrint, PriorPrint, ReasoningPrint } from "./wire-print.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function traceDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	if (env.PI_WIRE_TRACE_DIR) return env.PI_WIRE_TRACE_DIR;
	return join(stateDir(env, home), "wire-trace");
}

/** Drop traces older than a week. A forensic log nobody reads is just residue. */
export function pruneTraces(dir: string, now = Date.now()): number {
	return pruneOlderThan(dir, WEEK_MS, now);
}

export interface Anchor {
	seq: number;
	at: number;
	model: string;
	ttlMin?: number;
	print: PriorPrint;
	usage: CacheUsage;
	held?: number;
	payload?: unknown;
}

const TAIL_BYTES = 64 * 1024;

type LedgerRecord = Record<string, unknown>;

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
// SAFETY: every.item check above proved every element is a string
const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
// SAFETY: every item check above proved every element is a number
const numbers = (value: unknown): number[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "number") ? (value as number[]) : undefined;
const usageOf = (use: LedgerRecord): CacheUsage => ({
	input: num(use.input) ?? 0,
	cacheRead: num(use.read) ?? 0,
	cacheWrite: num(use.write) ?? 0,
	cacheWrite1h: num(use.write1h),
	reasoning: num(use.reasoning),
});
// SAFETY: isRecord and the every check above proved a string-to-string record
const stringMap = (value: unknown): ReasoningPrint | undefined =>
	isRecord(value) && Object.values(value).every((item) => typeof item === "string") ? (value as ReasoningPrint) : undefined;

export function readLedgerTail(path: string, maxBytes = TAIL_BYTES): LedgerRecord[] {
	const size = statSync(path).size;
	const from = Math.max(0, size - maxBytes);
	const buffer = Buffer.alloc(size - from);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, from);
	} finally {
		closeSync(fd);
	}
	const lines = buffer.toString("utf8").split("\n");
	if (from > 0) lines.shift();
	return lines.flatMap((line) => {
		try {
			const value: unknown = JSON.parse(line);
			return isRecord(value) ? [value] : [];
		} catch {
			return [];
		}
	});
}

/** Tokens re-billed across every cache break this session's ledger recorded; zero for a ledger that cannot be read. */
export function rebilledTokens(path: string): number {
	try {
		return readLedgerTail(path, Number.POSITIVE_INFINITY).reduce((sum, record) => sum + (record.t === "break" ? (num(record.shortfall) ?? 0) : 0), 0);
	} catch {
		return 0;
	}
}

interface Rehydrated {
	seq: number;
	settled?: Anchor;
	refreshedAt?: number;
	toolsHash?: string;
}

export function rehydrate(records: readonly LedgerRecord[]): Rehydrated {
	let seq = 0;
	let toolsHash: string | undefined;
	for (const record of records) {
		seq = Math.max(seq, num(record.n) ?? 0);
		if (record.t === "tools" && typeof record.hash === "string") toolsHash = record.hash;
	}

	let useAt = -1;
	let held: number | undefined;
	for (const [index, record] of records.entries()) {
		if (record.t !== "use") continue;
		useAt = index;
		held = cachedPrefix(usageOf(record), held);
	}
	if (useAt < 0) return { seq, toolsHash };

	let refreshedAt: number | undefined;
	for (let index = useAt + 1; index < records.length; index++) {
		const record = records[index];
		if (record.t !== "warm") continue;
		const at = Date.parse(String(record.at));
		if (Number.isFinite(at)) refreshedAt = at;
	}

	const use = records[useAt];
	const n = num(use.n);
	let reqAt = -1;
	for (let index = useAt - 1; index >= 0; index--) {
		if (records[index].t === "req" && num(records[index].n) === n) {
			reqAt = index;
			break;
		}
	}
	if (n === undefined || reqAt < 0) return { seq, toolsHash, refreshedAt };

	const req = records[reqAt];
	const at = Date.parse(String(req.at));
	if (!Number.isFinite(at)) return { seq, toolsHash, refreshedAt };

	const sysChars = numbers(req.sysChars) ?? [];
	const unkeyed = new Set(numbers(req.unkeyed) ?? []);
	const system: BlockPrint[] = (strings(req.sys) ?? []).map((blockHash, index) => ({
		type: "?",
		chars: sysChars[index] ?? 0,
		hash: blockHash,
		...(unkeyed.has(index) ? { keyed: false as const } : {}),
	}));

	let roster: LedgerRecord | undefined;
	for (let index = reqAt; index >= 0; index--) {
		if (records[index].t === "tools" && records[index].hash === req.tools) {
			roster = records[index];
			break;
		}
	}
	const names = strings(roster?.names);
	const hashes = strings(roster?.hashes);
	const chars = numbers(roster?.chars) ?? [];
	const tools =
		names !== undefined && hashes !== undefined && names.length === hashes.length
			? names.map((name, index) => ({ name, chars: chars[index] ?? 0, hash: hashes[index] }))
			: undefined;

	return {
		seq,
		toolsHash,
		refreshedAt,
		settled: {
			seq: n,
			at,
			model: typeof req.model === "string" ? req.model : "?",
			ttlMin: num(req.ttlMin),
			print: { system, tools, reasoning: stringMap(req.rs) },
			usage: usageOf(use),
			held,
		},
	};
}
