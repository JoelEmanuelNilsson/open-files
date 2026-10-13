/**
 * Rules the kit's source keeps that no single module can: only the session
 * scope starts a turn without a user message, and every raw timer outside it
 * has a `// raw-timer:` reason beside it. Each .ts/.tsx under the scan roots is lexed once by pi's own
 * esbuild, and both scans read that one output.
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT, PI_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The kit-relative directories both scans walk, recursively; a new source root must be added here. */
const SOURCE_SCAN_ROOTS = ["extensions", "lib"];
/** The one file allowed to start a turn without a user message: it knows whether `before_agent_start` has fired. */
const TRIGGER_TURN_SCOPE_FILE = "lib/session/session-scope.ts";

// pi's own esbuild lexes the source, so a regex literal like /^https?:\/\// opens no
// comment and a type-only mention is erased; strings stay, so a quoted key still counts.
const { transformSync } = createRequire(`${PI_ROOT}/package.json`)("esbuild");
const lexed = (source, loader = "ts") => transformSync(source, { loader, legalComments: "none" }).code;

/** Every .ts/.tsx under the scan roots: its kit-relative path, its source and its esbuild output. */
const scannedSources = SOURCE_SCAN_ROOTS.flatMap((dir) =>
	fs.readdirSync(path.join(KIT_ROOT, dir), { recursive: true, withFileTypes: true }).flatMap((entry) => {
		const file = path.join(entry.parentPath, entry.name);
		if (!entry.isFile() || !/\.tsx?$/.test(file)) return [];
		const raw = fs.readFileSync(file, "utf8");
		return [{ file: path.relative(KIT_ROOT, file), raw, code: lexed(raw, file.endsWith(".tsx") ? "tsx" : "ts") }];
	}),
);

// ---------------------------------------------------------------------------
section("the turns that start without a user message");
{
	// pi hands out the prompt options on `before_agent_start`, and a turn started
	// by a custom message skips it: on the first turn of a process `wire` had
	// nothing to build a prompt from (2026-09-06, req_011CenGzjBfwouGRX52Q5PE3),
	// and on 2026-09-23 such a turn raced a handoff's continuation. Only the
	// session scope, which knows whether that event has fired, may ask for one.
	const triggerTurnsIn = (code) =>
		[...code.matchAll(/\btriggerTurn\b(?!["']?\s*:\s*false\b)/g)].map((match) => code.slice(code.lastIndexOf("\n", match.index) + 1, code.indexOf("\n", match.index)).trim());
	check("the scan sees past a regex literal that holds `//`", triggerTurnsIn(lexed("const url = /^https?:\\/\\//; pi.sendMessage(m, { triggerTurn: true });")).length === 1);
	check("and ignores comments and `triggerTurn: false`", triggerTurnsIn(lexed("// triggerTurn: true\n/* triggerTurn: true */\npi.sendMessage(m, { triggerTurn: false });")).length === 0);
	const offenders = scannedSources
		.filter(({ file }) => file !== TRIGGER_TURN_SCOPE_FILE)
		.flatMap(({ file, code }) => triggerTurnsIn(code).map((line) => `${file}: ${line}`));
	check(`no triggerTurn other than false outside ${TRIGGER_TURN_SCOPE_FILE}`, offenders.length === 0, offenders.join(", "));

	// A timer outlives the session that armed it: on 2026-09-23 the watchdog's
	// fired into a reloaded seat, and a queued `/continue` into a quit one. The
	// session scope clears its timers at shutdown, so a raw one needs a reason
	// beside it, a `// raw-timer: <why>` comment per timer, or `// raw-timer(N): <why>`
	// for N that cannot carry one, and each file's count is exact so a new one needs its own.
	// Markers are read from the raw source because esbuild drops most comments. It keeps those before
	// a `case` or inside an argument list, so a marker there whose why names a timer counts as one.
	const rawTimerMarkersIn = (raw) => [...raw.matchAll(/\/\/ raw-timer(?:\((\d+)\))?: \S/g)].reduce((sum, match) => sum + Number(match[1] ?? 1), 0);
	check("the marker scan counts `// raw-timer(N): <why>` as N timers, `// raw-timer: <why>` as one, and a marker without a why as none", rawTimerMarkersIn("// raw-timer(4): template text\n// raw-timer: one\n// raw-timer:\n// raw-timer(2):") === 5);
	const rawTimersIn = (code) => code.match(/(?:(?<![\w$.])|(?<=\bglobalThis\.))set(?:Timeout|Interval)\b(?!\s*:)/g)?.length ?? 0;
	check("the timer scan counts a call or a reference, and not a method, a key, a type or a comment", rawTimersIn(lexed("setTimeout(f, 1); globalThis.setInterval(f, 1); run(setTimeout); scope.setTimeout(f); const clock = { setTimeout: (f) => f }; let t: ReturnType<typeof setTimeout>; // setTimeout(f)")) === 3);
	const counted = {};
	for (const { file, code } of scannedSources) {
		const count = rawTimersIn(code);
		if (count > 0) counted[file] = count;
	}
	const marked = {};
	for (const { file, raw } of scannedSources) {
		const count = rawTimerMarkersIn(raw);
		if (count > 0) marked[file] = count;
	}
	const unexplained = Object.entries(counted).filter(([file, count]) => marked[file] !== count).map(([file, count]) => `${file}: ${count} (marked ${marked[file] ?? 0})`);
	check("no raw setTimeout/setInterval without a `// raw-timer: <why>` marker beside it", unexplained.length === 0, unexplained.join(", "));
	const gone = Object.keys(marked).filter((file) => counted[file] === undefined);
	check("and every raw-timer marker still marks a timer", gone.length === 0, gone.join(", "));
}

await finish();
