/**
 * The suite runner.
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
 * There is one kind of red left, and it means our code is wrong. The suite
 * once had a second, *drifted*, for the Claude Code release we pinned no
 * longer being the installed one; that pin is gone — the version is read off
 * the installed binary, so it cannot fall behind. What the oracles in
 * `smoke.mjs` still check is the *structure* of the wire, and a structure
 * change is a real bug in this harness's mimicry, so it fails the run and
 * waits for a human.
 *
 * A file that crashes without printing a trailer counts as failed — a suite
 * that cannot say what it checked has not checked anything.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { childEnv, TEST_FILES } from "./files.mjs";

const KIT = path.resolve(import.meta.dirname, "..");

/** Runs one file to completion, echoing its output, and reads its trailer. */
function runFile(file) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [file], { cwd: KIT, env: childEnv() });
		let out = "";
		const tap = (stream, sink) => {
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => { out += chunk; sink.write(chunk); });
		};
		tap(child.stdout, process.stdout);
		tap(child.stderr, process.stderr);
		child.on("close", (code) => {
			const trailer = /^(\d+) passed, (\d+) failed$/m.exec(out);
			const aside = (label) => Number(new RegExp(`^(\\d+) ${label}$`, "m").exec(out)?.[1] ?? 0);
			resolve({
				file: path.basename(file),
				passed: trailer ? Number(trailer[1]) : 0,
				failed: trailer ? Number(trailer[2]) : 0,
				skipped: aside("skipped"),
				// No trailer and a bad exit code means the file died mid-run. Its
				// own count cannot be trusted, so the run is failed by the runner.
				crashed: trailer === null || (code !== 0 && Number(trailer[2]) === 0),
			});
		});
	});
}

const runs = [];
for (const file of TEST_FILES) {
	console.log(`\n\u001b[1m\u2500\u2500 ${file}\u001b[0m`);
	runs.push(await runFile(file));
}
const width = Math.max(...runs.map((run) => run.file.length));
const total = (key) => runs.reduce((sum, run) => sum + run[key], 0);
const crashed = runs.filter((run) => run.crashed);
const failed = runs.filter((run) => run.failed > 0);

console.log("\n\u001b[1msuite\u001b[0m");
for (const run of runs) {
	const marks = [
		run.failed > 0 ? `\u001b[31m${run.failed} failed\u001b[0m` : "",
		run.skipped > 0 ? `\u001b[33m${run.skipped} skipped\u001b[0m` : "",
		run.crashed ? "\u001b[31mcrashed\u001b[0m" : "",
	].filter(Boolean);
	console.log(`  ${run.file.padEnd(width)}  ${String(run.passed).padStart(4)} passed${marks.length ? `  ${marks.join("  ")}` : ""}`);
}

const skipped = total("skipped");
const verdict = crashed.length > 0 || failed.length > 0;
console.log(
	`\n${total("passed")} passed, ${total("failed")} failed` +
		(crashed.length > 0 ? `, \u001b[31m${crashed.length} crashed\u001b[0m` : "") +
		(skipped > 0 ? `  \u001b[33m\u00b7 ${skipped} skipped (no oracle on this machine)\u001b[0m` : ""),
);
if (crashed.length > 0) console.log(`\u001b[31mcrashed without a verdict: ${crashed.map((run) => run.file).join(", ")}\u001b[0m`);
process.exit(verdict ? 1 : 0);
