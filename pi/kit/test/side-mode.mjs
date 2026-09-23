/**
 * Side mode's shared state, and the two `input` listeners that must step aside
 * for a submit it claims.
 *
 * pi runs `input` handlers in extension load order — unsorted `readdir` — and
 * stops at the first `{ action: "handled" }` (`runner.js` `emitInput`). So a
 * side-mode submit may reach `agent-engine` and `skill-mentions` before
 * side-chat has claimed it; they must ignore it on their own, in either order.
 * Then zen-chrome's `[SIDE]`, typing and folded.
 */

import "./env.mjs";
import { execSync } from "node:child_process";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) pass++;
	else fail++;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
};

const { isSideModeOn, setSideMode, sideModeClaimsInput } = await jiti.import(`${ROOT}/lib/side-mode.ts`);

console.log("side-mode: who claims a submit");
const MAIN = "side-mode-main";
check("off by default", !isSideModeOn(MAIN));
check("off: plain interactive text is not claimed", !sideModeClaimsInput(MAIN, { text: "hi", source: "interactive" }));
setSideMode(MAIN, true);
check("on for the session it was set on", isSideModeOn(MAIN));
check("and only that one: an engine child prompting as interactive is not claimed", !sideModeClaimsInput("child", { text: "hi", source: "interactive" }));
check("on: plain interactive text is claimed", sideModeClaimsInput(MAIN, { text: "hi", source: "interactive" }));
check("on: a slash command is not", !sideModeClaimsInput(MAIN, { text: "/model", source: "interactive" }));
check("on: extension input is not", !sideModeClaimsInput(MAIN, { text: "hi", source: "extension" }));
check("on: rpc input is not", !sideModeClaimsInput(MAIN, { text: "hi", source: "rpc" }));
setSideMode(MAIN, false);
check("off again", !isSideModeOn(MAIN) && !sideModeClaimsInput(MAIN, { text: "hi", source: "interactive" }));

/** A stub `pi` that records handlers per event, in registration order. */
function stubApi(extra = {}) {
	const handlers = new Map();
	return {
		handlers,
		api: {
			on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerTool: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerMessageRenderer: () => {},
			registerEntryRenderer: () => {},
			appendEntry: () => {},
			sendMessage: () => {},
			getCommands: () => [],
			getAllTools: () => [],
			getActiveTools: () => [],
			getThinkingLevel: () => "high",
			events: { on: () => {}, emit: () => {} },
			flags: new Map(),
			...extra,
		},
	};
}

/** pi's `emitInput` loop: handlers in order, the first `handled` ends it. */
async function emitInput(handlers, event, ctx) {
	for (const handler of handlers) {
		const result = await handler(event, ctx);
		if (result?.action === "handled") return result;
	}
	return { action: "continue" };
}

/** What side-chat's listener does with a claimed submit. */
const sideChatInput = (event, ctx) => (sideModeClaimsInput(ctx.sessionManager.getSessionId(), event) ? { action: "handled" } : undefined);

console.log("side-mode: agent-engine and skill-mentions ignore a claimed submit, in either order");
const engineStub = stubApi();
await (await jiti.import(`${ROOT}/extensions/agent-engine.ts`, { default: true }))(engineStub.api);
const sent = [];
const skillStub = stubApi({
	getCommands: () => [{ name: "skill:commit", source: "skill", sourceInfo: { path: path.join(ROOT, "skills", "commit", "SKILL.md") } }],
	sendMessage: (message) => sent.push(message),
});
await (await jiti.import(`${ROOT}/extensions/skill-mentions.ts`, { default: true }))(skillStub.api);

const ctx = {
	cwd: ROOT,
	mode: "tui",
	isIdle: () => true,
	hasUI: false,
	model: undefined,
	modelRegistry: {},
	hasPendingMessages: () => false,
	sessionManager: {
		getSessionId: () => MAIN,
		getSessionFile: () => undefined,
		getSessionDir: () => ROOT,
		getEntries: () => [],
		getBranch: () => [],
	},
	ui: { notify: () => {}, addAutocompleteProvider: () => {} },
};
for (const handler of engineStub.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
for (const handler of skillStub.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
const { agentRuntimeOf } = await jiti.import(`${ROOT}/lib/agent-runtime-seam.ts`);
const runtime = agentRuntimeOf(MAIN);
check("agent-engine built its runtime", runtime !== undefined);
const interrupts = [];
runtime.interruptWaits = (who) => interrupts.push(who);

const others = [...engineStub.handlers.get("input"), ...skillStub.handlers.get("input")];
const steer = { type: "input", text: "what does $commit do", source: "interactive", streamingBehavior: "steer" };
for (const [order, handlers] of [
	["side-chat first", [sideChatInput, ...others]],
	["side-chat last", [...others, sideChatInput]],
]) {
	setSideMode(MAIN, true);
	interrupts.length = 0;
	sent.length = 0;
	const result = await emitInput(handlers, steer, ctx);
	check(`${order}: the submit is handled`, result.action === "handled");
	check(`${order}: main's waits are not interrupted`, interrupts.length === 0, interrupts.join(","));
	check(`${order}: no skill is sent into main`, sent.length === 0, JSON.stringify(sent));

	setSideMode(MAIN, false);
	const offResult = await emitInput(handlers, steer, ctx);
	check(`${order}, side off: the submit continues to main`, offResult.action === "continue");
	check(`${order}, side off: typing while streaming interrupts main's waits`, interrupts.length === 1);
	check(`${order}, side off: the $skill mention loads into main`, sent.length === 1);
	for (const handler of skillStub.handlers.get("session_compact") ?? []) await handler({}, ctx);
}

setSideMode(MAIN, true);
interrupts.length = 0;
await emitInput(others, { ...steer, text: "/model" }, ctx);
check("side on: a slash command still interrupts main's waits", interrupts.length === 1);
setSideMode(MAIN, false);
for (const handler of engineStub.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);

console.log("side-mode: zen-chrome's [SIDE]");
const SUCCESS = (text) => `\x1b[32m${text}\x1b[39m`;
const BOLD = (text) => `\x1b[1m${text}\x1b[22m`;
// The frame's light re-shades after each piece, so only the badge's opening codes are stable.
const BADGE = "\x1b[1m\x1b[32m[SIDE]";
const theme = {
	fg: (color, text) => (color === "success" ? SUCCESS(text) : text),
	bg: (_color, text) => text,
	bold: BOLD,
	italic: (text) => text,
	dim: (text) => text,
};
let editorFactory;
const chromeCtx = {
	mode: "tui",
	cwd: ROOT,
	hasUI: true,
	model: { id: "claude-opus-5", reasoning: true },
	thinkingLevel: "high",
	sessionManager: {
		getCwd: () => "/Users/joel/dotfiles",
		getSessionName: () => undefined,
		getSessionId: () => MAIN,
		getBranch: () => [],
		getEntries: () => [],
	},
	getContextUsage: () => ({ percent: 12, tokens: 31_400 }),
	ui: {
		theme,
		notify: () => {},
		setWorkingVisible: () => {},
		setFooter: () => {},
		setEditorComponent: (factory) => {
			editorFactory = factory;
		},
	},
};
const chromeStub = stubApi();
await (await jiti.import(`${ROOT}/extensions/zen-chrome/index.ts`, { default: true }))(chromeStub.api);
for (const handler of chromeStub.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, chromeCtx);
const tui = { terminal: { rows: 40, columns: 80, write: () => {} }, requestRender: () => {}, addInputListener: () => () => {} };
const identity = (text) => text;
const editorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};
const editor = editorFactory(tui, editorTheme, { matches: () => false });
editor.focused = true;
const bare = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

let out = editor.render(80);
check("off, folded: no [SIDE]", out.length === 1 && !bare(out[0]).includes("[SIDE]"), bare(out[0] ?? ""));
editor.setText("hi");
out = editor.render(80);
check("off, typing: no [SIDE]", out.length === 3 && !bare(out[0]).includes("[SIDE]"), bare(out[0] ?? ""));

setSideMode(MAIN, true);
out = editor.render(80);
check("on, typing: the top rule leads with bold [SIDE] in success", out[0].includes(BADGE) && /^╭─ \[SIDE\] \S*\/dotfiles/.test(bare(out[0])), JSON.stringify(out[0]));
check("on, typing: only the top rule carries it", out.slice(1).every((line) => !bare(line).includes("[SIDE]")));
editor.setText("");
out = editor.render(80);
check("on, folded: the row leads with bold [SIDE] in success", out.length === 1 && out[0].includes(BADGE) && /^╶─ \[SIDE\] \S*\/dotfiles/.test(bare(out[0])), JSON.stringify(out[0]));
out = editor.render(14);
check("on, folded and narrow: [SIDE] outlives the path", bare(out[0]).startsWith("╶─ [SIDE]") && !bare(out.join("")).includes("dotfiles"), JSON.stringify(out.map(bare)));

setSideMode(MAIN, false);
out = editor.render(80);
check("off again: gone from the folded row", !bare(out[0]).includes("[SIDE]"));
for (const handler of chromeStub.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, chromeCtx);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
