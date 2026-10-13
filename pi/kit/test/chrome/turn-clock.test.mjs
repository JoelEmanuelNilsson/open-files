/**
 * The turn clock zen-chrome writes and the bottom rule reads
 * (lib/session/turn-clock.ts): its state table and its formatter. All pure, so
 * none of it needs pi, a TUI, or a session.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();

const { TURN_CLOCK_FLOOR_MS, IDLE_TURN_CLOCK, elapsedMs, turnClockReading, reduceTurn } = await jiti.import(
	`${KIT_ROOT}/lib/session/turn-clock.ts`,
);
const { formatDuration } = await jiti.import(`${KIT_ROOT}/lib/ui/duration-label.ts`);

console.log("\n--- turn clock: the state table");

// Driven on a clock we control, so "thirty seconds later" is exact and no test
// ever sleeps. Assertions are on what the clock *says*, never on its fields.
const T0 = 1_700_000_000_000;
const at = (ms) => T0 + ms;
const drive = (events) => events.reduce((clock, [event, ms]) => reduceTurn(clock, event, at(ms)), IDLE_TURN_CLOCK);
const phaseAt = (clock, ms) => turnClockReading(clock, at(ms)).phase;
const labelAt = (clock, ms) => turnClockReading(clock, at(ms)).label;

check("idle shows nothing", phaseAt(IDLE_TURN_CLOCK, 0) === "empty" && labelAt(IDLE_TURN_CLOCK, 0) === "");

const running = drive([["turn_start", 0]]);
check("a turn still under the floor shows nothing", phaseAt(running, TURN_CLOCK_FLOOR_MS - 1) === "empty");
check(
	"and goes live exactly at the floor",
	phaseAt(running, TURN_CLOCK_FLOOR_MS) === "live" && labelAt(running, TURN_CLOCK_FLOOR_MS) === "30s",
	JSON.stringify(turnClockReading(running, at(TURN_CLOCK_FLOOR_MS))),
);

const settled = reduceTurn(running, "turn_settled", at(72_000));
check(
	"settling past the floor holds the final figure",
	phaseAt(settled, 72_000) === "held" && labelAt(settled, 72_000) === "1m 12s",
	JSON.stringify(turnClockReading(settled, at(72_000))),
);
check("and the held figure stops moving", labelAt(settled, 900_000) === "1m 12s");

// The floor gates the held value as well as the live one: a short turn leaves
// nothing behind, not even after the fact.
const brief = drive([
	["turn_start", 0],
	["turn_settled", 12_000],
]);
check("a sub-floor turn leaves no trace", phaseAt(brief, 12_000) === "empty" && phaseAt(brief, 999_000) === "empty");

// A running turn's slot must never carry the previous turn's number, not even
// during the thirty seconds before it has earned one of its own.
const next = reduceTurn(settled, "turn_start", at(100_000));
check("the next turn clears the held figure at once", phaseAt(next, 100_000) === "empty");
check("and then shows its own", labelAt(next, 100_000 + TURN_CLOCK_FLOOR_MS) === "30s");

// A retry and an auto-compaction both re-enter through `agent_start`, which the
// extension feeds in as another turn start. The user's wait did not restart.
const retried = drive([
	["turn_start", 0],
	["turn_start", 40_000],
	["turn_start", 55_000],
]);
check("a retry does not reset the start", labelAt(retried, 72_000) === "1m 12s", labelAt(retried, 72_000));
const compacted = reduceTurn(retried, "turn_settled", at(124_000));
check("and the total is the whole wait, not the last attempt", labelAt(compacted, 124_000) === "2m 04s");
check(
	"a stray second settle cannot zero a held figure",
	labelAt(reduceTurn(compacted, "turn_settled", at(900_000)), 900_000) === "2m 04s",
);

check("a session reset clears a held figure", phaseAt(reduceTurn(settled, "session_reset", at(80_000)), 80_000) === "empty");
check("and a running one", phaseAt(reduceTurn(running, "session_reset", at(80_000)), 80_000) === "empty");

// notify reads this clock too. It must get the same number whether it runs
// before or after zen-chrome closes the turn, or the ping and the frame differ.
check(
	"the clock reads the same either side of settling",
	elapsedMs(running, at(72_000)) === elapsedMs(settled, at(900_000)),
);

console.log("\n--- turn clock: the formatter");

for (const [ms, want] of [
	[0, "0s"],
	[999, "0s"],
	[12_000, "12s"],
	[TURN_CLOCK_FLOOR_MS, "30s"],
	[59_999, "59s"],
	[60_000, "1m 00s"],
	[72_000, "1m 12s"],
	[124_000, "2m 04s"],
	[119_600, "2m 00s"],
	[600_000, "10m 00s"],
]) {
	check(`${ms}ms reads as ${want}`, formatDuration(ms) === want, `got ${formatDuration(ms)}`);
}

await finish();
