/**
 * The suite runner: `npm test [-- name…] [--jobs N] [--timeout S] [--list]`.
 *
 * `npm test` used to be ten `node test/…` calls chained with `&&`. That makes
 * one file's verdict decide whether the next one runs, and on 2026-08-30 it
 * did: five stale oracle checks in `smoke.mjs` exited 1 and **517 checks in
 * the other nine files went dark, silently**, for as long as it took anyone to
 * notice the total had shrunk.
 *
 * The rule this file exists to enforce: **a test runner must never let one
 * file's verdict decide whether another file runs.** Independent suites are
 * independent. Every file runs, every time, and the exit code is decided once
 * at the end.
 *
 * There is one kind of red left, and it means our code is wrong. What the
 * oracles in `wire/owned-prompt.test.mjs` check is the *structure* of the wire, and a structure
 * change is a real bug in this harness's mimicry, so it fails the run and
 * waits for a human.
 *
 * A file that crashes without printing a trailer counts as failed — a suite
 * that cannot say what it checked has not checked anything. So does one killed
 * by a signal or by its timeout.
 *
 * Files run in parallel, each in its own process group with its own
 * XDG_STATE_HOME under one run root, so no file reads another's notices or
 * ledgers. Output is buffered per file and printed when the file finishes.
 * Files named `*-live.test.mjs` call the real Anthropic API and run one at a
 * time.
 * A name selects every file whose path relative to test/ contains it.
 * `--root <dir>` points the runner at another test directory (its self-tests).
 * A red run then reruns its failing files on main (a temporary worktree of
 * `main`, or `--baseline-root <dir>`) and separates the failures main also has
 * from the new ones, so no one stashes to tell them apart.
 *
 * The summary repeats every failed check by name, and the last line a crashed
 * file printed, so a red run is readable without scrolling the buffers.
 *
 * A file's timeout is `--timeout` seconds times the machine's load: the worst
 * one-minute load average per core seen while the file ran, never below 1. Nine
 * suites sharing one Mac stretch every file's wall time, and a fixed budget
 * would call that a hang.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPerCore } from "./support/async-waits.mjs";
import { discoverSuiteFiles, isLiveSuiteFile } from "./support/suite-files.mjs";

const BOLD = "\u001b[1m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const RESET = "\u001b[0m";

/** Stops the runner before any file runs, with a message naming what was wrong. */
function refuseToRun(message) {
	console.error(`suite-runner: ${message}`);
	process.exit(1);
}

const { values: options, positionals: names } = (() => {
	try {
		return parseArgs({
			allowPositionals: true,
			options: { jobs: { type: "string" }, timeout: { type: "string" }, list: { type: "boolean" }, root: { type: "string" }, "baseline-root": { type: "string" } },
		});
	} catch (error) {
		return refuseToRun(error.message);
	}
})();

const testRoot = path.resolve(options.root ?? import.meta.dirname);
const jobsText = options.jobs ?? process.env.KIT_TEST_JOBS;
const jobs = jobsText === undefined ? Math.max(1, Math.min(8, os.availableParallelism() - 1)) : Number(jobsText);
if (!Number.isInteger(jobs) || jobs < 1) refuseToRun(`--jobs (or KIT_TEST_JOBS) must be a positive integer, got ${jobsText}`);
const timeoutSeconds = Number(options.timeout ?? 300);
if (!(timeoutSeconds > 0)) refuseToRun(`--timeout must be a positive number of seconds, got ${options.timeout}`);

const discovered = discoverSuiteFiles(testRoot);
for (const name of names) if (!discovered.some((file) => file.includes(name))) refuseToRun(`no test file matches ${name}`);
const selected = names.length === 0 ? discovered : discovered.filter((file) => names.some((name) => file.includes(name)));
if (selected.length === 0) refuseToRun(`no test files under ${testRoot}`);

if (options.list) {
	for (const file of selected) console.log(file);
	process.exit(0);
}

const TIMES_FILE = path.join(testRoot, "node_modules/.cache/pi-kit-test-times.json");
const lastTimes = (() => {
	try {
		return JSON.parse(fs.readFileSync(TIMES_FILE, "utf8"));
	} catch {
		return {};
	}
})();
// Longest first so the slowest file never starts last; a file with no recorded time may be slow, so it goes first too.
const queue = [...selected].sort((a, b) => (lastTimes[b] ?? Infinity) - (lastTimes[a] ?? Infinity));

const wallStart = performance.now();
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-test-state-"));
const results = new Map();
const running = new Map();
const showStatus = process.stdout.isTTY === true;

function clearStatus() {
	if (showStatus) process.stdout.write("\r\u001b[2K");
}

function printStatus() {
	if (showStatus) process.stdout.write(`\r\u001b[2Krunning: ${[...running.keys()].join(", ")} (${results.size}/${selected.length})`);
}

/** Runs one file in its own process group, buffering its output, and reads its verdict from the trailer. */
function runSuiteFile(file) {
	return new Promise((resolve) => {
		const stateHome = path.join(runRoot, file.replace(/\.mjs$/, "").replaceAll("/", "__"));
		fs.mkdirSync(stateHome);
		const startedAt = performance.now();
		const child = spawn(process.execPath, [path.join(testRoot, file)], {
			cwd: path.dirname(testRoot),
			env: { ...process.env, XDG_STATE_HOME: stateHome },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		running.set(file, child);
		printStatus();
		let output = "";
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => (output += chunk));
		}
		let timedOut = false;
		let budgetSeconds = timeoutSeconds;
		const timer = setInterval(() => {
			budgetSeconds = Math.max(budgetSeconds, timeoutSeconds * loadPerCore());
			if (performance.now() - startedAt < budgetSeconds * 1000) return;
			timedOut = true;
			clearInterval(timer);
			killGroup(child);
		}, Math.min(1000, timeoutSeconds * 100));
		child.on("close", (code, signal) => {
			clearInterval(timer);
			running.delete(file);
			const ms = performance.now() - startedAt;
			const trailer = [...output.matchAll(/^(\d+) passed, (\d+) failed$/gm)].at(-1);
			const skippedLine = [...output.matchAll(/^(\d+) skipped$/gm)].at(-1);
			const failed = trailer ? Number(trailer[2]) : 0;
			const result = {
				file,
				ms,
				passed: trailer ? Number(trailer[1]) : 0,
				failed,
				skipped: skippedLine ? Number(skippedLine[1]) : 0,
				timedOut,
				// No trailer and a bad exit code means the file died mid-run. Its
				// own count cannot be trusted, so the run is failed by the runner.
				crashed: trailer === undefined || (code !== 0 && failed === 0) || signal !== null || timedOut,
				failedChecks: [...output.matchAll(/^ {2}FAIL (.*)$|^--- (.*)\nTHREW: /gm)].map((match) => match[1] ?? match[2]),
				lastLine: output.trimEnd().split("\n").at(-1) ?? "",
			};
			results.set(file, result);
			clearStatus();
			console.log(`\n${BOLD}\u2500\u2500 ${file} (${(ms / 1000).toFixed(1)}s)${RESET}${timedOut ? `  ${RED}timed out after ${Math.round(budgetSeconds)}s${RESET}` : ""}`);
			process.stdout.write(output.endsWith("\n") || output === "" ? output : `${output}\n`);
			printStatus();
			resolve(result);
		});
	});
}

function killGroup(child) {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// The group already exited.
	}
}

/** The next queued file this slot may start: at most one live file runs at any moment. */
function takeNextFile() {
	const liveRunning = [...running.keys()].some(isLiveSuiteFile);
	const index = queue.findIndex((file) => !liveRunning || !isLiveSuiteFile(file));
	return index === -1 ? undefined : queue.splice(index, 1)[0];
}

function printSummary() {
	const finished = selected.filter((file) => results.has(file)).map((file) => results.get(file));
	const width = Math.max(...selected.map((file) => file.length));
	const total = (key) => finished.reduce((sum, result) => sum + result[key], 0);
	const crashed = finished.filter((result) => result.crashed);
	console.log(`\n${BOLD}suite${RESET} (${finished.length} files, ${jobs} jobs, ${((performance.now() - wallStart) / 1000).toFixed(1)}s)`);
	for (const result of finished) {
		const marks = [
			result.failed > 0 ? `${RED}${result.failed} failed${RESET}` : "",
			result.skipped > 0 ? `${YELLOW}${result.skipped} skipped${RESET}` : "",
			result.timedOut ? `${RED}timed out${RESET}` : result.crashed ? `${RED}crashed${RESET}` : "",
		].filter(Boolean);
		const seconds = `${(result.ms / 1000).toFixed(1)}s`.padStart(6);
		console.log(`  ${result.file.padEnd(width)}  ${String(result.passed).padStart(4)} passed  ${seconds}${marks.length ? `  ${marks.join("  ")}` : ""}`);
	}
	const skipped = total("skipped");
	console.log(
		`\n${total("passed")} passed, ${total("failed")} failed` +
			(crashed.length > 0 ? `, ${RED}${crashed.length} crashed${RESET}` : "") +
			(skipped > 0 ? `  ${YELLOW}\u00b7 ${skipped} skipped (no oracle on this machine)${RESET}` : ""),
	);
	if (crashed.length > 0) console.log(`${RED}crashed without a verdict: ${crashed.map((result) => result.file).join(", ")}${RESET}`);
	for (const result of finished) for (const name of result.failedChecks) console.log(`${RED}FAIL${RESET} ${result.file}: ${name}`);
	for (const result of crashed) console.log(`${RED}last line${RESET} ${result.file}: ${result.lastLine}`);
	return crashed.length > 0 || finished.some((result) => result.failed > 0);
}

/** Runs the failing files in another test directory and returns its `FAIL file: name` lines. */
function failuresIn(baselineTestRoot, files) {
	const run = spawnSync(process.execPath, [import.meta.filename, "--root", baselineTestRoot, ...files], {
		encoding: "utf8",
		env: { ...process.env, KIT_TEST_BASELINE: "1" },
	});
	return new Set([...`${run.stdout}${run.stderr}`.replace(/\u001b\[[0-9;]*m/g, "").matchAll(/^(?:FAIL|last line) (.*)$/gm)].map((match) => match[1]));
}

/** Prints which of this run's failures main also has. A checkout without a `main` branch prints nothing. */
function printAgainstMain() {
	const failed = [...results.values()].filter((result) => result.failed > 0 || result.crashed);
	let worktree;
	try {
		let baselineTestRoot = options["baseline-root"];
		if (baselineTestRoot === undefined) {
			if (options.root !== undefined) return;
			const git = (...args) => execFileSync("git", ["-C", testRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
			const top = git("rev-parse", "--show-toplevel");
			const prefix = git("rev-parse", "--show-prefix");
			worktree = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-main-"));
			git("worktree", "add", "--detach", worktree, "main");
			for (const dir of ["node_modules", "test/node_modules"]) {
				const from = path.join(top, prefix, dir);
				if (fs.existsSync(from)) fs.symlinkSync(from, path.join(worktree, prefix, dir));
			}
			baselineTestRoot = path.join(worktree, prefix, "test");
		}
		const onMain = failuresIn(baselineTestRoot, failed.map((result) => result.file));
		const lines = failed.flatMap((result) => (result.failedChecks.length > 0 ? result.failedChecks : [result.lastLine]).map((name) => `${result.file}: ${name}`));
		console.log("");
		for (const line of lines) console.log(`${onMain.has(line) ? "also failing on main" : `${RED}new vs main${RESET}`}: ${line}`);
	} catch (error) {
		console.log(`could not compare with main: ${error.message.split("\n")[0]}`);
	} finally {
		if (worktree !== undefined) spawnSync("git", ["-C", testRoot, "worktree", "remove", "--force", worktree]);
	}
}

process.on("SIGINT", () => {
	for (const child of running.values()) killGroup(child);
	clearStatus();
	printSummary();
	console.log(`${RED}interrupted; never finished: ${selected.filter((file) => !results.has(file)).join(", ")}${RESET}`);
	console.log(`state kept for reading: ${runRoot}`);
	process.exit(130);
});

const slots = [];
const startSlot = async () => {
	for (let file = takeNextFile(); file !== undefined; file = takeNextFile()) await runSuiteFile(file);
};
// A slot that finds only a live file blocked by the running one stops; the live file's own slot picks the rest up.
for (let slot = 0; slot < jobs; slot++) slots.push(startSlot());
await Promise.all(slots);

fs.mkdirSync(path.dirname(TIMES_FILE), { recursive: true });
const times = { ...lastTimes };
for (const result of results.values()) times[result.file] = Math.round(result.ms);
// Written aside and renamed: concurrent runs in one checkout share this file, and a torn read loses the order.
fs.writeFileSync(`${TIMES_FILE}.${process.pid}`, `${JSON.stringify(times, null, "\t")}\n`);
fs.renameSync(`${TIMES_FILE}.${process.pid}`, TIMES_FILE);

const red = printSummary();
if (red && process.env.KIT_TEST_BASELINE !== "1") printAgainstMain();
if (red) console.log(`state kept for reading: ${runRoot}`);
else fs.rmSync(runRoot, { recursive: true, force: true });
process.exit(red ? 1 : 0);
