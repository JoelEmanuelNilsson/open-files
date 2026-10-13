import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { renderContext as ctx, sgrTheme as themeStub } from "../support/tool-row-fixtures.mjs";

const jiti = kitJiti();
const header = await jiti.import(`${KIT_ROOT}/lib/transcript/call-header.ts`);
const receipt = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-receipt.ts`);
const row = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-row.ts`);

// ---------------------------------------------------------------------------
// The clock: started by the call slot, stopped by the result slot, once.
// ---------------------------------------------------------------------------

const clock = ctx({ executionStarted: false, isPartial: true });
row.startClock(clock);
eq("the clock does not start while arguments stream", clock.state.startedAt, undefined);
clock.executionStarted = true;
row.startClock(clock);
const began = clock.state.startedAt;
eq("it starts when execution does", typeof began, "number");
row.startClock(clock);
eq("and only once", clock.state.startedAt, began);
eq("a running call has no duration", row.stopClock(clock), null);
clock.isPartial = false;
clock.state.startedAt = Date.now() - 2400;
eq("a settled one does", row.stopClock(clock), "2.4s");
const stopped = clock.state.endedAt;
clock.state.startedAt = Date.now() - 90_000;
eq("the end is recorded once, not re-read on every frame", clock.state.endedAt, stopped);

// ---------------------------------------------------------------------------
// A call that was interrupted stopped; it is not still working.
// ---------------------------------------------------------------------------

const cut = ctx({ isPartial: true, toolCallId: "cut" });
let redrawn = 0;
cut.invalidate = () => redrawn++;
receipt.toolHeader("bash", { command: "sleep 100" }, themeStub, cut);
eq("a running call says so", header.stateOf(cut), "running");
row.quiesce();
eq("once the run settles, a call still in flight was cut off", header.stateOf(cut), "aborted");
eq("and the row is asked to draw itself again", redrawn, 1);
// A call that settled before the run did is not watched, so nothing can mark it.
const landed = ctx({ toolCallId: "landed" });
receipt.toolHeader("bash", { command: "true" }, themeStub, landed);
row.quiesce();
eq("a settled call is left alone", header.stateOf(landed), "done");

await finish();
