import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import {
	AGGREGATE_SOURCE,
	buildInitialSnapshot,
	type CaptureOrigin,
	contextOnlyItems,
	type InitialSnapshot,
	type InjectionItem,
	type InjectionSource,
} from "./injection-snapshot.ts";
import { analyzeSystemPrompt, type PromptOptionsSlice, type ToolSlice } from "./system-prompt-measure.ts";
import { buildOwnedSystemPrompt } from "../../lib/wire/owned-prompt.ts";

/** Everything available when the first context event finalizes a snapshot. */
export interface CaptureFinalization {
	systemPrompt: string;
	messages: ContextEvent["messages"];
	baselineMessages: ContextEvent["messages"];
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	origin: CaptureOrigin;
	capturedAt?: Date;
}

/** Inputs for an on-demand pi-native prompt/tool snapshot. */
export interface NativeSnapshotInput {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	capturedAt?: Date;
}

/** Resolved Initial capture, possibly degraded to the pi-native fallback. */
export interface InitialCaptureResult {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
}

interface CapturePreparation {
	readonly promptOptions: PromptOptionsSlice;
	readonly toolSnippets?: Readonly<Record<string, string>>;
}

export class InitialCaptureState {
	private pendingPreparation: CapturePreparation | undefined;
	private initialSnapshot: InitialSnapshot | undefined;

	public get snapshot(): InitialSnapshot | undefined {
		return this.initialSnapshot;
	}

	public prepare(options: BuildSystemPromptOptions): void {
		if (this.initialSnapshot !== undefined) return;
		this.pendingPreparation = {
			promptOptions: copyPromptOptions(options),
			toolSnippets: options.toolSnippets === undefined ? undefined : { ...options.toolSnippets },
		};
	}

	public finalize(input: CaptureFinalization): InitialSnapshot | undefined {
		if (this.initialSnapshot !== undefined) return this.initialSnapshot;
		if (this.pendingPreparation === undefined) return undefined;

		const preparation = this.pendingPreparation;
		const tools = captureActiveTools(input.allTools, input.activeToolNames, {
			toolSnippets: preparation.toolSnippets,
		});
		const items = [
			...analyzeSystemPrompt(input.systemPrompt, preparation.promptOptions, tools),
			...measureInjectedMessages(input.messages, input.baselineMessages),
		];
		this.initialSnapshot = buildInitialSnapshot(items, input.origin, input.capturedAt ?? new Date());
		this.pendingPreparation = undefined;
		return this.initialSnapshot;
	}
}

export async function resolveInitialCapture(
	pi: ExtensionAPI,
	capture: InitialCaptureState,
	context: ExtensionCommandContext,
): Promise<InitialCaptureResult> {
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	await context.waitForIdle();
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	return createFallback(pi, context);
}

function createFallback(pi: ExtensionAPI, context: ExtensionCommandContext): InitialCaptureResult {
	return {
		snapshot: buildCurrentNativeSnapshot(pi, context),
		degradedReason: "No turn has run since this session was loaded. "
			+ "Extension additions were not observed.",
	};
}

/** Build a view-local pi-native snapshot without freezing the main capture state. */
export function buildNativeSnapshot(input: NativeSnapshotInput): InitialSnapshot {
	const options = copyPromptOptions(input.options);
	const tools = captureActiveTools(input.allTools, input.activeToolNames, input.options);
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools);
	return buildInitialSnapshot(items, "pi-native", input.capturedAt ?? new Date());
}

/** The pi-native snapshot of the prompt and tools as they stand now, from the owned prompt builder. */
export function buildCurrentNativeSnapshot(pi: ExtensionAPI, context: ExtensionCommandContext): InitialSnapshot {
	return buildNativeSnapshot({
		systemPrompt: buildOwnedSystemPrompt(context.getSystemPromptOptions()),
		options: context.getSystemPromptOptions(),
		allTools: pi.getAllTools(),
		activeToolNames: pi.getActiveTools(),
	});
}

/** Add frozen context-only messages to a current prompt/tool snapshot for Usage. */
export function mergeContextOnlyMessages(
	snapshot: InitialSnapshot,
	initial: InitialSnapshot,
): InitialSnapshot {
	const contextOnly = contextOnlyItems(initial);
	if (contextOnly.length === 0) return snapshot;
	const items = [
		...snapshot.groups.flatMap((group) => group.items),
		...contextOnly,
	];
	return buildInitialSnapshot(items, snapshot.origin, snapshot.capturedAt);
}

/** Copy the prompt-options slice used by measurement, without shared nested references. */
export function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		cwd: options.cwd,
		homeDir: process.env.HOME,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		contextFilePaths: options.contextFiles?.map((file) => file.path),
		skills: options.skills
			?.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
			})),
	};
}

/** Snapshot the final active tool set with provenance and payload definitions. */
export function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: { readonly toolSnippets?: Readonly<Record<string, string>> },
): ToolSlice[] {
	const active = new Set(activeToolNames);
	return allTools
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters ?? {}),
			snippet: options.toolSnippets?.[tool.name],
			guidelines: normalizeGuidelines(tool.promptGuidelines),
			source: tool.sourceInfo.source,
		}));
}

export function measureInjectedMessages(
	messages: ContextEvent["messages"],
	baselineMessages: ContextEvent["messages"],
): InjectionItem[] {
	const baseline = messageSignatureCounts(baselineMessages);
	const occurrences = new Map<string, number>();
	const items: InjectionItem[] = [];
	for (const message of messages) {
		const contextOnly = !consumeMessageSignature(baseline, message);
		if (message.role !== "custom" && !contextOnly) continue;

		const identity = message.role === "custom" ? message.customType : message.role;
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		const text = messageText(message);
		items.push({
			id: message.role === "custom"
				? `message:${message.customType}:${occurrence}`
				: `message:context:${message.role}:${occurrence}`,
			phase: "initial",
			kind: "message",
			source: message.role === "custom" ? messageSource(message.customType) : AGGREGATE_SOURCE,
			label: message.role === "custom" ? "message" : `${message.role} message`,
			chars: text.length,
			tokens: estimateTokens(message),
			text,
			contextOnly: contextOnly || undefined,
		});
	}
	return items;
}

function messageSignatureCounts(messages: ContextEvent["messages"]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of messages) {
		const signature = JSON.stringify(message);
		counts.set(signature, (counts.get(signature) ?? 0) + 1);
	}
	return counts;
}

function consumeMessageSignature(
	counts: Map<string, number>,
	message: ContextEvent["messages"][number],
): boolean {
	const signature = JSON.stringify(message);
	const count = counts.get(signature) ?? 0;
	if (count === 0) return false;
	if (count === 1) counts.delete(signature);
	else counts.set(signature, count - 1);
	return true;
}

function messageText(message: ContextEvent["messages"][number]): string {
	if (!("content" in message)) return JSON.stringify(message);
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function messageSource(customType: string): InjectionSource {
	return { id: `message-type:${customType}`, label: customType, native: false };
}

function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
