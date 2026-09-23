/**
 * Mouse wheel events, read off the raw input a focused overlay is handed.
 *
 * pi's fullscreen renderer scrolls the transcript on the wheel itself, but
 * while an overlay has the keyboard it steps aside and passes the bytes on
 * (`tui-alt-screen.js` `shouldDeferViewportInputToOverlay`). An overlay that
 * wants to scroll has to read them. Same two encodings pi reads: SGR
 * (`ESC [ < b ; x ; y M`) and X10 (`ESC [ M b x y`), wheel when bit 64 of the
 * button is set, up on 0 and down on 1.
 */

/** `-1` up, `1` down. */
export type WheelDirection = -1 | 1;

const SGR = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;
const X10_PREFIX = "\x1b[M";

function directionOf(button: number): WheelDirection | undefined {
	if ((button & 64) === 0) return undefined;
	const low = button & 3;
	if (low === 0) return -1;
	if (low === 1) return 1;
	return undefined;
}

/** The wheel direction in `data`, or undefined when it is not a wheel event. */
export function wheelDirection(data: string): WheelDirection | undefined {
	const sgr = SGR.exec(data);
	if (sgr) return directionOf(Number.parseInt(sgr[1] ?? "", 10));
	if (data.length === 6 && data.startsWith(X10_PREFIX)) return directionOf(data.charCodeAt(3) - 32);
	return undefined;
}
