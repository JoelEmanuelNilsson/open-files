import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { answer, assistant, call, prompt, said, thought } from "../support/tool-row-fixtures.mjs";

const jiti = kitJiti();

// ---------------------------------------------------------------------------
// A run of calls collapses to one line: present tense while it runs, past tense
// when it is over.
//
// The grammar and every rule below were read off Claude Code (2.1.247, then
// 2.1.248) running in a pane beside this one, not guessed: one call collapses
// as readily as seven, a failure does not (that one is ours), work that
// finished while its own message is still running says nothing at all, and
// `ctrl+o` puts every row back.
// ---------------------------------------------------------------------------

const group = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-rollup.ts`);
const rollupPlan = await jiti.import(`${KIT_ROOT}/lib/transcript/rollup-plan.ts`);

const planned = (entries, live = false) => rollupPlan.plan(entries, live).map((g) => g.ids.join("+"));
/** The same, with an ellipsis on the group whose line is present tense. */
const shape = (entries, live = true) => rollupPlan.plan(entries, live).map((g) => g.ids.join("+") + (g.running ? "\u2026" : ""));

eq(
	"one message, one group",
	planned([prompt("go"), assistant(said("on it"), call("a", "bash"), call("b", "bash")), answer("a"), answer("b")]),
	["a+b"],
);

// pi adds the whole assistant message at message_start and appends its rows
// after it, so a message that says anything says it above its own calls.
eq(
	"prose between two messages starts a new group",
	planned([assistant(call("a", "bash")), answer("a"), assistant(said("now this"), call("b", "bash")), answer("b")]),
	["a", "b"],
);
eq(
	"a silent message keeps the group going",
	planned([assistant(call("a", "bash")), answer("a"), assistant(call("b", "bash")), answer("b")]),
	["a+b"],
);
// Thinking never breaks a group, hidden or not — Claude Code skips thinking
// blocks when it groups too. With `hideThinkingBlock` on, which is this
// harness's setting, a reasoning model puts a thinking block in front of almost
// every message: counting one as prose made almost every message a group of one
// and put the rollup line out of reach of the models that use it most.
eq("thinking does not break a group", planned([assistant(call("a", "bash")), answer("a"), assistant(thought("hm"), call("b", "bash")), answer("b")]), ["a+b"]);
eq(
	"but text alongside it still does",
	planned([assistant(call("a", "bash")), answer("a"), assistant(thought("hm"), said("now this"), call("b", "bash")), answer("b")]),
	["a", "b"],
);
eq(
	"a thinking model's whole turn is one group",
	planned([assistant(thought("first"), call("a", "read")), answer("a"), assistant(thought("then"), call("b", "bash")), answer("b")]),
	["a+b"],
);
eq("an empty text block is not prose", planned([assistant(call("a", "bash")), answer("a"), assistant(said("  "), call("b", "bash")), answer("b")]), ["a+b"]);

// Everything below is a row that stays on screen, so the run is cut there
// rather than summarised around it.
eq(
	"a failure keeps its row and splits the group",
	planned([assistant(call("a", "read"), call("b", "bash"), call("c", "read")), answer("a"), answer("b", { isError: true }), answer("c")]),
	["a", "c"],
);
eq(
	"a write keeps its row",
	planned([assistant(call("a", "read"), call("b", "write"), call("c", "read")), answer("a"), answer("b"), answer("c")]),
	["a", "c"],
);
eq("an unknown tool keeps its row", planned([assistant(call("a", "read"), call("b", "mcp__x__y")), answer("a"), answer("b")]), ["a"]);
// pi draws the picture as a child of the row whether or not the renderers
// produce a line, so a collapsed row would leave it floating under no header.
eq(
	"a result carrying a picture keeps its row",
	planned([assistant(call("a", "read"), call("b", "read")), answer("a", { content: [{ type: "image", data: "x", mimeType: "image/png" }] }), answer("b")]),
	["b"],
);
// A run that is over has no calls in flight, so one that never came back was
// interrupted, and an interrupted call keeps its row.
eq("an interrupted call keeps its row and splits the group", planned([assistant(call("a", "read"), call("b", "read")), answer("b")]), ["b"]);
eq(
	"the calls either side of it still fold",
	planned([assistant(call("a", "read"), call("b", "read"), call("c", "read")), answer("a"), answer("c")]),
	["a", "c"],
);
// While the run is live, a call that has not come back joins its group and is
// the reason the group speaks in the present tense. pi creates a row for every
// call in a batch as its arguments stream, so without this a seven-call turn is
// seven rows on screen before any of them has run.
//
// The tense is a property of the *run*, not of the results: it is present from
// the first token to `agent_settled`, whatever has already come back. Deciding
// it per result is what made a turn of three commands bounce two lines to one
// and back, since the gap between one result and the next call has nothing in
// flight in it.
const batch = [assistant(call("a", "read"), call("b", "bash"), call("c", "bash"))];
eq("a live batch speaks in the present from the first token", shape(batch), ["a+b+c\u2026"]);
eq("a result landing changes nothing about the tense", shape([...batch, answer("a")]), ["a+b+c\u2026"]);
// A batch runs in parallel, so the third result can land before the second.
eq("nor does one landing out of order", shape([...batch, answer("a"), answer("c")]), ["a+b+c\u2026"]);
eq("nor the last of them, while the model is still going", shape([...batch, answer("a"), answer("b"), answer("c")]), ["a+b+c\u2026"]);
eq("the run stopping is what makes it past", shape([...batch, answer("a"), answer("b"), answer("c")], false), ["a+b+c"]);
eq("a settled run with a call still out keeps that row", shape(batch, false), []);
// Only the group the transcript ends on can be about work still happening;
// everything before it has something printed after it.
eq(
	"only the trailing group is present tense",
	shape([assistant(call("a", "read")), answer("a"), prompt("more"), assistant(call("b", "read"))]),
	["a", "b\u2026"],
);
// A row that stays ends the run whether or not anything is still going.
eq("a write splits a live batch too", shape([assistant(call("a", "read"), call("b", "write"), call("c", "read"))]), ["a", "c\u2026"]);

// A result reaches the planner before it reaches the session, because pi emits
// the event first and a parallel batch writes every result down at the end.
group.noteResult("b", false);
eq("a result that has not been written down yet still folds", planned([assistant(call("a", "read"), call("b", "read")), answer("a")]), ["a+b"]);
group.noteResult("c", true);
eq("and a failure that has not either keeps its row", planned([assistant(call("c", "read"), call("a", "read")), answer("a")]), ["a"]);
group.forgetResults();
eq("forgotten once the session has them", planned([assistant(call("a", "read"), call("b", "read")), answer("a")]), ["a"]);
eq(
	"an interrupted turn keeps every row",
	planned([{ type: "message", message: { role: "assistant", stopReason: "aborted", content: [call("a", "read"), call("b", "read")] } }, answer("a")]),
	[],
);
eq("a user message splits", planned([assistant(call("a", "read")), answer("a"), prompt("more"), assistant(call("b", "read")), answer("b")]), ["a", "b"]);
eq(
	"a compaction summary splits",
	planned([assistant(call("a", "read")), answer("a"), { type: "compaction", summary: "…" }, assistant(call("b", "read")), answer("b")]),
	["a", "b"],
);
// A model change prints nothing, so it cannot separate two rows.
eq(
	"an invisible entry does not",
	planned([assistant(call("a", "read")), answer("a"), { type: "model_change" }, assistant(call("b", "read")), answer("b")]),
	["a+b"],
);
eq("junk in the entries is ignored, not thrown over", planned([null, undefined, 7, "x", { type: "message" }]), []);

await finish();
