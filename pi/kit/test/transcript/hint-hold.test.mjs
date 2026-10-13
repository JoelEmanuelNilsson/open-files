import { eq, finish } from "../support/check-harness.mjs";
import { mock } from "node:test";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const hintHold = await jiti.import(`${KIT_ROOT}/lib/transcript/hint-hold.ts`);

// ---------------------------------------------------------------------------
// The hint holds for its minimum. A command printing faster than the eye can
// finish a line leaves nothing readable behind, so the gutter is worth less
// than a blank one. Claude Code's `useMinDisplayTime`, at 700ms.
// ---------------------------------------------------------------------------

// The hold books its redraw on a timer; a fake clock runs it without waiting.
mock.timers.enable({ apis: ["setTimeout"] });

const held = {};
const hintAt = (text, ms) => hintHold.heldHint(held, { line: text, hidden: 0 }, false, () => {}, ms)?.line;
eq("the first hint goes up at once", hintAt("PASS a", 1_000), "PASS a");
eq("one replacing it inside the window waits", hintAt("PASS b", 1_100), "PASS a");
// The window is a property of the line on screen, not of the last attempt to
// replace it, or a fast enough command would hold its first line forever.
eq("and the attempt does not restart the window", hintAt("PASS c", 1_690), "PASS a");
eq("past it, the newest one wins", hintAt("PASS c", 1_700), "PASS c");
// The newest value is never carried, only re-read: pi re-runs the result slot
// against the result it still holds. So a command that prints nothing more
// before its window closes still ends on its real last line rather than on the
// one before it, and that costs exactly one booked redraw however many frames
// were refused.
let closed = 0;
const silent = {};
const reopen = () => closed++;
const silentAt = Date.now();
hintHold.heldHint(silent, { line: "first", hidden: 0 }, false, reopen, silentAt);
hintHold.heldHint(silent, { line: "second", hidden: 0 }, false, reopen, silentAt + hintHold.HINT_HOLD_MS - 25);
hintHold.heldHint(silent, { line: "third", hidden: 0 }, false, reopen, silentAt + hintHold.HINT_HOLD_MS - 20);
mock.timers.tick(60);
eq("a hint that has gone quiet still closes its own window, once", closed, 1);

// A settled render is the record of what a command printed, and a record that
// arrives late is a row that changes after it has finished.
const finishing = {};
hintHold.heldHint(finishing, { line: "PASS a", hidden: 0 }, false, () => {}, 2_000);
eq("settling is never held", hintHold.heldHint(finishing, { line: "PASS z", hidden: 3 }, true, () => {}, 2_010), { line: "PASS z", hidden: 3 });
eq("and takes the hold down with it", finishing.hint, undefined);

mock.timers.reset();

await finish();
