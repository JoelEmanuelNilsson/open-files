/**
 * context — inspect what occupies the model context.
 *
 * Started as pi-context-view 0.4.3. Ours now.
 *
 * Passively captures the first real turn of this runtime; before one has run,
 * the views degrade to pi's own prompt and tool figures and say so. Nothing
 * here writes to the session or raises a run — an instrument that changes what
 * it measures is not one.
 */
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionCommandContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
	getContextArgumentCompletions,
	parseContextCommand,
	resolveInitialCapture,
} from "./command.ts";
import {
	buildNativeSnapshot,
	createLegacyProbeFilter,
	InitialCaptureState,
	type LegacyProbeFilter,
	mergeContextOnlyMessages,
} from "./capture.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";
import { notice } from "../../lib/notice.ts";
import { buildOwnedSystemPrompt } from "../../lib/owned-prompt.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	// Read-only migration for sessions written before the silent probe was
	// retired; the identity function for every session written since.
	let filterLegacyProbe: LegacyProbeFilter = createLegacyProbeFilter([]);
	// What system-payload.ts actually puts on the wire, rebuilt from the same
	// options. ctx.getSystemPrompt() is pi's vanilla build and only a fallback:
	// it over-reports by the pi-docs block the owned builder never emits.
	let ownedPrompt: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		filterLegacyProbe = createLegacyProbeFilter(ctx.sessionManager.getEntries());
	});

	pi.on("before_agent_start", (event) => {
		ownedPrompt = buildOwnedSystemPrompt(event.systemPromptOptions);
		capture.prepare(event.systemPromptOptions);
	});

	pi.on("context", (event, ctx) => {
		const messages = filterLegacyProbe(event.messages);
		const baselineMessages = filterLegacyProbe(
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
		capture.finalize({
			systemPrompt: ownedPrompt ?? ctx.getSystemPrompt(),
			messages,
			baselineMessages,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			origin: "real-turn",
		});
		return messages === event.messages ? undefined : { messages };
	});

	pi.registerCommand("context", {
		// RegisteredCommand has no argumentHint; mimic pi's `<hint> — <description>` style.
		description: "[usage|injections] — Inspect context usage or injections",
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				notice(ctx, command.message, "error");
				return;
			}
			if (ctx.mode !== "tui") {
				notice(ctx, "/context requires TUI mode.", "warning");
				return;
			}
			const initial = await resolveInitialCapture(pi, capture, ctx);
			if (command.view === "injections") {
				await showInjectionsView(ctx, {
					snapshot: initial.snapshot,
					degradedReason: initial.degradedReason,
				});
				return;
			}
			const current = buildNativeSnapshot({
				systemPrompt: buildOwnedSystemPrompt(ctx.getSystemPromptOptions()),
				options: ctx.getSystemPromptOptions(),
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
			});
			await showUsageView(ctx, {
				usage: computeUsage({
					snapshot: mergeContextOnlyMessages(current, initial.snapshot),
					// ReadonlySessionManager lacks buildSessionContext(); use pi's exported builder.
					messages: filterLegacyProbe(
						buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
					),
					reported: toReportedUsage(ctx.getContextUsage()),
					modelLabel: ctx.model?.id,
					autoCompactReserveTokens: readAutoCompactReserveTokens(ctx),
				}),
				degradedReason: initial.degradedReason,
			});
		},
	});
}

/**
 * Read the auto-compaction reserve from the same merged settings files pi
 * uses, or undefined when auto-compaction is disabled. Read at view-open time
 * because `reserveTokens` has no runtime setter but `enabled` can change.
 */
function readAutoCompactReserveTokens(context: ExtensionCommandContext): number | undefined {
	try {
		const settings = SettingsManager.create(context.cwd, undefined, {
			projectTrusted: context.isProjectTrusted(),
		});
		if (!settings.getCompactionEnabled()) return undefined;
		return settings.getCompactionReserveTokens();
	} catch {
		// Unreadable settings degrade to a map without the buffer, not a failed view.
		return undefined;
	}
}
