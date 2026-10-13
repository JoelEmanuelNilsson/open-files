import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimScreen, notice, noticeOnce } from "../../lib/process/human-notice.ts";
import { isChatSeat } from "../../lib/session/seat-identity.ts";
import { createSessionScope } from "../../lib/session/session-scope.ts";
import { newPromptId } from "../../lib/wire/claude-code.ts";
import { seatWantsWarming } from "../../lib/wire/cache-touch.ts";
import { forgetOwnedPrompt } from "../../lib/wire/inherited-prompt.ts";
import { validatePromptOptions } from "../../lib/wire/owned-prompt.ts";
import { buildAnthropicWireRequest } from "./anthropic-request.ts";
import type { KnownCause } from "./cache-break.ts";
import { buildCodexWireRequest, CODEX_API } from "./codex-request.ts";
import { capturePromptOptions, forgetPromptOptions } from "./prompt-options-capture.ts";
import { createQuotaReadings } from "./quota-readings.ts";
import { createRequestImageBudget } from "./request-image-budget.ts";
import { createRequestInstruments } from "./request-instruments.ts";
import { createCacheWarmer } from "./cache-warmer.ts";
import { anthropicTargetOf, seatClaudeCodeHeaders } from "./wire-seat.ts";
import type { CacheUsage } from "../../lib/cache/cache-usage.ts";

const ISSUE_STATUS_KEY = "wire-issue";

const CHAT_SEAT = isChatSeat();

export default function wire(pi: ExtensionAPI) {
	const scope = createSessionScope(pi);
	const instruments = createRequestInstruments();
	const warmer = createCacheWarmer(pi, scope, instruments.warmSent);
	const quota = createQuotaReadings();
	const imageBudget = createRequestImageBudget();
	let reportedProblems = "";
	let promptId = newPromptId();
	let previousRequestId: string | undefined;
	let turnIndex: number | undefined;
	let turnOpened = false;
	let filedFor: string | undefined;

	pi.on("model_select", (_event, ctx) => warmer.arm(ctx));

	const transcriptReplaced = (cause: KnownCause, ctx: ExtensionContext): void => {
		warmer.disarm();
		instruments.transcriptChanged(cause, ctx.sessionManager.getSessionId());
	};
	pi.on("session_compact", (_event, ctx) => transcriptReplaced("compaction", ctx));
	pi.on("session_tree", (_event, ctx) => transcriptReplaced("your edit", ctx));

	pi.on("session_start", (_event, ctx) => {
		turnIndex = undefined;
		turnOpened = false;
		imageBudget.forgetImageCut();
		warmer.arm(ctx);
		if (!ctx.hasUI) return;
		scope.signal.addEventListener("abort", claimScreen((message, level) => ctx.ui.notify(message, level)), { once: true });
	});

	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		filedFor = ctx.sessionManager.getSessionId();
		capturePromptOptions(filedFor, options);
		promptId = newPromptId();
		turnOpened = true;
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

	pi.on("context", (event, ctx) => {
		if (turnOpened) {
			turnOpened = false;
			const hadHistory = event.messages.some((message) => message.role === "assistant" || message.role === "compactionSummary" || message.role === "branchSummary");
			turnIndex = turnIndex !== undefined ? turnIndex + 1 : hadHistory ? undefined : 1;
		}
		const { messages, cut } = imageBudget.fitContext(event.messages, ctx.model);
		if (cut !== undefined) {
			const megabytes = (cut.bytes / 1_000_000).toFixed(1);
			notice(ctx, `wire: removed the ${cut.images} oldest images (${megabytes} MB) from context to keep the request under the provider's size limit`, "warning");
		}
		return messages === event.messages ? undefined : { messages };
	});

	pi.on("turn_end", (event) => {
		const entries = imageBudget.recordImageCut(event.context.contextEntries);
		return entries.length === 0 ? undefined : { entries };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api === CODEX_API) {
			const model = ctx.model;
			const sent = buildCodexWireRequest(ctx, event.payload, CHAT_SEAT);
			if (sent === undefined) return undefined;
			filedFor = ctx.sessionManager.getSessionId();
			quota.codexRequestSent();
			beside(ctx, "recording the request", undefined, () => instruments.codexRequestSent(ctx, model, sent));
			return sent.payload;
		}
		const target = anthropicTargetOf(ctx);
		if (target === undefined) return;
		const sent = buildAnthropicWireRequest(ctx, target, event.payload, CHAT_SEAT, {
			promptId,
			previousRequestId,
			turnPosition: turnIndex === undefined ? undefined : { promptIndex: turnIndex, turnIndex },
		});
		if (sent === undefined) return;
		filedFor = ctx.sessionManager.getSessionId();

		beside(ctx, "recording the request", undefined, () => instruments.anthropicRequestSent(ctx, target, sent));
		if (!sent.sideSeat) beside(ctx, "scheduling the cache warm", undefined, () => warmer.arm(ctx));
		return sent.payload;
	});

	pi.on("cache_warming_decision", (_event, ctx) => {
		if (ctx.model?.api === "anthropic-messages") return { action: "stop" };
		return seatWantsWarming(ctx.sessionManager.getSessionId()) ? { action: "warm" } : undefined;
	});

	pi.on("message_end", (event, ctx) => {
		// SAFETY: message_end events carry AgentMessage; every field read is type-checked
		const message = event.message as { role?: string; api?: string; provider?: string; model?: string; stopReason?: string; usage?: CacheUsage };
		if (message?.role !== "assistant") return;
		if (message.api === CODEX_API) {
			quota.codexAnswered(message.stopReason);
			return;
		}
		if (message.usage === undefined) return;
		instruments.usageSettled(ctx, message.usage, quota.takePendingReading());
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (anthropicTargetOf(ctx)?.oauth === true) Object.assign(event.headers, seatClaudeCodeHeaders(ctx));
		instruments.headersStaged(event.headers);
	});

	pi.on("session_shutdown", (event, ctx) => {
		const ending = filedFor ?? ctx.sessionManager.getSessionId();
		forgetOwnedPrompt(ending);
		if (event.reason !== "reload") {
			forgetPromptOptions(ending);
		}
		warmer.disarm();
		instruments.sessionEnded(event.reason);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.api === CODEX_API) {
			quota.codexResponded(event.headers);
			return;
		}
		const target = anthropicTargetOf(ctx);
		if (target === undefined) return;
		const header = event.headers["request-id"];
		const requestId = typeof header === "string" && header.length > 0 ? header : undefined;
		instruments.responseArrived(event.status, requestId);
		if (!target.oauth) return;
		if (requestId !== undefined) previousRequestId = requestId;
		quota.anthropicResponded(event.headers);
	});

	pi.registerCommand("quota", {
		description: "What the server last said about the subscription allowance",
		handler: async (_args, ctx) => quota.notifyQuota(ctx),
	});

	pi.registerCommand("prompt", {
		description: "Dump the whole context window last sent to the provider, verbatim",
		handler: async (_args, ctx) => instruments.notifyPromptDump(ctx),
	});

	pi.registerCommand("trace", {
		description: "Where this session's cache trace is, and the last break it classified",
		handler: async (_args, ctx) => instruments.notifyTraceSummary(ctx),
	});
}

function beside<T>(ctx: ExtensionContext, what: string, fallback: T, run: () => T): T {
	try {
		return run();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		noticeOnce(ctx, `wire:beside:${what}`, `wire: ${what} failed (${reason}) — the request went out; the instrument did not.`, "warning");
		return fallback;
	}
}
