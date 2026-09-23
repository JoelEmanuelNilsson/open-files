/**
 * Stops the dock under the transcript from reserving rows a component does not
 * draw, so the prompt box sits on the bottom line of the screen.
 *
 * pi stacks the strip under the transcript as a VStack — pending messages,
 * status, widgets, editor, widgets, footer (chat-viewport.ts) — and gives the
 * editor entry `minSize: 3`. In fullscreen that minimum is a floor, not a
 * fallback: pi-tui's `allocateStackSizes` clamps every entry up to its
 * `minSize`, so the prompt box folded to one row still gets three, and the
 * spare rows sit blank under it. (The footer entry had `minSize: 1` and
 * the same blank row; pi now gives it 0.)
 *
 * A component cannot render fewer than zero lines, so the rows can only be
 * reclaimed by telling the layout they are not wanted. `fitDockRows` finds
 * the stack entry a docked component sits in and hands back a setter for that
 * entry's minimum height. pi-tui measures children by rendering them and only
 * then allocates sizes (layout.ts: `measureHeight`, then
 * `allocateStackSizes`), so calling the setter from inside the component's own
 * `render` lands in the same frame — no lag, no extra render.
 *
 * Why a minimum per frame instead of a flat zero: `minSize` is also what
 * protects a component from being shrunk away when the terminal is too short
 * for everything. Asking for exactly the rows it is about to use keeps that
 * protection whenever there is something to show, and gives the rows back the
 * rest of the time. `capDockFloor` does the same for the editor without ever
 * going above pi's own floor.
 *
 * Every step here reaches into pi's layout internals, so every step is
 * optional. No layout root (pi's `regular` tuiMode drives the components as a
 * flat list, where an empty render already costs nothing), no stack, or a
 * reshuffled dock all end in a setter that does nothing and a blank row that
 * stays. Chrome must never be able to break a render.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";

/** pi-tui's layout protocol, keyed by a registered symbol so no import is needed. */
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** The slice of pi-tui's `StackLayoutEntry` this file writes to. */
interface Entry {
	component: unknown;
	minSize?: number;
	visible?: (viewport: { width: number; height: number }) => boolean;
}

interface Stack {
	type: string;
	entries: Entry[];
}

function stackOf(component: unknown): Stack | undefined {
	const node = (component as Record<symbol, unknown> | undefined)?.[LAYOUT_NODE];
	if (typeof node !== "function") return undefined;
	const layout = node.call(component) as Stack | undefined;
	if (!layout || (layout.type !== "vstack" && layout.type !== "hstack")) return undefined;
	return Array.isArray(layout.entries) ? layout : undefined;
}

/** Whether `target` is `root` or anywhere in its children. */
function contains(root: unknown, target: unknown): boolean {
	if (root === target) return true;
	const children = (root as { children?: unknown } | undefined)?.children;
	if (!Array.isArray(children)) return false;
	return children.some((child) => contains(child, target));
}

/**
 * The innermost stack entry holding `target`.
 *
 * Innermost, because the outer stacks hold it too: the dock's entry for the
 * footer container is the one whose height is the footer's, while the root's
 * entry for the dock is the whole strip.
 */
function entryFor(root: unknown, target: unknown): Entry | undefined {
	return holderOf(root, target)?.entry;
}

/** The innermost stack holding `target`, and its entry there. */
function holderOf(root: unknown, target: unknown): { stack: Stack; entry: Entry } | undefined {
	const stack = stackOf(root);
	if (!stack) return undefined;
	for (const entry of stack.entries) {
		if (!contains(entry.component, target)) continue;
		return holderOf(entry.component, target) ?? { stack, entry };
	}
	return undefined;
}

/**
 * Finds the stack entry holding a docked component, lazily so it can be wired
 * up before the component exists, and again whenever the entry it found no
 * longer holds it — pi swaps what sits in the editor's container.
 */
function dockEntry(tui: TUI, component: () => Component | undefined): () => Entry | undefined {
	let entry: Entry | undefined;
	return () => {
		const target = component();
		if (!target) return undefined;
		if (entry && contains(entry.component, target)) return entry;
		const root = (tui as { layoutRoot?: Component }).layoutRoot;
		entry = root ? entryFor(root, target) : undefined;
		return entry;
	};
}

/**
 * Returns a setter for the minimum number of rows the layout reserves for
 * `component`, resolved lazily so it can be wired up before the component
 * exists and re-resolved for as long as it cannot be found.
 */
export function fitDockRows(tui: TUI, component: () => Component | undefined): (rows: number) => void {
	const find = dockEntry(tui, component);
	return (rows: number) => {
		try {
			const entry = find();
			if (entry) entry.minSize = Math.max(0, Math.floor(rows));
		} catch {}
	};
}

/**
 * Returns a setter that lowers pi's minimum rows for a docked component to the
 * rows it is about to render, and never raises it past pi's own floor — the
 * floor pi's dock layout set is still the protection a full-height render gets.
 */
export function capDockFloor(tui: TUI, component: () => Component | undefined): (rows: number) => void {
	const find = dockEntry(tui, component);
	const floors = new WeakMap<Entry, number>();
	return (rows: number) => {
		try {
			const entry = find();
			if (!entry) return;
			const floor = floors.get(entry) ?? entry.minSize ?? 0;
			floors.set(entry, floor);
			entry.minSize = Math.min(floor, Math.max(0, Math.floor(rows)));
		} catch {}
	};
}

/** Entries already told to hide while blank; the predicate is installed once per entry. */
const hidingWhenBlank = new WeakSet<Entry>();

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Hides every dock entry above `component` for as long as it renders nothing
 * but blank rows, so the box sits directly under the last transcript row.
 *
 * pi keeps a `Spacer(1)` in the widgets-above container whenever no widget is
 * there (`renderWidgetContainer`, `spacerWhenEmpty`), which is a blank row
 * between the transcript and the prompt box on every frame. The box's own top
 * rule already separates the two. An entry with any text in it — a widget, a
 * steering message, a status — stays exactly as pi drew it.
 *
 * Done with the entry's own `visible` predicate, which pi-tui asks before it
 * measures anything, so from then on the row is gone in the same frame it
 * would have appeared in. The frame that installs it was measured without it,
 * so that one asks for another. Call it from the component's render;
 * installing is idempotent.
 */
export function hideBlankRowsAbove(tui: TUI, component: () => Component | undefined): () => void {
	return () => {
		try {
			const target = component();
			const root = (tui as { layoutRoot?: Component }).layoutRoot;
			if (!target || !root) return;
			const holder = holderOf(root, target);
			if (!holder || holder.stack.type !== "vstack") return;
			for (const entry of holder.stack.entries) {
				if (entry === holder.entry) return;
				if (hidingWhenBlank.has(entry)) continue;
				hidingWhenBlank.add(entry);
				tui.requestRender();
				const shown = entry.visible;
				const above = entry.component as Component;
				entry.visible = (viewport) => {
					if (shown && !shown(viewport)) return false;
					try {
						return above.render(viewport.width).some((line) => line.replace(ANSI, "").trim() !== "");
					} catch {
						return true;
					}
				};
			}
		} catch {}
	};
}
