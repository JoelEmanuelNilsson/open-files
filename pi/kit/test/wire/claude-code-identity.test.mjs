/**
 * Claude Code's wire identity (lib/wire/claude-code.ts): the attribution block,
 * byte for byte, and the facts it is built from.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { createHash } from "node:crypto";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
console.log("claude-code identity");
{
	const {
		buildAttributionHeader,
		claudeCodeHeaders,
		firstUserTextOf,
		isFirstParty,
		sessionIdFromPath,
		subagentIdentity,
		CLAUDE_CODE_VERSION,
		LAST_VERIFIED_VERSION,
		CLAUDE_CODE_USER_AGENT,
	} = await jiti.import(`${KIT_ROOT}/lib/wire/claude-code.ts`);

	// Pinned to one release's shape, byte for byte. A refactor that changes one
	// character of this line fails here, before it can reach the wire. The
	// version is not part of that shape — it comes off the installed binary — so
	// it is a hole, and what is asserted is how the line composes around it.
	//
	// The three hash digits are the real assertion: they can only come out right
	// if salt, sampled characters and version compose as upstream composes them.
	// They are recomputed here from a second transcription of those three facts,
	// never read back out of the harness, or the pin would pin the
	// implementation. The transcription itself is held to the digits read off
	// 2.1.284 by hand, which no release can move:
	//
	//   printf '%s' '59cf53e54c78t b2.1.284' | shasum -a 256 | cut -c1-3   # cab
	//   printf '%s' '59cf53e54c78'"000"'2.1.284' | shasum -a 256 | cut -c1-3  # 12a
	//
	// `t b` is characters 4, 7 and 20 of PIN below; `000` is the empty-message
	// case, where every sampled character falls back to "0".
	const ccHash = (sampled, version) => createHash("sha256").update(`59cf53e54c78${sampled}${version}`).digest("hex").slice(0, 3);
	check(
		"the transcribed hash reproduces the digits read off 2.1.284 by hand",
		ccHash("t b", LAST_VERIFIED_VERSION) === "cab" && ccHash("000", LAST_VERIFIED_VERSION) === "12a",
	);
	const PIN = "pin the attribution block";
	const V = CLAUDE_CODE_VERSION;
	const pinnedMessages = [{ role: "user", content: PIN }];
	const pinnedFacts = { firstUserText: PIN, firstParty: true };
	check(
		"attribution block matches the pinned wire shape",
		buildAttributionHeader(pinnedFacts) === `x-anthropic-billing-header: cc_version=${V}.${ccHash("t b", V)}; cc_entrypoint=cli; cch=00000;`,
		buildAttributionHeader(pinnedFacts),
	);
	check(
		"attribution survives an empty conversation",
		buildAttributionHeader({ firstUserText: "", firstParty: true }) ===
			`x-anthropic-billing-header: cc_version=${V}.${ccHash("000", V)}; cc_entrypoint=cli; cch=00000;`,
	);
	check(
		"a non-first-party request drops cch, prev-req and prompt-id",
		buildAttributionHeader({
			...pinnedFacts,
			firstParty: false,
			previousRequestId: "req_abc",
			promptId: "550e8400-e29b-41d4-a716-446655440000",
		}) === `x-anthropic-billing-header: cc_version=${V}.${ccHash("t b", V)}; cc_entrypoint=cli;`,
	);
	check(
		"the optional fields keep Claude Code's field order",
		buildAttributionHeader({
			...pinnedFacts,
			subagent: { agentId: "550e8400-e29b-41d4-a716-446655440000", parentAgentId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
			previousRequestId: "req_011CQ4x",
			promptId: "550e8400-e29b-41d4-a716-446655440000",
			turnOrigin: "human",
			turnPosition: { promptIndex: 3, turnIndex: 4 },
		}) ===
			`x-anthropic-billing-header: cc_version=${V}.${ccHash("t b", V)}; cc_entrypoint=cli; cch=00000; cc_is_subagent=true; cc_prev_req=req_011CQ4x; cc_prompt_id=550e8400-e29b-41d4-a716-446655440000; cc_turn_origin=human; cc_prompt_index=3; cc_turn_index=4;`,
	);
	const positioned = (promptIndex, turnIndex, firstParty = true) =>
		buildAttributionHeader({ ...pinnedFacts, firstParty, turnPosition: { promptIndex, turnIndex } }).includes("cc_prompt_index");
	check("a turn opened by no human prompt yet sends prompt index 0", positioned(0, 1));
	check(
		"an index outside upstream's bounds drops both fields",
		!positioned(0, 0) && !positioned(-1, 1) && !positioned(1.5, 2) && !positioned(1, 10_000_001) && positioned(10_000_000, 10_000_000),
	);
	check("a non-first-party request drops the turn position too", !positioned(1, 1, false));
	check(
		"a malformed turn origin is dropped, not sent",
		!buildAttributionHeader({ ...pinnedFacts, turnOrigin: "Human Turn" }).includes("cc_turn_origin"),
	);
	check(
		"a non-first-party request drops the turn origin too",
		!buildAttributionHeader({ ...pinnedFacts, firstParty: false, turnOrigin: "human" }).includes("cc_turn_origin"),
	);
	check(
		"a malformed request id is dropped, not sent",
		!buildAttributionHeader({ ...pinnedFacts, previousRequestId: "nope-not-a-request-id" }).includes("cc_prev_req"),
	);
	check(
		"a malformed prompt id is dropped, not sent",
		!buildAttributionHeader({ ...pinnedFacts, promptId: "not-a-uuid" }).includes("cc_prompt_id"),
	);

	// The hash samples the first user message the way upstream reads it: the
	// first text block of block content, not every block joined.
	check("first user text reads a string message", firstUserTextOf(pinnedMessages) === PIN);
	check(
		"first user text reads the FIRST text block only",
		firstUserTextOf([{ role: "user", content: [{ type: "text", text: PIN }, { type: "text", text: "second" }] }]) === PIN,
	);
	check("first user text skips non-user messages", firstUserTextOf([{ role: "assistant", content: "x" }, { role: "user", content: PIN }]) === PIN);
	check("first user text of an empty conversation is empty", firstUserTextOf([]) === "");

	check("first-party by default", isFirstParty(undefined) && isFirstParty("https://api.anthropic.com"));
	check("a proxied base url is not first-party", !isFirstParty("https://proxy.example.com/v1") && !isFirstParty("not a url"));

	// A half-declared subagent is unrepresentable.
	check("a subagent needs both ids", subagentIdentity("550e8400-e29b-41d4-a716-446655440000", undefined) === undefined);
	check("a subagent needs well-formed ids", subagentIdentity("550e8400-e29b-41d4-a716-446655440000", "parent") === undefined);
	check(
		"a parent session id is read out of its file path",
		sessionIdFromPath("/s/2026-08-28T17-59-47-975Z_01a04987-2207-720a-92a1-36eebcb0d389.jsonl") === "01a04987-2207-720a-92a1-36eebcb0d389",
	);
	check("an id-less path yields no parent", sessionIdFromPath("/s/session.jsonl") === undefined && sessionIdFromPath(undefined) === undefined);

	check(
		"a main session sends only the two always-on headers",
		JSON.stringify(claudeCodeHeaders({ sessionId: "s1" })) ===
			JSON.stringify({ "user-agent": CLAUDE_CODE_USER_AGENT, "X-Claude-Code-Session-Id": "s1" }),
	);
	check("the user-agent carries the one resolved version", CLAUDE_CODE_USER_AGENT === `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`);
}

await finish();
