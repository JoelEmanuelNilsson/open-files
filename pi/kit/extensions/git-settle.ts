import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Clears the stale "modified" mark git leaves after pi rewrites settings.json.
 *
 * The volatile keys in that file — today just the thinking-block toggle — are
 * pinned to their committed values by a git clean filter, so they can never be
 * staged or committed (see bin/pi-settings-filter). What the filter cannot fix
 * is `git status`: the index caches one file size, a pinned `true` against a
 * live `false` is one byte short of it, and git calls a size mismatch a
 * modification without ever reading the file.
 *
 * `pi-settings-filter settle` ends that: it hashes the file through the filter
 * and, only if the result is the blob git already has, runs `git add` — which
 * stages nothing and records the new size. A real settings change hashes
 * differently and is left alone, so nothing can be hidden by this.
 *
 * Run at the start and end of every turn, gated on the file's mtime, so the
 * only time anything is spawned is a turn where the file was actually written.
 * That is what makes a toggle invisible in practice rather than in principle:
 * the mark is gone by the next time anyone looks at the repo.
 */

/** <repo>/bin/pi-settings-filter, from this file's own path — no home-relative guess. */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = new URL("../../../", import.meta.url);
const FILTER = fileURLToPath(new URL("bin/pi-settings-filter", REPO));
const SETTINGS = fileURLToPath(new URL("pi/settings.json", REPO));

export default function gitSettle(pi: ExtensionAPI): void {
	// Only this checkout's own copy of the kit settles its own repo. A kit
	// loaded from anywhere else has no business running git in ~/dotfiles.
	if (!HERE.endsWith("/pi/kit/extensions/")) return;

	let seen = 0;
	const settle = (): void => {
		try {
			const written = statSync(SETTINGS).mtimeMs;
			if (written === seen) return;
			seen = written;
			// Detached and ignored: this is housekeeping, and a turn must never
			// wait on it or fail because of it.
			execFile(FILTER, ["settle"], () => {});
		} catch {}
	};

	pi.on("session_start", settle);
	pi.on("before_agent_start", settle);
	pi.on("agent_settled", settle);
}
