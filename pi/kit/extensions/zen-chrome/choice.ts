/**
 * Which light the box outline carries, kept between sessions.
 *
 * A preference and not a setting: it changes nothing but how the chrome looks,
 * so it lives in the kit's own state root rather than in `settings.json` — out
 * of git entirely, which is what "my machine, my taste" means. A second machine
 * running the same dotfiles gets the default until someone there picks.
 *
 * Read once per process and cached, so a running session keeps the light it
 * opened with and the next one starts on the new choice. `/glow` sets both the
 * file and this process, so the session that asks sees the answer immediately.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDir, stateDir } from "../../lib/state-dir.ts";

/** The lights a box outline can carry, by name. */
export const GLOWS = ["one", "two"] as const;

export type GlowName = (typeof GLOWS)[number];

/** What each name means, for `/glow`'s completions and for reading this file. */
export const GLOW_NOTES: Readonly<Record<GlowName, string>> = {
	one: "a single hue, drifting",
	two: "two hues, a long gradient",
};

/** The light a fresh machine gets. */
const DEFAULT: GlowName = "one";

/** Where the choice is kept. */
export function glowFile(): string {
	return join(stateDir(), "glow");
}

/**
 * A name out of stored text, or null for anything this version does not know:
 * a name a future version added, a half-written file, a stray editor newline.
 * None of them is worth failing to draw a box over.
 */
export function parseGlow(text: string): GlowName | null {
	const word = text.trim();
	return (GLOWS as readonly string[]).includes(word) ? (word as GlowName) : null;
}

let cached: GlowName | null = null;

/** The chosen light. Unreadable or unrecognised state means the default, never a crash. */
export function glowName(): GlowName {
	if (cached === null) {
		try {
			cached = parseGlow(readFileSync(glowFile(), "utf8")) ?? DEFAULT;
		} catch {
			cached = DEFAULT;
		}
	}
	return cached;
}

/** Choose, for this process and for the sessions after it. */
export function setGlowName(name: GlowName): void {
	cached = name;
	ensurePrivateDir(stateDir());
	writeFileSync(glowFile(), `${name}\n`, { mode: 0o600 });
}
