import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const summary = await jiti.import(`${KIT_ROOT}/lib/transcript/call-summary.ts`);

// ---------------------------------------------------------------------------
// Summaries come from the output contract, never from the shape of the text.
// ---------------------------------------------------------------------------

const sum = (tool, text, args = {}, truncated = false) => summary.summarizeToolResult(tool, text, args, truncated);
const say = (s) => (s === null ? null : summary.summaryText(s));

eq("read counts lines", say(sum("read", "a\nb\nc")), "Read 3 lines");
eq("read ignores pi's notice", say(sum("read", "a\nb\n\n[3 more lines in file. Use offset=3 to continue.]")), "Read 2 lines");
eq("read admits a truncated count is a floor", say(sum("read", "a\nb", {}, true)), "Read 2+ lines");
eq("one is singular", say(sum("read", "a")), "Read 1 line");


// `write` is counted from what it was handed, not from `Successfully wrote N bytes`.
eq("write counts the content it was given", say(sum("write", "Successfully wrote 6 bytes", { content: "a\nb\nc\n" })), "Wrote 3 lines");
eq("write with no content says nothing", sum("write", "x", {}), null);
eq("an empty write is zero lines", say(sum("write", "x", { content: "" })), "Wrote 0 lines");

eq("bash has no honest count", sum("bash", "anything at all"), null);
eq("an unknown tool has no count", sum("mcp__whatever", "x\ny"), null);

eq("bytes", [summary.formatBytes(900), summary.formatBytes(2048), summary.formatBytes(3_500_000)], ["900 B", "2.0 KB", "3.3 MB"]);

// ---------------------------------------------------------------------------
// Durations below the floor are noise, not information.
// ---------------------------------------------------------------------------

eq("4ms is not worth saying", summary.formatCallDuration(4), null);
eq("499ms is not worth saying", summary.formatCallDuration(499), null);
eq("500ms is", summary.formatCallDuration(500), "0.5s");
eq("seconds", summary.formatCallDuration(2410), "2.4s");
eq("minutes", summary.formatCallDuration(125_000), "2m 5s");
eq("59.6s of remainder carries into the minute", summary.formatCallDuration(599_600), "10m");
eq("whole minutes", summary.formatCallDuration(120_000), "2m");

await finish();
