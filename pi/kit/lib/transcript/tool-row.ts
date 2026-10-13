import type { Component } from "@earendil-works/pi-tui";
import type { HintHold } from "./hint-hold.ts";
import { transcriptPlannerState } from "./rollup-planner-state.ts";
import { formatCallDuration, type Summary } from "./call-summary.ts";
import { envSwitchOff } from "./env-switch.ts";

export const DOT = "●";
export const CUT = "○";

export const BLANK: Component = { render: () => [], invalidate: () => {} };

export interface RenderContext {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: unknown;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

export interface RowState extends HintHold {
	startedAt?: number;
	endedAt?: number;
	aborted?: boolean;
	summary?: Summary | null;
	exists?: boolean;
	line?: number;
	offTranscript?: true;
}

export function rowState(context: RenderContext): RowState {
	const state = context.state;
	// SAFETY: RowState has only optional fields, so any object satisfies it; non-objects become {}
	return (typeof state === "object" && state !== null ? state : {}) as RowState;
}

export function startClock(context: RenderContext): void {
	const state = rowState(context);
	if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
}

export function watchInFlightRow(context: RenderContext): void {
	const inFlight = transcriptPlannerState().inFlight;
	if (rowState(context).offTranscript) return;
	if (!context.isPartial || context.isError) {
		inFlight.delete(context.toolCallId);
		return;
	}
	inFlight.set(context.toolCallId, { state: rowState(context), invalidate: context.invalidate });
}

export function quiesce(): void {
	const inFlight = transcriptPlannerState().inFlight;
	for (const { state, invalidate } of inFlight.values()) {
		if (state.aborted) continue;
		state.aborted = true;
		try {
			invalidate();
		} catch {
		}
	}
	inFlight.clear();
}

export function stopClock(context: RenderContext): string | null {
	const state = rowState(context);
	if (context.isPartial) return null;
	if (state.endedAt === undefined) state.endedAt = Date.now();
	if (state.startedAt === undefined) return null;
	return formatCallDuration(state.endedAt - state.startedAt);
}

export function transcriptEnabled(): boolean {
	return !envSwitchOff("PI_TRANSCRIPT");
}
