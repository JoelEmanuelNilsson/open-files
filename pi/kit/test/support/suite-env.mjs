/**
 * The environment a suite file runs in, applied to the process that imports it.
 *
 * The runner is not how a failure gets debugged — `node test/wire/wire-trace.test.mjs`
 * is. When the environment was defined for the runner's children only, six of
 * the forty files run that way inherited the seat's own environment and wrote
 * into `~/.local/state/pi-kit`: notices and wire traces. On 2026-09-21 seven notice lines left there by a test fixture
 * were read as a seat's own and sent a diagnosis down a false trail.
 *
 * So the environment is defined once and applied where it is needed, rather
 * than handed down by a runner the failing case never goes through. A suite
 * file's first code line imports it — `import "../support/suite-env.mjs";`, or
 * `check-harness.mjs` / `pi-package.mjs`, which import it first themselves —
 * and `kit/suite-layout.test.mjs` checks that it does, because the next file added is
 * otherwise the next leak.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A `PI_*` variable exported by the seat that typed `npm test` is a variable
// the code under test will read: `extensions/wire/index.ts` decides chat-versus-coding from
// `PI_CHAT` once at module load, so running the suite from a chat seat reported
// seven failures that were nothing but the runner's own shell. An alarm whose
// verdict depends on who is looking at it is not an alarm.
//
// The whole namespace goes, not the one name that caught us: the kit reads two
// dozen `PI_*` variables and any of them could be exported by a live seat
// tomorrow. A file that needs one sets it after this import, which is what
// `prose-links.mjs` does with `PI_TRANSCRIPT_OPEN`.
//
// `HERDR_*` goes the same way: the seat exports HERDR_PANE_ID,
// HERDR_SOCKET_PATH, HERDR_ENV, HERDR_TAB_ID, HERDR_WORKSPACE_ID and
// HERDR_BIN_PATH, and herdr's own `~/.pi/agent/extensions/herdr-agent-state.ts`
// reads them, so a test on the live agent dir would report agent state to
// Joel's live herdr pane.
for (const name of Object.keys(process.env)) if (name.startsWith("PI_") || name.startsWith("HERDR_")) delete process.env[name];

// Scripted children reply in plain text, and the reply-format steer would add a
// turn their scripts do not have. The reply-formats test turns the formats back on.
process.env.PI_KIT_REPLY_FORMATS = "off";

// Set rather than dropped, and an inherited one is kept: the suite runner hands
// each file its own state root under the run's.
process.env.XDG_STATE_HOME ??= mkdtempSync(join(tmpdir(), "pi-kit-test-state-"));

// pi's agent dir defaults to the live `~/.pi/agent`, and `SettingsManager`
// holds a lock on its settings.json for every read. Concurrent runs and the
// live seat then contend for one lock, whose retry spins on `Date.now()` —
// forever in a file that freezes the clock, as a test that stubs `Date` does.
// Every file gets an empty agent dir of its own; a live file points it back.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(process.env.XDG_STATE_HOME, "pi-agent-"));

// The control sockets of live pi sessions sit in /tmp/pi-kit-<uid>; a file that lists or answers there sees them. A unix socket path is short (104 bytes on macOS), so the directory is under /tmp, not the state root.
process.env.PI_KIT_CONTROL_DIR = mkdtempSync("/tmp/pic-");
const controlDir = process.env.PI_KIT_CONTROL_DIR;
process.on("exit", () => rmSync(controlDir, { recursive: true, force: true }));
