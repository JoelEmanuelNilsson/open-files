/**
 * btw seeds its side session with the main branch, verbatim.
 *
 * That seeding is the one place btw reaches into pi-agent-core's Agent, and
 * it is exactly where it broke on 2026-09-02: `agent.replaceMessages` was
 * removed upstream, and `/btw` crashed with "replaceMessages is not a
 * function" — but only in a session that had messages, because an empty seed
 * skips the call. Every smoke run in a fresh cwd stayed green.
 *
 * Three checks, all against the installed pi:
 *
 *   1. The seeding path pi itself uses for a resume (entries already in the
 *      session manager, sdk.js) lands in the request history of a session
 *      made the way btw makes one. Assigning `agent.state.messages` is not
 *      that path: since pi 0.87 the session manager is canonical and the
 *      assignment never reaches the provider.
 *   2. The `/btw <question>` handler, on a branch that has messages, gets
 *      past seeding. The model points at a closed port so the provider step
 *      fails fast and deterministically; that failure must arrive through
 *      `ui.notify`, never as a throw out of the handler.
 *   3. A popover submit whose side session cannot be built reports and lives.
 *      Nothing awaits a keystroke, so before the overlay caught its own
 *      failures a rejected `createAgentSession` was an unhandled rejection,
 *      and node's default (`--unhandled-rejections=throw`, no handler in pi)
 *      turned that into a dead editor mid-session. This one drives the real
 *      submit callback: a stubbed `ui.custom` that never builds the overlay
 *      cannot see the bug, because the callback never fires.
 *
 *   node test/btw.mjs
 */

import "./env.mjs";
import { execSync } from "node:child_process";

const PI = execSync("npm root -g", { encoding: "utf8" }).trim() + "/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { createAgentSession, SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const btw = await jiti.import(`${ROOT}/extensions/btw.ts`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

/** A model whose requests die at connect: no key, no network, no waiting. */
const model = {
	id: "btw-test",
	name: "btw-test",
	provider: "btw-test-provider",
	api: "anthropic-messages",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 8_192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	provider: model.provider,
	model: model.id,
	api: model.api,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 2,
});

console.log("btw: seeding a side session");
{
	const sessionManager = SessionManager.inMemory(ROOT);
	for (const message of [user("first"), assistant("second")]) sessionManager.appendMessage(message);
	const { session } = await createAgentSession({ cwd: ROOT, sessionManager, model });
	check("the seed is the session's request history", session.sessionManager.buildSessionContext().messages.length === 2);
	check("and the agent's inspection view agrees", session.agent.state.messages.length === 2);
	check("agent.replaceMessages is gone upstream", typeof session.agent.replaceMessages !== "function");
	session.dispose();
}

console.log("btw: /btw on a branch with messages");
{
	const main = SessionManager.inMemory();
	main.appendMessage(user("hello from main"));
	main.appendMessage(assistant("hi"));

	const commands = new Map();
	const handlers = new Map();
	const notices = [];
	const api = {
		registerCommand: (name, def) => commands.set(name, def),
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: () => {},
		getThinkingLevel: () => "off",
		sendUserMessage: () => {},
	};
	(btw.default ?? btw)(api);

	const ctx = {
		cwd: ROOT,
		hasUI: true,
		model,
		sessionManager: main,
		isIdle: () => true,
		ui: { notify: (message, level) => notices.push({ message, level }), custom: () => new Promise(() => {}), select: async () => undefined },
	};

	await handlers.get("session_start")({}, ctx);
	let thrown = null;
	try {
		await commands.get("btw").handler("say PONG", ctx);
	} catch (error) {
		thrown = error;
	}
	check("handler does not throw", thrown === null, String(thrown));
	const error = notices.find((n) => n.level === "error");
	check("provider failure arrives through notify", Boolean(error), JSON.stringify(notices));
	check("failure is not the seeding step", !/replaceMessages|is not a function/.test(error?.message ?? ""), error?.message);
	await handlers.get("session_shutdown")({}, ctx);
}

console.log("btw: a popover submit whose side session cannot be built");
{
	const commands = new Map();
	const handlers = new Map();
	const notices = [];
	const api = {
		registerCommand: (name, def) => commands.set(name, def),
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: () => {},
		getThinkingLevel: () => "off",
		sendUserMessage: () => {},
	};
	(btw.default ?? btw)(api);

	// The submit callback only exists once the overlay is built, so `ui.custom`
	// here runs pi's factory inline instead of standing in for it.
	const tui = { requestRender: () => {} };
	const theme = { fg: (_name, text) => text, bold: (text) => text };
	const keybindings = { matches: () => false };
	let component = null;

	const ctx = {
		// A cwd that is not a string makes the real createAgentSession reject on
		// its first line: the failure under test, forced without net or clock.
		cwd: 42,
		hasUI: true,
		model,
		sessionManager: SessionManager.inMemory(),
		isIdle: () => true,
		ui: {
			notify: (message, level) => notices.push({ message, level }),
			select: async () => undefined,
			custom: async (factory) => {
				component = await factory(tui, theme, keybindings, () => {});
			},
		},
	};

	let leaked = null;
	const onLeak = (error) => {
		leaked = error;
	};
	process.once("unhandledRejection", onLeak);

	await handlers.get("session_start")({}, ctx);
	await commands.get("btw").handler("", ctx);
	check("the popover component exists", component !== null);

	component?.setDraft("why did this take pi down");
	component?.handleInput("\n");
	await new Promise((resolve) => setTimeout(resolve, 250));

	check("submit leaks no unhandled rejection", leaked === null, leaked instanceof Error ? leaked.message : String(leaked));
	const failure = notices.find((n) => n.level === "error");
	check("the side session failure reaches the user", Boolean(failure), JSON.stringify(notices));
	process.off("unhandledRejection", onLeak);
	await handlers.get("session_shutdown")({}, ctx);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
