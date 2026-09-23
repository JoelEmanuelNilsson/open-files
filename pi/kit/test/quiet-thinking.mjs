/**
 * Does hidden thinking draw nothing?
 *
 * Everything here runs against the *installed* pi package: pi's own
 * `AssistantMessageComponent`, pi's theme, pi's markdown renderer, at a real
 * width. There is no stub, because the whole extension is one wrapper around
 * one of pi's methods and a stub of that method would only ever agree with
 * itself.
 *
 * The file opens with the pins. `quiet-thinking.ts` depends on four facts
 * about pi — the method that rebuilds the content container is called
 * `updateContent`, the flag on the instance is called `hideThinkingBlock`, an
 * unpatched pi really does draw a blank line and `Thinking...`, and setting an
 * empty label draws two blank lines instead. If any of those move, the
 * extension goes quietly inert, which is the one failure mode a wrapper has.
 * So they are checked first and they fail the run, loudly, naming the file in
 * pi's dist that moved.
 *
 *   node test/quiet-thinking.mjs
 */

import "./env.mjs";
import { execSync } from "node:child_process";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);
const { AssistantMessageComponent } = await import(`${PI}/dist/modes/interactive/components/index.js`);

const { enableQuietThinking, withoutThinkingBlocks } = await jiti.import(`${ROOT}/extensions/quiet-thinking.ts`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, actual, expected) =>
	check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);

const WIDTH = 80;
/** The text of a rendered line: colour and the OSC 133 prompt marks removed. */
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]133;[ABC]\x07/g, "").trimEnd();
const drawn = (component) => component.render(WIDTH).map(plain);

const thinking = (text = "deep thoughts") => ({ type: "thinking", thinking: text });
const says = (text) => ({ type: "text", text });
const calls = () => ({ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } });
const message = (content, extra = {}) => ({ role: "assistant", content, ...extra });
/** A component in the state pi builds it in: hiding thinking, message applied. */
const shown = (content, hide = true, extra = {}) => new AssistantMessageComponent(message(content, extra), hide);

const PRISTINE = AssistantMessageComponent.prototype.updateContent;

// ---------------------------------------------------------------------------
console.log("\npins on the installed pi (0.84.x): the wrapper's four assumptions");
// ---------------------------------------------------------------------------

check(
	"pi rebuilds the content container in `updateContent`",
	typeof PRISTINE === "function" && PRISTINE.length >= 1,
	"AssistantMessageComponent.prototype.updateContent moved — dist/modes/interactive/components/assistant-message.js",
);

check(
	"pi keeps the hide flag on the instance as `hideThinkingBlock`",
	shown([says("hi")]).hideThinkingBlock === true && shown([says("hi")], false).hideThinkingBlock === false,
	"the constructor's second argument no longer lands on `hideThinkingBlock`",
);

eq("unpatched pi spends a blank line and a label on hidden thinking", drawn(shown([thinking()])), ["", " Thinking..."]);

{
	// Why `ctx.ui.setHiddenThinkingLabel("")` is not the fix: `theme.fg` wraps
	// even an empty string in escapes, so `Text` still draws a line.
	const component = shown([thinking()]);
	component.setHiddenThinkingLabel("");
	eq("an empty label swaps the word for a second blank line", drawn(component), ["", ""]);
}

// ---------------------------------------------------------------------------
console.log("\nthe filter");
// ---------------------------------------------------------------------------

{
	const without = message([says("a"), calls()]);
	check("a message with no thinking is handed back unchanged, same object", withoutThinkingBlocks(without) === without);

	const with_ = message([thinking(), says("a"), calls(), { type: "image", data: "", mimeType: "image/png" }]);
	const filtered = withoutThinkingBlocks(with_);
	check("filtering does not mutate the message pi owns", with_.content.length === 4);
	eq("everything that is not thinking survives", filtered.content.map((block) => block.type), ["text", "toolCall", "image"]);
	eq("the rest of the message survives", filtered.role, "assistant");

	eq("a message of nothing but thinking filters to empty content", withoutThinkingBlocks(message([thinking(), thinking("more")])).content, []);
	const odd = message(undefined);
	check("content that is not an array is not this extension's business", withoutThinkingBlocks(odd) === odd);
}

// ---------------------------------------------------------------------------
console.log("\nwith the wrapper installed");
// ---------------------------------------------------------------------------

const unquiet = enableQuietThinking();
/** The wrapper itself, so a check can put it back after borrowing pi's own. */
const quiet = AssistantMessageComponent.prototype.updateContent;

eq("hidden thinking alone draws nothing at all", drawn(shown([thinking()])), []);
eq("two runs of hidden thinking still draw nothing", drawn(shown([thinking(), thinking("and more")])), []);
eq("hidden thinking before prose leaves one blank above the prose", drawn(shown([thinking(), says("Here is the answer.")])), ["", " Here is the answer."]);
eq("prose on its own is untouched", drawn(shown([says("Here is the answer.")])), ["", " Here is the answer."]);

{
	const component = shown([thinking(), calls()]);
	eq("a thinking-then-tool-call message draws nothing", drawn(component), []);
	check("the tool calls are still seen, so pi's prompt marks stay off", component.hasToolCalls === true);
}

// The declared limit, pinned so it is a decision and not an accident: thinking
// draws nothing, including the blank line it used to leave behind it.
eq(
	"thinking between two runs of prose closes them up",
	drawn(shown([says("First run."), thinking(), says("Second run.")])),
	["", " First run.", " Second run."],
);

// The branches after the thinking one are pi's, and they still run.
eq(
	"an aborted message still says so",
	drawn(shown([thinking()], true, { stopReason: "aborted", errorMessage: "Stopped by the user" })),
	["", " Stopped by the user"],
);
eq(
	"a truncated message still says so",
	drawn(shown([thinking(), says("half an ans")], true, { stopReason: "length" })),
	["", " half an ans", "", " Response was truncated before completion."],
);

// ---------------------------------------------------------------------------
console.log("\nshowing thinking is pi's own behaviour, byte for byte");
// ---------------------------------------------------------------------------

for (const [name, content] of [
	["thinking and prose", [thinking(), says("Here is the answer.")]],
	["prose alone", [says("Here is the answer.")]],
	["prose, thinking, prose", [says("First run."), thinking(), says("Second run.")]],
]) {
	const patched = shown(content, false).render(WIDTH);
	AssistantMessageComponent.prototype.updateContent = PRISTINE;
	const vanilla = shown(content, false).render(WIDTH);
	AssistantMessageComponent.prototype.updateContent = quiet;
	eq(`with the block shown, ${name} renders exactly what pi renders`, patched, vanilla);
}

// ---------------------------------------------------------------------------
console.log("\nthe message pi re-renders from");
// ---------------------------------------------------------------------------

{
	const component = shown([thinking(), says("Here is the answer.")]);
	component.invalidate();
	eq("invalidate re-renders and keeps thinking hidden", drawn(component), ["", " Here is the answer."]);

	component.setHideThinkingBlock(false);
	eq("turning the block back on brings the reasoning back", drawn(component), ["", " deep thoughts", "", " Here is the answer."]);

	component.setHideThinkingBlock(true);
	eq("and turning it off hides it again", drawn(component), ["", " Here is the answer."]);
}

{
	// Streaming: pi mutates one message object and calls `updateContent` again
	// for every event, so the filtered clone must never become the source.
	const streaming = message([thinking("thinking hard")]);
	const component = new AssistantMessageComponent(undefined, true);
	component.updateContent(streaming, true);
	eq("a streaming message of pure thinking draws nothing", drawn(component), []);
	streaming.content.push(says("Half an ans"));
	component.updateContent(streaming, true);
	eq("prose arriving mid-stream draws with one blank above it", drawn(component), ["", " Half an ans"]);
	streaming.content[1].text = "Half an answer, then the rest.";
	component.updateContent(streaming, false);
	eq("the settled message is the last text, still with no label", drawn(component), ["", " Half an answer, then the rest."]);
	component.setHideThinkingBlock(false);
	eq("and the whole run of reasoning is still there to show", drawn(component), ["", " thinking hard", "", " Half an answer, then the rest."]);
}

{
	const component = shown([thinking()]);
	let threw = false;
	try {
		component.updateContent(undefined);
	} catch {
		threw = true;
	}
	// pi's own method reads `message.content` and throws on `undefined`; the
	// point is that the wrapper adds no throw of its own and swallows none.
	AssistantMessageComponent.prototype.updateContent = PRISTINE;
	let threwVanilla = false;
	try {
		shown([thinking()]).updateContent(undefined);
	} catch {
		threwVanilla = true;
	}
	AssistantMessageComponent.prototype.updateContent = quiet;
	check("a message pi cannot render fails exactly as it fails without the wrapper", threw === threwVanilla);
}

// ---------------------------------------------------------------------------
console.log("\ninstalling and taking it down");
// ---------------------------------------------------------------------------

{
	check("the wrapper is installed", AssistantMessageComponent.prototype.updateContent !== PRISTINE);
	// A `/reload` re-imports the module and loses the handle. The next install
	// has to unwrap the old one instead of nesting inside it.
	const second = enableQuietThinking();
	check("a second install replaces the first rather than nesting", AssistantMessageComponent.prototype.updateContent[Symbol.for("pi.kit.quiet-thinking.update-content")] === PRISTINE);
	eq("and one wrapper still hides one run of thinking", drawn(shown([thinking(), says("Here is the answer.")])), ["", " Here is the answer."]);
	second();
	check("taking it down restores pi's own method exactly", AssistantMessageComponent.prototype.updateContent === PRISTINE);
	eq("and pi draws its label again", drawn(shown([thinking()])), ["", " Thinking..."]);

	// The stale handle from the install that was replaced must not undo whoever
	// owns the prototype now.
	const third = enableQuietThinking();
	unquiet();
	check("a stale handle from a replaced install changes nothing", AssistantMessageComponent.prototype.updateContent !== PRISTINE);
	third();
	check("the owner's handle restores pi's method", AssistantMessageComponent.prototype.updateContent === PRISTINE);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
