/**
 * The suite environment a file gets from `support/suite-env.mjs`, checked in a
 * child process that inherits a seat-like environment: `PI_*` and `HERDR_*`
 * gone, a state root set.
 */

import { check, eq, finish, is } from "../support/check-harness.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SUITE_ENV = pathToFileURL(path.resolve(import.meta.dirname, "../support/suite-env.mjs")).href;
const printEnv = `await import(${JSON.stringify(SUITE_ENV)}); console.log(JSON.stringify(process.env));`;

/** Runs a child that imports suite-env under `env` and returns the environment it ends with. */
function envAfterSuiteEnv(env) {
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", printEnv], { encoding: "utf8", env }));
}

const seatEnv = { PATH: process.env.PATH, PI_X: "1", PI_CHAT: "1", PI_CODING_AGENT_DIR: "/live/agent", HERDR_X: "1", HERDR_PANE_ID: "p1", KEEP_ME: "1" };
const child = envAfterSuiteEnv(seatEnv);
eq("PI_* variables are gone but the suite's own agent dir", Object.keys(child).filter((name) => name.startsWith("PI_")), ["PI_KIT_REPLY_FORMATS", "PI_CODING_AGENT_DIR", "PI_KIT_CONTROL_DIR"]);
check("PI_KIT_CONTROL_DIR is a directory of its own under /tmp, not the live socket directory", typeof child.PI_KIT_CONTROL_DIR === "string" && child.PI_KIT_CONTROL_DIR.startsWith("/tmp/pic-"), String(child.PI_KIT_CONTROL_DIR));
eq("HERDR_* variables are gone", Object.keys(child).filter((name) => name.startsWith("HERDR_")), []);
is("other variables stay", child.KEEP_ME, "1");
check("XDG_STATE_HOME is set to a throwaway state root", typeof child.XDG_STATE_HOME === "string" && path.basename(child.XDG_STATE_HOME).startsWith("pi-kit-test-state-"), String(child.XDG_STATE_HOME));

check("PI_CODING_AGENT_DIR is an empty agent dir under the state root",
	typeof child.PI_CODING_AGENT_DIR === "string" && path.dirname(child.PI_CODING_AGENT_DIR) === child.XDG_STATE_HOME && fs.readdirSync(child.PI_CODING_AGENT_DIR).length === 0,
	String(child.PI_CODING_AGENT_DIR));

const runnerState = fs.mkdtempSync(path.join(process.env.XDG_STATE_HOME, "runner-state-"));
const inherited = envAfterSuiteEnv({ ...seatEnv, XDG_STATE_HOME: runnerState });
is("an inherited XDG_STATE_HOME is kept", inherited.XDG_STATE_HOME, runnerState);

await finish();
