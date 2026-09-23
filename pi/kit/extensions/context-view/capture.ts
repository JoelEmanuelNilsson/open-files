/**
 * Initial capture state and conversion from pi event data to the semantic
 * model. Event registration remains in index.ts; this module is independently
 * unit-testable.
 *
 * Capture is passive: the first real model turn of this runtime freezes the
 * Initial snapshot, and until one runs `/context` shows the pi-native rebuild
 * instead. There was once a silent probe that manufactured a turn to fill that
 * window — an empty user message aborted at `turn_start`. It raised pi's whole
 * run lifecycle, which six extensions read as a real turn, and it measured a
 * quantity that is always zero, so it is gone (issue 18). All that survives is
 * the read-only filter for the messages it left in sessions on disk.
 */
import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	estimateTokens,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type PromptOptionsSlice, type ToolSlice } from "./measure.ts";
import {
	AGGREGATE_SOURCE_ID,
	buildSnapshot,
	type CaptureOrigin,
	type InitialSnapshot,
	type InjectionItem,
	type InjectionSource,
} from "./model.ts";

/**
 * Session custom-entry type the retired silent probe wrote its message
 * identities under. Read to migrate old sessions; never written again.
 */
const PROBE_IDENTITIES_CUSTOM_TYPE = "pi-context-view:probe-identities";

const AGGREGATE_SOURCE: InjectionSource = {
	id: AGGREGATE_SOURCE_ID,
	label: "extensions (aggregate)",
	native: false,
};

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

/** Exact identity of one message left behind by the retired silent probe. */
interface SyntheticMessageIdentity {
	readonly role: "user" | "assistant";
	readonly timestamp: number;
}

/** Owned structured inputs prepared before later extension handlers can mutate shared event data. */
interface CapturePreparation {
	readonly promptOptions: PromptOptionsSlice;
	readonly toolSnippets?: Readonly<Record<string, string>>;
}

/**
 * Capture-once state machine. `prepare()` refreshes the structured options on
 * every run until `finalize()` succeeds; subsequent finalizations return the
 * original snapshot unchanged.
 */
export class InitialCaptureState {
	private pendingPreparation: CapturePreparation | undefined;
	private initialSnapshot: InitialSnapshot | undefined;

	/** The frozen Initial snapshot, or undefined until `finalize()` succeeds. */
	public get snapshot(): InitialSnapshot | undefined {
		return this.initialSnapshot;
	}

	/** Own the structured prompt inputs from `before_agent_start`; no-op once frozen. */
	public prepare(options: BuildSystemPromptOptions): void {
		if (this.initialSnapshot !== undefined) return;
		this.pendingPreparation = {
			promptOptions: copyPromptOptions(options),
			toolSnippets: options.toolSnippets === undefined ? undefined : { ...options.toolSnippets },
		};
	}

	/**
	 * Freeze the Initial snapshot from the first context event. Returns the
	 * existing snapshot on repeat calls, or undefined when `prepare()` never ran.
	 */
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
		this.initialSnapshot = buildSnapshot(items, input.origin, input.capturedAt ?? new Date());
		this.pendingPreparation = undefined;
		return this.initialSnapshot;
	}
}

/**
 * Drop the empty message pair the retired silent probe left in a session, or
 * return the messages untouched.
 *
 * The probe is gone, but sessions written before it was retired still carry the
 * identities it persisted, and resuming one would replay an empty user turn and
 * an empty assistant reply into the model context. This reads those identities
 * and never writes them, so it ages out with the sessions that have them.
 */
export type LegacyProbeFilter = (messages: ContextEvent["messages"]) => ContextEvent["messages"];

/**
 * Build the filter for one session's already-persisted probe messages. Returns
 * the identity function — no per-message work at all — for every session
 * written since the probe was retired, which is all of them from now on.
 */
export function createLegacyProbeFilter(entries: readonly SessionEntry[]): LegacyProbeFilter {
	const identities = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PROBE_IDENTITIES_CUSTOM_TYPE) continue;
		for (const identity of parsePersistedIdentities(entry.data)) identities.add(identityKey(identity));
	}
	if (identities.size === 0) return (messages) => messages;
	return (messages) => {
		const kept = messages.filter((message) =>
			(message.role !== "user" && message.role !== "assistant") || !identities.has(identityKey(message))
		);
		// Referential identity is the signal to pi's `context` handler that nothing
		// was rewritten; a fresh array on every event would be a needless rewrite.
		return kept.length === messages.length ? messages : kept;
	};
}

/**
 * Parse one persisted probe-identities entry payload. Malformed or foreign
 * records are ignored so a corrupt entry can never suppress genuine messages.
 */
function parsePersistedIdentities(data: unknown): SyntheticMessageIdentity[] {
	if (typeof data !== "object" || data === null) return [];
	const messages = (data as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return [];
	const identities: SyntheticMessageIdentity[] = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const { role, timestamp } = message as { role?: unknown; timestamp?: unknown };
		if ((role === "user" || role === "assistant") && typeof timestamp === "number" && Number.isFinite(timestamp)) {
			identities.push({ role, timestamp });
		}
	}
	return identities;
}

/** Build a view-local pi-native snapshot without freezing the main capture state. */
export function buildNativeSnapshot(input: NativeSnapshotInput): InitialSnapshot {
	const options = copyPromptOptions(input.options);
	const tools = captureActiveTools(input.allTools, input.activeToolNames, input.options);
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools);
	return buildSnapshot(items, "pi-native", input.capturedAt ?? new Date());
}

/** Add frozen context-only messages to a current prompt/tool snapshot for Usage. */
export function mergeContextOnlyMessages(
	snapshot: InitialSnapshot,
	initial: InitialSnapshot,
): InitialSnapshot {
	const contextOnly = initial.groups.flatMap((group) =>
		group.items.filter((item) => item.kind === "message" && item.contextOnly === true)
	);
	if (contextOnly.length === 0) return snapshot;
	const items = [
		...snapshot.groups.flatMap((group) => group.items),
		...contextOnly,
	];
	return buildSnapshot(items, snapshot.origin, snapshot.capturedAt);
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

/**
 * Measure extension messages while excluding ordinary session history. Custom
 * messages remain attributable by customType; other roles are captured only
 * when they differ from the session-branch baseline.
 */
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

/** Count structurally identical baseline messages for order-independent diffing. */
function messageSignatureCounts(messages: ContextEvent["messages"]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of messages) {
		const signature = JSON.stringify(message);
		counts.set(signature, (counts.get(signature) ?? 0) + 1);
	}
	return counts;
}

/** Consume one matching baseline occurrence, returning false for a context-only message. */
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

/** Extract provider-bound message content for raw preview. */
function messageText(message: ContextEvent["messages"][number]): string {
	if (!("content" in message)) return JSON.stringify(message);
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

/** Map key uniquely identifying one legacy probe message by role and timestamp. */
function identityKey(identity: SyntheticMessageIdentity): string {
	return `${identity.role}:${identity.timestamp}`;
}

/** Attribute a custom-role message to its customType; the actual injector is unknowable. */
function messageSource(customType: string): InjectionSource {
	return { id: `message-type:${customType}`, label: customType, native: false };
}

/** Normalize the string-or-array promptGuidelines field to an owned array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
