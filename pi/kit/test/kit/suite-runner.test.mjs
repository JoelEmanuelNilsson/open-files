/**
 * The suite runner's own rules, checked against small fixture suites in a
 * temp directory: verdicts and crashes, the trailer it reads, timeouts, name
 * selection, per-file state roots, the serial live lane and longest-first order.
 */

import { check, eq, finish, is, section } from "../support/check-harness.mjs";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNNER = path.resolve(import.meta.dirname, "../suite-runner.mjs");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "suite-runner-test-"));
const ANSI = /\u001b\[[0-9;]*m/g;

/** Writes a fixture test directory: each entry is a relative path and its source. */
function fixtureSuite(name, files) {
	const testDir = path.join(fixtureRoot, name, "test");
	for (const [file, source] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(testDir, file)), { recursive: true });
		fs.writeFileSync(path.join(testDir, file), source);
	}
	return testDir;
}

/** Runs the suite runner over a fixture directory and resolves with its exit code and colourless output. */
function runRunner(testDir, args = []) {
	return new Promise((resolve) => {
		execFile(process.execPath, [RUNNER, "--root", testDir, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({ code: error ? error.code : 0, out: `${stdout}${stderr}`.replace(ANSI, "") });
		});
	});
}

const trailer = (passed, failed, extra = "") => `${extra}console.log("\\n${passed} passed, ${failed} failed");\nprocess.exit(${failed ? 1 : 0});\n`;
const printsState = `console.log("STATE " + process.env.XDG_STATE_HOME);\n`;
const tableRow = (out, file) => new RegExp(`^  ${file.replaceAll(".", "\\.")}\\s+(\\d+) passed\\s+[\\d.]+s(.*)$`, "m").exec(out);

const mixed = fixtureSuite("mixed", {
	"pass.test.mjs": trailer(3, 0, printsState),
	"fail.test.mjs": trailer(1, 2, `${printsState}console.log("  FAIL the answer is 42");\n`),
	"crash.test.mjs": `console.log("  ok   one");\nthrow new Error("boom");\n`,
	"exit-without-failures.test.mjs": `console.log("\\n2 passed, 0 failed");\nprocess.exit(1);\n`,
	"last-match.test.mjs": `console.log("9 passed, 9 failed");\nconsole.log("\\n4 passed, 0 failed");\n`,
	"skipped.test.mjs": `console.log("\\n1 passed, 0 failed");\nconsole.log("2 skipped\\n  a\\n  b");\n`,
	"hang.test.mjs": `setInterval(() => {}, 1000);\n`,
	"support/helper.test.mjs": trailer(1, 0),
	"preview/preview-frame.mjs": trailer(1, 0),
	"node_modules/dep.test.mjs": trailer(1, 0),
	".scratch.test.mjs": trailer(1, 0),
	"nested/deep.test.mjs": trailer(5, 0),
	"flat.mjs": trailer(1, 0),
	"nested/helper.mjs": trailer(1, 0),
});
const green = fixtureSuite("green", { "alpha.test.mjs": trailer(2, 0, printsState), "beta.test.mjs": trailer(3, 0, printsState) });
const named = fixtureSuite("named", { "alpha.test.mjs": trailer(2, 0), "beta.test.mjs": trailer(3, 0) });
// Each file stays up until a file of the other lane has started (or 10s pass), so
// a runner that overlaps them yields overlapping spans however slowly each boots.
const liveLane = fixtureSuite("live", Object.fromEntries(
	["one-live.test.mjs", "two-live.test.mjs", "plain.test.mjs"].map((file) => [
		file,
		`import fs from "node:fs";\nconst start = Date.now();\nfs.writeFileSync(\`\${import.meta.dirname}/${file}.started\`, "");\n` +
			`const partners = ${JSON.stringify(file === "plain.test.mjs" ? ["one-live.test.mjs.started", "two-live.test.mjs.started"] : ["plain.test.mjs.started"])};\n` +
			`await new Promise((resolve) => setTimeout(resolve, 300));\n` +
			`while (!fs.readdirSync(import.meta.dirname).some((name) => partners.includes(name)) && Date.now() < start + 10000) await new Promise((resolve) => setTimeout(resolve, 10));\n` +
			`console.log("SPAN ${file} " + start + " " + Date.now());\n${trailer(1, 0)}`,
	]),
));
const ordered = fixtureSuite("ordered", { "quick.test.mjs": trailer(1, 0), "slow.test.mjs": trailer(1, 0) });
fs.mkdirSync(path.join(ordered, "node_modules/.cache"), { recursive: true });
fs.writeFileSync(path.join(ordered, "node_modules/.cache/pi-kit-test-times.json"), JSON.stringify({ "quick.test.mjs": 10, "slow.test.mjs": 5000 }));

const [mixedRun, greenRun, filtered, noMatch, listed, liveRun, orderedRun] = await Promise.all([
	runRunner(mixed, ["--timeout", "1", "--jobs", "8"]),
	runRunner(green),
	runRunner(named, ["alp"]),
	runRunner(named, ["alp", "nothing-like-this"]),
	runRunner(mixed, ["--list"]),
	runRunner(liveLane, ["--jobs", "3"]),
	runRunner(ordered, ["--jobs", "1"]),
]);

section("suite-runner: verdicts");
{
	const out = mixedRun.out;
	is("a red run exits 1", mixedRun.code, 1);
	check("a passing file is counted and unmarked", tableRow(out, "pass.test.mjs")?.[1] === "3" && tableRow(out, "pass.test.mjs")?.[2] === "", tableRow(out, "pass.test.mjs")?.[0]);
	check("a failing file shows its failures", /2 failed/.test(tableRow(out, "fail.test.mjs")?.[2] ?? ""), tableRow(out, "fail.test.mjs")?.[0]);
	check("a file with no trailer crashed", /crashed/.test(tableRow(out, "crash.test.mjs")?.[2] ?? ""), tableRow(out, "crash.test.mjs")?.[0]);
	check("a file exiting 1 with 0 failed crashed", /crashed/.test(tableRow(out, "exit-without-failures.test.mjs")?.[2] ?? ""), tableRow(out, "exit-without-failures.test.mjs")?.[0]);
	check("the last trailer is the file's own", tableRow(out, "last-match.test.mjs")?.[1] === "4" && tableRow(out, "last-match.test.mjs")?.[2] === "", tableRow(out, "last-match.test.mjs")?.[0]);
	check("skipped checks are read and shown", /2 skipped/.test(tableRow(out, "skipped.test.mjs")?.[2] ?? ""), tableRow(out, "skipped.test.mjs")?.[0]);
	check("a file past its timeout is timed out", /timed out/.test(tableRow(out, "hang.test.mjs")?.[2] ?? "") && /── hang\.test\.mjs \([\d.]+s\)  timed out after \d+s/.test(out), tableRow(out, "hang.test.mjs")?.[0]);
	check("the totals line sums every file, counting crashes", /^16 passed, 2 failed, 3 crashed  · 2 skipped \(no oracle on this machine\)$/m.test(out), out.split("\n").slice(-4).join(" | "));
	check("the summary names each failed check with its file", /^FAIL fail\.test\.mjs: the answer is 42$/m.test(out), out.split("\n").slice(-8).join(" | "));
	check("and repeats the last line a crashed file printed", /^last line crash\.test\.mjs: .+$/m.test(out), out.split("\n").slice(-8).join(" | "));
	check("each file's output is printed under its own header", /── pass\.test\.mjs \([\d.]+s\)\nSTATE /.test(out));
}

section("suite-runner: discovery");
eq(
	"*.test.mjs under test/, sorted, outside support/, preview/, node_modules and dotfiles",
	listed.out.trim().split("\n"),
	["crash.test.mjs", "exit-without-failures.test.mjs", "fail.test.mjs", "hang.test.mjs", "last-match.test.mjs", "nested/deep.test.mjs", "pass.test.mjs", "skipped.test.mjs"],
);
is("--list runs nothing and exits 0", listed.code, 0);
check("a name selects the files whose path contains it", filtered.code === 0 && /^  alpha\.test\.mjs/m.test(filtered.out) && !/beta/.test(filtered.out), filtered.out);
check("a name that matches nothing exits 1 and says so", noMatch.code === 1 && /no test file matches nothing-like-this/.test(noMatch.out), noMatch.out);

section("suite-runner: per-file state");
{
	const states = [...mixedRun.out.matchAll(/^STATE (.*)$/gm)].map((match) => match[1]);
	check("each file gets its own XDG_STATE_HOME under one run root", states.length === 2 && states[0] !== states[1] && path.dirname(states[0]) === path.dirname(states[1]), states.join(", "));
	const kept = /^state kept for reading: (.*)$/m.exec(mixedRun.out)?.[1];
	check("a red run keeps the run root and prints it", kept === path.dirname(states[0]) && fs.existsSync(kept), kept);
	const greenStates = [...greenRun.out.matchAll(/^STATE (.*)$/gm)].map((match) => match[1]);
	check("a green run removes the run root", greenRun.code === 0 && greenStates.length === 2 && !fs.existsSync(path.dirname(greenStates[0])), greenRun.out);
	if (kept) fs.rmSync(kept, { recursive: true, force: true });
}

section("suite-runner: scheduling");
{
	const spans = Object.fromEntries([...liveRun.out.matchAll(/^SPAN (\S+) (\d+) (\d+)$/gm)].map((match) => [match[1], [Number(match[2]), Number(match[3])]]));
	const overlap = (a, b) => a && b && a[0] < b[1] && b[0] < a[1];
	check("live files never run at the same time", Object.keys(spans).length === 3 && !overlap(spans["one-live.test.mjs"], spans["two-live.test.mjs"]), JSON.stringify(spans));
	check("but run alongside the other files", overlap(spans["plain.test.mjs"], spans["one-live.test.mjs"]) || overlap(spans["plain.test.mjs"], spans["two-live.test.mjs"]), JSON.stringify(spans));
	check("the file that took longest last time starts first", orderedRun.out.indexOf("── slow.test.mjs") < orderedRun.out.indexOf("── quick.test.mjs"), orderedRun.out);
	const times = JSON.parse(fs.readFileSync(path.join(green, "node_modules/.cache/pi-kit-test-times.json"), "utf8"));
	eq("each run records every file's time for the next", Object.keys(times).sort(), ["alpha.test.mjs", "beta.test.mjs"]);
}

section("suite-runner: failures against main");
{
	const failing = (...names) => trailer(1, names.length, names.map((name) => `console.log("  FAIL ${name}");\n`).join(""));
	const now = fixtureSuite("now", { "a.test.mjs": failing("old one", "new one"), "b.test.mjs": failing("gone") });
	const main = fixtureSuite("main", { "a.test.mjs": failing("old one"), "b.test.mjs": trailer(1, 0) });
	const { out } = await runRunner(now, ["--baseline-root", main]);
	check("a failure that also fails on main is listed as pre-existing", /^also failing on main: a\.test\.mjs: old one$/m.test(out), out.split("\n").slice(-6).join(" | "));
	check("a failure main passes is listed as new", /^new vs main: a\.test\.mjs: new one$/m.test(out) && /^new vs main: b\.test\.mjs: gone$/m.test(out), out.split("\n").slice(-6).join(" | "));
}

fs.rmSync(fixtureRoot, { recursive: true, force: true });
await finish();
