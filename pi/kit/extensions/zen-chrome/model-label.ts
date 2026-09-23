/**
 * The model label in the top rule: family only, then the reasoning effort as a
 * slider. Terminal width is the budget; `claude-fable-5-1 medium` spent it on
 * nothing.
 */

import { familyOf } from "../../lib/model-family.ts";

/**
 * `claude-fable-5-1` → `fable`, `gpt-6-luna` → `luna`; an id with no family
 * passes through untouched. The version is noise: the catalog holds one per family.
 */
export function shortModelId(id: string): string {
	return familyOf(id) ?? id;
}

/**
 * pi's thinking levels, lowest effort first.
 *
 * Pinned against the installed pi by `test/model-label.mjs`: a level pi adds
 * and this list misses would draw a slider shorter than the model's real range,
 * which is a wrong reading rather than a missing one.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** What the slider needs of a model: whether it reasons at all, and which levels it maps. */
export interface ThinkingModel {
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Readonly<Record<string, string | null | undefined>>;
}

/**
 * The levels this model exposes, lowest first.
 *
 * Mirrors pi's own `getSupportedThinkingLevels`, which pi does not export: a
 * level mapped to null is unsupported, and `xhigh` and `max` exist only where
 * the model names a value for them. A model that does not reason has no scale
 * to show, so it gets an empty one rather than pi's one-entry `off`.
 */
export function thinkingLevels(model: ThinkingModel | undefined): string[] {
	if (!model?.reasoning) return [];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level === "xhigh" || level === "max" ? mapped !== undefined : true;
	});
}

/** Where a level sits on a model's scale: which notch, out of how many. */
export interface ThinkingScale {
	readonly index: number;
	readonly count: number;
}

/**
 * Where the current level sits on this model's own scale, or null when there is
 * no scale worth drawing.
 *
 * The range is the model's, not a fixed five: the point of a slider over a word
 * is that its length says how far the level could go, so a model with four
 * levels gets four notches and the label changes width with the model.
 */
export function thinkingScale(model: ThinkingModel | undefined, level: string): ThinkingScale | null {
	const levels = thinkingLevels(model);
	const index = levels.indexOf(level);
	return levels.length < 2 || index < 0 ? null : { index, count: levels.length };
}

/**
 * One slot on the scale.
 *
 * A single glyph and not a filled/empty pair, because the level is said by
 * which slot is lit and a second carrier that says the same thing only makes
 * the strip harder to read: a run of filled cells has to be counted, and its
 * length is the one quantity five cells report badly (2026-09-12). Identical
 * slots leave nothing to count — you look at the lit one.
 */
export const NOTCH = "▱";

/**
 * `▱▱▱▱▱` — the scale as slots, one per level the model offers.
 *
 * The plain text is the track and nothing more: it gives the strip its width
 * and says how far the level could go, but not where it is. Uncoloured, this
 * label does not report the level at all, which is the price of dropping the
 * filled run; `paintSlider` is what makes it readable.
 */
export function effortSlider(scale: ThinkingScale): string {
	return NOTCH.repeat(scale.count);
}

/** Which way the level has moved away from the one the cache was written at. */
export type EffortDrift = "+" | "−";

/**
 * The mark the label wears when the level has moved since the request that
 * filled the cache, and moving it costs that cache: `+` for raised, `−` for
 * lowered. Null when there is nothing to say.
 *
 * `−` is U+2212 and not a hyphen so the two marks are the same width and sit at
 * the same height — one cell that changes meaning, not one that also jumps.
 *
 * Both scales come from the model shown, and `sent` is null when the model
 * itself has changed since: a different model rewrites everything anyway, so a
 * mark blaming the level would be pointing at the wrong cause. `rewrites` is
 * the measured fact, so a model nobody has measured wears no mark rather than
 * a guessed one.
 */
export function effortDrift(now: ThinkingScale, sent: ThinkingScale | null, rewrites: boolean): EffortDrift | null {
	if (!rewrites || sent === null || sent.index === now.index) return null;
	return now.index > sent.index ? "+" : "−";
}

const RESET = "\x1b[0m";

/**
 * The slider painted slot by slot: exactly one is lit — the level — and the
 * rest are the same slot sunk into the background.
 *
 * One lit slot rather than a lit run, because the whole reading is then a
 * position, and position among five cells is read at a glance without counting
 * anything. The contrast that carries it is the one already proven on this
 * strip: a slot the level has not reached sits over 100 in luma from a lit one,
 * while a filled run had to be measured by length.
 *
 * Each slot is coloured at its own place on the arc — 0 at the bottom of the
 * model's range, 1 at the top — so the lit slot's hue names the level a second
 * time, cold at the bottom and warm at the top, and the reading survives even
 * where the eye misjudges the position.
 *
 * `colorAt` turns a place and whether it is the level into an SGR prefix. The
 * caller owns the palette, so this module keeps knowing nothing about the
 * terminal and one painter serves the chrome and its preview alike.
 */
export function paintSlider(scale: ThinkingScale, colorAt: (at: number, lit: boolean) => string): string {
	// A one-slot scale has no span to divide by; `thinkingScale` already declines
	// to draw one, so this only keeps the arithmetic total.
	const span = Math.max(scale.count - 1, 1);
	return Array.from(
		{ length: scale.count },
		(_, slot) => `${colorAt(slot / span, slot === scale.index)}${NOTCH}${RESET}`,
	).join("");
}
