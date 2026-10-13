import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionCommandContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { computeContextUsage, toReportedUsage } from "./context-usage.ts";
import {
	buildCurrentNativeSnapshot,
	type InitialCaptureState,
	mergeContextOnlyMessages,
	resolveInitialCapture,
} from "./initial-capture.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { notice } from "../../lib/process/human-notice.ts";

/** What `/context` reads from the runtime that registered it, current at the moment it runs. */
export interface ContextCommandRuntime {
	readonly pi: ExtensionAPI;
	readonly capture: InitialCaptureState;
}

/** Run one `/context` invocation: open the usage view. */
export async function runContextCommand(
	ctx: ExtensionCommandContext,
	{ pi, capture }: ContextCommandRuntime,
): Promise<void> {
	if (ctx.mode !== "tui") {
		notice(ctx, "/context requires TUI mode.", "warning");
		return;
	}
	const initial = await resolveInitialCapture(pi, capture, ctx);
	const current = buildCurrentNativeSnapshot(pi, ctx);
	await showUsageView(ctx, {
		usage: computeContextUsage({
			snapshot: mergeContextOnlyMessages(current, initial.snapshot),
			messages: buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			reported: toReportedUsage(ctx.getContextUsage()),
			modelLabel: ctx.model?.id,
			autoCompactReserveTokens: readAutoCompactReserveTokens(ctx),
		}),
		degradedReason: initial.degradedReason,
	});
}

function readAutoCompactReserveTokens(context: ExtensionCommandContext): number | undefined {
	try {
		const settings = SettingsManager.create(context.cwd, undefined, {
			projectTrusted: context.isProjectTrusted(),
		});
		if (!settings.getCompactionEnabled()) return undefined;
		return settings.getCompactionReserveTokens();
	} catch {
		return undefined;
	}
}
