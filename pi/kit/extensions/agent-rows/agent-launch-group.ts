import { AGENT_TOOL_NAMES, DEFAULT_AGENT_TYPE } from "../../lib/agents/agent-tool-text.ts";
import { processShared } from "../../lib/process/process-shared-state.ts";
import { argumentsStreaming } from "../../lib/transcript/streaming-arguments.ts";
import type { RenderContext } from "../../lib/transcript/tool-row.ts";

/** What a member row reported about itself once its result landed. */
export interface LaunchOutcome {
	status: string;
	displayName: string;
	description: string;
}

interface LaunchBatch {
	ids: string[];
	expanded: boolean;
}

export interface LaunchCall {
	displayName: string;
	description: string;
}

interface LaunchSeat {
	batch: LaunchBatch;
	index: number;
	call: LaunchCall | undefined;
}

interface LaunchRegistry {
	seats: Map<string, LaunchSeat>;
	outcomes: Map<string, LaunchOutcome>;
	redraws: Map<string, () => void>;
}

const REGISTRY_KEY = Symbol.for("pi.kit.agent-rows.launches");

const registry = (): LaunchRegistry => processShared(REGISTRY_KEY, () => ({ seats: new Map(), outcomes: new Map(), redraws: new Map() }));

interface Block {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	partialJson?: unknown;
	partialArgs?: unknown;
	n?: unknown;
}

function callOf(block: Block): LaunchCall | undefined {
	const args = block.arguments;
	if (typeof args !== "object" || args === null) return undefined;
	if (argumentsStreaming(block)) return undefined;
	// SAFETY: args is read only through typeof checks on both fields
	const { description, subagent_type: type } = args as { description?: unknown; subagent_type?: unknown };
	if (typeof description !== "string" || description === "") return undefined;
	return { displayName: launchBadgeOf(type), description };
}

/** The name a launch row shows for an agent type: the engine's default type is badged `Agent`, every other type by its own name. */
export function launchBadgeOf(type: unknown): string {
	return typeof type === "string" && type !== "" && type !== DEFAULT_AGENT_TYPE ? type : "Agent";
}

interface StreamedMessage {
	role?: string;
	content?: unknown;
}

export function toolCallStreamProgress(message: StreamedMessage): number {
	const content = message.content;
	if (!Array.isArray(content)) return 0;
	let calls = 0;
	let closed = 0;
	for (const value of content) {
		// SAFETY: content blocks are null-checked and compared on type before any other field is read
		const block = value as Block | null;
		if (block?.type !== "toolCall") continue;
		calls += 1;
		if (!argumentsStreaming(block)) closed += 1;
	}
	return calls * 1024 + closed;
}

export function planAgentLaunches(message: StreamedMessage): void {
	if (message.role !== "assistant") return;
	const content = message.content;
	if (!Array.isArray(content)) return;
	const state = registry();
	const touched: string[] = [];
	const before = new Map<string, string>();
	const remember = (id: string) => {
		if (!before.has(id)) {
			before.set(id, partOf(state.seats.get(id)));
			touched.push(id);
		}
	};

	let run: { id: string; call: LaunchCall | undefined }[] = [];
	const flush = () => {
		for (const { id } of run) remember(id);
		if (run.length >= 2) {
			const ids = run.map((entry) => entry.id);
			const previous = state.seats.get(ids[0] ?? "")?.batch;
			const batch: LaunchBatch = { ids, expanded: previous?.expanded === true && grewFrom(previous, ids) };
			run.forEach(({ id, call }, index) => state.seats.set(id, { batch, index, call }));
		} else {
			for (const { id } of run) state.seats.delete(id);
		}
		run = [];
	};

	for (const value of content) {
		// SAFETY: value is a non-null object here, else the empty object; Block fields are all optional
		const block = (typeof value === "object" && value !== null ? value : {}) as Block;
		if (block.type !== "toolCall") continue;
		if (block.name !== AGENT_TOOL_NAMES.AGENT || typeof block.id !== "string") {
			flush();
			continue;
		}
		run.push({ id: block.id, call: callOf(block) });
	}
	flush();

	const wake = new Set<string>();
	for (const id of touched) {
		if (before.get(id) === partOf(state.seats.get(id))) continue;
		wake.add(id);
		const speaker = state.seats.get(id)?.batch.ids[0];
		if (speaker !== undefined) wake.add(speaker);
	}
	for (const id of wake) redraw(id);
}

function partOf(seat: LaunchSeat | undefined): string {
	if (!seat) return "";
	const call = seat.call ? `${seat.call.displayName}\u0001${seat.call.description}` : "";
	return `${seat.batch.ids.join(" ")}\u0000${seat.index}\u0000${call}`;
}

function grewFrom(previous: LaunchBatch, ids: string[]): boolean {
	if (previous.ids.length > ids.length) return false;
	return previous.ids.every((id, index) => ids[index] === id);
}

type LaunchRole = "row" | "block" | "hidden";

function intact(batch: LaunchBatch, outcomes: Map<string, LaunchOutcome>): boolean {
	return batch.ids.every((id) => {
		const outcome = outcomes.get(id);
		return outcome === undefined || outcome.status === "background";
	});
}

/** What this launch row draws on this frame; the speaker's frame also opens or closes its batch. */
export function launchRoleOf(context: RenderContext): LaunchRole {
	const state = registry();
	const seat = state.seats.get(context.toolCallId);
	if (!seat || !intact(seat.batch, state.outcomes)) return "row";
	const { batch, index } = seat;
	if (index !== 0) {
		if (context.expanded === true) return "row";
		return batch.expanded ? "row" : "hidden";
	}
	openBatch(batch, context.expanded === true);
	if (context.expanded === true) return "row";
	return "block";
}

function openBatch(batch: LaunchBatch, expanded: boolean): void {
	if (batch.expanded === expanded) return;
	batch.expanded = expanded;
	const members = batch.ids.slice(1);
	queueMicrotask(() => {
		for (const id of members) redraw(id);
	});
}

/** The facts the block draws, in launch order. Undefined when this row is not a speaker. */
export function launchBatchOf(
	id: string,
): { outcomes: (LaunchOutcome | undefined)[]; calls: (LaunchCall | undefined)[]; settled: boolean } | undefined {
	const state = registry();
	const seat = state.seats.get(id);
	if (!seat || seat.index !== 0) return undefined;
	const outcomes = seat.batch.ids.map((member) => state.outcomes.get(member));
	const calls = seat.batch.ids.map((member) => state.seats.get(member)?.call);
	return { outcomes, calls, settled: outcomes.every((outcome) => outcome !== undefined) };
}

/** Called from the header slot, the one slot every row reaches on every frame. */
export function noteLaunchRow(context: RenderContext): void {
	const id = context.toolCallId;
	if (typeof id !== "string" || typeof context.invalidate !== "function") return;
	registry().redraws.set(id, context.invalidate);
}

export function noteLaunchOutcome(id: string, outcome: LaunchOutcome): void {
	const state = registry();
	const previous = state.outcomes.get(id);
	if (previous && previous.status === outcome.status && previous.description === outcome.description && previous.displayName === outcome.displayName) return;
	state.outcomes.set(id, outcome);
	const seat = state.seats.get(id);
	if (!seat) return;
	const speaker = seat.batch.ids[0];
	const wake = intact(seat.batch, state.outcomes) ? (speaker === undefined ? [] : [speaker]) : seat.batch.ids;
	queueMicrotask(() => {
		for (const member of wake) redraw(member);
	});
}

function redraw(id: string): void {
	const invalidate = registry().redraws.get(id);
	if (!invalidate) return;
	try {
		invalidate();
	} catch {
	}
}

export function forgetAgentLaunches(): void {
	const state = registry();
	const drawn = [...state.seats.keys()];
	state.seats.clear();
	state.outcomes.clear();
	for (const id of drawn) redraw(id);
	state.redraws.clear();
}
