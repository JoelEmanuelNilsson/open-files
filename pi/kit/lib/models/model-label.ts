import { familyOf } from "./model-family.ts";
import { SGR_RESET } from "../ui/rgb-color.ts";

export function shortModelId(id: string): string {
	return familyOf(id) ?? id;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** What the slider needs of a model: whether it reasons at all, and which levels it maps. */
export interface ThinkingModel {
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Readonly<Record<string, string | null | undefined>>;
}

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

export function thinkingScale(model: ThinkingModel | undefined, level: string): ThinkingScale | null {
	const levels = thinkingLevels(model);
	const index = levels.indexOf(level);
	return levels.length < 2 || index < 0 ? null : { index, count: levels.length };
}

export const NOTCH = "▱";

export function effortSlider(scale: ThinkingScale): string {
	return NOTCH.repeat(scale.count);
}

export function paintSlider(scale: ThinkingScale, colorAt: (at: number, lit: boolean) => string): string {
	const span = Math.max(scale.count - 1, 1);
	return Array.from(
		{ length: scale.count },
		(_, slot) => `${colorAt(slot / span, slot === scale.index)}${NOTCH}${SGR_RESET}`,
	).join("");
}
