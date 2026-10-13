/**
 * A background command's process group dies with the process that owns it,
 * even when that process exits without a session shutdown: on 2026-10-06 seven
 * test commands ran orphaned for 23 hours.
 */

import { check, finish } from "../support/check-harness.mjs";
import { until } from "../support/async-waits.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SINK = fs.mkdtempSync(path.join(os.tmpdir(), "bash-process-exit-"));
const pidFile = path.join(SINK, "command.pid");

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// The owner starts a command that would outlast the test (bounded at 60 s), then exits with no shutdown.
const owner = `
import { kitJiti } from ${JSON.stringify(path.join(KIT_ROOT, "test/support/pi-package.mjs"))};
const { BashRun } = kitJiti()(${JSON.stringify(path.join(KIT_ROOT, "extensions/bash/bash-process.ts"))});
const run = new BashRun({ id: 1, command: "echo $$ > ${pidFile}; sleep 60", logPath: ${JSON.stringify(path.join(SINK, "run.log"))}, mayBackground: true, scope: { timeout: () => () => {} }, onSettled: () => true, onStalled: () => {} });
void run.exec(run.command, ${JSON.stringify(SINK)}, { onData() {}, env: process.env });
const { existsSync } = await import("node:fs");
while (!existsSync(${JSON.stringify(pidFile)})) await new Promise((r) => setTimeout(r, 20));
process.exit(0);
`;
const ownerFile = path.join(SINK, "owner.mjs");
fs.writeFileSync(ownerFile, owner);

console.log("\nthe owner exits without a shutdown");
{
	const child = spawn(process.execPath, [ownerFile], { stdio: "ignore" });
	const exited = await new Promise((resolve) => child.on("exit", resolve));
	const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
	check("the owner ran to its exit", exited === 0, String(exited));
	const gone = await until(() => !alive(pid), 5_000, 20);
	if (!gone) for (const target of [-pid, pid]) try { process.kill(target, "SIGKILL"); } catch {}
	check("the command's process group is gone", gone);
}

fs.rmSync(SINK, { recursive: true, force: true });
await finish();
