import { type Group, plan } from "./rollup-plan.ts";
import { type Seat, transcriptPlannerState } from "./rollup-planner-state.ts";
import { heldHint, type Hint } from "./hint-hold.ts";
import { type RenderContext, rowState } from "./tool-row.ts";

const SPEAKER = 0;

export type Role = "row" | "line" | "hidden";

function planner() {
	return transcriptPlannerState();
}

export function noteRow(context: RenderContext): void {
	const id = context.toolCallId;
	if (typeof id !== "string" || typeof context.invalidate !== "function") return;
	planner().redraws.set(id, context.invalidate);
	began(id, rowState(context).startedAt);
}

function began(id: string, at: number | undefined): void {
	const group = planner().seats.get(id)?.group;
	if (at === undefined || !group) return;
	if (group.startedAt !== undefined && group.startedAt <= at) return;
	group.startedAt = at;
	retime();
}

export function roleOf(context: RenderContext): Role {
	const seat = planner().seats.get(context.toolCallId);
	if (!seat) return "row";
	const { group, index } = seat;
	if (index !== SPEAKER) {
		if (context.expanded === true) return "row";
		return group.expanded ? "row" : "hidden";
	}
	open(group, context.expanded === true);
	if (context.expanded === true) return "row";
	return "line";
}

function hintOf(group: Group): string | undefined {
	for (let index = group.ids.length - 1; index >= 0; index--) {
		const said = group.hints[index];
		if (said !== undefined && said !== "") return said;
	}
	return undefined;
}

export function lineOf(id: string): { tools: string[]; subjects: (string | undefined)[]; live: boolean; startedAt?: number; hint?: string } | undefined {
	const seat = planner().seats.get(id);
	if (!seat) return undefined;
	const { group } = seat;
	const hint = holdHint(group);
	return { tools: group.tools, subjects: group.subjects, live: group.running, startedAt: group.startedAt, hint };
}

function holdHint(group: Group): string | undefined {
	const speaker = group.ids[SPEAKER] ?? "";
	const said = group.running ? hintOf(group) : undefined;
	const shown: Hint | undefined = said === undefined ? undefined : { line: said, hidden: 0 };
	return heldHint(group, shown, !group.running, () => redraw(speaker))?.line;
}

function open(group: Group, expanded: boolean): void {
	if (group.expanded === expanded) return;
	group.expanded = expanded;
	const speaker = group.ids[SPEAKER];
	const members = group.ids.filter((id) => id !== speaker);
	queueMicrotask(() => {
		for (const id of members) redraw(id);
	});
}

function redraw(id: string): void {
	const invalidate = planner().redraws.get(id);
	if (!invalidate) return;
	try {
		invalidate();
	} catch {
	}
}

const TICK_MS = 1000;

function ticking(): string[] {
	const out: string[] = [];
	const seen = new Set<Group>();
	for (const { group } of planner().seats.values()) {
		if (seen.has(group)) continue;
		seen.add(group);
		if (!group.running || group.startedAt === undefined) continue;
		const id = group.ids[SPEAKER];
		if (id !== undefined) out.push(id);
	}
	return out;
}

function retime(): void {
	const state = planner();
	if (ticking().length === 0) {
		stopTicking();
		return;
	}
	if (state.ticker !== undefined) return;
	// raw-timer: a TUI component timer: row clocks, redrawn through their components
	const timer = setInterval(() => {
		const rows = ticking();
		if (rows.length === 0) {
			stopTicking();
			return;
		}
		for (const id of rows) redraw(id);
	}, TICK_MS);
	timer.unref?.();
	state.ticker = timer;
}

export function stopTicking(): void {
	const state = planner();
	if (state.ticker === undefined) return;
	clearInterval(state.ticker);
	state.ticker = undefined;
}

export function regroup(entries: readonly unknown[], live = false): void {
	const state = planner();
	const seats = state.seats;
	const next = new Map<string, Seat>();
	for (const group of plan(entries, live)) {
		const previous = seats.get(group.ids[0] ?? "")?.group;
		if (previous && grewFrom(previous, group)) {
			if (previous.expanded) group.expanded = true;
			group.startedAt = previous.startedAt;
			group.hint = previous.hint;
		}
		group.ids.forEach((id, index) => next.set(id, { group, index }));
	}
	const changed = new Set<string>();
	for (const [id, seat] of seats) if (partOf(next.get(id)) !== partOf(seat)) changed.add(id);
	for (const [id, seat] of next) if (partOf(seats.get(id)) !== partOf(seat)) changed.add(id);
	state.seats = next;
	retime();
	for (const id of changed) redraw(id);
}

function partOf(seat: Seat | undefined): string {
	if (!seat) return "";
	const group = seat.group;
	return `${group.key}\u0000${seat.index}\u0000${group.running}\u0000${group.subjects.join("\u0001")}\u0000${group.hints.join("\u0001")}`;
}

function grewFrom(previous: Group, group: Group): boolean {
	if (previous.ids.length > group.ids.length) return false;
	return previous.ids.every((id, index) => group.ids[index] === id);
}

export function forgetRows(): void {
	planner().redraws.clear();
}

/** Puts every row back the way pi drew it. For tests and when the extension shuts down. */
export function ungroup(): void {
	stopTicking();
	const state = planner();
	const drawn = [...state.seats.keys()];
	for (const { group } of state.seats.values()) heldHint(group, undefined, true, () => {});
	state.seats = new Map();
	state.arrivals.clear();
	for (const id of drawn) redraw(id);
	state.redraws.clear();
}

export function noteResult(id: string, failed: boolean): void {
	if (typeof id !== "string") return;
	planner().arrivals.set(id, { failed });
}

/** Dropped when the next run starts: by then the session has said it all itself. */
export function forgetResults(): void {
	planner().arrivals.clear();
}
