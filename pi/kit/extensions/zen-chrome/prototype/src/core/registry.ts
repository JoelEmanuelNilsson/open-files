/** PROTOTYPE — throwaway. Every file in src/effects that default-exports an Effect shows up here. */

import type { Effect } from "./types.ts";

const modules = import.meta.glob<{ default: Effect }>("../effects/*.ts", { eager: true });

const found = Object.entries(modules)
	.map(([path, mod]) => ({ path, effect: mod.default }))
	.filter((entry): entry is { path: string; effect: Effect } => Boolean(entry.effect?.id));

/** The current zen-chrome wave sorts first; it is the thing being replaced. */
export const EFFECTS: Effect[] = found
	.map((entry) => entry.effect)
	.sort((a, b) => {
		if (a.id === "wave") return -1;
		if (b.id === "wave") return 1;
		return a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group);
	});

export function effectById(id: string | null): Effect {
	return EFFECTS.find((e) => e.id === id) ?? (EFFECTS[0] as Effect);
}

/** Default parameter values for one effect. */
export function defaultParams(effect: Effect): Record<string, number> {
	const out: Record<string, number> = {};
	for (const spec of effect.params ?? []) out[spec.key] = spec.value;
	return out;
}
