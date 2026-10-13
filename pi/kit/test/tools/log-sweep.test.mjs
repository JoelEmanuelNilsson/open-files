/**
 * Command logs do not pile up: a background log older than 24 h and a pi
 * foreground temp log older than 24 h are deleted at session start, except a log
 * a live task holds and a log some process still has open.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const { sweepStaleLogs } = await jiti.import(`${KIT_ROOT}/lib/tools/log-sweep.ts`);
const { adoptBackgroundTask, endBackgroundTasksOf, heldLogPaths } = await jiti.import(`${KIT_ROOT}/lib/tools/background-tasks.ts`);

const SINK = fs.mkdtempSync(path.join(os.tmpdir(), "log-sweep-"));
const backgroundDir = path.join(SINK, "background");
const tmpDir = path.join(SINK, "tmp");
fs.mkdirSync(backgroundDir);
fs.mkdirSync(tmpDir);
const HOUR = 3_600_000;
const now = Date.now();
const make = (dir, name, ageMs) => {
	const file = path.join(dir, name);
	fs.writeFileSync(file, "output\n");
	fs.utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
	return file;
};

const oldEnded = make(backgroundDir, "s1-1-100.log", 25 * HOUR);
const young = make(backgroundDir, "s1-2-100.log", 23 * HOUR);
const oldLive = make(backgroundDir, "s1-3-100.log", 30 * HOUR);
const oldOpen = make(backgroundDir, "s2-1-100.log", 30 * HOUR);
const oldTemp = make(tmpDir, "pi-bash-0123456789abcdef.log", 25 * HOUR);
const youngTemp = make(tmpDir, "pi-bash-fedcba9876543210.log", 1 * HOUR);
const unrelated = make(tmpDir, "notes.log", 99 * HOUR);

adoptBackgroundTask("s1", { id: 3, command: "sleep 99999", logPath: oldLive }, { kill: () => true, exitedWith: undefined }, () => "appended", Date.now());
// Another process (another session's task) still has this log open.
const holder = spawn("sh", ["-c", `exec 3>>${oldOpen}; echo ready; sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
await new Promise((resolve) => holder.stdout.once("data", resolve));

const removed = await sweepStaleLogs({ backgroundDir, tmpDir, held: heldLogPaths(), now });
const there = (file) => fs.existsSync(file);
check("an ended background log older than 24 h is deleted", !there(oldEnded));
check("a log younger than 24 h stays", there(young));
check("a log a live task holds stays however old", there(oldLive));
check("a log another process has open stays however old", there(oldOpen));
check("a pi foreground temp log older than 24 h is deleted", !there(oldTemp));
check("a younger temp log and a file that is not pi's stay", there(youngTemp) && there(unrelated));
check("it reports what it deleted", JSON.stringify([...removed].sort()) === JSON.stringify([oldEnded, oldTemp].sort()), JSON.stringify(removed));

endBackgroundTasksOf("s1");
holder.kill();
fs.rmSync(SINK, { recursive: true, force: true });
await finish();
