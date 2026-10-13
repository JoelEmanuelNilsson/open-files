/**
 * A fake pi `ExtensionAPI` for loading a kit extension without a pi session:
 * it records what the extension registers and runs its event handlers the way
 * pi's runner does. A test loads an extension into it and drives the handlers:
 *
 *   const pi = fakeExtensionApi({ getThinkingLevel: () => "high" });
 *   await (await jiti.import(`${KIT_ROOT}/extensions/bash/index.ts`, { default: true }))(pi.api);
 *   await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
 *   pi.tools.get("bash"), pi.commands.get("stats"), pi.api.events.emit("subagents:started", …)
 *
 * Covers the stand-ins batch C's analysts planned to share: wire (bootWire's
 * events/on/registerCommand/getAllTools/getActiveTools/getThinkingLevel),
 * session-core (pi-api-stub: every handler runs, a live event bus), tools
 * (bash seat(), smoke makeApi, render and transcript load(): tools, shortcuts,
 * message renderers, sendMessage), context-and-skills-views (commands, message
 * renderers, sendMessage), zen-chrome (stubApi), agent-ui (agent-dock's /stats
 * stand-in: hooks, channels, commands) and transcript (fakeExtensionApi).
 *
 * The API is pi 1.1.0's: `EXTENSION_API_MEMBERS` is checked against
 * `ExtensionAPI` in pi's types.d.ts. A member with no fake throws when called,
 * naming itself, and a name that is not a member throws when read — a stub that
 * lacks a method must not pass by returning undefined.
 */

import { importPi } from "./pi-package.mjs";

const { createEventBus } = await importPi("dist/core/event-bus.js");

/** Every member of pi 1.1.0's `ExtensionAPI`, the names the fake answers to. */
export const EXTENSION_API_MEMBERS = [
	"appendEntry",
	"events",
	"exec",
	"getActiveTools",
	"getAllTools",
	"getCommands",
	"getFlag",
	"getMcpServers",
	"getSessionName",
	"getSettings",
	"getThinkingLevel",
	"on",
	"registerCommand",
	"registerEntryRenderer",
	"registerFlag",
	"registerMarkdownTransformer",
	"registerMcpServer",
	"registerMessageRenderer",
	"registerProvider",
	"registerShortcut",
	"registerTool",
	"registerToolRenderer",
	"registerVirtualModel",
	"sendMessage",
	"sendUserMessage",
	"setActiveTools",
	"setLabel",
	"setModel",
	"setSessionName",
	"setThinkingLevel",
	"unregisterMcpServer",
	"unregisterProvider",
	"unregisterVirtualModel",
];

/** Builds a fake ExtensionAPI whose recorders are returned beside it; `overrides` replaces or adds members, e.g. `{ getAllTools: () => [...] }`. */
export function fakeExtensionApi(overrides = {}) {
	const unknown = Object.keys(overrides).filter((name) => !EXTENSION_API_MEMBERS.includes(name));
	if (unknown.length > 0) throw new Error(`fakeExtensionApi: not ExtensionAPI members: ${unknown.join(", ")}`);
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const messageRenderers = new Map();
	const entryRenderers = new Map();
	const toolRenderers = [];
	const entries = [];
	const sentMessages = [];
	const sentUserMessages = [];
	let thinkingLevel = "off";
	const faked = {
		on: (event, handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
		},
		events: createEventBus(),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerToolRenderer: (resolver) => toolRenderers.push(resolver),
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: (shortcut, options) => shortcuts.set(shortcut, options),
		registerMessageRenderer: (customType, renderer) => messageRenderers.set(customType, renderer),
		registerEntryRenderer: (customType, renderer) => entryRenderers.set(customType, renderer),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message, options) => sentMessages.push({ message, options }),
		sendUserMessage: (content, options) => sentUserMessages.push({ content, options }),
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level) => {
			thinkingLevel = level;
		},
		...overrides,
	};
	const api = new Proxy(faked, {
		get(target, name, receiver) {
			if (typeof name === "symbol" || name in target) return Reflect.get(target, name, receiver);
			if (EXTENSION_API_MEMBERS.includes(name)) {
				return () => {
					throw new Error(`fakeExtensionApi: pi.${name} is not faked; pass it in fakeExtensionApi({ ${name}: … })`);
				};
			}
			// `await` probes `then` on any value it resolves; answering undefined keeps the api awaitable.
			if (name === "then") return undefined;
			throw new Error(`fakeExtensionApi: pi.${name} is not an ExtensionAPI member in pi 1.1.0`);
		},
	});
	/** Runs every handler registered for `event`, in registration order, each awaited as pi's runner does; returns their results. */
	async function fire(event, payload, ctx) {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	}
	return { api, handlers, tools, commands, shortcuts, messageRenderers, entryRenderers, toolRenderers, entries, sentMessages, sentUserMessages, fire };
}
