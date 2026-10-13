import { eq, finish, show } from "../support/check-harness.mjs";
import { mock } from "node:test";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import {
	answer,
	assistant,
	call,
	loadKitExtensions,
	prompt,
	ran,
	reading,
	realToolRows,
	renderContext as ctx,
	streamingBash,
	stripAnsi as strip,
	textContent as text,
	thought,
} from "../support/tool-row-fixtures.mjs";
// pi-tui caches terminal capabilities on first read and reports no image
// support under a multiplexer, which is the case the image fallback exists for.
process.env.TMUX = "test";

// The gutter hold and the line clock run on timers and read Date.now(); a fake
// clock moves both at once, so a hold or a tick is waited out without waiting.
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });

const jiti = kitJiti();
const group = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-rollup.ts`);
const hintHold = await jiti.import(`${KIT_ROOT}/lib/transcript/hint-hold.ts`);
const row = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-row.ts`);
const { tools: registered, toolRenderers } = await loadKitExtensions(jiti, "transcript/index.ts", "bash/index.ts");
const realComponent = await realToolRows(registered, toolRenderers);

// ---------------------------------------------------------------------------
// Through pi's own rows again: the group has to actually disappear.
// ---------------------------------------------------------------------------

const turn = [
	realComponent("read", { path: `${KIT_ROOT}/package.json` }, text("a\nb\nc"), { id: "g1" }),
	realComponent("bash", { command: "whoami" }, text("joel"), { id: "g2" }),
	realComponent("bash", { command: "date" }, text("Thu"), { id: "g3" }),
];
/** A result arriving on a row that had none, which is how a call actually lands. */
const land = (component, content) => component.updateResult({ content, details: undefined, isError: false }, false);
const entries = [prompt("go"), assistant(call("g1", "read"), call("g2", "bash"), call("g3", "bash")), answer("g1"), answer("g2"), answer("g3")];
const drawTurn = () => turn.flatMap((component) => component.render(80)).map(strip);
const headers = () => drawTurn().filter((line) => line.startsWith("●"));
// A row learns the group opened when the lead draws its line, and is asked to
// redraw on the microtask after it. pi schedules its frame on a timer, so the
// app never sees the gap; a test that renders by hand has to wait for it.
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** The gutter's minimum display time, waited out where a test needs it to change. */
const hold = async () => mock.timers.tick(hintHold.HINT_HOLD_MS + 20);

eq("while it runs, every call has its row", headers().length, 3);

// The whole turn, the way it happens: pi draws every row of the batch as the
// arguments stream, before any of them has run, and one call at a time comes
// back. Through all of it the line says the same thing — the counts are the
// group's, not the in-flight subset's, so nothing on screen runs backwards.
const running = [
	realComponent("read", { path: `${KIT_ROOT}/package.json` }, undefined, { id: "g1" }),
	realComponent("bash", { command: "whoami" }, undefined, { id: "g2" }),
	realComponent("bash", { command: "date" }, undefined, { id: "g3" }),
];
const drawRunning = () => running.flatMap((component) => component.render(80)).map(strip);
const inFlight = [prompt("go"), assistant(reading("g1", `${KIT_ROOT}/package.json`), ran("g2", "whoami"), ran("g3", "date"))];

group.regroup(inFlight, true);
eq("a batch in flight is one line, not one row per call", drawRunning(), ["", "● Reading 1 file, running 2 shell commands…", "  ⎿  $ date"]);

land(running[0], text("a\nb\nc"));
group.regroup([...inFlight, answer("g1")], true);
eq("a landing call changes nothing on the line", drawRunning()[1], "● Reading 1 file, running 2 shell commands…");

land(running[1], text("joel"));
group.regroup([...inFlight, answer("g1"), answer("g2")], true);
// The old rule swapped the counted line for the last call's own header here,
// which changed the component under the cursor one frame before the group
// settled. Shape is read off `ids.length`, which cannot shrink.
eq("one call left is still the same line", drawRunning()[1], "● Reading 1 file, running 2 shell commands…");

// The counts a batch settles on are the counts it showed all along: only the
// verb moves. This is the property the whole no-jump rule exists to buy.
const liveText = drawRunning()[1];
land(running[2], text("Mon"));
group.regroup([...inFlight, answer("g1"), answer("g2"), answer("g3")], true);
const numbers = (s) => s.match(/\d+/g)?.join(",") ?? "";
eq("settling moves no number", numbers(drawRunning()[1] ?? ""), numbers(liveText));

land(running[2], text("Thu"));
group.regroup(entries);
eq("and when the run ends, the past tense, in the same column", drawRunning(), ["", "  Read 1 file, ran 2 shell commands"]);

// The line draws its own gutter, naming the newest call it stands for by what
// it was asked to do. The rows underneath draw nothing in either slot, so this
// is the only thing on screen that can say it.
const tailing = [
	realComponent("bash", { command: "npm test" }, text("PASS a\nPASS b\n"), { partial: true, id: "t1" }),
	realComponent("bash", { command: "npm run lint" }, undefined, { id: "t2" }),
];
const drawTailing = () => tailing.flatMap((component) => component.render(80)).map(strip);
group.regroup([assistant(ran("t1", "npm test"), ran("t2", "npm run lint"))], true);
eq("a live line names the newest call it is waiting on", drawTailing(), ["", "● Running 2 shell commands…", "  ⎿  $ npm run lint"]);
// What a folded command prints stays off the line: the gutter is the call's
// name, as Claude Code's `latestDisplayHint` is, not its stdout going past.
await hold();
tailing[1].updateResult({ content: text("lint: 3 files\n"), details: undefined, isError: false }, true);
drawTailing();
await settle();
eq("and keeps naming it once it prints", drawTailing().slice(-1), ["  ⎿  $ npm run lint"]);
eq("and is still two lines", drawTailing().length, 3);

// Through the real rows, which is the only thing that proves the wiring: the
// line says files rather than calls because the planner hands it what each call
// was about, and the same file fetched twice is one file.
const pages = [
	realComponent("read", { path: `${KIT_ROOT}/package.json` }, undefined, { id: "p1" }),
	realComponent("read", { path: `${KIT_ROOT}/package.json` }, undefined, { id: "p2" }),
	realComponent("bash", { command: "date" }, undefined, { id: "p3" }),
];
group.regroup([assistant(reading("p1", `${KIT_ROOT}/package.json`), reading("p2", `${KIT_ROOT}/package.json`), ran("p3", "date"))], true);
eq(
	"one file paged twice is one file on the line",
	pages.flatMap((component) => component.render(80)).map(strip),
	["", "● Reading 1 file, running 1 shell command…", "  ⎿  $ date"],
);

// ---------------------------------------------------------------------------
// A group of one draws the line too, from the moment it is seated.
//
// `Running 1 shell command…` over `$ date` says what the row said, in the two
// columns the run will settle in, so a turn of three commands is two lines from
// the first token to the last rather than a block that changes height per call.
// ---------------------------------------------------------------------------

const alone = realComponent("bash", { command: "date" }, undefined, { id: "s1" });
const drawAlone = () => alone.render(80).map(strip);
group.regroup([assistant(ran("s1", "date"))], true);
eq("one call in flight is the line, named by its command", drawAlone(), ["", "● Running 1 shell command…", "  ⎿  $ date"]);
land(alone, text("Thu"));
group.regroup([assistant(ran("s1", "date")), answer("s1")]);
eq("and folds the moment it settles", drawAlone(), ["", "  Ran 1 shell command"]);
alone.setExpanded(true);
eq("ctrl+o and a click put the one row back", drawAlone(), ["", "● Bash(date)", "  ⎿  Thu"]);
alone.setExpanded(false);

// The exceptions are the ones that were always there, and each of them is a row
// the planner never puts in a group at all.
const keeps = (id, tool, args, content, options = {}) => {
	const component = realComponent(tool, args, content, { id, ...options });
	group.regroup([assistant(call(id, tool)), answer(id, options.answer)]);
	return component.render(80).map(strip)[1];
};
eq("a lone write keeps its row", keeps("s2", "write", { path: `${KIT_ROOT}/x.txt`, content: "a\n" }, text("Successfully wrote 2 bytes")), "● Write(x.txt)");
eq(
	"a lone failure keeps its row",
	keeps("s3", "bash", { command: "cat nope" }, text("cat: nope: No such file"), { error: true, answer: { isError: true } }),
	"● Bash(cat nope)",
);
eq(
	"a lone read of a picture keeps its row",
	keeps("s4", "read", { path: `${KIT_ROOT}/shot.png` }, [{ type: "image", data: "x", mimeType: "image/png" }], {
		answer: { content: [{ type: "image", data: "x", mimeType: "image/png" }] },
	}),
	"● Read(shot.png)",
);
// A run that stopped with the call still out is a call that was interrupted, and
// an interrupted call is the record of what happened.
const hollow = realComponent("bash", { command: "ping -c 25 127.0.0.1" }, undefined, { id: "s5" });
group.regroup([assistant(call("s5", "bash"))]);
row.quiesce();
hollow.invalidate();
eq("a lone call the run left behind keeps its row too", hollow.render(80).map(strip), ["", "○ Bash(ping -c 25 127.0.0.1)"]);

// ---------------------------------------------------------------------------
// Three shell commands, one per message, frame by frame — the shape a thinking
// model actually produces, and the one the old rules bounced on: two lines,
// one to the next, changing words in place, and one shrink at the very end.
//
// The tense used to be read off the results, so the gap between a command
// coming back and the next call being streamed had nothing in flight in it and
// the block fell to one line and grew back. It is read off the run now.
// ---------------------------------------------------------------------------

const flow = [];
const flowRows = [];
const drawFlow = () => {
	for (const component of flowRows) component.invalidate();
	// The clock is the one thing on the line that is allowed to move on its own,
	// and these frames are seconds apart.
	return flowRows.flatMap((component) => component.render(80)).map(strip).map((line) => line.replace(/ · [\d.]+s/, ""));
};
const prints = (index, text_) => flowRows[index].updateResult({ content: text(text_), details: undefined, isError: false }, true);
const lands = (index, id, text_) => {
	flowRows[index].updateResult({ content: text(text_), details: undefined, isError: false }, false);
	flow.push(answer(id));
	group.regroup(flow, true);
};
/** A frame: draw, let deferred redraws run, draw again. */
const frame = async () => {
	drawFlow();
	await settle();
	return drawFlow();
};
/**
 * The same, for a frame the gutter is allowed to change on.
 *
 * A hint that replaces one put up less than `HINT_HOLD_MS` ago waits its turn,
 * and the wait books its own redraw, so this is what the screen shows a moment
 * later rather than a different rule.
 */
const changed = async () => {
	await hold();
	return await frame();
};
const opens = (id, prefix) => {
	flow.push(assistant(thought("next"), streamingBash(id, prefix)));
	flowRows.push(realComponent("bash", { command: prefix }, undefined, { id }));
	group.regroup(flow, true);
};
const closes = (id, command) => {
	flow[flow.length - 1] = assistant(thought("next"), ran(id, command));
	group.regroup(flow, true);
};

opens("f1", "ec");
eq("a call still streaming its arguments says nothing yet", await frame(), []);
closes("f1", "echo one");
eq("closing them puts it on the line and under it", await frame(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

// The gutter names the call, as Claude Code's `latestDisplayHint` does. Output
// going past is not the transcript saying something.
prints(0, "one\n");
eq("what the command prints does not replace the command", await changed(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

lands(0, "f1", "one\n");
eq("the result landing leaves the block exactly where it was", await frame(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

opens("f2", "ec");
// The whole no-bounce property in one line: the model is thinking, nothing is
// in flight, and the second call has not said what it is yet.
eq("a second call streaming is seated, not counted, and moves nothing", await frame(), ["", "● Running 1 shell command…", "  ⎿  $ echo one"]);

closes("f2", "echo two");
eq("it joins the count and the gutter in the same frame", await changed(), ["", "● Running 2 shell commands…", "  ⎿  $ echo two"]);

lands(1, "f2", "");
opens("f3", "e");
eq("and the third call streaming moves nothing either", await frame(), ["", "● Running 2 shell commands…", "  ⎿  $ echo two"]);
closes("f3", "echo three");
eq("three commands, still two lines", await changed(), ["", "● Running 3 shell commands…", "  ⎿  $ echo three"]);
prints(2, "three\n");
eq("and the newest one printing changes nothing", await changed(), ["", "● Running 3 shell commands…", "  ⎿  $ echo three"]);

lands(2, "f3", "three\n");
group.regroup(flow);
eq("the turn ending is the one shrink in the whole run", await frame(), ["", "  Ran 3 shell commands"]);

group.regroup(entries);

// ctrl+o sets `expanded` on every row at once; a click sets it on the one row a
// collapsed group leaves clickable, which is the line itself.
for (const component of turn) component.setExpanded(true);
await settle();
eq("ctrl+o puts the rows back", headers(), ["● Read(package.json)", "● Bash(whoami)", "● Bash(date)"]);
for (const component of turn) component.setExpanded(false);
await settle();
eq("and takes them away again", drawTurn(), ["", "  Read 1 file, ran 2 shell commands"]);

// Only the lead is clickable once a group is collapsed, so opening it has to
// open the rows it stands for and not just itself.
turn[0].setExpanded(true);
await settle();
eq("the lead speaks for the group", headers(), ["● Read(package.json)", "● Bash(whoami)", "● Bash(date)"]);
turn[0].setExpanded(false);
await settle();
eq("and closing it closes them", drawTurn(), ["", "  Read 1 file, ran 2 shell commands"]);

// A second plan over the same transcript must not disturb what is on screen.
group.regroup(entries);
eq("replanning is idempotent", drawTurn(), ["", "  Read 1 file, ran 2 shell commands"]);

show("a settled turn @ 80", () => {
	const kept = realComponent("bash", { command: "cat nope" }, text("cat: nope: No such file"), { id: "g4", error: true });
	const after = realComponent("read", { path: `${KIT_ROOT}/README.md` }, text("a\nb"), { id: "g5" });
	group.regroup([...entries, assistant(call("g4", "bash"), call("g5", "read")), answer("g4", { isError: true }), answer("g5")]);
	return [...turn, kept, after]
		.flatMap((component) => component.render(80))
		.map(strip)
		.join("\n");
});

// ---------------------------------------------------------------------------
// The clock. A silent command prints nothing, so without one the screen says
// the same words for a minute and a half and working reads exactly like hung.
// ---------------------------------------------------------------------------

// It belongs to the group, not to any one row: the members of a batch start at
// different moments, and what the line counts is the run.
const clocked = [assistant(call("k1", "read"), call("k2", "bash"), call("k3", "bash"))];
group.regroup(clocked, true);
/** A row telling the planner when it began, which is what a header render does. */
const beganAt = (id, at) => group.noteRow(ctx({ toolCallId: id, isPartial: true, state: { startedAt: at } }));
beganAt("k2", 1_500);
beganAt("k1", 1_000);
beganAt("k3", 2_000);
eq("the group starts when its earliest member did", group.lineOf("k1").startedAt, 1_000);

group.noteResult("k1", false);
group.regroup([...clocked, answer("k1")], true);
const seatOf = (id) => group.roleOf(ctx({ toolCallId: id }));
// The speaker is the first row of the group and never moves: a result landing
// on it changes what the line says, not which component says it.
eq("a result does not hand the line to another row", [seatOf("k1"), seatOf("k2")], ["line", "hidden"]);
eq("and the clock stays where the run began", group.lineOf("k2").startedAt, 1_000);
group.forgetResults();

// Through the real rows, which is the only thing that proves the wiring.
const ticked = [assistant(call("c1", "bash"), call("c2", "bash"))];
group.regroup(ticked, true);
const clockRows = [
	realComponent("bash", { command: "sleep 30" }, undefined, { id: "c1" }),
	realComponent("bash", { command: "sleep 30" }, undefined, { id: "c2" }),
];
const redrawAll = () => {
	for (const component of clockRows) component.invalidate();
	return clockRows.flatMap((component) => component.render(80)).map(strip);
};
// `formatCallDuration`'s floor: a line that blinks `0.0s` into existence for two
// frames is the noise this whole extension exists to remove.
eq("a batch that just started shows no clock", redrawAll(), ["", "● Running 2 shell commands…"]);
beganAt("c1", Date.now() - 5_000);
// Spelled by the same function a settled row's `· 2.4s` uses, so one fact is not
// said two ways one line apart.
eq("past the floor it says how long", redrawAll(), ["", "● Running 2 shell commands · 5.0s…"]);

group.regroup([...ticked, answer("c1"), answer("c2")]);
eq("a settled line carries no clock", redrawAll(), ["", "  Ran 2 shell commands"]);

// What the tick is allowed to touch is the whole of what it costs, and this
// codebase refuses periodic repaints for good reasons (`lib/transcript/call-header.ts`). One row per
// live group — the row drawing its line — and nothing for a group beside it that
// has already settled.
const drew = { p1: 0, p2: 0, q1: 0, q2: 0 };
const mixed = [
	assistant(call("q1", "bash"), call("q2", "bash")),
	answer("q1"),
	answer("q2"),
	prompt("now this"),
	assistant(call("p1", "bash"), call("p2", "bash")),
];
group.regroup(mixed, true);
for (const id of Object.keys(drew)) {
	group.noteRow(ctx({ toolCallId: id, isPartial: true, invalidate: () => drew[id]++, state: { startedAt: Date.now() - 5_000 } }));
}
mock.timers.tick(1_050);
eq("one tick repaints the live group's speaking row and nothing else", [drew.p1 > 0, drew.p2, drew.q1, drew.q2], [true, 0, 0, 0]);

group.ungroup();
for (const component of turn) component.invalidate();
eq("ungrouping puts every row back", headers().length, 3);

await finish();
