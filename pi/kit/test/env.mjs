/**
 * The environment a suite file runs in, applied to the process that imports it.
 *
 * `files.mjs` defined this for the runner's children only, and the runner is
 * not how a failure gets debugged — `node test/wire-trace.mjs` is. Run that
 * way, six of the forty files inherited the seat's own environment and wrote
 * into `~/.local/state/pi-kit`: notices, wire traces, and the warm-prefix
 * ledger a live seat reads back and would otherwise learn a stub payload's
 * warmth from. On 2026-09-21 seven notice lines left there by a test fixture
 * were read as a seat's own and sent a diagnosis down a false trail.
 *
 * So the environment is defined once and applied where it is needed, rather
 * than handed down by a runner the failing case never goes through.
 * `import "./env.mjs";` is the first line of every suite file and `guards.mjs`
 * checks that it is, because the next file added is otherwise the next leak.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A `PI_*` variable exported by the seat that typed `npm test` is a variable
 * the code under test will read: `wire.ts` decides chat-versus-coding from
 * `PI_CHAT` once at module load, so running the suite from a chat seat reported
 * seven failures that were nothing but the runner's own shell. An alarm whose
 * verdict depends on who is looking at it is not an alarm.
 *
 * The whole namespace goes, not the one name that caught us: the kit reads two
 * dozen `PI_*` variables and any of them could be exported by a live seat
 * tomorrow. A file that needs one sets it after this import, which is what
 * `prose-links.mjs` does with `PI_TRANSCRIPT_OPEN`.
 *
 * `XDG_STATE_HOME` is set rather than dropped, and an inherited one is kept: a
 * child spawned by the runner belongs in the same throwaway root as the run.
 */
export function testEnv(base) {
	return {
		...Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("PI_"))),
		XDG_STATE_HOME: base.XDG_STATE_HOME ?? stateHome(),
	};
}

/** The run's throwaway state root, made on the first ask. A process that inherits one never asks. */
export function stateHome() {
	return (root ??= mkdtempSync(join(tmpdir(), "pi-kit-test-state-")));
}

let root;

for (const name of Object.keys(process.env)) if (name.startsWith("PI_")) delete process.env[name];
process.env.XDG_STATE_HOME ??= stateHome();
