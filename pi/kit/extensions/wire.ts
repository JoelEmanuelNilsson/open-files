/**
 * wire — the single owner of everything this harness puts on the Anthropic
 * wire except the conversation itself: the `system` array and the headers
 * that identify the client. Renamed from `system-payload` when the headers
 * joined it; two owners of a request shape is the failure mode ticket 05 was
 * written to end.
 *
 * The shape it produces for an OAuth request, matching Claude Code 2.1.251
 * field for field (see `lib/claude-code.ts` for the binary evidence):
 *
 *   system: [ { text: "x-anthropic-billing-header: …" },   ← attribution
 *             { text: "You are Claude Code, …" },          ← identity
 *             { text: <owned prompt>, cache_control },      ← the one breakpoint
 *             { text: "Current working directory: …" } ]    ← after the breakpoint
 *
 * The cwd block sits *after* the breakpoint because Anthropic caches the
 * prefix up to the last one: two seats on the same model and tools in
 * different directories then share one tools+system entry, and each pays for
 * its own cwd inside its own conversation tier. A child seat inherits the
 * parent's prompt body and always sends its own `ctx.cwd`.
 *   headers: user-agent: claude-cli/<installed version>, X-Claude-Code-Session-Id: …,
 *            and on a subagent's turns the two agent-id headers
 *
 * The prompt itself is rebuilt per request from the structured options pi
 * captured at `before_agent_start` — replace, never strip (see
 * `lib/owned-prompt.ts`), and in a subagent's session the parent prompt it
 * inherited is rebuilt with it (`lib/inherited-prompt.ts`), so pi's prose has
 * no branch left to arrive on. Rebuilding per request is also what killed the
 * notification-turn prompt flip: there is no turn-level state to desync, so
 * every request of a turn carries a byte-identical prompt.
 *
 * Why the attribution block may carry per-turn and per-request ids at all:
 * measured, not assumed — Anthropic's edge strips that block before both
 * inference and the prompt-cache key, so changing it costs nothing while any
 * other system block changing by one byte costs the whole cached prefix
 * (ticket 16 has the four-request table).
 *
 * Invariants are guaranteed at construction and checked at capture time,
 * never mid-flight: pi swallows handler throws and sends the request anyway,
 * so an extension cannot fail a request closed. If pi's options schema
 * drifts, the human is told loudly and the builder still emits everything it
 * can map.
 *
 * pi's `system` is never an input. The array is built by `claudeCodeSystem`
 * from one owned block, so there is no branch on which this client can claim
 * to be Claude Code while carrying pi's prose — the shape Anthropic refuses
 * as a third-party app, and the shape two requests left on before this was
 * closed. A request with no capture behind it is therefore not a degraded
 * prompt but a declared one (`PROMPT_UNAVAILABLE`): the seat says it has no
 * prompt and stops. The capture it reads lives in `lib/prompt-capture.ts`,
 * where a command that starts a turn without a user message can fill it from
 * pi's own accessor before the request is built.
 *
 * Chat mode (`PI_CHAT=1`, set by the `chat` command and nothing else): the
 * same owner, told to own almost nothing. The system array is the invariant
 * plus one owned block (`buildChatSystemPrompt`: the `CHAT_PROMPT` sentence
 * and the append text pi read from APPEND_SYSTEM.md) — no coding prompt, no
 * skills, no project context — and the tools are cut to web search and bash
 * (`lib/tool-policy.ts`'s `applyChatToolPolicy`). Headers, trace, ping and
 * `/prompt` behave exactly as on a coding seat; chat changes what is said,
 * never who says it. The prompt-cache breakpoint pi left on its system block
 * moves to the sentence, the last stable system bytes a chat request has. Read once at module load: a seat is chat for its whole life or not at
 * all, which is what keeps the cached prefix one shape per session.
 *
 * Scope: Anthropic requests and ChatGPT-subscription ones (`openai-codex-responses`).
 * API-key Anthropic requests get the owned prompt with no attribution,
 * identity, or Claude Code headers — none of that belongs on a Console-key
 * request. A Codex request gets the same owned prompt and cwd in its one
 * `instructions` string and the same tool cut and order, recorded for
 * `/prompt`; nothing Claude Code, no trace, no warm-prefix ledger, no ping.
 * Every other payload passes through untouched and degrades to pi's vanilla
 * prompt, a declared limit. The model a
 * hook sees is the session's current model, so a side request issued on a
 * different model would be judged by the session's — accepted, and the same
 * limit pi's own `before_provider_request` consumers carry.
 *
 * This extension must not stand down in a subagent's session: those ride the
 * same OAuth and need the same wire shape, plus their own agent ids.
 *
 * It reads `payload.model` without touching it. `lib/model-guard.ts` used to
 * coerce a model outside `enabledModels` onto the enabled member of its family;
 * that allowlist went when pi started shipping the whole catalog, and coercion
 * went with it. Which release a seat runs is no longer a question asked here at
 * all: `extensions/model-catalog.ts` cuts every superseded release out of the
 * provider, so the only models this process can reach are the ones it may run.
 * What is left is one alarm — a model the registry does not list is a hole in
 * that filter, said as an error notice, never a throw, because pi sends its own
 * payload after a handler throw and the request would go out without the owned
 * prompt — and one sentence, said once: the family on the wire is not the family
 * the launcher asked for.
 * Ctrl+P still moves between allowed families, and on 2026-09-21 the main seat
 * ran a whole session on the wrong one with nothing in it saying so. That
 * sentence is asked only of the seat that owns the command line: an engine child
 * runs in this process and would otherwise be measured against its parent's argv.
 *
 * It owns `payload.tools` for the same reason it owns `system`: one request
 * shape, one owner. Two things happen there, both static and both from
 * `lib/tool-policy.ts` — the built-in scan tools are cut from any seat that has
 * `bash` (issues/30), and bash's description is rewritten to state the deadline
 * that extension actually enforces instead of pi's "no default timeout"
 * (issues/29). Both are pure functions of the array pi handed over, so the tool
 * prefix changes exactly once, at the release that lands them, and never again
 * per request.
 *
 * Because it is the only thing holding the final payload, it is also where the
 * cache trace runs (`lib/wire-trace.ts`): every request fingerprinted, every
 * response's usage paired back to it, and a break classified against the
 * previous request while both are still in memory. Always on — a subagent
 * session builds its own extension set from the manifest and never sees a
 * parent's `-e` flag, so an opt-in instrument is structurally blind to exactly
 * the sessions that break most. The recorder is total by construction and can
 * never touch the payload; see that module's header.
 *
 * And for the same reason it publishes the session's replay ping target
 * (`lib/ping.ts`): a keep-warm ping only refreshes the cache if it replays the
 * bytes that wrote it, pi chains `before_provider_request` and takes the last
 * return value, and the last return value is this one. `session-mode` decides
 * when to ping; it may not decide what the request was.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildAttributionHeader,
	claudeCodeHeaders,
	claudeCodeSystem,
	claudeCodeToolName,
	firstUserTextOf,
	isFirstParty,
	newPromptId,
	sessionIdFromPath,
	type SubagentIdentity,
	subagentIdentity,
} from "../lib/claude-code.ts";
import { accounted, readCacheWindow, readRenewal, SHORT_TTL_MS, ttlFromPayload } from "../lib/cache-window.ts";
import { forgetOwnedPrompt, inheritedSessionPrompt, ownedSessionPrompt, type SessionLineage } from "../lib/inherited-prompt.ts";
import { commandLineModelSpec, familyOf } from "../lib/model-family.ts";
import { claimScreen, notice, noticeOnce, noticeSinkDir } from "../lib/notice.ts";
import { buildChatSystemPrompt, codexInstructions, cwdBlockText, PROMPT_UNAVAILABLE, validatePromptOptions, type WireToolName } from "../lib/owned-prompt.ts";
import { forgetPingTarget, publishPingTarget } from "../lib/ping.ts";
import { capturedPromptOptions, capturePromptOptions, forgetPromptOptions } from "../lib/prompt-capture.ts";
import { type CodexQuotaReading, codexQuotaReport, type QuotaReading, quotaReport, readCodexQuotaHeaders, readQuotaHeaders } from "../lib/quota-meter.ts";
import { childSeatOf, isChatSeat, isChildSeat, toolSeatOf } from "../lib/seat.ts";
import { ensurePrivateDir } from "../lib/state-dir.ts";
import { applyChatToolPolicy, applyToolPolicy, canonicalToolOrder } from "../lib/tool-policy.ts";
import { inputsKey, inputsParts, measuresReasoning, predictWarmth, type PrefixKey, prefixInputsOf, pruneWarmPrefixes, recordPrediction, recordReasoningFact, recordWarmPrefix, type Warmth, warmPrefixDir, wireKey } from "../lib/warm-prefix.ts";
import { captureWire, renderWireCapture, type TextBlock, type WireCapture } from "../lib/wire-dump.ts";
import {
	type BreakReport,
	type CacheUsage,
	createWireTrace,
	describeBreak,
	prefixRetired,
	traceDir,
	warmthBill,
	type WireTrace,
} from "../lib/wire-trace.ts";

const ISSUE_STATUS_KEY = "wire-issue";

/** The ChatGPT-subscription API: GPT seats on `openai-codex`. See "Scope" in the module header. */
const CODEX_API = "openai-codex-responses";

/**
 * What `/quota` says when the newest Codex response came over WebSocket. The
 * server sends the numbers there as a `codex.rate_limits` stream event, which
 * pi-ai 0.87 drops in `processResponsesStream` and no extension hook carries.
 */
const CODEX_QUOTA_UNREPORTED = "Codex quota: not reported over WebSocket (pi-ai drops the codex.rate_limits event; only an SSE response carries it to extensions)";

/** See "Chat mode" in the module header. */
const CHAT_SEAT = isChatSeat();

export default function wire(pi: ExtensionAPI) {
	let reportedProblems = "";
	let promptId = newPromptId();
	let previousRequestId: string | undefined;
	let lastWire: WireCapture | undefined;
	let trace: WireTrace | undefined;
	let lastBreak: BreakReport | undefined;
	/**
	 * What the newest response said about the subscription quota, held between
	 * the two hooks that see one response: `after_provider_response` carries the
	 * headers, `message_end` carries the tokens they were spent on. Cleared as it
	 * is filed, so a response that reported no quota is never handed the previous
	 * one's numbers.
	 */
	let pendingQuota: QuotaReading | undefined;
	/**
	 * The newest reading, kept for `/quota` alone. Separate from
	 * {@link pendingQuota}, which is consumed the moment it is filed against a
	 * turn's tokens: the question "where is my allowance now" outlives the record
	 * it came from.
	 */
	let lastQuota: QuotaReading | undefined;
	/**
	 * What the newest ChatGPT-subscription response said about its allowance,
	 * kept for `/quota` alone. `unreported` when it came over pi-ai's WebSocket
	 * transport, which hands extensions neither headers nor the
	 * `codex.rate_limits` event that carries the same numbers there: a stale SSE
	 * reading would then be a number for a request that is no longer the newest.
	 */
	let codexQuota: { kind: "read"; reading: CodexQuotaReading } | { kind: "unreported" } | undefined;
	/** A Codex request went out and no response headers have come back for it yet. */
	let codexAwaitingResponse = false;
	/**
	 * This request's headers, staged until its payload confirms the provider.
	 *
	 * Staged rather than stored because the two hooks answer to different
	 * requests' worth of state: pi transforms headers first
	 * (`ModelRegistry.applyAuth`) and builds the payload after, and a turn on
	 * another provider would otherwise leave the Anthropic payload paired with
	 * that provider's envelope.
	 */
	let pendingHeaders: ProviderHeaders = {};
	/**
	 * The session id this instance last published a ping target under.
	 *
	 * Remembered rather than re-read at shutdown, because pi's in-memory fork
	 * path reassigns `SessionManager.sessionId` *before* it emits
	 * `session_shutdown` — so asking the manager then would forget a key nobody
	 * ever wrote and strand a whole request payload on the seam.
	 */
	let publishedFor: string | undefined;
	/**
	 * The id this seat's prompt and options were last filed under.
	 *
	 * Remembered for the same reason {@link publishedFor} is: pi's in-memory fork
	 * reassigns `SessionManager.sessionId` before `session_shutdown`, so a seat
	 * that asked the manager at teardown would delete a key nobody wrote and leak
	 * the one it filled.
	 */
	let filedFor: string | undefined;
	let releaseScreen: (() => void) | undefined;
	/**
	 * What the warm-prefix ledger promised for this seat's first request, held
	 * until that request's usage arrives and can confirm or refute it. Consumed
	 * once: later requests are covered by the trace's own break detection.
	 */
	let firstPrediction: Warmth | undefined;
	let firstRequestSent = false;
	/**
	 * The request in flight is a measurement (`measuresReasoning`): its prefix
	 * was warm but for the reasoning fields, so its usage says whether this
	 * model reads across them. Held until the usage arrives.
	 */
	let pendingMeasurement: { model: string; at: number; held: number | undefined } | undefined;

	// wire is the only extension in every seat — main and child, and it may not
	// stand down in a subagent's session — so it is where the process learns which
	// seat owns the terminal. A child's notice then reaches the parent's UI
	// instead of the bytes under its frame (lib/notice.ts, issues/40).
	pi.on("session_start", (_event, ctx) => {
		firstPrediction = undefined;
		firstRequestSent = false;
		pendingMeasurement = undefined;
		if (!ctx.hasUI) return;
		releaseScreen?.();
		releaseScreen = claimScreen((message, level) => ctx.ui.notify(message, level));
		pruneWarmPrefixes(warmPrefixDir());
	});

	/**
	 * File this request in the warm-prefix ledger: the prefix it carries is warm
	 * from now for the TTL it asked, and a seat with these inputs sends this
	 * prefix. The first request also takes the prediction the status bar was
	 * showing, so `message_end` can hold the ledger to it.
	 */
	const fileWarmPrefix = (ctx: ExtensionContext, next: Record<string, unknown>, at: number, degraded: boolean): PrefixKey | undefined => {
		const key = wireKey(next);
		if (key === undefined) return undefined;
		const dir = warmPrefixDir();
		const inputs = prefixInputsOf(pi, ctx, CHAT_SEAT);
		const inputsHash = inputs === undefined ? undefined : inputsKey(inputs);
		if (!firstRequestSent) {
			firstRequestSent = true;
			firstPrediction = inputsHash === undefined ? undefined : predictWarmth(dir, inputsHash, at);
			// The inputs under which this seat's prefix is filed, component by
			// component, so a fresh seat that predicts a different key can be told
			// which input moved (`/warm`).
			if (inputs !== undefined) trace?.note({ t: "inputs", n: 1, key: inputsHash, wire: key, parts: inputsParts(inputs), predicted: firstPrediction });
		}
		const model = String(next.model);
		// Asked before this request is filed, which would make its own prefix warm.
		// `held` is the conversation the provider has, so the usage can say whether
		// all of it came back or only tools+system.
		pendingMeasurement = measuresReasoning(dir, key, at) ? { model, at, held: trace?.held() } : undefined;
		// `session-mode` owns how long this seat will keep replaying the prefix; wire
		// owns the bytes. It reads that commitment here rather than being told it, so
		// neither extension's handler has to run first (lib/cache-window.ts).
		const sessionId = ctx.sessionManager.getSessionId();
		const keepUntil = readRenewal(sessionId);
		recordWarmPrefix(dir, key, sessionId, {
			model,
			at,
			ttlMs: ttlFromPayload(next) ?? SHORT_TTL_MS,
			...(keepUntil === undefined ? {} : { keepUntil }),
		});
		// A degraded prompt or an engine child's inherited one are not what these
		// inputs produce on a seat of their own; recording them would teach the
		// ledger a mapping that holds for nobody.
		if (inputsHash !== undefined && !degraded && childSeatOf(sessionId) === undefined) {
			const { contradiction } = recordPrediction(dir, inputsHash, key);
			if (contradiction !== undefined) {
				noticeOnce(
					ctx,
					"wire:inputs-contradiction",
					`wire: the same seat inputs produced a different prefix (${contradiction} → ${key.exact}) — something the wire keys on is missing from the inputs witness (\`prefixInputsOf\`, lib/warm-prefix.ts). The newer mapping stands; \`/warm\` prints the components.`,
					"warning",
				);
			}
		}
		return key;
	};

	/**
	 * pi exposes no subagent flag, so a session is a subagent's exactly when it
	 * was spawned by another session (`parentSession`, which forks also set)
	 * *and* runs an agent definition's own prompt (`customPrompt`) — unless this
	 * process supplies a prompt to every session it runs, which erases the
	 * second signal (`lib/seat.ts` owns that inference, because background work
	 * branches on the same fact). Declining to declare is always the safe
	 * direction: subagent facts are all-or-nothing, and a
	 * main session that claims to be a subagent is the contradiction this
	 * module exists to prevent.
	 */
	const subagentOf = (ctx: ExtensionContext): SubagentIdentity | undefined => {
		if (!isChildSeat(optionsOf(ctx), process.argv, ctx.sessionManager.getSessionId())) return undefined;
		const { sessionId, parentSessionId } = lineageOf(ctx);
		return subagentIdentity(sessionId, parentSessionId);
	};

	/**
	 * Who this session is to the prompt seam. Kept separate from
	 * {@link subagentOf}, which answers a different question — that one decides
	 * whether to *claim* Claude Code's subagent facts and so demands two
	 * well-formed uuids; inheritance only needs whatever key pi filed the
	 * parent under.
	 */
	const lineageOf = (ctx: ExtensionContext): SessionLineage => ({
		sessionId: ctx.sessionManager.getSessionId(),
		parentSessionId: sessionIdFromPath(ctx.sessionManager.getHeader()?.parentSession),
	});

	/** What this seat's prompt is built from, as of right now. */
	const optionsOf = (ctx: ExtensionContext): BuildSystemPromptOptions | undefined => capturedPromptOptions(ctx.sessionManager.getSessionId());

	/**
	 * The Anthropic model a request runs on, how it authenticates, and the registry
	 * both were read from — handed back so a caller that has another question for it
	 * asks it of the same object this one read.
	 */
	const anthropicRequest = (ctx: ExtensionContext): { model: Model<Api>; oauth: boolean; registry: ExtensionContext["modelRegistry"] } | undefined => {
		const model = ctx.model;
		if (model === undefined || model.api !== "anthropic-messages") return undefined;
		const registry = ctx.modelRegistry;
		return { model, oauth: registry.isUsingOAuth(model), registry };
	};

	const claudeCodeHeadersFor = (ctx: ExtensionContext): Record<string, string> =>
		claudeCodeHeaders({ sessionId: ctx.sessionManager.getSessionId(), subagent: subagentOf(ctx) });

	/**
	 * The model spec this process was launched for: `--model` when a launcher named
	 * one (`bin/chat` does), otherwise pi's `defaultModel`. Read once — argv and
	 * the settings file are both fixed for the life of the process, and the read
	 * happens on the first request rather than at load so a settings file that
	 * cannot be parsed costs a notice instead of the extension.
	 */
	let declared: string | undefined | typeof UNREAD = UNREAD;
	const declaredModelSpec = (ctx: ExtensionContext): string | undefined => {
		if (declared === UNREAD) {
			const named = commandLineModelSpec(process.argv);
			declared = named ?? SettingsManager.create(ctx.cwd, getAgentDir()).getDefaultModel() ?? undefined;
		}
		return declared;
	};

	/**
	 * Say once whether the family on the wire is the one the launcher asked for.
	 *
	 * Nothing is changed and nothing is blocked: every model this process can
	 * reach is one the human may run, and a seat moved with Ctrl+P is a seat the
	 * human moved. What was missing on 2026-09-21 was the sentence, not the veto.
	 */
	const witnessModel = (ctx: ExtensionContext, sent: string): void => {
		// Only the seat that owns argv: an engine child shares this process and its
		// model comes from frontmatter the engine already resolved.
		if (childSeatOf(ctx.sessionManager.getSessionId()) !== undefined) return;
		const asked = declaredModelSpec(ctx);
		if (asked === undefined) return;
		const wanted = familyOf(asked);
		if (wanted === undefined || wanted === familyOf(sent)) return;
		noticeOnce(
			ctx,
			`wire:family:${wanted}:${sent}`,
			`wire: this seat started on "${sent}"; the launcher asked for "${asked}". Nothing was changed — if that was Ctrl+P, this is the only line about it.`,
			"info",
		);
	};

	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		filedFor = ctx.sessionManager.getSessionId();
		capturePromptOptions(filedFor, options);
		promptId = newPromptId();
		const problems = validatePromptOptions(options);
		const signature = problems.join("\n");
		if (signature === reportedProblems) return;
		reportedProblems = signature;
		if (problems.length === 0) {
			ctx.ui.setStatus(ISSUE_STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(ISSUE_STATUS_KEY, ctx.ui.theme.fg("error", "⚠ prompt options drift"));
		ctx.ui.notify(`wire: ${problems.join("; ")}. pi's options schema drifted; owned prompt may be missing content.`, "error");
	});

	/**
	 * The owned prompt body this seat sends, in the tool names its transport
	 * carries, and whether it had to be declared absent. Shared by every provider
	 * this module writes a prompt for, so a seat's words do not depend on its
	 * wire format.
	 */
	const ownedPromptOf = (ctx: ExtensionContext, wireToolName: WireToolName | undefined): { text: string; degraded: boolean } => {
		const captured = optionsOf(ctx);
		const degraded = captured === undefined;
		// An engine child (lib/seat.ts) with no prompt body sends its parent's owned
		// prompt, which is what lets it read the parent's cache entry (ticket 02). A
		// typed child with its own body is an ordinary custom prompt.
		const childSeat = childSeatOf(ctx.sessionManager.getSessionId());
		// A chat seat reads nothing off the capture but the append text, so it has a
		// prompt whether or not one was taken; a coding seat with no capture has none,
		// and says so rather than borrowing pi's (`PROMPT_UNAVAILABLE`).
		const text = CHAT_SEAT
			? buildChatSystemPrompt(captured?.appendSystemPrompt)
			: captured === undefined
				? PROMPT_UNAVAILABLE
				: childSeat?.prompt.kind === "inherit"
					? inheritedSessionPrompt(captured, lineageOf(ctx), wireToolName)
					: ownedSessionPrompt(captured, lineageOf(ctx), wireToolName);
		// Said every time it happens, because a turn Joel asked for is being refused,
		// and the model's own reply cannot tell him it was this seat rather than the
		// work that came up empty.
		if (degraded && !CHAT_SEAT) {
			notice(ctx, "wire: no prompt options were captured for this seat — the request went out declaring it has no system prompt. Send a message to restore it.", "error");
		}
		return { text, degraded };
	};

	/**
	 * The seat's tools as they go on the wire: the cut, then the canonical order.
	 *
	 * The cut is applied where the payload is owned, so `/prompt` measures what
	 * actually went out rather than what pi built. Bash's schema is not touched
	 * here: `extensions/bash.ts` registers the tool with the description and
	 * parameters that are true for its seat. The seat decides three things: a
	 * worker carries no delegation tools, only a workflow child carries the tool
	 * it returns its result through, and `Workflow` stands only where the launcher
	 * said so.
	 *
	 * The order is made canonical because the cut is not the only hand on this
	 * array: plannotator's `setActiveTools` and pi's own `_refreshToolRegistry`
	 * rebuild it while the session runs, and the same tools in a new sequence
	 * rewrite the whole prefix (issues/45). Sorting by name makes the array a
	 * function of the tool set, so a parent, its children and a resumed session
	 * send the same bytes without a shared record of who sent what first.
	 */
	const seatTools = (ctx: ExtensionContext, tools: unknown): unknown[] | undefined => {
		if (!Array.isArray(tools)) return undefined;
		return canonicalToolOrder(CHAT_SEAT ? applyChatToolPolicy(tools) : applyToolPolicy(tools, toolSeatOf(ctx.sessionManager.getSessionId())));
	};

	/**
	 * A ChatGPT-subscription request (`openai-codex-responses`): the owned prompt
	 * and the seat's tools, and nothing Claude Code. The Responses API carries the
	 * system prompt as one `instructions` string, so the owned body and the cwd
	 * block are joined there. Attribution, identity, the trace, the warm-prefix
	 * ledger and the ping all answer to Anthropic's cache and stay on that path.
	 */
	const codexRequest = (ctx: ExtensionContext, model: Model<Api>, payload: unknown): Record<string, unknown> | undefined => {
		if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
		const { text, degraded } = ownedPromptOf(ctx, undefined);
		const instructions = codexInstructions(text, ctx.cwd);
		const tools = seatTools(ctx, payload.tools);
		filedFor = ctx.sessionManager.getSessionId();
		codexAwaitingResponse = true;
		beside(ctx, "recording the request", undefined, () => {
			lastWire = captureWire({
				api: CODEX_API,
				at: new Date(),
				model: typeof payload.model === "string" ? payload.model : model.id,
				oauth: ctx.modelRegistry.isUsingOAuth(model),
				degraded,
				system: [{ type: "text", text: instructions }],
				headers: Object.fromEntries(Object.entries(pendingHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
				tools: tools ?? payload.tools,
				messages: payload.input,
				payload,
			});
		});
		return { ...payload, instructions, ...(tools ? { tools } : {}) };
	};

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api === CODEX_API) return codexRequest(ctx, ctx.model, event.payload);
		const request = anthropicRequest(ctx);
		if (request === undefined) return;
		const { model, oauth } = request;
		// The filter in `extensions/model-catalog.ts` is what keeps a superseded
		// release off the wire; this says so out loud at the one place every
		// Anthropic request passes. A model the registry cannot find got here around
		// the catalog, which is a defect in the filter. It is not a throw: pi catches
		// a handler error and sends its own payload (runner.js `emitBeforeProviderRequest`),
		// so throwing would not stop the request and would strip the owned prompt
		// and the Claude Code wire invariant from it. The request goes out whole;
		// the sentence is the alarm.
		if (request.registry.find(model.provider, model.id) === undefined) {
			noticeOnce(
				ctx,
				`wire:unlisted-model:${model.provider}/${model.id}`,
				`wire: this seat is on "${model.provider}/${model.id}", which the model registry does not list. The catalog filter in extensions/model-catalog.ts should have made that unreachable.`,
				"error",
			);
		}
		// `payload.model` is left exactly as pi resolved it; it is only read.
		const payload = event.payload;
		if (!isRecord(payload) || !Array.isArray(payload.messages)) return;

		// The one thing read off pi's system array, and the only thing that may be:
		// where it put the prompt-cache breakpoint. Its text is not an input — see
		// the module header.
		const existing = Array.isArray(payload.system) ? payload.system.filter(isTextBlock) : [];
		const cacheControl = [...existing].reverse().find((block) => block.cache_control)?.cache_control;

		// pi-ai renames tools to Claude Code's casing on an OAuth request, so the
		// guidelines have to be written in the names this request will carry.
		const { text, degraded } = ownedPromptOf(ctx, oauth ? claudeCodeToolName : undefined);
		// The one block this harness writes, and the only one it hands over.
		const prompt: TextBlock = { type: "text", text, ...(cacheControl ? { cache_control: cacheControl } : {}) };
		const cwdBlock: TextBlock = { type: "text", text: cwdBlockText(ctx.cwd) };
		// Four blocks on OAuth, always, in one construction — typed as the quadruple it
		// is, so the invariant survives without a test to watch it. On a Console key
		// the owned prompt stands alone: attribution and identity say which *client*
		// speaks to a subscription, and a Console key has no subscription to speak to.
		const subagent = subagentOf(ctx);
		const system: [TextBlock, TextBlock, TextBlock, TextBlock] | [TextBlock, TextBlock] = oauth
			? claudeCodeSystem(
					{
						firstUserText: firstUserTextOf(payload.messages),
						firstParty: isFirstParty(model.baseUrl),
						subagent,
						previousRequestId,
						promptId,
						// A seat Joel types into is upstream's `human`. A subagent's turn is
						// started by a tool call whose upstream origin this harness cannot
						// observe, so it names none.
						turnOrigin: subagent === undefined ? "human" : undefined,
					},
					prompt,
					cwdBlock,
				)
			: [prompt, cwdBlock];

		const tools = seatTools(ctx, payload.tools);
		const sessionId = ctx.sessionManager.getSessionId();
		filedFor = sessionId;

		const next = { ...payload, system, ...(tools ? { tools } : {}) };

		// Everything past this line is instrumentation, and none of it may cost the
		// request: pi catches a handler's throw and sends the payload it already had
		// (`dist/core/extensions/runner.js`) — pi's prompt, no attribution, no
		// identity, the very shape this extension exists to make impossible. The owned
		// bytes are finished above; the instruments run beside them.
		beside(ctx, "witnessing the model", undefined, () => witnessModel(ctx, typeof payload.model === "string" ? payload.model : model.id));
		beside(ctx, "recording the request", undefined, () => {
			// The whole context window, snapshotted as it leaves (lib/wire-dump.ts):
			// tools and messages as wire JSON, so `/prompt` shows what was sent even
			// if something mutates the live arrays afterwards.
			lastWire = captureWire({
				api: "anthropic-messages",
				at: new Date(),
				model: typeof payload.model === "string" ? payload.model : model.id,
				oauth,
				degraded,
				system,
				headers: oauth ? claudeCodeHeadersFor(ctx) : {},
				tools: tools ?? payload.tools,
				messages: payload.messages,
				payload: next,
			});

			const sentAt = Date.now();
			trace ??= createWireTrace(sessionId);
			const prefixKey = fileWarmPrefix(ctx, next, sentAt, degraded);
			const window = readCacheWindow(sessionId);
			const recorder = trace;
			const seq = trace.request(next, {
				model: model.id,
				degraded,
				ttlMin: (ttlFromPayload(next) ?? 0) / 60_000 || undefined,
				warmForSec: window ? Math.round((window.warmUntil - Date.now()) / 1000) : undefined,
			});
			// The one moment the warning is still a warning: the bytes are built, the
			// request has not gone out, and the ledger knows what the provider was holding.
			const rewrite = trace.takeRewrite();
			if (rewrite !== undefined) notice(ctx, `wire: ${rewrite}`, "warning");
			// Published from here and nowhere else: this is the object the provider gets,
			// `stream: true` and all, so a replay of it is a cache read rather
			// than a second full-price write of a prefix nobody asked for. The trace
			// sequence is bound here too, so a ping that lands after the next request has
			// gone out is still filed against the one whose bytes it sent.
			publishedFor = sessionId;
			publishPingTarget({
				payload: next,
				at: sentAt,
				headers: pendingHeaders,
				model,
				sessionId,
				...(prefixKey === undefined ? {} : { prefixKey }),
				registry: ctx.modelRegistry,
				record: (result) => recorder.ping({ n: seq, ...result }),
			});
		});
		return next;
	});

	/**
	 * Usage arrives here, not on `after_provider_response` — that event carries
	 * status and headers only. This is the second half of every trace record.
	 */
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; api?: string; stopReason?: string; usage?: CacheUsage };
		if (message?.role !== "assistant") return;
		if (message.api === CODEX_API) {
			// Answered with no headers and no transport error: the WebSocket path. A
			// failed or aborted request answered nothing, so the last word stands.
			if (codexAwaitingResponse && message.stopReason !== "error" && message.stopReason !== "aborted") codexQuota = { kind: "unreported" };
			codexAwaitingResponse = false;
			return;
		}
		if (message.usage === undefined) return;
		const quota = pendingQuota;
		pendingQuota = undefined;
		settleMeasurement(ctx, message.usage);
		checkFirstPrediction(ctx, message.usage);
		const report = trace?.usage(message.usage, quota);
		if (report === undefined) return;
		lastBreak = report;
		notice(ctx, `wire: ${describeBreak(report)}`, "warning");
	});

	/**
	 * The ledger's promise for the first request, against what the provider
	 * actually did with it. A warm prediction the provider wrote through is the
	 * ledger being wrong about something it claims to know; a cold one the
	 * provider read back is an entry kept warm by a client this ledger cannot
	 * see. Both are said once, and only for a UI seat: a subagent has no glow.
	 * Checked after `settleMeasurement`, so a wrong per-model fact is already
	 * corrected when the warning about it lands.
	 */
	function checkFirstPrediction(ctx: ExtensionContext, usage: CacheUsage): void {
		const predicted = firstPrediction;
		if (predicted === undefined) return;
		// An aborted turn accounts for nothing and refutes nothing.
		if (accounted(usage) === 0) return;
		firstPrediction = undefined;
		if (!ctx.hasUI) return;
		const read = usage.cacheRead ?? 0;
		if (predicted.kind === "warm" && read === 0) {
			notice(ctx, "wire: the cache glow promised a warm prefix and the provider wrote it — the warm-prefix ledger was wrong; see the wire trace", "warning");
		} else if (predicted.kind === "cold" && read > 0) {
			notice(ctx, `wire: the ledger called this prefix cold and the provider read ${read.toLocaleString()} tokens of it — something outside this harness kept it warm`, "info");
		}
	}

	/**
	 * A request that went out warm-but-for-reasoning has been answered: the
	 * provider read the prefix or wrote it, and that is the model's fact from
	 * now on (`lib/warm-prefix.ts`). Said once per model, and again only if the
	 * provider's answer changes.
	 */
	function settleMeasurement(ctx: ExtensionContext, usage: CacheUsage): void {
		const measurement = pendingMeasurement;
		if (measurement === undefined) return;
		if (accounted(usage) === 0) return;
		pendingMeasurement = undefined;
		const read = usage.cacheRead ?? 0;
		const prefix = read > 0;
		// The whole conversation came back when nothing had to be written, or when
		// the read covers what the provider held. A conversation that shrank below
		// what it held (a compaction landing on the same request) answers nothing.
		const { held } = measurement;
		const conversation = !prefix
			? false
			: (usage.cacheWrite ?? 0) === 0
				? true
				: held === undefined || prefixRetired(usage, held)
					? undefined
					: read >= held;
		const { changed } = recordReasoningFact(warmPrefixDir(), measurement.model, { prefix, ...(conversation === undefined ? {} : { conversation }) }, measurement.at);
		if (changed && ctx.hasUI) {
			const word = !prefix ? "rewrites its prefix after" : conversation === false ? "reads tools+system but rewrites the conversation after" : "reads its cache across";
			notice(ctx, `wire: measured — ${measurement.model} ${word} a reasoning change; the cache glow now knows`, "info");
		}
	}

	/**
	 * Request-level headers win over pi-ai's client defaults whatever their
	 * casing (verified against the bundled Anthropic SDK), so setting the
	 * canonical lowercase name is enough to replace pi-ai's stale
	 * `claude-cli/2.1.75`.
	 */
	pi.on("before_provider_headers", (event, ctx) => {
		if (anthropicRequest(ctx)?.oauth === true) Object.assign(event.headers, claudeCodeHeadersFor(ctx));
		// Copied whole, nulls and all: pi-ai reads null as "suppress the client's own
		// default of this name", so a snapshot that filtered them would put a header
		// back on the ping that the request it replays went out without. Copied
		// rather than aliased because pi builds this bag fresh per request and the
		// ping reads it long afterwards.
		pendingHeaders = { ...event.headers };
	});

	pi.on("session_shutdown", (event, ctx) => {
		releaseScreen?.();
		releaseScreen = undefined;
		const ending = filedFor ?? ctx.sessionManager.getSessionId();
		forgetOwnedPrompt(ending);
		// Same reasoning as the ping target below: a reload is not an ending, and a
		// seat that forgot its options there would refuse its next non-user turn.
		if (event.reason !== "reload") forgetPromptOptions(ending);
		// Never warm a dead seat's cache, and never hold its payload in this process
		// after it is gone. A reload is not gone: it replaces every instance while
		// the seat, its conversation and the provider's entry go on, and dropping the
		// bytes there leaves the seat unable to ping until its next request
		// (issues/43).
		if (publishedFor !== undefined && event.reason !== "reload") forgetPingTarget(publishedFor);
	});

	/**
	 * The one hook that sees response headers, and so the only place the quota
	 * meter can live (ticket 13's open question, settled: pi hands
	 * `headersToRecord(response.headers)` straight through).
	 *
	 * The status is recorded for every Anthropic response, before anything else
	 * here can decline to. It is the only line that distinguishes a turn nobody
	 * answered from a turn the human cancelled, and until 2026-09-21 the trace
	 * carried neither — a 529 that pi then retried for half a minute left a `req`
	 * record and silence, which is what a cancelled turn leaves too.
	 *
	 * The quota reading below is OAuth only, because a Console-key request has no
	 * subscription to report on and would leave `/quota` answering with a number
	 * from whenever the seat last spoke as itself.
	 *
	 * The reading goes to the trace and to `/quota`, and nowhere else. It used to
	 * publish a status too; Joel ruled it off the bottom rule — quota is for
	 * diagnosis on demand, not chrome under his chat bar (C15).
	 */
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.api === CODEX_API) {
			codexAwaitingResponse = false;
			const reading = readCodexQuotaHeaders(event.headers);
			if (reading !== undefined) codexQuota = { kind: "read", reading };
			return;
		}
		const request = anthropicRequest(ctx);
		if (request === undefined) return;
		const header = event.headers["request-id"];
		const requestId = typeof header === "string" && header.length > 0 ? header : undefined;
		trace?.response(event.status, requestId);
		if (!request.oauth) return;
		if (requestId !== undefined) previousRequestId = requestId;

		const reading = readQuotaHeaders(event.headers);
		// A response that said nothing about quota is not a fresh allowance: the last
		// number actually reported stands, and the trace records nothing.
		if (reading === undefined) return;
		pendingQuota = reading;
		lastQuota = reading;
	});

	// The deliberate ask. `/stats` (agent-dock) is the other on-demand surface,
	// but it cannot see this closure and a shared global to bridge two extensions
	// would cost more than a second command does.
	pi.registerCommand("quota", {
		description: "What the server last said about the subscription allowance",
		handler: async (_args, ctx) => {
			const claude = quotaReport(lastQuota);
			const codex = codexQuota === undefined ? undefined : codexQuota.kind === "read" ? `Codex quota ${codexQuotaReport(codexQuota.reading)}` : CODEX_QUOTA_UNREPORTED;
			if (claude === undefined && codex === undefined) {
				notice(ctx, "No quota headers seen yet this runtime (Anthropic OAuth and Codex responses only).", "warning");
				return;
			}
			const lines = [...(claude === undefined ? [] : [`Quota ${claude}`]), ...(codex === undefined ? [] : [codex])];
			notice(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("prompt", {
		description: "Dump the whole context window last sent to the provider, verbatim",
		handler: async (_args, ctx) => {
			if (lastWire === undefined) {
				notice(ctx, "No provider request captured yet this runtime.", "warning");
				return;
			}
			// The state dir, not tmpdir: this file is the whole context window, and
			// world-readable /tmp is where the probes this replaced left theirs.
			const path = join(ensurePrivateDir(traceDir()), `prompt-${ctx.sessionManager.getSessionId()}.md`);
			writeFileSync(path, renderWireCapture(lastWire), { encoding: "utf8", mode: 0o600 });
			chmodSync(path, 0o600);
			notice(ctx, `Wire prompt (${lastWire.model}, ${lastWire.at.toISOString()}) dumped to ${path}`, "info");
		},
	});

	pi.registerCommand("warm", {
		description: "What the warm-prefix ledger predicts for this seat's next request, and the inputs it keys on",
		handler: async (_args, ctx) => {
			const inputs = prefixInputsOf(pi, ctx, CHAT_SEAT);
			if (inputs === undefined) {
				notice(ctx, "warm: the next request is not an Anthropic one; the ledger has no word on it.", "info");
				return;
			}
			const key = inputsKey(inputs);
			const verdict = predictWarmth(warmPrefixDir(), key, Date.now());
			const parts = Object.entries(inputsParts(inputs))
				.map(([name, value]) => `${name}=${value}`)
				.join(" ");
			notice(ctx, `warm: ${JSON.stringify(verdict)} — inputs ${key} [${parts}]`, "info");
		},
	});

	pi.registerCommand("trace", {
		description: "Where this session's cache trace is, and the last break it classified",
		handler: async (_args, ctx) => {
			if (trace === undefined) {
				notice(ctx, "No provider request traced yet this runtime.", "warning");
				return;
			}
			const last = lastBreak ? describeBreak(lastBreak) : "no cache break yet";
			// The bill for keeping the prefix warm, read off the ledger. Only here,
			// only when Joel asks: money and quota never reach the chrome (C15).
			const bill = warmthBill(trace.path);
			const warmth =
				bill.pings > 0
					? ` — ${bill.pings} pings read ${bill.read.toLocaleString()} tokens keeping it warm${bill.misses > 0 ? ` (${bill.misses} wrote instead)` : ""}`
					: "";
			const cost = bill.rebilled > 0 ? `, ${bill.rebilled.toLocaleString()} tokens re-billed across every break` : "";
			// A seat with no UI and no screen owner says nothing out loud — its notices
			// go to a day file under this directory (lib/notice.ts). The directory
			// rather than today's file: the seat asking is the one with a UI, so its own
			// notices went to the frame and today's file usually does not exist, while
			// the headless run worth reading was yesterday's.
			notice(ctx, `Wire trace: ${trace.path} — ${last}${warmth}${cost} — headless notices: ${noticeSinkDir()}`, "info");
		},
	});
}

/**
 * Run an instrument beside the request rather than in its path.
 *
 * pi catches whatever a `before_provider_request` handler throws and sends the
 * payload it already had — pi's own prompt, with no attribution and no
 * identity, the shape Anthropic refuses as a third-party app. So a full disk,
 * an unreadable ledger or any other failure in the trace, the ping or the wire
 * dump must not reach pi: it costs the instrument, is said once, and the owned
 * bytes go out regardless. Only pure construction is allowed to sit between
 * those bytes and the return.
 */
function beside<T>(ctx: ExtensionContext, what: string, fallback: T, run: () => T): T {
	try {
		return run();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		noticeOnce(ctx, `wire:beside:${what}`, `wire: ${what} failed (${reason}) — the request went out; the instrument did not.`, "warning");
		return fallback;
	}
}

/** "not read yet", distinct from "read, and there is no declaration". */
const UNREAD = Symbol("unread");

function isTextBlock(value: unknown): value is TextBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
