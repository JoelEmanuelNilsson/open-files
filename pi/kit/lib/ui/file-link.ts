import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How a file link opens: the `pi-open:` handler app, a plain `file://` URL, or no link. */
export type FileLinkScheme = "pi-open" | "file" | "off";

/** The bundle that owns `pi-open:`. Its absence is what makes `auto` say `file`. */
export const PI_OPEN_HANDLER = join(homedir(), "Applications", "Pi Open.app");

// shared-state: a memo of PI_TRANSCRIPT_OPEN and whether the handler app is installed; every copy computes the same answer
let resolved: FileLinkScheme | undefined;

export function fileLinkScheme(): FileLinkScheme {
	if (resolved) return resolved;
	const asked = (process.env.PI_TRANSCRIPT_OPEN ?? "").toLowerCase();
	if (asked === "off" || asked === "file" || asked === "pi-open") resolved = asked;
	else resolved = handlerInstalled() ? "pi-open" : "file";
	return resolved;
}

/** Test seam: the module-level answer is a cache, not a constant. */
export function resetFileLinkScheme(): void {
	resolved = undefined;
}

function handlerInstalled(): boolean {
	try {
		return existsSync(PI_OPEN_HANDLER);
	} catch {
		return false;
	}
}

function encodePath(file: string): string {
	return encodeURI(file).replace(/\?/g, "%3F").replace(/#/g, "%23");
}

/** The URL for one path, or nothing when links are off. */
export function fileLinkUrl(file: string, line?: number): string | undefined {
	const choice = fileLinkScheme();
	if (choice === "off") return undefined;
	const path = encodePath(file);
	if (choice === "file") return `file://${path}`;
	return line === undefined ? `pi-open://${path}` : `pi-open://${path}?line=${line}`;
}
