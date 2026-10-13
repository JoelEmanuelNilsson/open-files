import type { TUI } from "@earendil-works/pi-tui";

/** Lines one notch scrolls when the TUI exposes no step of its own. */
export const DEFAULT_WHEEL_SCROLL_LINES = 3;

const SGR_WHEEL_PATTERN = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

const X10_PREFIX = "\x1b[M";
const X10_LENGTH = 6;
const X10_BUTTON_INDEX = 3;
const X10_BYTE_OFFSET = 32;

const WHEEL_BUTTON_BIT = 64;
const DIRECTION_MASK = 3;

/** One notch backwards (up) or forwards (down). */
export type WheelDirection = -1 | 1;

export function parseWheelDirection(data: string): WheelDirection | undefined {
	const sgrButton = SGR_WHEEL_PATTERN.exec(data)?.[1];
	if (sgrButton !== undefined) return decodeWheelButton(Number.parseInt(sgrButton, 10));
	if (data.length === X10_LENGTH && data.startsWith(X10_PREFIX)) {
		return decodeWheelButton(data.charCodeAt(X10_BUTTON_INDEX) - X10_BYTE_OFFSET);
	}
	return undefined;
}

export function readWheelScrollLines(tui: TUI): number {
	// SAFETY: pi's TUI may carry wheelScrollLines; the value is type-checked as a finite number below
	const lines = (tui as { readonly wheelScrollLines?: unknown }).wheelScrollLines;
	if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_WHEEL_SCROLL_LINES;
	return Math.max(1, Math.floor(lines));
}

function decodeWheelButton(button: number): WheelDirection | undefined {
	if ((button & WHEEL_BUTTON_BIT) === 0) return undefined;
	const direction = button & DIRECTION_MASK;
	if (direction === 0) return -1;
	if (direction === 1) return 1;
	return undefined;
}
