import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = new URL("../../../", import.meta.url);
/** The repo's settings filter script, run to settle `pi/settings.json`. */
export const SETTINGS_FILTER_SCRIPT = fileURLToPath(new URL("bin/pi-settings-filter", REPO));
/** The repo's `pi/settings.json`, whose mtime gates a settle. */
export const PI_SETTINGS_FILE = fileURLToPath(new URL("pi/settings.json", REPO));

export default function gitSettle(pi: ExtensionAPI): void {
	if (!HERE.endsWith("/pi/kit/extensions/")) return;

	let seen = 0;
	const settle = (): void => {
		try {
			const written = statSync(PI_SETTINGS_FILE).mtimeMs;
			if (written === seen) return;
			seen = written;
			execFile(SETTINGS_FILTER_SCRIPT, ["settle"], () => {});
		} catch {}
	};

	pi.on("session_start", settle);
	pi.on("before_agent_start", settle);
	pi.on("agent_settled", settle);
}
