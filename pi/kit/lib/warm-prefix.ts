/**
 * Whether the prefix a seat is about to send is already in the provider's cache.
 *
 * Anthropic's cache is a server-side store nobody can query. The only facts a
 * client has are the bytes it sent, on which model, when, with what TTL — and
 * what the provider reported reading back. So this module keeps a ledger of
 * exactly those facts, on disk, shared by every pi process on the machine:
 *
 *   entries/<wire key>/<renewer>  "this seat put the prefix in the provider's
 *                                  cache at T, and keeps it there until K"
 *   inputs/<inputs key>           "a seat with these inputs sends this prefix"
 *
 * The **wire key** is every request field the server could key the prefix
 * on: the whole payload except `messages` (the tier below the prefix) and
 * `stream` (transport), and within `system` only the blocks up to and
 * including the last one carrying `cache_control` — Anthropic caches the
 * prefix up to the last breakpoint, so anything after it belongs to the
 * conversation tier and cannot split the entry (a `system` array with no
 * breakpoint at all is keyed whole). Minus the attribution block Claude Code sends and the
 * server strips (it changes every request and the cache hits anyway — every
 * first request of a session in `~/.local/state/pi-kit/wire-trace` reads the
 * previous session's tools+system at a different `cc_prompt_id`), minus
 * `cache_control` for the same reason the trace leaves it out: the TTL asked
 * for is not part of the bytes being cached.
 *
 * Whether the reasoning fields (`thinking`, `output_config`) are in the
 * server's key is undocumented and differs by model — measured 2026-09-08 on
 * one prompt: Opus 5 high → low wrote the whole prefix again (read 0, write
 * 6346), Fable 5.1 high → low read all of it (read 6346, write 0), Haiku 4.5
 * kept it across a `budget_tokens` change. So the key has two parts, `exact`
 * (every field) and `bytes` (every field but reasoning), and the ledger keeps
 * a third kind of fact, `models/<id>`: whether that model reads across a
 * reasoning change — its tools+system prefix, and separately the whole
 * conversation, since a model can read the one and rewrite the other (Haiku
 * 4.5: prefix read, messages written again). Neither is ever guessed. Every
 * request whose `bytes` are warm while its `exact` is cold is a measurement —
 * the provider reads the prefix or writes it, reads the conversation whole or
 * not — and `wire` records what it can tell from the usage. Until a model has
 * been measured, a seat that differs from a warm entry only in reasoning is
 * told "unknown", not "cold".
 *
 * The **inputs key** is what a seat knows *before* its first request: the
 * model it will send on and that model's whole record, its reasoning level,
 * how it authenticates, which seat it is, pi's own rendering of the prompt
 * options, the tools the seat will send after the cuts, and the code that
 * turns all of that into bytes ({@link PrefixInputs.build}). The request
 * builder (`extensions/wire.ts`) is a pure function of these, so equal inputs
 * give equal wire bytes — and that claim is checked, not assumed: every
 * request records inputs → wire key, and a request that produces different
 * bytes from the same inputs is reported once and overwrites the mapping. A
 * contradiction is then a bug report about this witness, not a state the
 * ledger sits in: something the wire keys on is missing from the inputs above.
 *
 * Declared limits, and the only ones: an entry evicted before its TTL cannot
 * be seen from here (Anthropic documents none); a client outside this harness
 * can keep an entry warm that this ledger calls cold, never the reverse; a
 * request served on a model other than the one asked for belongs to whichever
 * the provider keyed it on. `wire` checks every first request's usage against
 * the prediction made for it, so each of these shows up as a notice after the
 * fact rather than as a wrong bill nobody explained.
 *
 * One file per key and renewer, written by rename, so two processes writing at
 * once can only race on the same value. No read-modify-write of a shared file.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";
import { ATTRIBUTION_PREFIX } from "./claude-code.ts";
import { toolSeatOf } from "./seat.ts";
import { ensurePrivateDir, pruneOlderThan, stateDir } from "./state-dir.ts";
import { applyChatToolPolicy, applyToolPolicy, canonicalToolOrder } from "./tool-policy.ts";

/** Everything a seat knows about its next request's cacheable prefix before sending it. */
export interface PrefixInputs {
	/** The id the request will carry: what pi resolved, which is what goes out. */
	readonly model: string;
	/**
	 * The model's whole record, hashed: `max_tokens`, the compat flags and the
	 * thinking mapping all reach the wire from it, and a pi release that revises
	 * one of them without changing the id moves the bytes with nothing else to
	 * witness it.
	 */
	readonly modelRecord: string;
	/** The kit's code and pi's version, hashed; see {@link BUILD_STAMP}. */
	readonly build: string;
	/** The reasoning level pi will render into `thinking` / `output_config`. */
	readonly reasoning: string;
	/** OAuth requests carry the Claude Code identity block; Console-key requests do not. */
	readonly oauth: boolean;
	/** Which tool cut and which prompt shape this seat gets; see `seatName`. */
	readonly seat: string;
	/**
	 * The prompt body the wire will send, cwd excluded: a complete witness for
	 * the owned prompt's inputs, and the same bytes for two seats that differ
	 * only in where they run.
	 */
	readonly systemPrompt: string;
	/** The tools the wire will send: pi's active set, cut and in canonical order. */
	readonly tools: readonly { name: string; description: string; parameters: unknown }[];
}

/** One seat's identity in the inputs key: role, and the launch answer that changes its tools. */
export function seatName(seat: { role: string; workflows: boolean }, chat: boolean): string {
	if (chat) return "chat";
	return seat.workflows ? `${seat.role}+workflows` : seat.role;
}

/**
 * A live seat's inputs, read off pi. `undefined` when the seat's next request
 * is not an Anthropic one, which is the only case the ledger does not cover.
 *
 * The same reads on both sides — the request builder records under this key,
 * the status bar looks it up — so the two can only disagree if pi changes
 * between the look-up and the request, which is exactly a change the seat
 * should react to.
 */
export function prefixInputsOf(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getThinkingLevel">,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "getSystemPrompt" | "sessionManager">,
	chat: boolean,
): PrefixInputs | undefined {
	const model = ctx.model;
	if (model === undefined || model.api !== "anthropic-messages") return undefined;
	const active = new Set(pi.getActiveTools());
	const seat = toolSeatOf(ctx.sessionManager.getSessionId());
	const listed = pi
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	const cut = chat ? applyChatToolPolicy(listed) : applyToolPolicy(listed, seat);
	return {
		model: model.id,
		modelRecord: digest(stableJson(model)),
		build: BUILD_STAMP,
		reasoning: pi.getThinkingLevel(),
		oauth: ctx.modelRegistry.isUsingOAuth(model),
		seat: seatName(seat, chat),
		systemPrompt: promptBody(ctx),
		// The witness is the post-cut, sorted list the wire will send, by the same
		// two functions the wire calls, so neither side can compute an order the
		// other does not. Safe: both key on `name` alone — they drop and reorder
		// elements, never rebuild them — so the list keeps the shape it went in with.
		tools: canonicalToolOrder(cut) as PrefixInputs["tools"],
	};
}

/**
 * pi's own rendering of the prompt options, minus the cwd line it ends in.
 *
 * A witness for the inputs, not the bytes the wire sends: it only has to be
 * the *same* reading on both sides of the ledger — the seat predicting before
 * its first request and the request builder recording after it. pi's
 * rendering is the one text both sides can read at both moments; the owned
 * prompt is not, since it is built from options captured at the first turn
 * and a fresh seat has none yet. Two sources gave a fresh seat one key and
 * its own first request another, so no seat ever read as warm (2026-09-09).
 * The cwd line is cut because the wire no longer puts it in the cached block
 * (`extensions/wire.ts`): a witness that carried it would give two
 * directories two keys for one entry.
 */
function promptBody(ctx: Pick<ExtensionContext, "getSystemPrompt">): string {
	return ctx.getSystemPrompt().replace(/\n?Current working directory: [^\n]*\n?$/, "");
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** JSON with every object's keys in sorted order, so field order cannot make two hashes of one record. */
function stableJson(value: unknown): string {
	const sortKeys = (inner: unknown): unknown => {
		if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return inner;
		const record = inner as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, record[key]]),
		);
	};
	return JSON.stringify(value, (_key, inner: unknown) => sortKeys(inner)) ?? "";
}

/** Every non-test `.ts` under `dir`, recursively. */
function kitSources(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.includes("test")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...kitSources(path));
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
}

const KIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The kit's own code identity: every non-test module under `lib/` and
 * `extensions/`, content-hashed with its path, plus the pi version they run
 * against.
 *
 * The wire sends the *owned* prompt while the inputs witness pi's render, so
 * the kit's source — the identity text, the guidelines, the skills catalogue,
 * the tool policy — moves the bytes with nothing in the inputs to show for it.
 * This is what witnesses it.
 *
 * Hashed once at load and never per call, and that is load-bearing: a process
 * running old code must key to the code it loaded. Re-reading the tree per
 * request would let an edit on disk make a running seat file `inputs(new
 * source) → wire(old bytes)` while a fresh process files `inputs(new) →
 * wire(new)` — the contradiction this component exists to remove.
 *
 * Declared limits: a hand edit to pi's own `dist` without a version bump is
 * invisible here, and the contradiction notice is what catches it; every kit
 * edit costs one "never-seen" glow per seat configuration, which is honest and
 * heals at that seat's next request.
 */
const BUILD_STAMP: string = ((): string => {
	try {
		const sources = [...kitSources(join(KIT_ROOT, "lib")), ...kitSources(join(KIT_ROOT, "extensions"))].sort();
		return digest(JSON.stringify([VERSION, sources.map((path) => [relative(KIT_ROOT, path), digest(readFileSync(path, "utf8"))])]));
	} catch {
		// A tree that cannot be read is one code identity like any other: every seat
		// in this process agrees on it, which is all the key needs.
		return digest(`unreadable:${VERSION}`);
	}
})();

/**
 * The inputs, one hash per component, for saying *which* of them made two
 * seats' keys differ. The key itself is one digest and cannot say; this is
 * what `/warm` prints and the trace files at the first request.
 */
export function inputsParts(inputs: PrefixInputs): Record<keyof PrefixInputs, string> {
	return {
		model: inputs.model,
		modelRecord: inputs.modelRecord,
		build: inputs.build,
		reasoning: inputs.reasoning,
		oauth: String(inputs.oauth),
		seat: inputs.seat,
		systemPrompt: digest(inputs.systemPrompt),
		tools: digest(JSON.stringify(inputs.tools.map((tool) => [tool.name, tool.description, tool.parameters]))),
	};
}

/** The inputs, hashed. Pure: the same seat state gives the same key on every call. */
export function inputsKey(inputs: PrefixInputs): string {
	const tools = inputs.tools.map((tool) => JSON.stringify([tool.name, tool.description, tool.parameters]));
	return digest(JSON.stringify([inputs.model, inputs.modelRecord, inputs.build, inputs.reasoning, inputs.oauth, inputs.seat, inputs.systemPrompt, tools]));
}

/** `cache_control` dropped from every block: the TTL is asked for, not cached. */
const withoutCacheControl = (value: unknown): string =>
	JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)) ?? "";

/** Request fields that are not part of the cached prefix: the tier below it, and transport. */
const BELOW_PREFIX = new Set(["messages", "stream"]);
/**
 * Request fields whose place in the server's key is a per-model fact
 * (`readsAcrossReasoning`). Shared with `wire-trace.ts` so the two instruments
 * can never disagree about which fields "reasoning" means.
 */
export const REASONING_FIELDS: ReadonlySet<string> = new Set(["thinking", "output_config"]);

/** The prefix as the server may key it, hashed twice: with the reasoning fields and without. */
export interface PrefixKey {
	readonly exact: string;
	readonly bytes: string;
}

/**
 * The prefix the server keys on, hashed, from the payload as it leaves: every
 * field but `messages` and `stream`, `system` cut at its last breakpoint, keys
 * sorted so field order cannot split one prefix into two. `undefined` for a
 * payload that is not an Anthropic request.
 */
export function wireKey(payload: unknown): PrefixKey | undefined {
	const body = payload as Record<string, unknown> | null;
	if (!body || typeof body.model !== "string") return undefined;
	const system = Array.isArray(body.system) ? body.system : [];
	const lastBreak = system.reduce((last, block, index) => ((block as { cache_control?: unknown } | null)?.cache_control ? index : last), -1);
	const cached = lastBreak === -1 ? system : system.slice(0, lastBreak + 1);
	const kept = cached.filter((block) => {
		const text = (block as { text?: unknown } | null)?.text;
		return !(typeof text === "string" && text.startsWith(ATTRIBUTION_PREFIX));
	});
	const hashed = (skip: ReadonlySet<string>): string =>
		digest(
			JSON.stringify(
				Object.keys(body)
					// An undefined field is not on the wire: JSON drops it.
					.filter((key) => body[key] !== undefined && !BELOW_PREFIX.has(key) && !skip.has(key))
					.sort()
					.map((key) => [key, withoutCacheControl(key === "system" ? kept : body[key])]),
			),
		);
	return { exact: hashed(new Set()), bytes: hashed(REASONING_FIELDS) };
}

/**
 * One fact: the provider's clock for this prefix restarted at `at`, for `ttlMs`
 * — and, in `keepUntil`, how long the renewer that wrote it commits to keeping
 * it alive by replaying it. A missing `keepUntil` is no commitment beyond the
 * TTL, which is what a halted chain's last write carries, so that case is exact.
 *
 * Declared limit: a renewer that dies without halting over-promises until its
 * own `at + ttlMs` passes — at most one TTL — after which the file stops
 * counting and the key falls back to whatever is still live.
 */
export interface WarmEntry {
	readonly model: string;
	readonly at: number;
	readonly ttlMs: number;
	/** Epoch ms this renewer's ping chain keeps the entry alive to. */
	readonly keepUntil?: number;
}

/** What the ledger says about a seat's next request. */
export type Warmth =
	| { readonly kind: "warm"; readonly until: number; readonly model: string }
	| { readonly kind: "cold" }
	| { readonly kind: "unknown"; readonly reason: "never-seen" | "reasoning-unmeasured" };

/** Where the ledger lives: under the kit's private state root. */
export function warmPrefixDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return join(stateDir(env, home), "warm-prefix");
}

/** Entries older than this cannot be warm under any TTL the provider offers. */
const ENTRY_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** A seat configuration nobody has sent from in a month is not coming back. */
const INPUTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const entriesDir = (dir: string): string => join(dir, "entries");
const inputsDir = (dir: string): string => join(dir, "inputs");
const modelsDir = (dir: string): string => join(dir, "models");

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Written whole under a private name, then renamed over the target, so a reader sees one version or the other. */
function writeJson(dir: string, name: string, value: unknown): void {
	ensurePrivateDir(dir);
	const target = join(dir, name);
	const staging = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(staging, JSON.stringify(value), { mode: 0o600 });
	renameSync(staging, target);
}

function readEntryFile(path: string): WarmEntry | undefined {
	const raw = readJson(path) as { model?: unknown; at?: unknown; ttlMs?: unknown; keepUntil?: unknown } | undefined;
	if (!raw || typeof raw.model !== "string" || typeof raw.at !== "number" || typeof raw.ttlMs !== "number") return undefined;
	return { model: raw.model, at: raw.at, ttlMs: raw.ttlMs, ...(typeof raw.keepUntil === "number" ? { keepUntil: raw.keepUntil } : {}) };
}

/** What a key's live renewers together promise: the last of their clocks, and the newest one's model. */
interface KeyWarmth {
	readonly model: string;
	readonly until: number;
}

/**
 * The key as its renewers leave it now: every file whose own TTL has not run
 * out, the latest cold time any of them promises, and the model of the one that
 * wrote last — a stale renewer cannot rename the prefix's model out from under
 * the seat that is still sending on it.
 */
function readKey(dir: string, hash: string, now: number): KeyWarmth | undefined {
	let names: string[];
	try {
		names = readdirSync(join(entriesDir(dir), hash));
	} catch {
		return undefined;
	}
	let newest: WarmEntry | undefined;
	let until = 0;
	for (const name of names) {
		const entry = readEntryFile(join(entriesDir(dir), hash, name));
		if (entry === undefined || entry.at + entry.ttlMs <= now) continue;
		until = Math.max(until, entry.at + entry.ttlMs, entry.keepUntil ?? 0);
		if (newest === undefined || entry.at > newest.at) newest = entry;
	}
	return newest === undefined ? undefined : { model: newest.model, until };
}

/**
 * Record that a request or a successful replay ping by `renewer` restarted the
 * provider's clock for `key` — under both its hashes, since which one the
 * server keys on is the model's fact, not the request's. One file per renewer,
 * because only the seat that sent the bytes can replay them: the key is warm
 * until the last of its renewers gives up, and each writes its own file rather
 * than racing over a shared one. The newest anchor wins per file, so a ping that
 * reports after a later request cannot move that renewer's clock backwards.
 */
export function recordWarmPrefix(dir: string, key: PrefixKey, renewer: string, entry: WarmEntry): void {
	const name = `${digest(renewer)}.json`;
	for (const hash of key.exact === key.bytes ? [key.exact] : [key.exact, key.bytes]) {
		const existing = readEntryFile(join(entriesDir(dir), hash, name));
		if (existing !== undefined && existing.at >= entry.at) continue;
		writeJson(join(entriesDir(dir), hash), name, entry);
	}
}

/**
 * This renewer stops replaying `key`: its files keep their anchor, so the entry
 * still counts as warm for the TTL the provider granted, but drop the
 * commitment. Called when a chain halts and when a seat shuts down, because
 * both moments are known to the seat and the alternative — leaving a promise
 * nobody will keep — is exactly the limit the ledger otherwise has to declare.
 */
export function withdrawRenewal(dir: string, key: PrefixKey, renewer: string): void {
	const name = `${digest(renewer)}.json`;
	for (const hash of key.exact === key.bytes ? [key.exact] : [key.exact, key.bytes]) {
		const existing = readEntryFile(join(entriesDir(dir), hash, name));
		if (existing === undefined || existing.keepUntil === undefined) continue;
		const { keepUntil: _keepUntil, ...anchor } = existing;
		writeJson(join(entriesDir(dir), hash), name, anchor);
	}
}

/**
 * Whether sending `key` now would be a measurement of its model: the prefix
 * is warm but for the reasoning fields, so the provider's read count answers
 * `readsAcrossReasoning` for that model. Asked before the request is recorded.
 */
export function measuresReasoning(dir: string, key: PrefixKey, now: number): boolean {
	if (key.exact === key.bytes) return false;
	return readKey(dir, key.exact, now) === undefined && readKey(dir, key.bytes, now) !== undefined;
}

/** What a model does with a warm prefix when the reasoning fields change. */
export interface ReasoningFact {
	/** Reads tools+system back. Every measurement answers this. */
	readonly prefix: boolean;
	/**
	 * Reads the whole conversation back. Answered only by a measurement that
	 * could see the conversation's size: a request with a settled predecessor in
	 * its session, or one whose usage wrote nothing at all.
	 */
	readonly conversation?: boolean;
}

function readReasoningFact(dir: string, model: string): (ReasoningFact & { at: number }) | undefined {
	const raw = readJson(join(modelsDir(dir), `${model}.json`)) as { prefix?: unknown; conversation?: unknown; at?: unknown } | undefined;
	if (!raw || typeof raw.prefix !== "boolean" || typeof raw.at !== "number") return undefined;
	return { prefix: raw.prefix, ...(typeof raw.conversation === "boolean" ? { conversation: raw.conversation } : {}), at: raw.at };
}

/** The model's measured fact, or undefined until one request has measured it. */
export function readsAcrossReasoning(dir: string, model: string): ReasoningFact | undefined {
	const fact = readReasoningFact(dir, model);
	if (fact === undefined) return undefined;
	const { at: _at, ...rest } = fact;
	return rest;
}

/** What moving the reasoning level now would cost the conversation already cached. */
export type ReasoningCost = "rewrites" | "keeps" | "unmeasured";

/**
 * What changing the reasoning level would do to the conversation this seat has
 * already put in the provider's cache — the tier the ledger does not key and
 * cannot see, so the answer comes from the model's measured fact rather than
 * from any entry.
 *
 * Three states and not a boolean, because `conversation` is only answered by a
 * measurement that could see the conversation's size. A model nobody has
 * measured reads `unmeasured`, and a caller that warns on it would be guessing
 * — which is the one thing this ledger never does.
 */
export function reasoningChangeCost(dir: string, model: string): ReasoningCost {
	const fact = readsAcrossReasoning(dir, model);
	if (fact?.conversation === undefined) return "unmeasured";
	return fact.conversation ? "keeps" : "rewrites";
}

/**
 * Record a measurement (`measuresReasoning`) as the model's fact. The newest
 * wins, so the fact follows the provider if the provider changes; an answer
 * the measurement could not give leaves the held one standing. Returns
 * whether anything is new or different, for saying so once.
 */
export function recordReasoningFact(dir: string, model: string, measured: ReasoningFact, at: number): { changed: boolean } {
	const existing = readReasoningFact(dir, model);
	if (existing !== undefined && existing.at >= at) return { changed: false };
	// A prefix the model rewrites takes the conversation with it: nothing below a written prefix is read.
	const conversation = measured.prefix ? (measured.conversation ?? existing?.conversation) : false;
	writeJson(modelsDir(dir), `${model}.json`, { prefix: measured.prefix, ...(conversation === undefined ? {} : { conversation }), at });
	return { changed: existing?.prefix !== measured.prefix || existing?.conversation !== conversation };
}

interface Prediction {
	readonly wire: PrefixKey;
}

/** Fields this build does not know are ignored, so a file written by an older one still reads. */
function readPrediction(dir: string, inputs: string): Prediction | undefined {
	const raw = readJson(join(inputsDir(dir), `${inputs}.json`)) as { wire?: unknown; bytes?: unknown } | undefined;
	if (!raw || typeof raw.wire !== "string" || typeof raw.bytes !== "string") return undefined;
	return { wire: { exact: raw.wire, bytes: raw.bytes } };
}

/**
 * Record that a seat with `inputs` sent prefix `wire`. Returns the wire key it
 * previously mapped to when that differs — the newest mapping wins, because
 * the bytes just sent are the ones the provider now holds, and the older
 * mapping can only mislead the next seat.
 *
 * A contradiction is a bug report, not a state: with the tool order canonical
 * and the code hashed at load, the only way two prefixes share one inputs key
 * is an input the witness above is missing. The caller says so once, and
 * `checkFirstPrediction` is the backstop that catches the wrong promise after
 * the fact.
 */
export function recordPrediction(dir: string, inputs: string, wire: PrefixKey): { contradiction?: string } {
	const existing = readPrediction(dir, inputs);
	if (existing === undefined) {
		writeJson(inputsDir(dir), `${inputs}.json`, { wire: wire.exact, bytes: wire.bytes });
		return {};
	}
	if (existing.wire.exact === wire.exact) {
		// Read again, so the month's prune measures use rather than last change.
		try {
			const now = new Date();
			utimesSync(join(inputsDir(dir), `${inputs}.json`), now, now);
		} catch {}
		return {};
	}
	writeJson(inputsDir(dir), `${inputs}.json`, { wire: wire.exact, bytes: wire.bytes });
	return { contradiction: existing.wire.exact };
}

/**
 * Whether a seat with `inputs` would read its prefix back from cache right now,
 * and until when — every renewer's commitment included, so the number is the
 * time until cold rather than the time until the next ping.
 *
 * One prediction file and at most two small directories of entries, one file
 * per live renewer; safe to call every second from the status bar.
 */
export function predictWarmth(dir: string, inputs: string, now: number): Warmth {
	const prediction = readPrediction(dir, inputs);
	if (prediction === undefined) return { kind: "unknown", reason: "never-seen" };
	const exact = readKey(dir, prediction.wire.exact, now);
	if (exact !== undefined) return { kind: "warm", until: exact.until, model: exact.model };
	if (prediction.wire.bytes === prediction.wire.exact) return { kind: "cold" };
	const bytes = readKey(dir, prediction.wire.bytes, now);
	if (bytes === undefined) return { kind: "cold" };
	const fact = readsAcrossReasoning(dir, bytes.model);
	if (fact === undefined) return { kind: "unknown", reason: "reasoning-unmeasured" };
	return fact.prefix ? { kind: "warm", until: bytes.until, model: bytes.model } : { kind: "cold" };
}

/** Drop what can no longer be read: entries past every TTL, inputs nobody has sent from in a month. */
export function pruneWarmPrefixes(dir: string, now = Date.now()): void {
	try {
		const root = entriesDir(dir);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		pruneOlderThan(root, ENTRY_MAX_AGE_MS, now);
		for (const name of readdirSync(root)) {
			const sub = join(root, name);
			try {
				if (!statSync(sub).isDirectory()) continue;
				pruneOlderThan(sub, ENTRY_MAX_AGE_MS, now);
				if (readdirSync(sub).length === 0) rmSync(sub, { recursive: true, force: true });
			} catch {
				// A key that cannot be pruned is still a key.
			}
		}
	} catch {
		// A ledger that cannot be pruned is still a ledger.
	}
	try {
		const inputs = inputsDir(dir);
		mkdirSync(inputs, { recursive: true, mode: 0o700 });
		pruneOlderThan(inputs, INPUTS_MAX_AGE_MS, now);
	} catch {
		// A ledger that cannot be pruned is still a ledger.
	}
}
