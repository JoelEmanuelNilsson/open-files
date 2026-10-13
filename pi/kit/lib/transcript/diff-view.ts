import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Keybinding, sliceByColumn, truncateToWidth } from "@earendil-works/pi-tui";
import { bg, indexFromPainted, lerp, luminance, type Rgb, rgbFromPainted } from "../ui/rgb-color.ts";
import { slotColors } from "../ui/terminal-slot-colors.ts";
import { type DiffMode, type DiffPalette, layoutDiff } from "./split-diff.ts";
import type { Paint } from "../ui/labelled-rule.ts";

/** Lines a collapsed diff shows before it counts the rest. */
export const DIFF_PREVIEW_LINES = 24;

const RESET_BG = "\x1b[49m";
const RESET_FG = "\x1b[39m";

const ROW_LUMA = 65;
const SPAN_LUMA = 120;

function backgroundOf(fgAnsi: string): string {
	return fgAnsi.replace("[38;", "[48;");
}

function scaledEmphasis(rgb: Rgb): string {
	const scale = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b < 128 ? 1.8 : 0.6;
	const channel = (value: number) => Math.min(255, Math.round(value * scale));
	return `\x1b[48;2;${channel(rgb.r)};${channel(rgb.g)};${channel(rgb.b)}m`;
}

function tint(surface: Rgb, color: Rgb, delta: number): Rgb {
	const reach = Math.abs(luminance(color) - luminance(surface));
	return lerp(surface, color, reach < 1 ? 1 : Math.min(1, delta / reach));
}

function backgrounds(fgAnsi: string): [row: string, span: string] | null {
	const hex = rgbFromPainted(fgAnsi);
	if (hex !== null) return [backgroundOf(fgAnsi), scaledEmphasis(hex)];
	const slot = indexFromPainted(fgAnsi);
	if (slot === null) return null;
	const colors = slotColors();
	const color = colors.get(slot);
	const surface = colors.background();
	if (color === undefined || surface === undefined) return null;
	return [bg(tint(surface, color, ROW_LUMA)), bg(tint(surface, color, SPAN_LUMA))];
}

function paintOf(fgAnsi: string, which: 0 | 1): Paint {
	if (fgAnsi === "") return (text) => text;
	return (text) => {
		const pair = backgrounds(fgAnsi);
		if (pair === null) return `${fgAnsi}${text}${RESET_FG}`;
		return `${pair[which]}${text}${RESET_BG}`;
	};
}

function escapeOf(theme: Theme, color: "toolDiffAdded" | "toolDiffRemoved"): string {
	try {
		return theme.getFgAnsi(color);
	} catch {
		return "";
	}
}

export function diffPalette(theme: Theme): DiffPalette {
	const added = escapeOf(theme, "toolDiffAdded");
	const removed = escapeOf(theme, "toolDiffRemoved");
	return {
		removed: paintOf(removed, 0),
		added: paintOf(added, 0),
		context: (text) => theme.fg("toolDiffContext", text),
		note: (text) => theme.fg("accent", text),
		separator: (text) => theme.fg("dim", text),
		removedEmphasis: paintOf(removed, 1),
		addedEmphasis: paintOf(added, 1),
	};
}

function safeHint(id: Keybinding, description: string): string {
	try {
		return keyHint(id, description);
	} catch {
		return description;
	}
}

/** `PI_DIFF_MODE=split|unified` pins the layout; anything else decides per hunk. */
export function configuredMode(): DiffMode {
	const setting = process.env.PI_DIFF_MODE;
	return setting === "split" || setting === "unified" ? setting : "auto";
}

export class DiffView implements Component {
	private cachedWidth?: number;
	private cachedColors?: number;
	private cachedLines?: string[];

	constructor(
		private readonly diff: string,
		private readonly palette: DiffPalette,
		private readonly mode: DiffMode,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		const colors = slotColors().version;
		if (this.cachedLines && this.cachedWidth === width && this.cachedColors === colors) return this.cachedLines;

		let lines: string[];
		try {
			lines = layoutDiff(this.diff, width, { palette: this.palette, mode: this.mode });
		} catch {
			lines = this.diff.split("\n").map((line) => this.palette.context(sliceByColumn(line, 0, width, true)));
		}

		if (!this.expanded && lines.length > DIFF_PREVIEW_LINES) {
			const hidden = lines.length - DIFF_PREVIEW_LINES;
			const note = `${this.palette.context(`… ${hidden} more lines`)} (${safeHint("app.tools.expand", "expand to see")})`;
			lines = [...lines.slice(0, DIFF_PREVIEW_LINES), truncateToWidth(note, width)];
		}

		this.cachedWidth = width;
		this.cachedColors = colors;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedColors = undefined;
		this.cachedLines = undefined;
	}
}
