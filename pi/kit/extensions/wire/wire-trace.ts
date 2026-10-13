import { appendFileSync, chmodSync, closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accounted, type CacheUsage, cachedPrefix, promptTokens } from "../../lib/cache/cache-usage.ts";
import { ensurePrivateDir } from "../../lib/process/kit-state-dir.ts";
import { type BreakReport, detailFor, type Inherited, prefixRetired, rewriteNotice, type RewriteNotice, verdictOf, type KnownCause } from "./cache-break.ts";
import type { QuotaReading } from "./quota-meter.ts";
import { type Anchor, pruneTraces, readLedgerTail, rehydrate, traceDir } from "./wire-trace-ledger.ts";
import { cachedSystemBlock, firstDivergence, wirePrint, type WirePrint } from "./wire-print.ts";

/** What the trace records about a request beyond its bytes. */
export interface RequestMeta {
	model: string;
	degraded: boolean;
	ttlMin?: number;
	cause?: KnownCause;
}

export interface WireTrace {
	readonly path: string;
	request(payload: unknown, meta: RequestMeta): number;
	usage(usage: CacheUsage, quota?: QuotaReading): BreakReport | undefined;
	response(status: number, requestId?: string): void;
	held(): number | undefined;
	warm(model: string): void;
	takeRewrite(): RewriteNotice | undefined;
}

interface Pending {
	seq: number;
	at: number;
	model: string;
	ttlMin?: number;
	cause?: KnownCause;
	print: WirePrint;
	payload?: unknown;
}

export function createWireTrace(sessionId: string, env: NodeJS.ProcessEnv = process.env): WireTrace {
	const full = env.PI_WIRE_TRACE === "full";
	const dir = traceDir(env);
	const path = join(dir, `${sessionId}.jsonl`);
	let live = true;
	let seq = 0;
	let pending: Pending | undefined;
	let settled: Anchor | undefined;
	let lastToolsHash: string | undefined;
	let refreshedAt: number | undefined;
	let inherited: Inherited | undefined;
	let rewrite: RewriteNotice | undefined;

	const write = (record: Record<string, unknown>): void => {
		appendFileSync(path, `${JSON.stringify({ at: new Date(Date.now()).toISOString(), ...record })}\n`, { mode: 0o600 });
	};

	try {
		ensurePrivateDir(dir);
		pruneTraces(dir);
		closeSync(openSync(path, "a", 0o600));
		chmodSync(path, 0o600);
		const prior = rehydrate(readLedgerTail(path));
		seq = prior.seq;
		settled = prior.settled;
		refreshedAt = prior.refreshedAt;
		lastToolsHash = prior.toolsHash;
		if (prior.settled !== undefined)
			inherited = { tools: prior.settled.print.tools, toolsHash: prior.toolsHash, prefix: prior.settled.held ?? 0 };
	} catch {
		live = false;
	}

	return {
		path,
		request(payload, meta) {
			if (!live) return 0;
			try {
				const print = wirePrint(payload);
				if (print === undefined) return 0;
				seq++;
				pending = { seq, at: Date.now(), model: meta.model, ttlMin: meta.ttlMin, cause: meta.cause, print, payload: full ? payload : undefined };
				if (inherited !== undefined) {
					rewrite = rewriteNotice(inherited, print);
					inherited = undefined;
				}
				if (print.toolsHash !== lastToolsHash) {
					write({
						t: "tools",
						n: seq,
						hash: print.toolsHash,
						names: print.tools.map((tool) => tool.name),
						hashes: print.tools.map((tool) => tool.hash),
						chars: print.tools.map((tool) => tool.chars),
					});
					lastToolsHash = print.toolsHash;
				}
				const unkeyed = print.system.flatMap((block, index) => (block.keyed === false ? [index] : []));
				write({
					t: "req",
					n: seq,
					model: meta.model,
					degraded: meta.degraded || undefined,
					ttlMin: meta.ttlMin,
					sys: print.system.map((block) => block.hash),
					sysChars: print.system.map((block) => block.chars),
					unkeyed: unkeyed.length > 0 ? unkeyed : undefined,
					tools: print.toolsHash,
					toolCount: print.tools.length,
					rs: print.reasoning,
					msgCount: print.messages.length,
					bp: print.breakpoints,
					bytes: print.bytes,
				});
				if (seq === 1) {
					const cached = cachedSystemBlock(payload);
					if (cached !== undefined) write({ t: "prompt", n: seq, hash: print.system[cached.index].hash, text: cached.text });
				}
				return seq;
			} catch {
				live = false;
				return 0;
			}
		},
		usage(usage, quota) {
			if (!live) return undefined;
			try {
				const current = pending;
				pending = undefined;
				if (current === undefined) return undefined;
				if (accounted(usage) === 0) {
					write({ t: "abort", n: current.seq });
					return undefined;
				}
				write({
					t: "use",
					n: current.seq,
					input: usage.input,
					read: usage.cacheRead,
					write: usage.cacheWrite,
					write1h: usage.cacheWrite1h,
					reasoning: usage.reasoning,
					quota,
				});

				const previous = settled;
				const refreshed = refreshedAt;
				settled = { ...current, usage, held: cachedPrefix(usage, previous?.held) };
				refreshedAt = undefined;
				const expected = previous?.held;
				if (previous === undefined || expected === undefined) return undefined;
				if (usage.cacheRead >= expected) return undefined;

				const sinceSec = Math.round((current.at - previous.at) / 1000);
				if (prefixRetired(usage, expected)) {
					write({
						t: "retire",
						n: current.seq,
						expected,
						read: usage.cacheRead,
						prompt: promptTokens(usage),
						sinceSec,
						prevSeq: previous.seq,
					});
					return undefined;
				}

				const divergence = firstDivergence(previous.print, current.print);
				const warmSec = Math.round((current.at - Math.max(previous.at, refreshed ?? 0)) / 1000);
				const ttlExpired = previous.ttlMin !== undefined && warmSec > previous.ttlMin * 60;
				const verdict = verdictOf(previous.print, current.print, divergence, ttlExpired, {
					model: previous.model,
					nextModel: current.model,
					thought: (previous.usage.reasoning ?? 0) > 0,
				}, current.cause);
				const report: BreakReport = {
					seq: current.seq,
					expected,
					read: usage.cacheRead,
					shortfall: expected - usage.cacheRead,
					sinceSec,
					ttlExpired,
					verdict,
					prompt: promptTokens(usage),
					divergence,
					detail: divergence && detailFor(previous.print, current.print, divergence),
					...(verdict === "reasoning" && previous.print.reasoning
						? { reasoning: { previous: previous.print.reasoning, next: current.print.reasoning } }
						: {}),
				};
				if (full && previous.payload !== undefined) {
					const dump = join(dir, `${sessionId}.break-${current.seq}.json`);
					writeFileSync(dump, JSON.stringify({ previous: previous.payload, next: current.payload }, null, 1), {
						mode: 0o600,
					});
					chmodSync(dump, 0o600);
					report.dump = dump;
				}
				write({ t: "break", n: current.seq, ...report, prevSeq: previous.seq });
				if (verdict === "thinking-turn") return undefined;
				return report;
			} catch {
				live = false;
				return undefined;
			}
		},
		held() {
			return settled?.held;
		},
		response(status, requestId) {
			if (!live) return;
			try {
				write({ t: "resp", ...(pending === undefined ? {} : { n: pending.seq }), status, ...(requestId === undefined ? {} : { id: requestId }) });
			} catch {
				live = false;
			}
		},
		takeRewrite() {
			const line = rewrite;
			rewrite = undefined;
			return line;
		},
		warm(model) {
			if (!live) return;
			try {
				write({ t: "warm", model });
				refreshedAt = Date.now();
			} catch {
				live = false;
			}
		},
	};
}
