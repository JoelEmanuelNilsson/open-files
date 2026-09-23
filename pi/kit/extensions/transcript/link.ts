/**
 * Where a click on a path goes.
 *
 * An OSC-8 hyperlink is the only clickable thing an extension can put on a row:
 * pi hands components keyboard input and nothing else, `ToolRenderContext`
 * carries no pointer, and in regular mode pi never turns mouse reporting on, so
 * the terminal owns the click. Which means the whole question is what URL to
 * write, because the terminal will hand whatever it is to the OS.
 *
 * `file://` is the obvious answer and the wrong one here. macOS opens a file
 * URL with the app registered for the extension, and on this machine that is
 * QuickTime Player for `.ts`, TextEdit for `.md`, and a browser for `.json` —
 * none of them the editor. A file URL also has nowhere to put a line number:
 * LaunchServices resolves it to a path and the fragment is gone.
 *
 * So the rows link `pi-open:`, a scheme owned by `~/Applications/Pi Open.app`,
 * which runs `~/dotfiles/bin/pi-open` and lands the file in nvim beside the
 * pane that was clicked. The URL carries the line when the call knows one.
 *
 *     pi-open:///Users/joel/dotfiles/pi/kit/extensions/transcript/row.ts?line=42
 *
 * `PI_TRANSCRIPT_OPEN` picks: `pi-open`, `file` for the old behaviour, `off`
 * for no links at all. The default is `pi-open` where that handler is installed
 * and `file` where it is not, so a machine without the handler still gets the
 * links it had rather than links that open nothing.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Scheme = "pi-open" | "file" | "off";

/** The bundle that owns `pi-open:`. Its absence is what makes `auto` say `file`. */
export const HANDLER = join(homedir(), "Applications", "Pi Open.app");

let resolved: Scheme | undefined;

/**
 * Read once. The environment does not change while a session runs, and neither
 * does whether the handler is installed — an `existsSync` per row per frame
 * would be a syscall to answer a question with one answer.
 */
export function scheme(): Scheme {
	if (resolved) return resolved;
	const asked = (process.env.PI_TRANSCRIPT_OPEN ?? "").toLowerCase();
	if (asked === "off" || asked === "file" || asked === "pi-open") resolved = asked;
	else resolved = handlerInstalled() ? "pi-open" : "file";
	return resolved;
}

/** Test seam: the module-level answer is a cache, not a constant. */
export function resetScheme(): void {
	resolved = undefined;
}

function handlerInstalled(): boolean {
	try {
		return existsSync(HANDLER);
	} catch {
		return false;
	}
}

/**
 * Percent-encoding for a path inside a URL.
 *
 * `encodeURI` leaves `?` and `#` alone because they are URL syntax, which is
 * exactly why a filename containing one has to be encoded here: the handler
 * splits the line number off at the first `?`.
 */
function encodePath(file: string): string {
	return encodeURI(file).replace(/\?/g, "%3F").replace(/#/g, "%23");
}

/** The URL for one path, or nothing when links are off. */
export function linkTo(file: string, line?: number): string | undefined {
	const choice = scheme();
	if (choice === "off") return undefined;
	const path = encodePath(file);
	if (choice === "file") return `file://${path}`;
	return line === undefined ? `pi-open://${path}` : `pi-open://${path}?line=${line}`;
}
