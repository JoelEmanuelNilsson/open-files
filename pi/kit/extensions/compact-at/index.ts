import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { liveWorkOf } from "../../lib/session/live-work.ts";

const FLOOR = 20_000;

type Request = { readonly kind: "show" } | { readonly kind: "default" } | { readonly kind: "set"; readonly tokens: number } | { readonly kind: "unreadable" };

function parseRequest(args: string): Request {
	const text = args.trim().toLowerCase();
	if (text === "") return { kind: "show" };
	if (text === "default") return { kind: "default" };
	const match = /^(\d+)(k?)$/.exec(text);
	if (match === null) return { kind: "unreadable" };
	return { kind: "set", tokens: Number(match[1]) * (match[2] === "k" ? 1000 : 1) };
}

function writeReserve(path: string, modelKey: string, reserveTokens: number | undefined): void {
	const text = readFileSync(path, "utf8");
	const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
	// SAFETY: only the compaction.modelOverrides fields declared here are read, each checked by the code below
	const settings = JSON.parse(text) as { compaction?: { modelOverrides?: Record<string, { reserveTokens?: number }> } };
	const compaction = (settings.compaction ??= {});
	if (reserveTokens !== undefined) {
		const overrides = (compaction.modelOverrides ??= {});
		overrides[modelKey] = { ...overrides[modelKey], reserveTokens };
	} else if (compaction.modelOverrides?.[modelKey] !== undefined) {
		delete compaction.modelOverrides[modelKey].reserveTokens;
		if (Object.keys(compaction.modelOverrides[modelKey]).length === 0) delete compaction.modelOverrides[modelKey];
		if (Object.keys(compaction.modelOverrides).length === 0) delete compaction.modelOverrides;
	}
	writeFileSync(path, `${JSON.stringify(settings, null, indent)}${text.endsWith("\n") ? "\n" : ""}`);
}

async function compactAtCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { model } = ctx;
	const request = parseRequest(args);
	const refuse = (reason: string) => ctx.ui.notify(`/compact-at: ${reason}`, "error");
	if (model === undefined) return refuse("no model is selected");
	const modelKey = `${model.provider}/${model.id}`;
	if (request.kind === "show") {
		const reserve = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionReserveTokens(model);
		return ctx.ui.notify(`compact_at ${Math.max(0, model.contextWindow - reserve)} on ${modelKey} (window ${model.contextWindow})`, "info");
	}
	if (request.kind === "unreadable") return refuse("give a token count such as 300000 or 300k, or default");
	if (request.kind === "set" && (request.tokens < FLOOR || request.tokens >= model.contextWindow)) return refuse(`${request.tokens} is outside ${FLOOR} to ${model.contextWindow - 1} (pi keeps the last ${FLOOR} tokens verbatim; the model's window is ${model.contextWindow})`);
	const live = liveWorkOf(ctx.sessionManager.getSessionId());
	if (live.length > 0) return refuse(`not changed: ${live.join(" and ")} still running, and the reload that applies it ends them`);
	writeReserve(join(getAgentDir(), "settings.json"), modelKey, request.kind === "set" ? model.contextWindow - request.tokens : undefined);
	const what = request.kind === "set" ? `compact_at ${request.tokens}` : "compact_at back to default";
	ctx.ui.notify(`${what} on ${modelKey}: applies to this session now and to others when they start or reload`, "info");
	await ctx.reload();
}

export default function compactAt(pi: ExtensionAPI) {
	pi.registerCommand("compact-at", {
		description: "[tokens|default] — Show or set main's compaction threshold for this model",
		handler: compactAtCommand,
	});
}
