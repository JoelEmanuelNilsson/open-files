/**
 * The seam that stopped a child seat painting over the frame (issues/40), and
 * the one that stops a child seat talking to the provider.
 *
 * Two faults, one door. A headless seat's stdout smears a TUI's frame; a
 * headless seat's *stderr* is a capture buffer — on 2026-09-07 a `pi -p` seat's
 * cache-break warning went to stderr, a parent's bash tool folded it into a
 * tool result, and the sentence rode every later request of that session to
 * Anthropic. Both are the same rule: **the kit writes to no process stream a
 * seat does not own.**
 *
 * Three kinds of check. The behavioural half drives `lib/notice.ts` in real
 * child processes with both streams piped — which is exactly what a parent's
 * bash tool does — and asserts on the bytes that came back. The named half
 * pushes the real warning through the real formatter, so the incident itself
 * has a test. The structural half greps the whole kit, because the fault was
 * never one call site: any `console.log` from a headless seat does it, so the
 * invariant has to be "there are none" rather than "the one we found is fixed".
 *
 *   node test/notice.mjs
 */

import "./env.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const { claimScreen, forgetNoticedKeys, notice, noticeOnce, screenIsOwned } = await jiti.import(`${ROOT}/lib/notice.ts`);

/** A seat: `hasUI` and a `notify` that records instead of drawing. */
const seat = (hasUI) => {
	const seen = [];
	return { hasUI, ui: { notify: (message, type) => seen.push(`${type}:${message}`) }, seen };
};

/** Runs `body` in a child process with both streams piped, and returns them. */
const probe = (body, env = {}) => {
	const script = `
		const { createJiti } = await import(${JSON.stringify(`${PI}/node_modules/jiti/lib/jiti.mjs`)});
		const jiti = createJiti(${JSON.stringify(import.meta.url)}, { interopDefault: true });
		const load = (file) => jiti.import(${JSON.stringify(`${ROOT}/lib/`)} + file);
		${body}
	`;
	const file = path.join(ROOT, "test", `.notice-probe-${process.pid}.mjs`);
	fs.writeFileSync(file, script);
	const run = spawnSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, ...env } });
	fs.rmSync(file, { force: true });
	return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

/** A throwaway XDG_STATE_HOME, so a probe's notices never touch the real sink. */
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "kit-notice-"));

/** Everything a sandbox's notice log holds, or "" when nothing was written. */
const logged = (home) => {
	const dir = path.join(home, "pi-kit", "notices");
	if (!fs.existsSync(dir)) return "";
	return fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("");
};

// ---------------------------------------------------------------------------
console.log("notice: a seat with nobody to talk to writes to no stream at all");
{
	// The 2026-09-07 leak, run for real: no TUI, no screen owner, both streams
	// piped exactly as a parent's bash tool pipes them. Whatever the seat says
	// has to land on disk and nowhere a caller could capture it.
	const home = sandbox();
	const run = probe(
		`
		const { notice, noticeOnce, noticeSinkPath } = await load("notice.ts");
		const headless = { hasUI: false, ui: { notify: () => { throw new Error("a headless seat has no ui"); } } };
		notice(headless, "seat says one", "warning");
		noticeOnce(headless, "k", "seat says two", "info");
		notice(undefined, "and one with no context at all", "error");
		if (!noticeSinkPath().startsWith(process.env.XDG_STATE_HOME)) throw new Error("sink escaped the sandbox");
	`,
		{ XDG_STATE_HOME: home },
	);
	const log = logged(home);

	check("the probe ran", run.status === 0, run.stderr);
	check("nothing reached stdout", run.stdout === "", JSON.stringify(run.stdout));
	check("nothing reached stderr either \u2014 both are somebody's capture buffer", run.stderr === "", JSON.stringify(run.stderr));
	check("all three notices went to the private log instead", log.includes("seat says one") && log.includes("seat says two") && log.includes("and one with no context at all"), log);
	check("each line carries its level and the pid that said it", /\d+ warning seat says one$/m.test(log) && /\d+ error and one/m.test(log), log);

	const dir = path.join(home, "pi-kit", "notices");
	const mode = (target) => fs.statSync(target).mode & 0o777;
	check("the sink is private before anything is written to it", mode(dir) === 0o700, mode(dir).toString(8));
	check("and so is the log", fs.readdirSync(dir).every((name) => mode(path.join(dir, name)) === 0o600));
	fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\nnotice: the cache-break warning never reaches a stream");
{
	// The incident by name, through the real formatter rather than a lookalike
	// string: `describeBreak` is what the seat says, so it is what the test
	// pushes. The provider must never receive our own telemetry about the
	// provider.
	const home = sandbox();
	const run = probe(
		`
		const { notice } = await load("notice.ts");
		const { describeBreak } = await load("wire-trace.ts");
		const report = { seq: 2, expected: 6994, read: 6354, shortfall: 640, sinceSec: 6, ttlExpired: false, verdict: "dropped" };
		const headless = { hasUI: false, ui: { notify: () => { throw new Error("a headless seat has no ui"); } } };
		notice(headless, "wire: " + describeBreak(report), "warning");
	`,
		{ XDG_STATE_HOME: home },
	);
	const streams = run.stdout + run.stderr;
	const log = logged(home);

	check("the probe ran", run.status === 0, run.stderr);
	check("the warning reached neither stream", streams === "", JSON.stringify(streams));
	check("not one word of it is anywhere a parent's tool could capture", !/cache break|re-billed|dropped/.test(streams), JSON.stringify(streams));
	check("and the sentence is on disk, whole", log.includes("cache break: dropped") && log.includes("640 tokens re-billed (read 6,354 of 6,994)"), log);
	fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\nnotice: a sink that cannot be written loses the message, not the rule");
{
	// The one outcome worse than the file, chosen deliberately and pinned here so
	// that a future `catch` which "helpfully" falls back to a stream fails a test
	// named after the decision rather than only the grep.
	const home = path.join(sandbox(), "locked", "state");
	fs.mkdirSync(path.dirname(home), { recursive: true });
	fs.chmodSync(path.dirname(home), 0o500);
	const run = probe(
		`
		const { notice } = await load("notice.ts");
		for (let i = 0; i < 50; i++) notice(undefined, "nowhere to put this one", "error");
	`,
		{ XDG_STATE_HOME: home },
	);

	check("the seat carries on with nowhere to write", run.status === 0, run.stderr);
	check("and fifty lost notices reach no stream on the way down", run.stdout === "" && run.stderr === "", JSON.stringify(run.stdout + run.stderr));
	fs.chmodSync(path.dirname(home), 0o700);
	fs.rmSync(path.dirname(path.dirname(home)), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\nnotice: terminal control reaches a terminal or nothing");
{
	// The one exception to "no stream", and the reason it is safe: escape
	// sequences are addressed to an emulator, and with stdout piped there is no
	// emulator on the other end — only the capture buffer again.
	const run = probe(`
		const { terminalWrite } = await load("notice.ts");
		terminalWrite("\\u0007");
		terminalWrite("\\u001b]777;notify;title;body\\u0007");
	`);

	check("the probe ran", run.status === 0, run.stderr);
	check("with stdout piped, not one escape byte is written", run.stdout === "", JSON.stringify(run.stdout));
	check("and nothing spills to stderr instead", run.stderr === "", JSON.stringify(run.stderr));
}

// ---------------------------------------------------------------------------
console.log("\nnotice: a child seat speaks through the screen owner, never over it");
{
	// The first bug (issues/40), run for real: a parent owns the screen, a child
	// has no UI of its own, and the child speaks. The assertion is on the child
	// process's stdout, which is what a TUI's renderer owns.
	const run = probe(`
		const { claimScreen, notice, noticeOnce } = await load("notice.ts");
		const painted = [];
		claimScreen((message, level) => painted.push(level + ":" + message));
		const child = { hasUI: false, ui: { notify: () => { throw new Error("a headless seat has no ui"); } } };
		notice(child, "child says one", "warning");
		noticeOnce(child, "k", "child says two", "info");
		process.stderr.write("PAINTED " + JSON.stringify(painted) + "\\n");
	`);

	check("the probe ran", run.status === 0, run.stderr);
	check("nothing at all reached the child process's stdout", run.stdout === "", JSON.stringify(run.stdout));
	check("both notices reached the screen owner instead", run.stderr.includes("child says one") && run.stderr.includes("child says two"), run.stderr);
	check("and they arrived through notify, not as raw bytes", run.stderr.includes(`PAINTED ["warning:child says one","info:child says two"]`), run.stderr);
}

// ---------------------------------------------------------------------------
console.log("\nnotice: routing");
{
	forgetNoticedKeys();
	const owner = seat(true);
	const release = claimScreen((message, level) => owner.ui.notify(message, level));

	check("a claim is visible process-wide", screenIsOwned() === true);

	const child = seat(false);
	notice(child, "from the child", "warning");
	check("a headless seat's notice lands on the owner's ui", owner.seen.at(-1) === "warning:from the child");
	check("and never on its own ui", child.seen.length === 0);

	const own = seat(true);
	notice(own, "from a seat with a ui", "info");
	check("a seat that has a ui uses its own", own.seen.at(-1) === "info:from a seat with a ui");
	check("without touching the owner's", owner.seen.length === 1);

	notice(undefined, "no context at all", "error");
	check("a notice with no context still reaches the owner", owner.seen.at(-1) === "error:no context at all");

	release();
	check("release gives the screen back", screenIsOwned() === false);

	const second = seat(true);
	const releaseSecond = claimScreen((message, level) => second.ui.notify(message, level));
	const third = seat(true);
	claimScreen((message, level) => third.ui.notify(message, level));
	notice(seat(false), "after the handover", "info");
	check("the newest claim wins \u2014 one process draws one frame", third.seen.at(-1) === "info:after the handover" && second.seen.length === 0);
	releaseSecond();
	check("a stale release cannot unclaim the live owner", screenIsOwned() === true);

	claimScreen(() => { throw new Error("the owner's ui is gone"); });
	notice(seat(false), "into a dead frame", "info");
	check("an owner that throws mid-teardown does not take the notice down with it", true);

	// The same must hold for a seat's own ui, and for a harder reason: callers say
	// things from inside pi's hooks, and pi answers a throw in `wire`'s hook by
	// sending its own payload — pi's prompt, unattributed. A message to the human
	// may never cost that.
	const landed = [];
	claimScreen((message, level) => landed.push(`${level}:${message}`));
	const broken = { hasUI: true, ui: { notify: () => { throw new Error("this frame is unmounted"); } } };
	let threw = false;
	try { notice(broken, "through a dead ui", "error"); } catch { threw = true; }
	check("a seat whose own ui throws does not throw at the caller", !threw);
	check("and the message falls through to the screen owner rather than vanishing", landed.at(-1) === "error:through a dead ui", JSON.stringify(landed));
}

// ---------------------------------------------------------------------------
console.log("\nnotice: once per process, not once per seat");
{
	forgetNoticedKeys();
	const owner = seat(true);
	claimScreen((message, level) => owner.ui.notify(message, level));

	// The repeat half of issues/40: the dedupe used to be a Set in an extension
	// closure, and ~20 fanned-out children are ~20 closures.
	const children = Array.from({ length: 20 }, () => seat(false));
	const delivered = children.filter((child) => noticeOnce(child, "wire:coerced:claude-sonnet-4-5", "coerced", "warning"));
	check("twenty child seats say it once between them", delivered.length === 1 && owner.seen.length === 1);

	check("a different key is a different message", noticeOnce(owner, "other", "other", "info") === true && owner.seen.length === 2);
	check("the same key never comes back", noticeOnce(owner, "other", "other", "info") === false && owner.seen.length === 2);

	forgetNoticedKeys();
	check("forgetting the keys is what lets a test start clean", noticeOnce(owner, "other", "other", "info") === true);
}

// ---------------------------------------------------------------------------
console.log("\nnotice: no kit file writes to a process stream");
{
	// The structural half, and the reason the exception list is two standalone
	// programs rather than a judgement call per call site: `notify.ts` used to be
	// allowed here for its escape sequences, which meant reviewing every write in
	// it forever. It now goes through `terminalWrite`, so the rule is a grep with
	// one exempt module. The zen-chrome scripts are run by hand, never loaded as
	// extensions; stdout is their whole product.
	//
	// The pattern bans the *mention*, not the call, because the call has too many
	// spellings to enumerate: `console.table`, `process.stdout?.write`, a saved
	// reference, a write split across two lines, `writeSync(1, ...)`, a handle on
	// `/dev/stderr`. Reading the terminal's shape is the one thing a mention can
	// legitimately be, so `isTTY`, `rows` and `columns` are the whole exemption.
	const ALLOWED = new Set(["extensions/zen-chrome/preview.ts", "extensions/zen-chrome/test.ts"]);
	const WRITES = /console\.|process\.(?:stdout|stderr)(?!\.(?:isTTY|rows|columns)\b)|writeSync\s*\(\s*[12]\s*,|\/dev\/(?:stdout|stderr|fd\/[12])/;

	// A directory with its own `package.json` is its own project — a vendored
	// prototype, a spike, anything with a bundler — and none of it is kit source.
	// The guards below claim things about code written here, and a foreign tree
	// fails them for reasons that are nobody's bug: a minified bundle mentions
	// `console`, a `.tsx` file does not parse as a pi module, `import.meta.glob`
	// exists only under Vite. Asking the directory what it is beats keeping a list
	// of names, which would have to be extended for every next spike.
	const foreign = (dir) => fs.existsSync(path.join(dir, "package.json"));
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return foreign(full) ? [] : walk(full);
		return entry.isFile() && /\.(?:ts|tsx|mjs|cjs|js)$/.test(entry.name) ? [full] : [];
	});

	const modules = [...walk(path.join(ROOT, "extensions")), ...walk(path.join(ROOT, "lib"))];
	const offenders = [];
	for (const file of modules) {
		const relative = path.relative(ROOT, file);
		if (ALLOWED.has(relative) || relative === "lib/notice.ts") continue;
		const lines = fs.readFileSync(file, "utf8").split("\n");
		for (const [index, line] of lines.entries()) {
			if (WRITES.test(line)) offenders.push(`${relative}:${index + 1}`);
		}
	}
	check("no console or stream write survives outside lib/notice.ts", offenders.length === 0, offenders.join("\n       "));

	// And the same claim without a regex in it: load every module the kit has, in
	// a piped child, with both streams replaced by recorders. A grep knows the
	// spellings someone thought of; this knows the bytes. It covers module scope
	// only — a write inside a function is the grep's job — which is exactly where
	// a stray debug line or a chatty dependency lands.
	const loadable = modules.filter((file) => !ALLOWED.has(path.relative(ROOT, file)));
	const home = sandbox();
	const run = probe(
		`
		const seen = [];
		const tap = (name) => { const real = process[name].write.bind(process[name]); process[name].write = (chunk) => { seen.push(name + ": " + String(chunk)); return true; }; return real; };
		const stdout = tap("stdout");
		const stderr = tap("stderr");
		const broken = [];
		for (const file of JSON.parse(process.env.KIT_MODULES)) {
			try { await jiti.import(file); } catch (error) { broken.push(file + ": " + error.message.split("\\n")[0]); }
		}
		process.stdout.write = stdout;
		process.stderr.write = stderr;
		stdout(JSON.stringify({ seen, broken }) + "\\n");
	`,
		{ KIT_MODULES: JSON.stringify(loadable), XDG_STATE_HOME: home },
	);
	fs.rmSync(home, { recursive: true, force: true });
	const loaded = JSON.parse(run.stdout || '{"seen":["the probe never reported"],"broken":[]}');
	check(`all ${loadable.length} kit modules load`, run.status === 0 && loaded.broken.length === 0, `${run.stderr}${loaded.broken.join("\n       ")}`);
	check("and not one of them writes a byte to a stream on the way in", loaded.seen.length === 0, loaded.seen.join("\n       "));

	const noticeSource = fs.readFileSync(path.join(ROOT, "lib", "notice.ts"), "utf8");
	const writes = noticeSource.match(/process\.(?:stdout|stderr)\.write\s*\(/g) ?? [];
	check("the seam itself makes exactly one stream write — terminalWrite's", writes.length === 1, writes.join(" "));
	check("and it is guarded by the terminal being there", /isTTY !== true\) return;/.test(noticeSource));
	check("stderr is not a diagnostics channel here — it is a parent's capture buffer", !/process\.stderr/.test(noticeSource));

	// The hole `terminalWrite` opens is one line wide, and this is the line: it
	// refuses to be a door for prose, so a caller cannot reach past `notice` by
	// reaching for it. Checked on a fake TTY, because on a piped stream the
	// earlier guard would pass this test for the wrong reason.
	const tty = probe(`
		const { terminalWrite } = await load("notice.ts");
		Object.defineProperty(process.stdout, "isTTY", { value: true });
		terminalWrite("\\u0007");
		terminalWrite("wire: cache break: dropped — 640 tokens re-billed");
	`);
	check("with a terminal attached, a control sequence goes out", tty.stdout === "\u0007", JSON.stringify(tty.stdout));
	check("and a sentence is refused — the one stream write left is not a door for prose", !tty.stdout.includes("cache break") && !tty.stderr.includes("cache break"), JSON.stringify(tty.stdout + tty.stderr));
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
