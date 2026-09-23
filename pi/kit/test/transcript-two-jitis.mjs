/**
 * The transcript's planner has to work when its files are loaded the way pi
 * loads them: one jiti per extension file, `moduleCache: false`.
 *
 * The rest of the suite loads the kit through a single jiti, so every extension
 * file shares one copy of every module — which is exactly the condition under
 * which this bug class is invisible. pi does the opposite
 * (`dist/core/extensions/loader.js`, `createJiti(…, { moduleCache: false })`
 * per file), so `extensions/bash.ts`, which borrows `transcript/receipt.ts` for
 * its rows, used to get its own copy of `group.ts` with an empty `seats` map:
 * `roleOf` answered `"row"` for every bash call, bash never folded, and when a
 * bash row was a group's speaker its `read` members hid with no line to replace
 * them. Output silently lost, and every test green.
 *
 * So this file loads the two extensions through two loaders, drives pi's real
 * events over pi's real `ToolExecutionComponent`, and reads the screen.
 */

// pi-tui caches terminal capabilities on first read; a multiplexer reports no
// image support, which is the quieter of the two paths through the row.
import "./env.mjs";
process.env.TMUX = "test";
// Nothing here has a mouse, and the click patch lives on a shared prototype.
process.env.PI_TRANSCRIPT_CLICK = "off";

import { execSync } from "node:child_process";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}\n  expected ${b}\n  actual   ${a}`);
};

// ---------------------------------------------------------------------------
// Load them the way pi does.
// ---------------------------------------------------------------------------

const registered = new Map();
const handlers = new Map();
const api = {
	registerTool: (tool) => registered.set(tool.name, tool),
	registerCommand: () => {},
	registerShortcut: () => {},
	registerMessageRenderer: () => {},
	sendMessage: () => {},
	events: { on: () => () => {}, emit: () => {} },
	on: (name, fn) => {
		const list = handlers.get(name) ?? [];
		list.push(fn);
		handlers.set(name, list);
	},
};
const fire = (name, event, ctx) => {
	for (const fn of handlers.get(name) ?? []) fn(event, ctx);
};

/** One fresh loader per extension file, with no module cache — pi's own call. */
const loadLikePi = async (file) => {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const load = await jiti.import(`${ROOT}/extensions/${file}`, { default: true });
	load(api);
	return jiti;
};
const transcriptLoader = await loadLikePi("transcript/index.ts");
const bashLoader = await loadLikePi("bash.ts");

// The premise of the whole file. If jiti ever started sharing modules across
// loaders this test would pass while proving nothing, so it is checked rather
// than assumed.
const groupIn = async (jiti) => jiti.import(`${ROOT}/extensions/transcript/group.ts`);
const [transcriptGroup, bashGroup] = [await groupIn(transcriptLoader), await groupIn(bashLoader)];
eq("the two loaders really are two copies of the planner", transcriptGroup.roleOf === bashGroup.roleOf, false);
// And the one thing they must share: the state, which is on the process.
const stateOf = (jiti) => jiti.import(`${ROOT}/extensions/transcript/planner-state.ts`);
const [oneState, otherState] = [await stateOf(transcriptLoader), await stateOf(bashLoader)];
eq("but one planner state between them", oneState.transcriptPlannerState() === otherState.transcriptPlannerState(), true);

// ---------------------------------------------------------------------------
// Real rows, real events.
// ---------------------------------------------------------------------------

const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeModule.initTheme("dark", false);
const { ToolExecutionComponent } = await import(`${PI}/dist/modes/interactive/components/index.js`);

const strip = (s) => s.replace(/\x1b\][0-9;]*;?[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
const ui = { requestRender: () => {} };
const text = (t) => [{ type: "text", text: t }];
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const message = (...content) => ({ role: "assistant", content, stopReason: "toolUse" });
const entry = (m) => ({ type: "message", message: m });
const answer = (id) => entry({ role: "toolResult", toolCallId: id, content: text("ok"), isError: false });
const prompt = (t) => entry({ role: "user", content: [{ type: "text", text: t }] });

const entries = [prompt("go")];
const ctx = { mode: "tui", cwd: ROOT, sessionManager: { buildContextEntries: () => entries.slice() } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const drawn = [];
/** A row as pi builds one: arguments complete, execution started, result in. */
function row(tool, args, output, id, { settled = true } = {}) {
	const component = new ToolExecutionComponent(tool, id, args, { showImages: true }, registered.get(tool), ui, ROOT);
	drawn.push(component);
	component.setArgsComplete();
	component.markExecutionStarted();
	if (settled) component.updateResult({ content: text(output), details: undefined, isError: false }, false);
	return component;
}
const screen = () => drawn.flatMap((component) => component.render(80)).map(strip);

fire("session_start", {}, ctx);

// Three silent shell commands and a read, each in its own message, which is how
// a model that narrates nothing between calls actually behaves.
const steps = [
	["bash", { command: "echo one" }, "one", "b1"],
	["bash", { command: "echo two" }, "two", "b2"],
	["bash", { command: "echo three" }, "three", "b3"],
	["read", { path: `${ROOT}/package.json` }, "a\nb", "r1"],
];
for (const [tool, args, output, id] of steps) {
	const sent = message(call(id, tool, args));
	fire("message_start", { message: sent }, ctx);
	fire("message_update", { message: sent }, ctx);
	row(tool, args, output, id);
	fire("message_end", { message: sent }, ctx);
	entries.push(entry(sent));
	fire("tool_execution_end", { toolCallId: id, isError: false }, ctx);
	entries.push(answer(id));
	await settle();
}
fire("agent_settled", {}, ctx);
await settle();

// The whole point: the bash rows are the kit's own tool, registered by another
// extension file, and they fold into the same line as the read.
eq("bash rows fold with the rows around them", screen(), ["", "  Read 1 file, ran 3 shell commands"]);

// The other half of the shared state: `row.ts` watches rows that have not
// settled, and `agent_settled` reaches only the transcript's copy. A bash row
// left in flight has to hear about it through the same registry.
for (const component of drawn.splice(0)) component.setExpanded(false);
// A user message between the two runs, so this one is a group of its own and
// what it draws is about this call rather than about the batch before it.
entries.push(prompt("now this"));
const cut = message(call("b4", "bash", { command: "ping -c 25 127.0.0.1" }));
fire("message_start", { message: cut }, ctx);
fire("message_update", { message: cut }, ctx);
row("bash", { command: "ping -c 25 127.0.0.1" }, "", "b4", { settled: false });
fire("message_end", { message: cut }, ctx);
entries.push(entry(cut));
await settle();
// A call in flight is a group of one, and a group of one draws the line: the
// sentence, and under it the command, both out of the transcript's copy of the
// planner over a row the other copy registered.
eq("a bash call still running speaks through the line", screen(), ["", "● Running 1 shell command…", "  ⎿  $ ping -c 25 127.0.0.1"]);

fire("agent_settled", {}, ctx);
await settle();
for (const component of drawn) component.invalidate();
eq("and a bash call the run left behind turns hollow", screen(), ["", "○ Bash(ping -c 25 127.0.0.1)"]);

fire("session_shutdown", {}, ctx);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
