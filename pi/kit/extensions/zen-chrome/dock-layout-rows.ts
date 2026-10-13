import type { Component, TUI } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../lib/ui/labelled-rule.ts";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

const FLOOR = Symbol.for("pi-kit/zen-chrome/dock-floor");
const BLANK_HIDING = Symbol.for("pi-kit/zen-chrome/blank-hiding");

type Visible = NonNullable<Entry["visible"]>;

interface Entry {
	[FLOOR]?: number;
	component: unknown;
	minSize?: number;
	visible?: ((viewport: { width: number; height: number }) => boolean) & { [BLANK_HIDING]?: { original: Visible | undefined } };
}

interface Stack {
	type: string;
	entries: Entry[];
}

function stackOf(component: unknown): Stack | undefined {
	// SAFETY: the symbol read yields unknown and is checked to be a function below
	const node = (component as Record<symbol, unknown> | undefined)?.[LAYOUT_NODE];
	if (typeof node !== "function") return undefined;
	// SAFETY: pi's LAYOUT_NODE method returns a stack node; type is checked on the next line
	const layout = node.call(component) as Stack | undefined;
	if (!layout || (layout.type !== "vstack" && layout.type !== "hstack")) return undefined;
	return Array.isArray(layout.entries) ? layout : undefined;
}

function contains(root: unknown, target: unknown): boolean {
	if (root === target) return true;
	// SAFETY: children is read as unknown and Array.isArray-checked on the next line
	const children = (root as { children?: unknown } | undefined)?.children;
	if (!Array.isArray(children)) return false;
	return children.some((child) => contains(child, target));
}

function entryFor(root: unknown, target: unknown): Entry | undefined {
	return holderOf(root, target)?.entry;
}

function holderOf(root: unknown, target: unknown): { stack: Stack; entry: Entry } | undefined {
	const stack = stackOf(root);
	if (!stack) return undefined;
	for (const entry of stack.entries) {
		if (!contains(entry.component, target)) continue;
		return holderOf(entry.component, target) ?? { stack, entry };
	}
	return undefined;
}

function rememberFloor(entry: Entry): number {
	entry[FLOOR] ??= entry.minSize ?? 0;
	return entry[FLOOR];
}

function dockEntry(tui: TUI, component: () => Component | undefined): () => Entry | undefined {
	let entry: Entry | undefined;
	return () => {
		const target = component();
		if (!target) return undefined;
		if (entry && contains(entry.component, target)) return entry;
		// SAFETY: pi's TUI has a layoutRoot field that is absent from its types; it is undefined before first render
		const root = (tui as { layoutRoot?: Component }).layoutRoot;
		entry = root ? entryFor(root, target) : undefined;
		return entry;
	};
}

export function fitDockRows(tui: TUI, component: () => Component | undefined): (rows: number) => void {
	const find = dockEntry(tui, component);
	return (rows: number) => {
		try {
			const entry = find();
			if (!entry) return;
			rememberFloor(entry);
			entry.minSize = Math.max(0, Math.floor(rows));
		} catch {}
	};
}

export function capDockFloor(tui: TUI, component: () => Component | undefined): (rows: number) => void {
	const find = dockEntry(tui, component);
	return (rows: number) => {
		try {
			const entry = find();
			if (!entry) return;
			entry.minSize = Math.min(rememberFloor(entry), Math.max(0, Math.floor(rows)));
		} catch {}
	};
}

export function hideBlankRowsAbove(tui: TUI, component: () => Component | undefined): () => void {
	return () => {
		try {
			const target = component();
			// SAFETY: pi's TUI has a layoutRoot field that is absent from its types; it is checked before use
			const root = (tui as { layoutRoot?: Component }).layoutRoot;
			if (!target || !root) return;
			const holder = holderOf(root, target);
			if (!holder || holder.stack.type !== "vstack") return;
			for (const entry of holder.stack.entries) {
				if (entry === holder.entry) return;
				if (entry.visible?.[BLANK_HIDING]) continue;
				tui.requestRender();
				const shown = entry.visible;
				// SAFETY: entry.component was found in the layout tree, so it is a Component
				const above = entry.component as Component;
				const hiding: Visible & { [BLANK_HIDING]?: { original: Visible | undefined } } = (viewport) => {
					if (shown && !shown(viewport)) return false;
					try {
						return above.render(viewport.width).some((line) => stripAnsi(line).trim() !== "");
					} catch {
						return true;
					}
				};
				hiding[BLANK_HIDING] = { original: shown };
				entry.visible = hiding;
			}
		} catch {}
	};
}

/** Put back every floor and visibility predicate this module (or an earlier copy of it) changed under `tui`. */
export function restoreDockLayout(tui: TUI): void {
	// SAFETY: pi's TUI has a layoutRoot field that is absent from its types; it is checked before use
	const root = (tui as { layoutRoot?: Component }).layoutRoot;
	if (root) restoreUnder(root);
}

function restoreUnder(component: unknown): void {
	const stack = stackOf(component);
	if (!stack) return;
	for (const entry of stack.entries) {
		if (entry[FLOOR] !== undefined) {
			entry.minSize = entry[FLOOR];
			delete entry[FLOOR];
		}
		const hiding = entry.visible?.[BLANK_HIDING];
		if (hiding) entry.visible = hiding.original;
		restoreUnder(entry.component);
	}
}
