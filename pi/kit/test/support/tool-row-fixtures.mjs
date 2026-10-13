/**
 * Fixtures for the transcript's tool-row tests: a render context, theme stubs,
 * pi session entries, and real rows drawn through pi's own `ToolExecutionComponent`.
 * A test file imports what it needs, e.g.
 * `import { renderContext, stripAnsi } from "../support/tool-row-fixtures.mjs";`.
 * Nothing here imports pi-tui at load, so a file can still set `TMUX` before
 * pi-tui caches terminal capabilities.
 */

import { fakeExtensionApi } from "./fake-extension-api.mjs";
import { KIT_ROOT, importPi, initDarkTheme } from "./pi-package.mjs";

/** Drops OSC-8 hyperlinks and SGR colour, leaving what a terminal would show. */
export const stripAnsi = (s) => s.replace(/\x1b\][0-9;]*;?[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");

/** A settled, non-error `RenderContext` for call id `t` in `/w/kit`; `over` replaces fields. */
export const renderContext = (over = {}) => ({
	args: {},
	toolCallId: "t",
	invalidate: () => {},
	lastComponent: undefined,
	state: {},
	cwd: "/w/kit",
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: true,
	isError: false,
	...over,
});

/** A theme that paints real SGR escapes, so `stripAnsi` and `visibleWidth` see what a terminal would. */
export const sgrTheme = {
	fg: (color, t) => `\x1b[38;2;${[...color].reduce((n, c) => n + c.charCodeAt(0), 0) % 200};1;1m${t}\x1b[39m`,
	bold: (t) => `\x1b[1m${t}\x1b[22m`,
	bg: (_c, t) => t,
	italic: (t) => t,
};

/** A theme that writes each colour's name, e.g. `<dim>●`. */
export const namedTheme = { fg: (color, t) => `<${color}>${t}`, bold: (t) => t, bg: (_c, t) => t, italic: (t) => t };

/** A text block, and a tool result's content holding one. */
export const said = (t) => ({ type: "text", text: t });
export const textContent = (t) => [said(t)];
/** A thinking block. */
export const thought = (t) => ({ type: "thinking", thinking: t });
/** A tool call whose arguments have landed empty. */
export const call = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
/** A shell call with its arguments closed, which is when the rollup line can name it. */
export const ran = (id, command) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
/** A read whose arguments have finished streaming. */
export const reading = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
/** A read mid-stream: the prefix reparsed into `arguments`, the raw buffer beside it. */
export const mistyping = (id, prefix) => ({ type: "toolCall", id, name: "read", arguments: { path: prefix }, partialJson: `{"path":"${prefix}` });
/** A shell call mid-stream: pi seats its row on the first token, long before it closes. */
export const streamingBash = (id, prefix) => ({ type: "toolCall", id, name: "bash", arguments: { command: prefix }, partialJson: `{"command":"${prefix}` });
/** Session entries: an assistant message, a tool result, a user prompt. */
export const assistant = (...content) => ({ type: "message", message: { role: "assistant", content } });
export const answer = (id, extra = {}) => ({ type: "message", message: { role: "toolResult", toolCallId: id, content: [said("ok")], isError: false, ...extra } });
export const prompt = (t) => ({ type: "message", message: { role: "user", content: [said(t)] } });

/** Loads kit extensions (paths under extensions/) into one fake pi API, in order, and returns its recorders. */
export async function loadKitExtensions(jiti, ...paths) {
	const pi = fakeExtensionApi();
	for (const path of paths) (await jiti.import(`${KIT_ROOT}/extensions/${path}`, { default: true }))(pi.api);
	return pi;
}

/**
 * A maker of real tool rows over `tools` (name to registered definition) and `toolRenderers` (resolvers), with
 * pi's dark theme initialised: `(tool, args, content, { partial, error, expanded, id })`
 * returns the `ToolExecutionComponent`, arguments complete and execution started.
 */
export async function realToolRows(tools, toolRenderers = []) {
	await initDarkTheme();
	const { ToolExecutionComponent } = await importPi("dist/modes/interactive/components/index.js");
	const ui = { requestRender: () => {} };
	// pi's runner: each resolver in load order, then the registered tool.
	const resolve = (tool, index) => (index < toolRenderers.length ? toolRenderers[index](tool, () => resolve(tool, index + 1)) : tools.get(tool));
	return (tool, args, content, { partial = false, error = false, expanded = false, id } = {}) => {
		const component = new ToolExecutionComponent(tool, id ?? `id-${tool}-${Math.random()}`, args, { showImages: true }, resolve(tool, 0), ui, KIT_ROOT);
		component.setExpanded(expanded);
		component.setArgsComplete();
		component.markExecutionStarted();
		if (content !== undefined) component.updateResult({ content, details: undefined, isError: error }, partial);
		return component;
	};
}
