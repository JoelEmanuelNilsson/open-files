/**
 * Why a cache read collapsed, recorded at the moment it collapses.
 *
 * The session store keeps the *outcome* of a break — `cacheRead`, `cacheWrite`,
 * `cacheWrite1h` — and no payload, so every past attribution was reverse
 * engineered from token arithmetic days later, and the first answer was wrong
 * three times running (issues 13, 20, 21). The cause is knowable for free while
 * the request is still in hand: Anthropic keys the prompt cache
 * `tools -> system -> messages` and reads the longest matching prefix, so the
 * *earliest* section whose bytes differ from the previous request is the
 * culprit, and nothing later can be.
 *
 * So this module holds one request's fingerprint in memory, diffs the next one
 * against it, and writes the classification — not the conversation. Content
 * never reaches disk unless `PI_WIRE_TRACE=full` is set, and then only for the
 * two payloads that straddle a break — with one exception: the cached system
 * block's text, once per session, on the first request. Two sessions that were
 * meant to share a tools+system entry and did not can then be diffed from
 * their ledgers instead of being reasoned about from hashes.
 *
 * Three facts make the diff decisive rather than suggestive:
 *
 *   - **Appending is not a change.** A tool loop appends messages every turn
 *     and the cache is fine with it. Only a divergence inside the *common
 *     prefix* can kill a read, so an all-append diff paired with a collapsed
 *     read proves the loss is not in our bytes.
 *   - **Thinking blocks are split.** The text and its signature are hashed
 *     apart, because the models summarise extended thinking: a re-summarised
 *     block moves the text while the signature holds, and that is a different
 *     defect from anything the harness could cause.
 *   - **The expected read is arithmetic, not a threshold.** After a request
 *     settles the provider holds exactly `cacheRead + cacheWrite` tokens of
 *     prefix. The next request in the same session should read that number
 *     back. Anything less is a break, and the shortfall is its size. Measured
 *     live across four sessions and 59 consecutive request pairs it held
 *     exactly 58 times; the one exception was a break.
 *   - **A response that accounts for nothing never happened.** Press escape
 *     mid-stream and pi still emits `message_end`, carrying a usage object
 *     zeroed in every field. Read literally that says "the whole prefix was
 *     re-billed at a cache read of zero", which is the loudest possible way to
 *     report an event that cost nothing at all (issue 22). Every real response
 *     accounts for the prompt across `input + cacheRead + cacheWrite`, so a
 *     total of zero is the signature of no response, and the pair is dropped
 *     rather than judged.
 *
 *   - **A prefix the request was too small to have re-sent was retired, not
 *     broken.** A handoff replaces `messages[0]` and the conversation gets
 *     shorter; the old prefix is abandoned, never sent again, and never paid
 *     for twice. Comparing the request's own prompt size against the prefix
 *     separates the two with no special case for handoff, compaction or trim
 *     ({@link prefixRetired}) — recorded as `retire`, and nobody is notified,
 *     because nothing went wrong.
 *
 *   - **The reasoning fields are part of the key.** `thinking` and
 *     `output_config` sit outside tools, system and messages, but Anthropic keys
 *     the conversation tier on them: an effort switch mid-session keeps the
 *     tools+system read and rewrites every message (Fable 5.1, measured
 *     2026-09-09: read 6,266 of 75,329 after minimal→medium, then the reverse
 *     three requests later). A print that ignored them called both switches a
 *     vendor fault. They are hashed as a fourth section, checked between system
 *     and messages because that is where the loss begins.
 *
 *   - **Haiku 4.5 misses the tier after a turn it thought on.** Across 2,221
 *     ledgers, the request following a Haiku 4.5 turn with `reasoning > 0`
 *     failed to read the tier that turn wrote 96 times in 103; every other
 *     model, budget-thinking Opus 4.5 and Sonnet 4.5 included, sits at or under
 *     0.3%. Nothing of ours moves, the TTL is not near, and the cost is a few
 *     thousand tokens at Haiku prices on nearly every sub-agent's second
 *     request. It is recorded as `thinking-turn` and nobody is notified: a
 *     warning that fires on every explore spawn is noise, and the classifier
 *     exists to make the rare break visible, not to bury it.
 *
 * Which makes every *break* exactly one of a handful of things, and the record
 * says which: the window expired (the gap outran the TTL the payload asked for),
 * our bytes moved (a divergence, with the section and index), our reasoning
 * fields moved (an effort switch), a known per-model quirk fired, or none of
 * these — the provider dropped a prefix it had told us it was holding. Only the
 * last is a vendor fault, and only this instrument can tell it from the rest.
 *
 * Sink: `$XDG_STATE_HOME/pi-kit/wire-trace` (`~/.local/state/...` by default),
 * directory `0700`, files `0600`, pruned after a week. Not `/tmp`, which is
 * world-readable and where the previous generation of hand-rolled probes left
 * whole conversations lying at mode 644 (issue 18).
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accounted } from "./cache-window.ts";
import { ATTRIBUTION_PREFIX } from "./claude-code.ts";
import { REASONING_FIELDS } from "./warm-prefix.ts";
import type { PingResult } from "./ping.ts";
import type { QuotaReading } from "./quota-meter.ts";
import { ensurePrivateDir, pruneOlderThan, stateDir } from "./state-dir.ts";

/**
 * The bytes of a block, with `cache_control` taken out.
 *
 * A breakpoint is a marker on content, not content, and pi moves the message
 * breakpoint onto the newest user turn every single request. Hashing it would
 * report two changed messages per turn forever and the classifier would be
 * noise. Breakpoint positions are recorded on their own, where a move reads as
 * a move.
 */
const contentOf = (value: unknown): string =>
	JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)) ?? "\u0000undefined";

/** Truncated sha256. 32 bits of hash over a set of at most a few hundred blocks. */
const hash = (value: unknown): string =>
	createHash("sha256")
		.update(typeof value === "string" ? value : contentOf(value))
		.digest("hex")
		.slice(0, 8);

/** One content block, as much of it as can be recorded without recording it. */
export interface BlockPrint {
	type: string;
	chars: number;
	hash: string;
	/**
	 * False for the attribution block, which Anthropic's edge strips before both
	 * inference and the cache key (ticket 16's four-request table). It carries a
	 * per-request id, so it changes on every single request by design: hash it,
	 * record it, never blame it. Without this the classifier would answer
	 * "system[0]" to every question ever asked of it.
	 */
	keyed?: false;
	/**
	 * Thinking blocks only, hashed apart from the block as a whole. A provider
	 * that re-summarises its own reasoning moves `thinking` and leaves
	 * `signature` alone; a harness that mangles the round-trip usually does the
	 * opposite. One field tells the two apart.
	 */
	thinking?: { chars: number; hash: string };
	signature?: { chars: number; hash: string };
}

export interface MessagePrint {
	role: string;
	hash: string;
	blocks: BlockPrint[];
}

export interface ToolPrint {
	name: string;
	chars: number;
	hash: string;
}

/**
 * The reasoning fields as scalar leaves, e.g. `{ "thinking.type": "adaptive",
 * "output_config.effort": "medium" }`. Kept as values, not a hash, because the
 * break notice has to say what moved (`effort low → medium`), and the values are
 * configuration rather than content — nothing here is worth hiding.
 */
export type ReasoningPrint = Record<string, string>;

/** Everything about a request that can decide a cache question, and nothing else. */
export interface WirePrint {
	system: BlockPrint[];
	tools: ToolPrint[];
	/** One hash over the whole tools array — the thing the cache key actually sees. */
	toolsHash: string;
	reasoning: ReasoningPrint;
	messages: MessagePrint[];
	/** Where `cache_control` sits, e.g. `tools[17]`, `system[2]`, `messages[62]/1`. */
	breakpoints: string[];
	/** Serialized size of the payload, for scale on every record. */
	bytes: number;
}

/**
 * A previous request's print as far as it is knowable.
 *
 * Every {@link WirePrint} is one. The rehydrated kind is not: the ledger keeps
 * hashes for the system blocks and, since the roster record, for the tools, but
 * it never keeps message prints. An absent section means **cannot compare**,
 * never *unchanged* — a comparator that read absence as agreement would report
 * that the provider dropped a prefix on evidence it does not have.
 */
export interface PriorPrint {
	system: readonly BlockPrint[];
	tools?: readonly ToolPrint[];
	reasoning?: ReasoningPrint;
	messages?: readonly MessagePrint[];
}

export type WireSection = "tools" | "system" | "messages";

/**
 * Models known to miss the tier written by a turn they thought on, on the very
 * next request. A measurement (see the module comment), not a hunch; a model
 * joins this set with its numbers.
 */
const THINKING_TURN_MISS: ReadonlySet<string> = new Set(["claude-haiku-4-5"]);

export interface Divergence {
	section: WireSection;
	/** Index of the first differing entry within that section. */
	index: number;
	kind: "changed" | "added" | "removed";
}

export interface CacheUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function blockPrint(block: unknown): BlockPrint {
	if (!isRecord(block)) return { type: typeof block, chars: 0, hash: hash(block) };
	const type = typeof block.type === "string" ? block.type : "?";
	const print: BlockPrint = { type, chars: contentOf(block).length, hash: hash(block) };
	if (typeof block.text === "string" && block.text.startsWith(ATTRIBUTION_PREFIX)) print.keyed = false;
	if (type === "thinking" || type === "redacted_thinking") {
		const thinking = str(block.thinking ?? block.data);
		const signature = str(block.signature ?? block.data);
		print.thinking = { chars: thinking.length, hash: hash(thinking) };
		print.signature = { chars: signature.length, hash: hash(signature) };
	}
	return print;
}

function blocksOf(content: unknown): unknown[] {
	if (Array.isArray(content)) return content;
	if (content === undefined) return [];
	return [content];
}

function hasBreakpoint(value: unknown): boolean {
	return isRecord(value) && isRecord(value.cache_control);
}

/** Every scalar leaf under the reasoning fields, keyed by its dotted path. */
function reasoningPrint(payload: Record<string, unknown>): ReasoningPrint {
	const leaves: ReasoningPrint = {};
	const walk = (path: string, value: unknown): void => {
		if (isRecord(value)) {
			for (const key of Object.keys(value).sort()) walk(`${path}.${key}`, value[key]);
			return;
		}
		if (value !== undefined) leaves[path] = JSON.stringify(value);
	};
	for (const field of [...REASONING_FIELDS].sort()) if (payload[field] !== undefined) walk(field, payload[field]);
	return leaves;
}

const sameReasoning = (previous: ReasoningPrint, next: ReasoningPrint): boolean =>
	JSON.stringify(Object.entries(previous).sort()) === JSON.stringify(Object.entries(next).sort());

/** `effort "low" → "medium"` for every leaf that differs; an added or removed leaf shows as `none`. */
function reasoningMoves(previous: ReasoningPrint, next: ReasoningPrint): string {
	const keys = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
	return keys
		.filter((key) => previous[key] !== next[key])
		.map((key) => `${key.slice(key.lastIndexOf(".") + 1)} ${previous[key] ?? "none"} → ${next[key] ?? "none"}`)
		.join(", ");
}

/**
 * Fingerprint an Anthropic messages payload. Returns undefined for anything
 * that is not one — the trace covers the wire this harness owns and says so
 * rather than guessing at another provider's shape.
 */
export function wirePrint(payload: unknown): WirePrint | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;

	const breakpoints: string[] = [];

	const systemBlocks = Array.isArray(payload.system) ? payload.system : [];
	const system = systemBlocks.map((block, index) => {
		if (hasBreakpoint(block)) breakpoints.push(`system[${index}]`);
		return blockPrint(block);
	});

	const toolList = Array.isArray(payload.tools) ? payload.tools : [];
	const tools = toolList.map((tool, index) => {
		if (hasBreakpoint(tool)) breakpoints.push(`tools[${index}]`);
		const json = contentOf(tool);
		return {
			name: isRecord(tool) && typeof tool.name === "string" ? tool.name : "?",
			chars: json.length,
			hash: hash(json),
		};
	});

	const messages = payload.messages.map((message, index) => {
		const record = isRecord(message) ? message : {};
		const blocks = blocksOf(record.content);
		blocks.forEach((block, blockIndex) => {
			if (hasBreakpoint(block)) breakpoints.push(`messages[${index}]/${blockIndex}`);
		});
		return {
			role: typeof record.role === "string" ? record.role : "?",
			hash: hash(message),
			blocks: blocks.map(blockPrint),
		};
	});

	return {
		system,
		tools,
		toolsHash: hash(tools.map((tool) => tool.hash).join(",")),
		reasoning: reasoningPrint(payload),
		messages,
		breakpoints,
		bytes: (JSON.stringify(payload) ?? "").length,
	};
}

function firstIn<T extends { hash: string; keyed?: false }>(
	previous: readonly T[],
	next: readonly T[],
	section: WireSection,
	appendIsFree: boolean,
): Divergence | undefined {
	const common = Math.min(previous.length, next.length);
	for (let index = 0; index < common; index++) {
		if (previous[index].keyed === false || next[index].keyed === false) continue;
		if (previous[index].hash !== next[index].hash) return { section, index, kind: "changed" };
	}
	if (next.length < previous.length) return { section, index: next.length, kind: "removed" };
	if (next.length > previous.length && !appendIsFree) return { section, index: previous.length, kind: "added" };
	return undefined;
}

/**
 * The first section whose bytes moved, in the order Anthropic keys the cache.
 * Undefined means the new request extends the old one without rewriting any of
 * it — the only shape a healthy tool loop ever has.
 *
 * Appending messages is free and reported as no divergence; appending a *system*
 * block is not, because everything behind it shifts. Removal is always a
 * divergence, whichever section it happens in: it is what a trim or a compaction
 * looks like from here.
 *
 * A section the previous print does not carry is skipped rather than blamed, so
 * a comparator rebuilt from the ledger can still name a tools or system move and
 * stays silent about the messages it never saw.
 */
export function firstDivergence(previous: PriorPrint, next: WirePrint): Divergence | undefined {
	return (
		(previous.tools && firstIn(previous.tools, next.tools, "tools", false)) ??
		firstIn(previous.system, next.system, "system", false) ??
		(previous.messages && firstIn(previous.messages, next.messages, "messages", true)) ??
		undefined
	);
}

/**
 * What caused a break, as a value rather than as prose.
 *
 * `unknown` is a first-class answer and the reason the other six can be
 * trusted: a comparison that could not see every section says so instead of
 * naming the most likely-looking cause.
 */
export type BreakVerdict = "reorder" | "edit" | "added" | "removed" | "reasoning" | "expired" | "thinking-turn" | "dropped" | "unknown";

/** Which of the four kinds a tools move was, read off the two rosters. */
function toolsVerdict(previous: readonly ToolPrint[], next: readonly ToolPrint[]): BreakVerdict {
	const before = previous.map((tool) => tool.name);
	const after = next.map((tool) => tool.name);
	if (before.some((name) => !after.includes(name))) return "removed";
	if (after.some((name) => !before.includes(name))) return "added";
	if (before.join("\u0000") !== after.join("\u0000")) return "reorder";
	return "edit";
}

/** What the previous request was, beyond its bytes: who answered it and whether it thought. */
interface PriorTurn {
	model: string;
	thought: boolean;
}

function verdictOf(previous: PriorPrint, next: WirePrint, divergence: Divergence | undefined, ttlExpired: boolean, turn: PriorTurn): BreakVerdict {
	if (divergence?.section === "tools" && previous.tools !== undefined) return toolsVerdict(previous.tools, next.tools);
	if (divergence !== undefined && divergence.section !== "messages") return divergence.kind === "changed" ? "edit" : divergence.kind;
	// Between system and messages: a reasoning change keeps the prefix (on the
	// models measured so far) and rewrites the conversation from messages[0], so
	// it precedes any edit further in.
	if (previous.reasoning !== undefined && !sameReasoning(previous.reasoning, next.reasoning)) return "reasoning";
	if (divergence !== undefined) return divergence.kind === "changed" ? "edit" : divergence.kind;
	if (ttlExpired) return "expired";
	// Only a comparison that saw every section may call the loss the provider's.
	if (previous.tools === undefined || previous.messages === undefined) return "unknown";
	if (turn.thought && THINKING_TURN_MISS.has(turn.model)) return "thinking-turn";
	return "dropped";
}

/** Tokens of prefix the provider is known to hold once a request has settled. */
export const cachedPrefix = (usage: CacheUsage): number => usage.cacheRead + usage.cacheWrite;

/**
 * Tokens of prompt this request actually put on the wire.
 *
 * Every prompt token a response is billed for lands in exactly one of three
 * buckets — read from cache, written to cache, or neither — so the three sum to
 * the whole prompt and nothing is counted twice. `cacheWrite1h` is deliberately
 * absent: pi-ai defines it as the *subset* of `cacheWrite` written with 1h
 * retention, so adding it would count those tokens twice.
 */
export const promptTokens = (usage: CacheUsage): number => usage.input + usage.cacheRead + usage.cacheWrite;

/**
 * Whether a short read means the prefix was **retired** rather than broken.
 *
 * A break costs money: the provider dropped a prefix we sent again, so we paid
 * full price for bytes it had been holding. A retirement costs nothing: the
 * conversation got *shorter* — a handoff, a compaction, a trim — and the old
 * prefix was simply abandoned. The arithmetic separates them with no special
 * case for any of those three, because it asks the only question that decides
 * it: could this request have re-sent that prefix at all? A request whose whole
 * prompt is smaller than the prefix could not have, so nothing was re-billed.
 *
 * The generalization matters more than the handoff it was written for (ticket
 * 06): every future shrink path gets the right word for free, and no shrink
 * path has to remember to register itself here.
 */
export const prefixRetired = (usage: CacheUsage, expected: number): boolean => promptTokens(usage) < expected;

export interface BreakReport {
	seq: number;
	/** What the next read should have been: the prefix the provider already held. */
	expected: number;
	read: number;
	/** `expected - read`: the tokens that had to be paid for a second time. */
	shortfall: number;
	/** Seconds since the request that wrote the prefix this one failed to read. */
	sinceSec: number;
	/** The gap outran the retention the previous payload asked for. Not a defect. */
	ttlExpired: boolean;
	/** The cause, as something `/trace` and any future counter can branch on. */
	verdict: BreakVerdict;
	/** Undefined when nothing in the common prefix moved — then the loss is not ours. */
	divergence?: Divergence;
	/** The reasoning fields on both sides, when the verdict is `reasoning`. */
	reasoning?: { previous: ReasoningPrint; next: ReasoningPrint };
	/** Block-level before/after for the one entry that changed, when there is one. */
	detail?: { previous: BlockPrint[] | ToolPrint[]; next: BlockPrint[] | ToolPrint[] };
	/** Path of the full-fidelity payload pair, when `PI_WIRE_TRACE=full`. */
	dump?: string;
}

/** One line for a human, for the notice and for `/trace`. The verdict leads; the prose is its tail. */
export function describeBreak(report: BreakReport): string {
	const where =
		report.verdict === "reasoning" && report.reasoning
			? `${reasoningMoves(report.reasoning.previous, report.reasoning.next)} rewrote the conversation tier`
			: report.divergence
				? `${report.divergence.section}[${report.divergence.index}] ${report.divergence.kind}`
				: report.verdict === "expired"
					? `window expired after ${report.sinceSec}s`
					: report.verdict === "thinking-turn"
						? "the model missed the tier written by a turn it thought on — a known per-model quirk, not notified"
						: report.verdict === "dropped"
							? `nothing of ours changed in ${report.sinceSec}s — the provider dropped it`
							: `no cause after ${report.sinceSec}s — the ledger cannot compare every section`;
	return `cache break: ${report.verdict} — ${where}, ${report.shortfall.toLocaleString()} tokens re-billed (read ${report.read.toLocaleString()} of ${report.expected.toLocaleString()})`;
}

/** The prefix a reload inherited: what the provider holds, and the roster it was written with. */
interface Inherited {
	tools?: readonly ToolPrint[];
	/** The newest roster's hash, so a block move is still knowable when the roster's names are not. */
	toolsHash?: string;
	/** Tokens the provider is holding, which is what a rewrite spends again. */
	prefix: number;
}

/** Which tools moved between two rosters, in the words the warning prints. */
function toolMoves(previous: readonly ToolPrint[], next: readonly ToolPrint[]): string[] {
	const before = new Map(previous.map((tool) => [tool.name, tool.hash]));
	const after = new Map(next.map((tool) => [tool.name, tool.hash]));
	const moves = [
		...next.filter((tool) => !before.has(tool.name)).map((tool) => `${tool.name} added`),
		...previous.filter((tool) => !after.has(tool.name)).map((tool) => `${tool.name} removed`),
		...next.filter((tool) => before.has(tool.name) && before.get(tool.name) !== tool.hash).map((tool) => `${tool.name} edited`),
	];
	const sameSet = previous.length === next.length && previous.every((tool) => after.has(tool.name));
	const names = (roster: readonly ToolPrint[]) => roster.map((tool) => tool.name).join("\u0000");
	if (sameSet && names(previous) !== names(next)) moves.push("the same tools in a new order");
	return moves;
}

/**
 * One sentence for the first request after a reload, when that request rewrites
 * the tools block the provider was still holding.
 *
 * Undefined when nothing moved and undefined when the ledger cannot tell:
 * a sentence that guesses at a cause is what ticket 45 was written about, so
 * an unnamed roster prints the move and no cause rather than a likely-looking
 * one.
 */
function rewriteNotice(inherited: Inherited, print: WirePrint): string | undefined {
	const cost = inherited.prefix > 0 ? ` ${inherited.prefix.toLocaleString()} tokens of cached prefix are being written again.` : "";
	if (inherited.tools === undefined) {
		if (inherited.toolsHash === undefined || inherited.toolsHash === print.toolsHash) return undefined;
		return `reload rewrote the tools block; the ledger holds no roster for the prefix it inherited, so which tool changed cannot be named.${cost}`;
	}
	const moves = toolMoves(inherited.tools, print.tools);
	if (moves.length === 0) return undefined;
	return `reload rewrote the tools block: ${moves.join(", ")}.${cost}`;
}

// --- the sink ---------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where traces live. Not `/tmp`: these are hashes today, and full payloads the
 * moment someone sets `PI_WIRE_TRACE=full`, so the directory has to be private
 * before anything is written to it rather than after someone notices.
 */
export function traceDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	if (env.PI_WIRE_TRACE_DIR) return env.PI_WIRE_TRACE_DIR;
	return join(stateDir(env, home), "wire-trace");
}

/** Drop traces older than a week. A forensic log nobody reads is just residue. */
export function pruneTraces(dir: string, now = Date.now()): number {
	return pruneOlderThan(dir, WEEK_MS, now);
}

/** What the trace records about a request beyond its bytes. */
export interface RequestMeta {
	model: string;
	/** Whether this session's prompt is the owned one or pi's fallback. */
	degraded: boolean;
	/** Minutes of retention the payload actually asked for; undefined writes no cache. */
	ttlMin?: number;
	/** Seconds of warmth the status bar was still promising as this went out. */
	warmForSec?: number;
}

/**
 * What a keep-warm ping did, as the trace records it: the ping's own result,
 * plus which request it replayed.
 *
 * The result is carried whole rather than copied field by field, because the
 * fields that matter are the ones nobody thought to copy. A ping reports
 * `read` and `write` off `message_start`, and those two numbers are the only
 * same-day evidence that a replay is still a replay — see {@link WireTrace.ping}.
 */
export type PingMeta = PingResult & {
	/**
	 * The sequence number of the request this ping replayed — supplied by the
	 * caller, not read off the live counter. A ping runs concurrently with real
	 * requests by design, so "the newest request" and "the request being
	 * replayed" are routinely different, and guessing would file the record
	 * against a request the ping never sent.
	 */
	n: number;
};

export interface WireTrace {
	readonly path: string;
	/**
	 * Fingerprint an outgoing request, and return its sequence number in this
	 * trace — `0` when there was nothing to record. Never throws; never touches
	 * the payload.
	 */
	request(payload: unknown, meta: RequestMeta): number;
	/**
	 * Pair a settled response with the request before it, and classify a break.
	 *
	 * `quota` is what that same response said about the subscription
	 * (`lib/quota-meter.ts`), recorded beside the token counts because the pair is
	 * the whole measurement: tokens are what we spent, utilization is what it cost
	 * the allowance, and the ratio between them is the only way to learn the
	 * server's undocumented weights (ticket 01). Undefined when the response
	 * carried no quota headers — nothing is filed rather than a stale reading
	 * attributed to a request that never saw it.
	 */
	usage(usage: CacheUsage, quota?: QuotaReading): BreakReport | undefined;
	/**
	 * The HTTP status the provider answered the request in flight with, and the
	 * request id it answered under.
	 *
	 * Recorded because the absence of a record is not one. A request that never
	 * settles writes a `req` line and then nothing, which reads exactly like a
	 * turn the human cancelled — on 2026-09-21 the two had to be told apart by
	 * the mtime of a ledger file. A `resp` line makes "it answered 529 and pi
	 * retried" and "nothing ever came back" different lines in the same log.
	 *
	 * Filed against the pending request without consuming it: the status arrives
	 * before the usage does, and every retry of one turn answers separately.
	 */
	response(status: number, requestId?: string): void;
	/**
	 * The prefix the provider holds for this conversation as of the last settled
	 * response: what the next request should read back whole. Undefined before
	 * the first response — a request with nothing to compare against.
	 */
	held(): number | undefined;
	/**
	 * Record an out-of-band ping against the request whose payload it replayed.
	 *
	 * A ping skips every hook, so without its own record the trace would show a
	 * gap the size of the ping interval and no reason the cache survived it.
	 *
	 * A successful ping is also a measurement, and the record says so: `miss` is
	 * written whenever the ping *wrote* cache instead of reading it. That is a
	 * break — the replay did not match the entry it was replaying — and it is the
	 * one break this harness can see the same day it happens rather than
	 * reconstructing it from a bill.
	 */
	ping(meta: PingMeta): void;
	/** File one free-form record, for facts no other line carries: the ledger inputs at the first request. */
	note(record: Record<string, unknown>): void;
	/**
	 * The warning the last {@link WireTrace.request} earned, once.
	 *
	 * Only ever set on the first request after a reload, and only when that
	 * request's tools block differs from the one the inherited prefix was written
	 * with — the one moment the harness can say *this is about to cost you* while
	 * it is still true.
	 */
	takeRewrite(): string | undefined;
}

interface Pending {
	seq: number;
	at: number;
	model: string;
	/** Retention the payload asked for, in minutes; undefined writes no cache. */
	ttlMin?: number;
	print: WirePrint;
	payload?: unknown;
}

/**
 * The prefix the provider is believed to hold: what wrote it, when, and how big
 * it came back. Built from the last settled request, or rebuilt from the ledger
 * after a reload — which is why its print is a {@link PriorPrint}.
 */
interface Anchor {
	seq: number;
	at: number;
	model: string;
	ttlMin?: number;
	print: PriorPrint;
	usage: CacheUsage;
	payload?: unknown;
}

/** Bytes of ledger read back at open. A few hundred records, far more than the tail needs. */
const TAIL_BYTES = 64 * 1024;

type LedgerRecord = Record<string, unknown>;

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
const numbers = (value: unknown): number[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "number") ? (value as number[]) : undefined;
const stringMap = (value: unknown): ReasoningPrint | undefined =>
	isRecord(value) && Object.values(value).every((item) => typeof item === "string") ? (value as ReasoningPrint) : undefined;

/**
 * The tail of a JSONL ledger, oldest first.
 *
 * Bounded because a long session's file is megabytes and this runs on the path
 * that builds a request. The first line after a mid-file start is dropped: it is
 * half a record. A line that will not parse is skipped rather than fatal — the
 * writer appends from a hot path and a torn last line is an ordinary state.
 */
function readLedgerTail(path: string, maxBytes = TAIL_BYTES): LedgerRecord[] {
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

/**
 * What keeping this session's prefix warm has cost, read back off its own ledger.
 *
 * The chain's whole justification is a trade — cache reads spent against
 * rewrites avoided — and ticket 33 could only price it in theory. This prices it
 * on this seat, from records that already exist. Rendered only where it was
 * asked for (`/trace`), never in the chrome (C15).
 */
export function warmthBill(path: string): { pings: number; read: number; misses: number; rebilled: number } {
	const bill = { pings: 0, read: 0, misses: 0, rebilled: 0 };
	try {
		// Every ping counts, so the whole file rather than its tail.
		for (const record of readLedgerTail(path, Number.POSITIVE_INFINITY)) {
			if (record.t === "ping" && record.ok === true) {
				bill.pings++;
				bill.read += num(record.read) ?? 0;
				if ((num(record.write) ?? 0) > 0) bill.misses++;
			}
			if (record.t === "break") bill.rebilled += num(record.shortfall) ?? 0;
		}
	} catch {
		// A ledger that cannot be read has no bill to report; the caller says so.
	}
	return bill;
}

interface Rehydrated {
	/** The highest sequence the file has seen, so a reloaded session counts on. */
	seq: number;
	settled?: Anchor;
	refreshedAt?: number;
	/** The newest roster's hash, so an unchanged tools array is not re-recorded. */
	toolsHash?: string;
}

/**
 * Rebuild the comparator from the session's own ledger.
 *
 * The trace file is keyed on the session id, and a fork gets a new id, so
 * "never rehydrate somebody else's prefix" is true by construction rather than
 * by a check. What is rebuilt is only what the file holds: system hashes always,
 * the tools roster since that record existed, message prints never.
 */
function rehydrate(records: readonly LedgerRecord[]): Rehydrated {
	let seq = 0;
	let toolsHash: string | undefined;
	for (const record of records) {
		seq = Math.max(seq, num(record.n) ?? 0);
		if (record.t === "tools" && typeof record.hash === "string") toolsHash = record.hash;
	}

	let useAt = -1;
	for (let index = records.length - 1; index >= 0; index--) {
		if (records[index].t === "use") {
			useAt = index;
			break;
		}
	}
	if (useAt < 0) return { seq, toolsHash };

	let refreshedAt: number | undefined;
	for (let index = useAt + 1; index < records.length; index++) {
		const record = records[index];
		if (record.t !== "ping" || record.ok !== true) continue;
		// A ping that wrote replaced the entry: its identity and its size are no
		// longer the ones this file recorded, so there is nothing honest to compare.
		if ((num(record.write) ?? 0) > 0) return { seq, toolsHash };
		const at = Date.parse(String(record.at));
		if (Number.isFinite(at)) refreshedAt = at;
	}

	const use = records[useAt];
	const n = num(use.n);
	// Searched backwards: a file written before sequences continued across a reload
	// restarts at n=1, so the same n can appear twice and only the newer one is ours.
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
		// The type is not recorded; nothing compares it, and inventing one would lie.
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
			// An older ledger has no `rs`; absent means cannot compare, never unchanged.
			print: { system, tools, reasoning: stringMap(req.rs) },
			usage: {
				input: num(use.input) ?? 0,
				cacheRead: num(use.read) ?? 0,
				cacheWrite: num(use.write) ?? 0,
				cacheWrite1h: num(use.write1h),
				reasoning: num(use.reasoning),
			},
		},
	};
}

/**
 * Open this session's trace.
 *
 * Total by construction: every entry point swallows its own failure and the
 * trace disables itself on the first one. It runs inside `wire`'s
 * `before_provider_request`, whose *return value is the request*, and pi drops
 * that return value if the handler throws (`runner.js:794`) — so a recorder
 * that can throw is a recorder that can strip the owned prompt off the wire and
 * break the very cache it exists to watch. It cannot, and that is the point.
 */
export function createWireTrace(sessionId: string, env: NodeJS.ProcessEnv = process.env): WireTrace {
	const full = env.PI_WIRE_TRACE === "full";
	const dir = traceDir(env);
	const path = join(dir, `${sessionId}.jsonl`);
	let live = true;
	let seq = 0;
	let pending: Pending | undefined;
	let settled: Anchor | undefined;
	/** The newest tools array recorded, so the roster is written per change, not per request. */
	let lastToolsHash: string | undefined;
	/**
	 * When a ping last re-read the entry, restarting the provider's clock. The
	 * expiry test measures from here, because a refresh the trace recorded itself
	 * must not be reported as our own window running out.
	 */
	let refreshedAt: number | undefined;
	/** The prefix carried over a reload, held until the first request has been compared against it. */
	let inherited: Inherited | undefined;
	let rewrite: string | undefined;

	// Through `Date.now`, not `new Date()`: a reload parses this field back into
	// the anchor it compares against `Date.now()`, and two clocks for one instant
	// is the fault this whole area is being cured of.
	const write = (record: Record<string, unknown>): void => {
		appendFileSync(path, `${JSON.stringify({ at: new Date(Date.now()).toISOString(), ...record })}\n`, { mode: 0o600 });
	};

	try {
		ensurePrivateDir(dir);
		pruneTraces(dir);
		// `openSync` with a mode only applies it on creation; chmod makes an
		// existing file from an earlier umask private too.
		closeSync(openSync(path, "a", 0o600));
		chmodSync(path, 0o600);
		// A reload replaces this instance while the seat, the conversation and the
		// provider's entry go on, so the request most likely to have paid was the one
		// nobody measured (issues/43, 45). The ledger outlives the instance; read it.
		const prior = rehydrate(readLedgerTail(path));
		seq = prior.seq;
		settled = prior.settled;
		refreshedAt = prior.refreshedAt;
		lastToolsHash = prior.toolsHash;
		if (prior.settled !== undefined)
			inherited = { tools: prior.settled.print.tools, toolsHash: prior.toolsHash, prefix: cachedPrefix(prior.settled.usage) };
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
				pending = { seq, at: Date.now(), model: meta.model, ttlMin: meta.ttlMin, print, payload: full ? payload : undefined };
				if (inherited !== undefined) {
					rewrite = rewriteNotice(inherited, print);
					inherited = undefined;
				}
				// One roster per distinct tools array, not per request: without the
				// per-tool names and hashes a permutation and a one-byte description edit
				// are the same observation, and the classifier can only say "tools moved".
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
					warmForSec: meta.warmForSec,
					sys: print.system.map((block) => block.hash),
					sysChars: print.system.map((block) => block.chars),
					// Which system blocks the edge strips before the cache key. Recorded
					// because a comparator rebuilt without it would blame the attribution
					// block, which changes by design on every single request.
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
				// An abort settles nothing. Record that the request ended and leave the
				// anchor on the last response that actually happened, so the next
				// request is still measured against a prefix the provider really holds.
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
				settled = { ...current, usage };
				refreshedAt = undefined;
				if (previous === undefined) return undefined;

				const expected = cachedPrefix(previous.usage);
				if (usage.cacheRead >= expected) return undefined;

				const sinceSec = Math.round((current.at - previous.at) / 1000);
				// The conversation shrank below the prefix it used to ride on: recorded,
				// because a prefix going cold is worth knowing, and not returned, because
				// a report is a notification and nothing went wrong.
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
				// The clock starts when the request that wrote the entry *begins* (see
				// lib/cache-window.ts), and a successful ping restarts it — which this
				// module knows, because it wrote the ping record itself. Measuring from
				// the request alone dressed every pinged seat's vendor fault as our own
				// expiry, and every seat pings.
				const warmSec = Math.round((current.at - Math.max(previous.at, refreshed ?? 0)) / 1000);
				const ttlExpired = previous.ttlMin !== undefined && warmSec > previous.ttlMin * 60;
				const verdict = verdictOf(previous.print, current.print, divergence, ttlExpired, {
					model: previous.model,
					thought: (previous.usage.reasoning ?? 0) > 0,
				});
				const report: BreakReport = {
					seq: current.seq,
					expected,
					read: usage.cacheRead,
					shortfall: expected - usage.cacheRead,
					sinceSec,
					ttlExpired,
					verdict,
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
				// Recorded for `/trace`, returned to nobody: a quirk that fires on nearly
				// every sub-agent's second request is a fact about the model, not news.
				if (verdict === "thinking-turn") return undefined;
				return report;
			} catch {
				live = false;
				return undefined;
			}
		},
		held() {
			return settled === undefined ? undefined : cachedPrefix(settled.usage);
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
		note(record) {
			if (!live) return;
			try {
				write(record);
			} catch {
				live = false;
			}
		},
		ping(meta) {
			if (!live) return;
			try {
				write({ t: "ping", ...meta, ...(meta.ok && meta.write > 0 ? { miss: true } : {}) });
				if (!meta.ok) return;
				if (meta.write === 0) {
					refreshedAt = Date.now();
					return;
				}
				// The replay wrote a new entry, so the identity and the size we hold are
				// not what the provider holds. Better no comparison than one against a
				// prefix that is gone: a break report with an `expected` nobody ever had.
				settled = undefined;
				refreshedAt = undefined;
			} catch {
				live = false;
			}
		},
	};
}

/** The last system block carrying a breakpoint — the text every request of this session must repeat byte for byte. */
function cachedSystemBlock(payload: unknown): { index: number; text: string } | undefined {
	const system = isRecord(payload) && Array.isArray(payload.system) ? payload.system : [];
	for (let index = system.length - 1; index >= 0; index--) {
		const block = system[index];
		if (hasBreakpoint(block) && isRecord(block) && typeof block.text === "string") return { index, text: block.text };
	}
	return undefined;
}

/** The blocks on both sides of the one entry that moved. Types and sizes, never text. */
function detailFor(previous: PriorPrint, next: WirePrint, divergence: Divergence): BreakReport["detail"] {
	const { section, index } = divergence;
	if (section === "tools") return { previous: (previous.tools ?? []).slice(index, index + 1), next: next.tools.slice(index, index + 1) };
	if (section === "system") return { previous: previous.system.slice(index, index + 1), next: next.system.slice(index, index + 1) };
	return { previous: previous.messages?.[index]?.blocks ?? [], next: next.messages[index]?.blocks ?? [] };
}
