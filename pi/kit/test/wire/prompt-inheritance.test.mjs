/**
 * A child seat inherits its parent's published system prompt byte for byte
 * (lib/wire/inherited-prompt.ts), so it reads the parent's cached prefix.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
// Booting `wire` opens a cache trace. Point it at a temp dir so a test run
// cannot litter the real one; `test/wire/wire-trace.test.mjs` owns the sink's own checks.
const TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-inheritance-wire-trace-"));
process.env.PI_WIRE_TRACE_DIR = TRACE_DIR;

// ---------------------------------------------------------------------------
// Every seat's system prompt is built once and published under its session id,
// so a child can be handed its parent's exact bytes (map C10) and read the
// parent's tools+system cache entry instead of writing its own (map C4). These
// pin the publishing, the inheritance, and the two branches with no parent to
// inherit from.
console.log("prompt inheritance between sessions");
{
	const { buildOwnedSystemPrompt } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const { SKILLS_OPEN } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-skills-catalogue.ts`);
	const { ownedSessionPrompt, inheritedSessionPrompt, publishedOwnedPrompt, forgetOwnedPrompt } = await jiti.import(`${KIT_ROOT}/lib/wire/inherited-prompt.ts`);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-inherit-"));
	const agentsPath = path.join(dir, "AGENTS.md");
	fs.writeFileSync(agentsPath, "Solve the system, not the result.");
	const parentOptions = {
		cwd: dir,
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		appendSystemPrompt: "<COMMUNICATION>\nsay less\n</COMMUNICATION>",
		contextFiles: [{ path: agentsPath, content: "Solve the system, not the result." }],
		skills: [{ name: "tdd", description: "Red-green-refactor", filePath: path.join(dir, "tdd/SKILL.md") }],
	};
	const countOf = (prompt, needle) => prompt.split(needle).length - 1;

	const parentOwned = ownedSessionPrompt(parentOptions, { sessionId: "parent", parentSessionId: undefined });
	check("a main session's prompt is the owned one", parentOwned === buildOwnedSystemPrompt(parentOptions));
	check("and is published under its own id, as the bytes that went out", publishedOwnedPrompt("parent") === parentOwned);
	check("pi's docs block is on no seat", !parentOwned.includes("Pi documentation"));

	// A worker with no prompt body of its own: the parent's bytes, verbatim.
	const childOptions = { ...parentOptions, contextFiles: [], appendSystemPrompt: undefined, skills: [] };
	const childOwned = inheritedSessionPrompt(childOptions, { sessionId: "child", parentSessionId: "parent" });
	check("an inheriting child gets the parent's exact bytes", childOwned === parentOwned);
	check("not a rebuild of them — nothing appended, nothing dropped", countOf(childOwned, SKILLS_OPEN) === 1 && countOf(childOwned, "<project_context>") === 1 && countOf(childOwned, "<COMMUNICATION>") === 1);
	check("and it republishes them, so a grandchild inherits the same bytes", inheritedSessionPrompt(childOptions, { sessionId: "grand", parentSessionId: "child" }) === parentOwned);

	// The branches with no parent to inherit from: a skeleton built from the
	// child's own options. 100% owned text, less parental flavour.
	const orphan = inheritedSessionPrompt(childOptions, { sessionId: "orphan", parentSessionId: undefined });
	check("an unparented child gets an owned skeleton", orphan.startsWith("You are Joel's personal agent") && !orphan.includes("Pi documentation"));
	check("an unpublished parent falls back rather than leaking", inheritedSessionPrompt(childOptions, { sessionId: "missing", parentSessionId: "never-published" }) === orphan);
	forgetOwnedPrompt("parent");
	check("a shut-down parent stops being inheritable", inheritedSessionPrompt(childOptions, { sessionId: "late", parentSessionId: "parent" }) === orphan);
	check("and its published bytes go with it", publishedOwnedPrompt("parent") === undefined);

	// A child whose wire spells the tools differently from its parent's cannot take
	// the parent's bytes: they would name tools its request does not carry.
	const { claudeCodeToolName: ccName } = await jiti.import(`${KIT_ROOT}/lib/wire/claude-code.ts`);
	const oauthParent = ownedSessionPrompt(parentOptions, { sessionId: "oauth-parent", parentSessionId: undefined }, ccName);
	check("an oauth parent's prompt names tools in Claude Code's casing", oauthParent.includes("Use Bash") && oauthParent !== buildOwnedSystemPrompt(parentOptions));
	const codexChild = inheritedSessionPrompt(childOptions, { sessionId: "codex-child", parentSessionId: "oauth-parent" });
	check("a codex child of it gets the parent's prompt in its own tool names", codexChild === buildOwnedSystemPrompt(parentOptions) && !codexChild.includes("Use Bash"), codexChild.slice(0, 120));
	check("an oauth grandchild under the codex child gets the oauth bytes back", inheritedSessionPrompt(childOptions, { sessionId: "oauth-grand", parentSessionId: "codex-child" }, ccName) === oauthParent);
	check("a child on the parent's own spelling still takes its bytes verbatim", inheritedSessionPrompt(childOptions, { sessionId: "oauth-child", parentSessionId: "oauth-parent" }, ccName) === oauthParent);
	for (const id of ["oauth-parent", "codex-child", "oauth-grand", "oauth-child"]) forgetOwnedPrompt(id);

	// A typed child with a body of its own is not an inheriting child at all:
	// its body is an ordinary custom prompt and takes pi's own branch.
	const typed = { ...childOptions, customPrompt: "You are an explorer. Paths and lines, not prose." };
	const typedOwned = ownedSessionPrompt(typed, { sessionId: "typed", parentSessionId: "child" });
	check("a child with its own body is built from it, not from its parent", typedOwned === buildOwnedSystemPrompt(typed) && typedOwned.startsWith("You are an explorer."));

	// --- end to end through the extension ----------------------------------
	// Two wire instances, as the process really runs them: the parent's
	// publishes, the child's inherits, across module registries.
	const PARENT_ID = "550e8400-e29b-41d4-a716-446655440000";
	const CHILD_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
	const { declareChildSeat, forgetChildSeat } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
	const boot = async (tag) => {
		const handlers = new Map();
		const mod = await jiti.import(`${KIT_ROOT}/extensions/wire/index.ts?${tag}`);
		mod.default({ events: { on: () => () => {}, emit: () => {} }, on: (e, h) => handlers.set(e, h), registerCommand: () => {} });
		return handlers;
	};
	const sessionCtx = (sessionId, header, cwd = dir) => ({
		cwd,
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) },
		sessionManager: { getSessionId: () => sessionId, getHeader: () => header },
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c, s) => s } },
	});
	const payload = { messages: [{ role: "user", content: "go" }], system: [{ type: "text", text: "vanilla", cache_control: { type: "ephemeral", ttl: "1h" } }], tools: [] };
	// The cached block, by its breakpoint rather than by its position: the cwd
	// block sits after it and is the one block a child does not inherit.
	const promptBlockOf = (rewritten) => rewritten.system.find((block) => block.cache_control).text;

	const parentWire = await boot("inherit-parent");
	parentWire.get("before_agent_start")({ systemPromptOptions: parentOptions }, sessionCtx(PARENT_ID, { id: PARENT_ID }));
	const parentBlock = promptBlockOf(parentWire.get("before_provider_request")({ payload }, sessionCtx(PARENT_ID, { id: PARENT_ID })));

	declareChildSeat(CHILD_ID, { name: "w1", role: "worker", depth: 1, parentSessionId: PARENT_ID, prompt: { kind: "inherit" } });
	// In a worktree of its own, which is the case this arrangement exists for.
	const WORKTREE = path.join(dir, "worktree");
	const childCtx = sessionCtx(CHILD_ID, { parentSession: `/s/2026-08-29T00-00-00-000Z_${PARENT_ID}.jsonl` }, WORKTREE);
	const childWire = await boot("inherit-child");
	childWire.get("before_agent_start")({ systemPromptOptions: childOptions }, childCtx);
	const childBlock = promptBlockOf(childWire.get("before_provider_request")({ payload }, childCtx));
	check("live: the child's block carries no pi prose", !childBlock.includes("Pi documentation"));
	check("live: the child's block is the parent's cached bytes, byte for byte", childBlock === parentBlock, childBlock.slice(0, 120));
	check(
		"live: and it says where it actually runs, past the breakpoint",
		childWire.get("before_provider_request")({ payload }, childCtx).system.at(-1).text === `Current working directory: ${WORKTREE}`,
	);
	check("live: the child still declares itself a subagent", childWire.get("before_provider_request")({ payload }, childCtx).system[0].text.includes("cc_is_subagent=true"));

	{
		const CODEX_CHILD_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c9";
		declareChildSeat(CODEX_CHILD_ID, { name: "l1", role: "worker", depth: 1, parentSessionId: PARENT_ID, prompt: { kind: "inherit" } });
		const lunaCtx = {
			...sessionCtx(CODEX_CHILD_ID, { parentSession: `/s/2026-08-29T00-00-00-000Z_${PARENT_ID}.jsonl` }, WORKTREE),
			model: { id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses" },
		};
		const lunaWire = await boot("inherit-luna");
		lunaWire.get("before_agent_start")({ systemPromptOptions: childOptions }, lunaCtx);
		const lunaSent = lunaWire.get("before_provider_request")({ payload: { model: "gpt-6-luna", instructions: "vanilla", input: [], tools: [] } }, lunaCtx);
		check("live: the oauth parent's block names Claude Code's tools", parentBlock.includes("Use Bash"));
		check("live: a codex child of it gets that prompt in its own wire's tool names", lunaSent.instructions === `${buildOwnedSystemPrompt(parentOptions)}\n\nCurrent working directory: ${WORKTREE}` && !lunaSent.instructions.includes("Use Bash"), lunaSent.instructions.slice(0, 160));
		forgetChildSeat(CODEX_CHILD_ID);
	}

	parentWire.get("session_shutdown")({}, sessionCtx(PARENT_ID, { id: PARENT_ID }));
	const afterParentGone = promptBlockOf(childWire.get("before_provider_request")({ payload }, childCtx));
	check("live: a child spawned after its parent shut down still owns its text", !afterParentGone.includes("Pi documentation"));
	forgetChildSeat(CHILD_ID);

	// The capture belongs to the seat, not to a module instance. A reload replaces
	// every instance while the conversation goes on, and a seat that lost its
	// options there would refuse the next turn that starts without a user message.
	const { PROMPT_UNAVAILABLE: NO_PROMPT } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const RELOAD_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430aa";
	const reloadCtx = sessionCtx(RELOAD_ID, { id: RELOAD_ID });
	const before = await boot("reload-before");
	before.get("before_agent_start")({ systemPromptOptions: parentOptions }, reloadCtx);
	before.get("session_shutdown")({ reason: "reload" }, reloadCtx);
	const after = await boot("reload-after");
	check("live: a reload keeps the seat's prompt options", promptBlockOf(after.get("before_provider_request")({ payload }, reloadCtx)) === parentBlock);
	after.get("session_shutdown")({ reason: "quit" }, reloadCtx);
	const next = await boot("reload-gone");
	check("live: quitting drops them, and the next seat declares it has no prompt", promptBlockOf(next.get("before_provider_request")({ payload }, reloadCtx)) === NO_PROMPT);

	fs.rmSync(dir, { recursive: true, force: true });
}

fs.rmSync(TRACE_DIR, { recursive: true, force: true });

await finish();
