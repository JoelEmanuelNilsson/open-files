/**
 * The wire extension (extensions/wire/index.ts) end to end: the request it
 * sends on each seat, with the owned prompt and Claude Code's identity on it.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { bootWire } from "../support/boot-wire.mjs";
import { ownedPromptOptions } from "../support/owned-prompt-options.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
// Booting `wire` opens a cache trace. Point it at a temp dir so a test run
// cannot litter the real one; `test/wire/wire-trace.test.mjs` owns the sink's own checks.
const TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wire-request-wire-trace-"));
process.env.PI_WIRE_TRACE_DIR = TRACE_DIR;

// ---------------------------------------------------------------------------
console.log("wire request");
{
	const { buildOwnedSystemPrompt, PROMPT_UNAVAILABLE } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const { claudeCodeToolName, CLAUDE_CODE_VERSION, CLAUDE_CODE_USER_AGENT } = await jiti.import(`${KIT_ROOT}/lib/wire/claude-code.ts`);
	const { dir, options } = ownedPromptOptions();
	const ours = buildOwnedSystemPrompt(options);
	// What an OAuth request sends: the same build, with pi-ai's tool casing.
	const oauthOurs = buildOwnedSystemPrompt(options, claudeCodeToolName);
	// The second transcription of the attribution hash; claude-code-identity.test.mjs holds it to the hand-read digits.
	const ccHash = (sampled, version) => createHash("sha256").update(`59cf53e54c78${sampled}${version}`).digest("hex").slice(0, 3);
	// Characters 4, 7 and 20 of this message are `t b`.
	const pinnedMessages = [{ role: "user", content: "pin the attribution block" }];

	const seat = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
	check(
		"a --system-prompt process can identify no subagent",
		seat.cliSuppliesSystemPrompt(["pi", "--system-prompt", "x"]) &&
			seat.cliSuppliesSystemPrompt(["pi", "--system-prompt=x"]) &&
			!seat.cliSuppliesSystemPrompt(["pi", "--append-system-prompt", "x"]),
	);
	const { handlers, commands } = await bootWire(jiti);
	const WIRE_CWD = "/tmp/wire-seat";
	const mainSession = {
		getLeafId: () => null, getSessionId: () => "550e8400-e29b-41d4-a716-446655440000",
		getHeader: () => ({ id: "550e8400-e29b-41d4-a716-446655440000" }),
	};
	const ctx = {
		cwd: WIRE_CWD,
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) },
		sessionManager: mainSession,
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c, s) => s } },
	};
	const payload = {
		messages: pinnedMessages,
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral", ttl: "1h" } },
			{ type: "text", text: "vanilla pi prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
		],
		tools: [{ name: "Read", input_schema: {} }],
	};

	// Before any options capture. pi's prompt is not a fallback: a request that
	// says "I am Claude Code" and carries another product's prose is what the
	// provider refuses as a third-party app (req_011CedeAuH5mq3X7m9d1d52r,
	// req_011CenGzjBfwouGRX52Q5PE3), so the seat declares the absence instead.
	const refusalNotices = [];
	const degraded = handlers.get("before_provider_request")({ payload }, { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: (m, level) => refusalNotices.push({ m, level }) } });
	check("with no capture the array is still four blocks", degraded.system.length === 4, JSON.stringify(degraded.system.map((b) => b.text.slice(0, 30))));
	check("attribution first, identity second, whatever else is true", degraded.system[0].text.startsWith("x-anthropic-billing-header:") && degraded.system[1].text === "You are Claude Code, Anthropic's official CLI for Claude.");
	check("pi's prompt is never the third block", !degraded.system.some((b) => b.text.includes("vanilla pi prompt")));
	check("the third block declares the seat has no prompt", degraded.system[2].text === PROMPT_UNAVAILABLE);
	check("the identity block is still sent exactly once", degraded.system.filter((b) => b.text.includes("You are Claude Code")).length === 1);
	check("the cache breakpoint still lands on the third block", degraded.system[2].cache_control?.ttl === "1h");
	// The refusal alone, and once: the same request also carries the family line
	// (this fixture's seat is on claude-test while the settings name another family).
	check("and the human is told, at error level", refusalNotices.filter((n) => n.level === "error").length === 1 && refusalNotices.some((n) => n.level === "error" && n.m.includes("no system prompt")), JSON.stringify(refusalNotices));
	// Telling him is the one thing on this path that is not pure construction, so
	// it is the one thing that could hand the request back to pi — on exactly the
	// path where pi's payload is the shape the provider refuses.
	const throughDeadUi = handlers.get("before_provider_request")({ payload }, { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: () => { throw new Error("this frame is unmounted"); } } });
	check("a ui that throws while being told costs the notice, never the wire", throughDeadUi?.system.length === 4 && throughDeadUi.system[2].text === PROMPT_UNAVAILABLE, JSON.stringify(throughDeadUi?.system.map((b) => b.text.slice(0, 30))));

	handlers.get("before_agent_start")({ systemPromptOptions: options }, ctx);
	const rewritten = handlers.get("before_provider_request")({ payload }, ctx);
	check(
		"first block is the attribution",
		rewritten.system[0].text.startsWith(
			`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${ccHash("t b", CLAUDE_CODE_VERSION)}; cc_entrypoint=cli; cch=00000;`,
		),
	);
	check("attribution block carries no cache_control", rewritten.system[0].cache_control === undefined);
	check("second block is the Claude Code identity", rewritten.system[1].text === "You are Claude Code, Anthropic's official CLI for Claude.");
	check("the identity block is sent once", rewritten.system.filter((b) => b.text.includes("You are Claude Code")).length === 1);
	check("third block is the owned prompt", rewritten.system.length === 4 && rewritten.system[2].text === oauthOurs, rewritten.system[2].text.slice(0, 200));
	check("cache_control is carried onto the owned block", rewritten.system[2].cache_control?.ttl === "1h");
	// Past the breakpoint on purpose: two seats on the same model and tools in
	// different directories share one tools+system entry, and this block is the
	// only thing that tells them apart. Read off the seat's own cwd, so a child
	// in a worktree still sends the parent's cached body.
	check("the cwd is the fourth block, uncached", rewritten.system[3].text === `Current working directory: ${WIRE_CWD}` && rewritten.system[3].cache_control === undefined, JSON.stringify(rewritten.system[3]));
	check("the owned prompt carries no cwd of its own", !rewritten.system[2].text.includes("Current working directory"));
	const elsewhere = handlers.get("before_provider_request")({ payload }, { ...ctx, cwd: "/tmp/other-seat" });
	check("a seat in another directory sends the same cached block", elsewhere.system[2].text === rewritten.system[2].text && elsewhere.system[3].text === "Current working directory: /tmp/other-seat");
	check("messages pass through untouched", rewritten.messages === payload.messages);
	check("a payload with no bash keeps every tool it arrived with", JSON.stringify(rewritten.tools) === JSON.stringify(payload.tools));

	const again = handlers.get("before_provider_request")({ payload: rewritten }, ctx);
	check("a second pass is byte-identical", JSON.stringify(again.system) === JSON.stringify(rewritten.system));

	// Instruments run beside the request, never in its path: pi answers a throw in
	// this handler by sending the payload it already had — pi's prompt, no
	// attribution, no identity. Today's trace, dump and last-request capture each go dead rather
	// than throw; this pins the guarantee for the one that some day does not, by
	// breaking the seat under the instruments after the owned bytes are built.
	{
		const notices = [];
		const brokenCtx = {
			...ctx,
			hasUI: true,
			// Answers everything the payload is built from; only the leaf the last-request
			// capture records fails — the shape of any instrument that dies after the wire is decided.
			sessionManager: { getLeafId: () => { throw new Error("the session went away"); }, getSessionId: () => "6ba7b810-9dad-11d1-80b4-00c04fd430bb", getHeader: () => ({}) },
			ui: { ...ctx.ui, notify: (m, level) => notices.push({ m, level }) },
		};
		const { handlers: broken } = await bootWire(jiti, "?broken-instrument");
		broken.get("before_agent_start")({ systemPromptOptions: options }, brokenCtx);
		const sent = broken.get("before_provider_request")({ payload }, brokenCtx);
		check("an instrument that throws still sends the owned four blocks", sent?.system.length === 4 && sent.system[0].text.startsWith("x-anthropic-billing-header:") && sent.system[2].text === oauthOurs, JSON.stringify(sent?.system.map((b) => b.text.slice(0, 30))));
		check("with its tools", JSON.stringify(sent.tools) === JSON.stringify(payload.tools));
		check("and the failure is named, at warning level, without costing the turn", notices.some((n) => n.m.includes("the instrument did not") && n.level === "warning"), JSON.stringify(notices));
	}

	const keyed = handlers.get("before_provider_request")({ payload }, { ...ctx, modelRegistry: { isUsingOAuth: () => false, find: (provider, id) => ({ provider, id }) } });
	check("api-key requests get the owned prompt and its cwd, nothing else", keyed.system.length === 2 && keyed.system[0].text === ours && keyed.system[1].text === `Current working directory: ${WIRE_CWD}`);

	check(
		"a payload on any other api passes through",
		handlers.get("before_provider_request")({ payload }, { ...ctx, model: { id: "gpt", api: "openai-responses" } }) === undefined,
	);
	check("/prompt command is registered", commands.has("prompt"));

	// A main session declares no subagent facts, and one user turn carries one
	// prompt id across every request of that turn.
	const attributionOf = (blocks) => blocks[0].text;
	check("a main session sends no subagent field", !attributionOf(rewritten.system).includes("cc_is_subagent"));
	const promptId = /cc_prompt_id=([0-9a-f-]+);/.exec(attributionOf(rewritten.system))?.[1];
	check("a prompt id is always present", promptId !== undefined);
	check(
		"the prompt id is stable across the requests of one turn",
		/cc_prompt_id=([0-9a-f-]+);/.exec(attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system))?.[1] === promptId,
	);
	handlers.get("before_agent_start")({ systemPromptOptions: options }, ctx);
	check(
		"a new turn gets a new prompt id",
		/cc_prompt_id=([0-9a-f-]+);/.exec(attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system))?.[1] !== promptId,
	);

	// The previous response's request id rides the next request, and only a
	// well-formed one does.
	check("no previous request id on the first request", !attributionOf(rewritten.system).includes("cc_prev_req"));
	handlers.get("after_provider_response")({ status: 200, headers: { "request-id": "req_011CQ4xPinned" } }, ctx);
	check(
		"the previous request id rides the next request",
		attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system).includes("cc_prev_req=req_011CQ4xPinned;"),
	);
	handlers.get("after_provider_response")({ status: 200, headers: { "request-id": "garbage id" } }, ctx);
	check(
		"a malformed request id never reaches the wire",
		!attributionOf(handlers.get("before_provider_request")({ payload }, ctx).system).includes("cc_prev_req"),
	);

	// Headers: the user-agent override and the session id, OAuth only.
	const headers = { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" };
	handlers.get("before_provider_headers")({ headers }, ctx);
	check("the stale pi-ai user-agent is overridden", headers["user-agent"] === CLAUDE_CODE_USER_AGENT);
	check("the session id header is sent", headers["X-Claude-Code-Session-Id"] === "550e8400-e29b-41d4-a716-446655440000");
	check("pi's own headers are left alone", headers["anthropic-beta"] === "claude-code-20250219,oauth-2025-04-20");
	const keyedHeaders = {};
	handlers.get("before_provider_headers")({ headers: keyedHeaders }, { ...ctx, modelRegistry: { isUsingOAuth: () => false } });
	check("api-key requests get no Claude Code headers", Object.keys(keyedHeaders).length === 0);

	// A subagent session: parentSession AND customPrompt. All three subagent
	// facts appear together or not at all.
	const subCtx = {
		...ctx,
		sessionManager: {
			getLeafId: () => null, getSessionId: () => "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
			getHeader: () => ({ parentSession: "/s/2026-08-28T17-59-47-975Z_01a04987-2207-720a-92a1-36eebcb0d389.jsonl" }),
		},
	};
	const { handlers: subHandlers } = await bootWire(jiti, "?sub");
	subHandlers.get("before_agent_start")({ systemPromptOptions: { ...options, customPrompt: "You are a subagent." } }, subCtx);
	const subWire = subHandlers.get("before_provider_request")({ payload }, subCtx);
	check("a subagent declares itself", attributionOf(subWire.system).includes(" cc_is_subagent=true;"));
	const subHeaders = {};
	subHandlers.get("before_provider_headers")({ headers: subHeaders }, subCtx);
	check(
		"a subagent sends both agent-id headers",
		subHeaders["x-claude-code-agent-id"] === "6ba7b810-9dad-11d1-80b4-00c04fd430c8" &&
			subHeaders["x-claude-code-parent-agent-id"] === "01a04987-2207-720a-92a1-36eebcb0d389",
	);
	const orphanCtx = { ...subCtx, sessionManager: { getLeafId: () => null, getSessionId: () => "6ba7b810-9dad-11d1-80b4-00c04fd430c8", getHeader: () => ({}) } };
	const orphanHeaders = {};
	subHandlers.get("before_provider_headers")({ headers: orphanHeaders }, orphanCtx);
	check(
		"a subagent with no traceable parent declares nothing",
		!attributionOf(subHandlers.get("before_provider_request")({ payload }, orphanCtx).system).includes("cc_is_subagent") &&
			orphanHeaders["x-claude-code-agent-id"] === undefined,
	);

	// The turn position is counted from the history a new prompt's `context`
	// carries: from 1 on a fresh session, on from there, and not at all on a
	// history this process did not count.
	{
		const { handlers: turns } = await bootWire(jiti, "?turns");
		const send = (on = turns, at = ctx) => attributionOf(on.get("before_provider_request")({ payload }, at).system);
		const open = (messages, on = turns, at = ctx, systemPromptOptions = options) => {
			on.get("before_agent_start")({ systemPromptOptions }, at);
			on.get("context")({ messages }, at);
		};
		const ask = (text) => ({ role: "user", content: text, timestamp: 0 });
		const reply = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 };
		check("no turn position before a prompt is counted", !send().includes("cc_prompt_index"));
		open([ask("one")]);
		check("a fresh session's first prompt is prompt 1 of turn 1", send().endsWith(" cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;"), send());
		turns.get("context")({ messages: [ask("one"), reply, { role: "toolResult", toolCallId: "t", content: [], timestamp: 0 }] }, ctx);
		check("a tool-loop follow-up keeps its turn's position", send().endsWith(" cc_prompt_index=1; cc_turn_index=1;"), send());
		open([ask("one"), reply, ask("two")]);
		check("the next prompt counts on", send().endsWith(" cc_prompt_index=2; cc_turn_index=2;"), send());

		const { handlers: resumed } = await bootWire(jiti, "?resumed");
		open([ask("one"), reply, ask("two")], resumed);
		check("a prompt on history this process did not count sends no position", !send(resumed).includes("cc_prompt_index"), send(resumed));
		open([{ role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: 0 }, ask("two")], resumed);
		check("nor does the next one", !send(resumed).includes("cc_prompt_index"), send(resumed));

		const { handlers: sub } = await bootWire(jiti, "?sub-turns");
		open([ask("brief")], sub, subCtx, { ...options, customPrompt: "You are a subagent." });
		check("a subagent's turn sends no position", !send(sub, subCtx).includes("cc_prompt_index"), send(sub, subCtx));
	}

	// An engine child sends pi's payload as the main seat does: pi's betas, no context edits.
	{
		const childId = "9b2f6c1e-3d4a-4e5b-8c7d-1a2b3c4d5e6f";
		seat.declareChildSeat(childId, { name: "w", role: "worker", depth: 1, parentSessionId: "550e8400-e29b-41d4-a716-446655440000", workflowChild: false, workflows: false, prompt: { kind: "own" } });
		const childCtx = { ...ctx, sessionManager: { getLeafId: () => null, getSessionId: () => childId, getHeader: () => ({ parentSession: "/s/2026-08-28T17-59-47-975Z_550e8400-e29b-41d4-a716-446655440000.jsonl" }) } };
		const { handlers: childHandlers } = await bootWire(jiti, "?child");
		childHandlers.get("before_agent_start")({ systemPromptOptions: { ...options, customPrompt: "You are a worker." } }, childCtx);
		const piBetas = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
		const child = childHandlers.get("before_provider_request")({ payload: { ...payload, betas: piBetas, thinking: { type: "adaptive" } } }, childCtx);
		check("an engine child sends pi's betas and no context_management", child.context_management === undefined && JSON.stringify(child.betas) === JSON.stringify(piBetas), JSON.stringify(child.betas));
		seat.forgetChildSeat(childId);
	}

	// A ChatGPT-subscription seat: the same owned words and the same tool cut, in
	// the Responses API's shape, and nothing that belongs to Claude Code.
	{
		const luna = { id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex" };
		const notices = [];
		const codexCtx = { ...ctx, model: luna, hasUI: true, ui: { ...ctx.ui, notify: (m, level) => notices.push({ m, level }) } };
		const codexTool = (name) => ({ type: "function", name, description: `${name} tool`, parameters: {}, strict: null });
		const codexPayload = {
			model: "gpt-6-luna",
			instructions: "vanilla pi prompt",
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
			tools: ["write", "bash", "Agent", "read"].map(codexTool),
			prompt_cache_key: "550e8400-e29b-41d4-a716-446655440000",
		};
		handlers.get("before_agent_start")({ systemPromptOptions: options }, codexCtx);
		const codexHeaders = { authorization: "Bearer codex-token", "chatgpt-account-id": "acct" };
		handlers.get("before_provider_headers")({ headers: codexHeaders }, codexCtx);
		check("no claude code header is added to a codex request", JSON.stringify(Object.keys(codexHeaders)) === JSON.stringify(["authorization", "chatgpt-account-id"]));
		const sent = handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		check("a codex request carries the owned prompt and its cwd as its instructions", sent?.instructions === `${ours}\n\nCurrent working directory: ${WIRE_CWD}`, sent?.instructions?.slice(0, 200));
		check("pi's prompt is not in it", !sent.instructions.includes("vanilla pi prompt"));
		check("nothing Claude Code rides a codex request", !sent.instructions.includes("You are Claude Code") && !sent.instructions.includes("x-anthropic-billing-header") && sent.system === undefined);
		check("the canonical order applies to codex tools", JSON.stringify(sent.tools.map((t) => t.name)) === JSON.stringify(["Agent", "bash", "read", "write"]), JSON.stringify(sent.tools.map((t) => t.name)));
		check("and each kept tool goes out as pi built it", JSON.stringify(sent.tools[1]) === JSON.stringify(codexTool("bash")));
		check("the conversation and the cache key pass through untouched", sent.input === codexPayload.input && sent.prompt_cache_key === codexPayload.prompt_cache_key && sent.model === "gpt-6-luna");
		check("a second pass is byte-identical", JSON.stringify(handlers.get("before_provider_request")({ payload: sent }, codexCtx)) === JSON.stringify(sent));
		check("a codex request raises no notice", notices.length === 0, JSON.stringify(notices));

		const dumped = [];
		await commands.get("prompt").handler("", { ...codexCtx, ui: { ...ctx.ui, notify: (m) => dumped.push(m) } });
		const dumpPath = /dumped to (\S+)$/.exec(dumped[0] ?? "")?.[1];
		const dump = dumpPath === undefined ? "" : fs.readFileSync(dumpPath, "utf8");
		check("/prompt records the codex request", dumped[0]?.includes("(gpt-6-luna,") && dump.includes("Current working directory: /tmp/wire-seat") && dump.includes('"input_text"'), dumped[0]);
		check("with the tools that went out", dump.includes('"name": "Agent"'));
		check("rendered as a codex request: api, instructions, input", dump.includes("- api: openai-codex-responses") && dump.includes("## instructions (") && dump.includes("## input (1,") && !dump.includes("## system blocks") && !dump.includes("not an OAuth request"));
		check("with the headers pi handed over, the credential redacted", dump.includes("- chatgpt-account-id: acct") && dump.includes("- authorization: (redacted)") && !dump.includes("codex-token"));
		check("and the request's other fields", /## request fields[\s\S]*"prompt_cache_key": "550e8400/.test(dump) && !/## request fields[^#]*"instructions"/.test(dump));

		// A typed child's body is the custom prompt: it arrives once, in place of
		// pi's, and pi's copy of it in the vanilla instructions is gone with the rest.
		const typedSession = { getLeafId: () => null, getSessionId: () => "7c9e6679-7425-40de-944b-e07fc1f90ae7", getHeader: () => ({ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }) };
		const typedCtx = { ...codexCtx, sessionManager: typedSession };
		handlers.get("before_agent_start")({ systemPromptOptions: { ...options, customPrompt: "You are the explore agent. BODY-MARK" } }, typedCtx);
		const typed = handlers.get("before_provider_request")({ payload: { ...codexPayload, instructions: "vanilla pi prompt\nYou are the explore agent. BODY-MARK" } }, typedCtx);
		check("a typed child's body reaches a codex seat exactly once", typed.instructions.split("BODY-MARK").length === 2 && typed.instructions.startsWith("You are the explore agent. BODY-MARK") && !typed.instructions.includes("vanilla pi prompt"), typed.instructions.slice(0, 120));

		const reported = [];
		const quotaCtx = { ...codexCtx, ui: { ...ctx.ui, notify: (m) => reported.push(m) } };
		const resetAt = Math.floor(Date.now() / 1000) + 16_503;
		handlers.get("after_provider_response")({
			status: 200,
			headers: { "x-codex-primary-used-percent": "12.5", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(resetAt), "x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080" },
		}, codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("/quota reports the codex windows the response sent", reported.some((m) => /Codex quota 5h 13% · 7d 40% \(5h resets /.test(m)), JSON.stringify(reported));
		handlers.get("after_provider_response")({ status: 200, headers: { "content-type": "text/event-stream" } }, codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("a codex response with no quota headers leaves the last reading standing", reported.at(-1)?.includes("Codex quota 5h 13%"), reported.at(-1));
		check("and never becomes an anthropic reading", !reported.at(-1)?.split("\n").some((line) => line.startsWith("Quota ")), reported.at(-1));

		// Over WebSocket the response hook never fires. The newest answer then has
		// no numbers, and /quota says so instead of repeating the last SSE ones.
		const codexAnswer = (stopReason) => ({ message: { role: "assistant", api: "openai-codex-responses", stopReason, usage: { input: 1, output: 1 } } });
		handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		handlers.get("message_end")(codexAnswer("stop"), codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("a codex answer with no response headers is declared unreported, not shown stale", reported.at(-1) === "Codex quota: not reported over WebSocket (pi-ai drops the codex.rate_limits event; only an SSE response carries it to extensions)", reported.at(-1));
		handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		handlers.get("after_provider_response")({ status: 200, headers: { "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300" } }, codexCtx);
		handlers.get("message_end")(codexAnswer("stop"), codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("an SSE answer after it reads again", reported.at(-1) === "Codex quota 5h 20%", reported.at(-1));
		handlers.get("before_provider_request")({ payload: codexPayload }, codexCtx);
		handlers.get("message_end")(codexAnswer("error"), codexCtx);
		await commands.get("quota").handler("", quotaCtx);
		check("a request that failed answered nothing, so the last word stands", reported.at(-1) === "Codex quota 5h 20%", reported.at(-1));
	}

	fs.rmSync(dir, { recursive: true, force: true });
}

fs.rmSync(TRACE_DIR, { recursive: true, force: true });

await finish();
