/**
 * The order pi loads the kit's extensions in, and what hangs on it.
 *
 * pi discovers `extensions/<name>.ts` and `extensions/<name>/index.ts` in
 * `readdirSync` order and loads each in turn, so an entry's name is its place.
 * Several behaviours are that place: the first `session_shutdown` handler is
 * agent-dock's scope, pi chains `before_provider_request` in load order and
 * keeps the last return (wire's, which compaction replays), wire's snapshot of the
 * headers is final only while it touches them last, and each `registerTool`
 * appends to the tool list the wire carries. Moving or renaming an entry can
 * reorder any of them without a single other test noticing.
 *
 * The kit is loaded through pi's own resource loader, so the discovery, the
 * factories and the registrations are the real ones, not a model of them.
 *
 *   node test/kit/load-order.test.mjs
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The factories read the agent dir; a throwaway one keeps them off the seat's.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "load-order-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.mkdirSync(path.join(agentDir, "agents"));
fs.writeFileSync(path.join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: One job.\n---\n");

const { DefaultResourceLoader, SettingsManager } = await importPi("dist/index.js");

const loader = new DefaultResourceLoader({
	cwd: agentDir,
	agentDir,
	settingsManager: SettingsManager.inMemory(),
	additionalExtensionPaths: [KIT_ROOT],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();
const { extensions } = loader.getExtensions();

/** An entry's pi-visible name: `extensions/<name>.ts` or `extensions/<name>/index.ts`. */
const entryName = (file) => {
	const relative = path.relative(path.join(KIT_ROOT, "extensions"), file);
	return relative.endsWith("/index.ts") ? path.dirname(relative) : relative.replace(/\.ts$/, "");
};
const order = extensions.map((extension) => entryName(extension.path));
const registrars = (event) => extensions.filter((extension) => extension.handlers.has(event)).map((extension) => entryName(extension.path));
const show = (list) => list.join(", ");

section("the entries pi loads, in its order");
{
	check("pi finds the kit's entries", order.length >= 20, show(order));
	check("every fact below names an entry that loaded", ["agent-dock", "agent-engine", "bash", "multi-edit", "transcript", "watchdog", "wire", "workflow"].every((name) => order.includes(name)), show(order));
}

section("what the order decides");
{
	check("agent-dock loads first, so its scope is the first to see a shutdown", order[0] === "agent-dock" && registrars("session_shutdown")[0] === "agent-dock", show(registrars("session_shutdown")));
	check("wire alone builds the payload, so its return is the one sent", show(registrars("before_provider_request")) === "wire", show(registrars("before_provider_request")));
	check("wire alone touches the headers, so its snapshot is the final envelope", show(registrars("before_provider_headers")) === "wire", show(registrars("before_provider_headers")));
	const messageEnd = registrars("message_end");
	check("watchdog's message_end rewrite runs before wire reads the message, and wire's is last", messageEnd.indexOf("watchdog") >= 0 && messageEnd.indexOf("watchdog") < messageEnd.indexOf("wire") && messageEnd.at(-1) === "wire", show(messageEnd));
}

section("the tools, in the order the wire carries them");
{
	const tools = (name) => [...(extensions.find((extension) => entryName(extension.path) === name)?.tools.keys() ?? [])];
	check("the engine registers its five in order", show(tools("agent-engine")) === "Agent, SendMessage, ListAgents, TaskOutput, TaskStop", show(tools("agent-engine")));
	const factories = "write";
	check("transcript re-registers only write", show(tools("transcript")) === factories, show(tools("transcript")));
	const all = extensions.flatMap((extension) => [...extension.tools.keys()]);
	const expected = `Agent, SendMessage, ListAgents, TaskOutput, TaskStop, bash, edit, ${factories}, Workflow, StructuredOutput`;
	check("and every extension tool lands in load order", show(all) === expected, show(all));
}

section("the payload and header hooks, by source scan");
// A replay only refreshes the cache if it has the bytes that wrote it, and
// those bytes are `wire`'s: pi chains before_provider_request in loader order
// and takes the last return value. One writer is the fix; this is the pin that
// keeps it one.
{
	// Every kit source, not just the top-level files: half the extensions are
	// directories, and a registration hidden in one is exactly the drift that
	// would put a stranger's rewrite behind wire's and break the replay again.
	// Limit stated: this sees the kit, not the packages beside it.
	// pi-web-search does not register the hook today.
	const sources = [];
	const walk = (dir) => {
		for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, item.name);
			if (item.isDirectory()) walk(full);
			else if (item.name.endsWith(".ts")) sources.push(full);
		}
	};
	walk(`${KIT_ROOT}/extensions`);
	check("the walk sees the directory extensions too", sources.length > fs.readdirSync(`${KIT_ROOT}/extensions`).length);
	const sourceRegistrars = (hook) =>
		sources
			.filter((file) => fs.readFileSync(file, "utf8").includes(`pi.on("${hook}"`))
			.map((file) => path.relative(`${KIT_ROOT}/extensions`, file))
			.sort()
			.join();
	check("only one extension touches the outgoing payload at all",
		sourceRegistrars("before_provider_request") === "wire/index.ts", sourceRegistrars("before_provider_request"));
	// The headers have the same hazard and needed the same pin. pi mutates one
	// shared bag in extension order and ignores return values, so `wire`'s
	// snapshot is the final envelope only while `wire` is the last to touch it.
	// A replay uses a snapshot; a handler sorting after `wire` would be invisible
	// to it, which is the payload bug over again on the other half of the request.
	check("and one owns the envelope", sourceRegistrars("before_provider_headers") === "wire/index.ts", sourceRegistrars("before_provider_headers"));
}


fs.rmSync(agentDir, { recursive: true, force: true });
// A factory may leave a handle open; finish() ends the process once the verdict is in.
await finish();
