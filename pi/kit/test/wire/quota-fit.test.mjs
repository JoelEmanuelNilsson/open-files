/**
 * bin/quota-fit.mjs over a trace directory: the fit runs on the readings that
 * carry a 5-hour window, and a reading without one is not a window of its own.
 * Its default directory is where the wire trace writes.
 *
 *   node test/wire/quota-fit.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const QUOTA_FIT = path.join(KIT_ROOT, "bin/quota-fit.mjs");
const dir = fs.mkdtempSync(path.join(process.env.XDG_STATE_HOME, "quota-fit-"));

const RESET = 1_800_000_000;
const lines = [];
for (let n = 0; n < 8; n++) {
	const quota = n === 3 ? { sevenDayUtilization: 0.1 } : { fiveHourUtilization: 0.01 * (n + 1), fiveHourResetAtSec: RESET, sevenDayUtilization: 0.1 };
	lines.push({ t: "req", n, model: "claude-opus-4-7" });
	lines.push({ t: "use", n, at: new Date(Date.UTC(2027, 0, 1, 0, n)).toISOString(), input: 100 * (n + 1), read: 5000 * (n + 1), write: 200 * (n % 3), reasoning: 10 * n, quota });
}
fs.writeFileSync(path.join(dir, "s1.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

console.log("quota-fit: a reading without a 5-hour window");
{
	const run = spawnSync(process.execPath, [QUOTA_FIT, dir, "--json"], { encoding: "utf8" });
	check("the fit runs to completion", run.status === 0, run.stderr.trim().split("\n").slice(0, 3).join("\n"));
	const out = run.status === 0 ? JSON.parse(run.stdout) : undefined;
	check("only the readings with a 5-hour window are fitted", out?.records === 7, `records ${out?.records}`);
	check("they make one window, at their reset", out?.windows?.length === 1 && out.windows[0].reset === RESET, JSON.stringify(out?.windows?.map((w) => w.reset)));
}

console.log("quota-fit: the default directory is the wire trace's");
{
	// The runner gives this file its own XDG_STATE_HOME; the trace writes under it.
	const traces = path.join(process.env.XDG_STATE_HOME, "pi-kit/wire-trace");
	fs.mkdirSync(traces, { recursive: true });
	fs.copyFileSync(path.join(dir, "s1.jsonl"), path.join(traces, "s1.jsonl"));
	const { PI_WIRE_TRACE_DIR: _, ...env } = process.env;
	const fit = spawnSync(process.execPath, [QUOTA_FIT, "--json"], { encoding: "utf8", env });
	check("quota-fit reads $XDG_STATE_HOME/pi-kit/wire-trace", fit.status === 0 && JSON.parse(fit.stdout).dir === traces, fit.stdout.slice(0, 200) + fit.stderr.slice(0, 200));
	const named = spawnSync(process.execPath, [QUOTA_FIT, "--json"], { encoding: "utf8", env: { ...env, PI_WIRE_TRACE_DIR: dir } });
	check("PI_WIRE_TRACE_DIR names the directory, as it does for the trace", named.status === 0 && JSON.parse(named.stdout).dir === dir, named.stderr.slice(0, 200));
}

await finish();
