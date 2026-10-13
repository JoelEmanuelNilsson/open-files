import { processShared } from "../process/process-shared-state.ts";
import type { Group } from "./rollup-plan.ts";
import type { RowState } from "./tool-row.ts";

/** A row's place in its group. A row with no seat draws itself. */
export interface Seat {
	group: Group;
	index: number;
}

/** A tool result that has happened but has not been written into the session yet. */
export interface Arrival {
	failed: boolean;
}

/** A row that has drawn a header and not yet drawn a result. */
export interface WatchedRow {
	state: RowState;
	invalidate: () => void;
}

export interface TranscriptPlannerState {
	seats: Map<string, Seat>;
	redraws: Map<string, () => void>;
	arrivals: Map<string, Arrival>;
	inFlight: Map<string, WatchedRow>;
	skillPaths: Map<string, string>;
	ticker: ReturnType<typeof setInterval> | undefined;
}

const PLANNER_STATE = Symbol.for("pi.kit.transcript.state");

export function transcriptPlannerState(): TranscriptPlannerState {
	return processShared(PLANNER_STATE, () => ({ seats: new Map(), redraws: new Map(), arrivals: new Map(), inFlight: new Map(), skillPaths: new Map(), ticker: undefined }));
}
