/**
 * `support/fake-extension-api.mjs`: its members are pi's `ExtensionAPI`, a
 * missing fake fails by name, and a real kit extension loads into it.
 */

import { checkThrows, eq, finish, is, section } from "../support/check-harness.mjs";
import { EXTENSION_API_MEMBERS, fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { KIT_ROOT, PI_ROOT, kitJiti } from "../support/pi-package.mjs";

section("the members are pi's ExtensionAPI");
{
	const ts = createRequire(`${KIT_ROOT}/test/`)("typescript");
	const typesFile = path.join(PI_ROOT, "dist/core/extensions/types.d.ts");
	const source = ts.createSourceFile(typesFile, readFileSync(typesFile, "utf8"), ts.ScriptTarget.Latest);
	const declaration = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === "ExtensionAPI");
	const members = [...new Set(declaration.members.map((member) => member.name.getText(source)))].sort();
	eq("EXTENSION_API_MEMBERS lists every ExtensionAPI member in pi's types.d.ts, and nothing else", EXTENSION_API_MEMBERS, members);
}

section("what the fake does not answer fails loudly");
{
	const pi = fakeExtensionApi();
	await checkThrows("a member with no fake throws when called, naming itself", () => pi.api.exec("git", []), "pi.exec is not faked");
	await checkThrows("a name that is not a member throws when read", () => pi.api.flags, "pi.flags is not an ExtensionAPI member");
	await checkThrows("an override that is not a member is refused", () => fakeExtensionApi({ getFlags: () => [] }), "not ExtensionAPI members: getFlags");
	is("an override replaces the fake", fakeExtensionApi({ getThinkingLevel: () => "high" }).api.getThinkingLevel(), "high");
	is("the api can be awaited", await Promise.resolve(pi.api), pi.api);
}

section("handlers run as pi's runner runs them");
{
	const pi = fakeExtensionApi();
	const order = [];
	pi.api.on("input", async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		order.push("first");
		return "a";
	});
	const off = pi.api.on("input", (event, ctx) => {
		order.push(`second ${event.text} ${ctx.id}`);
		return "b";
	});
	eq("every handler runs in registration order, each awaited, and fire returns their results", [await pi.fire("input", { text: "hi" }, { id: "ctx" }), order], [["a", "b"], ["first", "second hi ctx"]]);
	off();
	eq("on returns an unsubscribe", await pi.fire("input", {}, {}), ["a"]);
	eq("an event nobody handles returns no results", await pi.fire("session_start", {}, {}), []);
}

section("the event bus is live");
{
	const pi = fakeExtensionApi();
	const heard = [];
	const off = pi.api.events.on("subagents:started", (data) => heard.push(data.id));
	pi.api.events.emit("subagents:started", { id: "a1" });
	off();
	pi.api.events.emit("subagents:started", { id: "a2" });
	eq("a listener hears an emit until it unsubscribes", heard, ["a1"]);
}

section("the recorders");
{
	const pi = fakeExtensionApi();
	pi.api.registerCommand("stats", { handler: () => {} });
	pi.api.registerShortcut("ctrl+b", { handler: () => {} });
	pi.api.registerMessageRenderer("note", () => undefined);
	pi.api.registerEntryRenderer("agent-record", () => undefined);
	pi.api.appendEntry("agent-record", { id: 1 });
	pi.api.sendMessage({ customType: "note", content: "x", display: true }, { triggerTurn: false });
	pi.api.sendUserMessage("go", { deliverAs: "followUp" });
	pi.api.setThinkingLevel("medium");
	eq("commands, shortcuts and renderers by name", [[...pi.commands.keys()], [...pi.shortcuts.keys()], [...pi.messageRenderers.keys()], [...pi.entryRenderers.keys()]], [["stats"], ["ctrl+b"], ["note"], ["agent-record"]]);
	eq("appended entries in session-entry shape", pi.entries, [{ type: "custom", customType: "agent-record", data: { id: 1 } }]);
	eq("sent messages with their options", [pi.sentMessages, pi.sentUserMessages], [[{ message: { customType: "note", content: "x", display: true }, options: { triggerTurn: false } }], [{ content: "go", options: { deliverAs: "followUp" } }]]);
	eq("the thinking level reads back what was set, off by default", [fakeExtensionApi().api.getThinkingLevel(), pi.api.getThinkingLevel()], ["off", "medium"]);
	eq("tool, command and active-tool lists are empty by default", [pi.api.getAllTools(), pi.api.getActiveTools(), pi.api.getCommands()], [[], [], []]);
}

section("a kit extension loads into it");
{
	const pi = fakeExtensionApi();
	await (await kitJiti().import(`${KIT_ROOT}/extensions/multi-edit/index.ts`, { default: true }))(pi.api);
	eq("multi-edit registers its edit tool", [...pi.tools.keys()], ["edit"]);
}

await finish();
