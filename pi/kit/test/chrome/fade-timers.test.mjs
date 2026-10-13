/**
 * The chrome's fades after shutdown: a settle fade or a level flash still in
 * flight when the session shuts down never paints the closed session's TUI.
 *
 *   node test/chrome/fade-timers.test.mjs
 */

import { eq, finish } from "../support/check-harness.mjs";
import { sleep } from "../support/async-waits.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const { FADE_MS, FRAME_MS } = await jiti.import(`${KIT_ROOT}/lib/ui/prism-light.ts`);

const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t };
let editorFactory;
const ctx = {
	mode: "tui",
	cwd: KIT_ROOT,
	hasUI: true,
	model: { id: "claude-opus-5", reasoning: true },
	thinkingLevel: "high",
	sessionManager: {
		getCwd: () => "/Users/joel/dotfiles",
		getSessionName: () => undefined,
		getSessionId: () => "fade-timers",
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

console.log("fade-timers: nothing paints after shutdown");
const pi = fakeExtensionApi({ getThinkingLevel: () => "high" });
await (await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/index.ts`, { default: true }))(pi.api);
await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

let renders = 0;
const tui = {
	terminal: { rows: 40, columns: 80, write: () => {} },
	requestRender: () => {
		renders++;
	},
	addInputListener: () => () => {},
};
const identity = (t) => t;
editorFactory(tui, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } }, { matches: () => false });

await pi.fire("agent_start", { type: "agent_start" }, ctx);
await pi.fire("agent_settled", { type: "agent_settled" }, ctx);
await pi.fire("thinking_level_select", { type: "thinking_level_select", level: "low" }, ctx);
await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
renders = 0;
await sleep(FADE_MS + FRAME_MS + 100);
eq("no fade timer asks the closed session's TUI for a render", renders, 0);

await finish();
