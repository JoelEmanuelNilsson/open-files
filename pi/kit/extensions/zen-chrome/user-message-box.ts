import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOTTOM_ENDS, type Paint, type Piece, rule, SIDE, stripAnsi, TOP_ENDS } from "../../lib/ui/labelled-rule.ts";
import { SGR_RESET } from "../../lib/ui/rgb-color.ts";

/** Columns taken by the left and right edges. */
export const FRAME = 2;

export const INSET = FRAME + 2;

export const MIN_WIDTH = 16;

function isBlank(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start] ?? "")) start++;
	while (end > start && isBlank(lines[end - 1] ?? "")) end--;
	return lines.slice(start, end);
}

function exactly(line: string, width: number): string {
	const overflow = visibleWidth(line) - width;
	if (overflow > 0) return truncateToWidth(line, width, "") + SGR_RESET;
	return line + " ".repeat(-overflow);
}

export function frameUserMessageBox(body: string[], width: number, label: Piece[], border: Paint): string[] {
	if (width < MIN_WIDTH) return [];
	const rows = trimBlank(body);
	if (rows.length === 0) return [];

	const side = border(SIDE);
	const inner = width - INSET;
	return [
		rule(width, label, [], border, TOP_ENDS),
		...rows.map((row) => side + " " + exactly(row, inner) + " " + side),
		rule(width, [], [], border, BOTTOM_ENDS),
	];
}
