/**
 * The Claude Code mimicry (lib/wire/claude-code.ts) checked against the
 * installed Claude Code binary.
 */

import { check, finish, skip } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

/**
 * A regex over Claude Code's minified bundle, where every identifier is a hole.
 *
 * Claude Code ships minified, and the minifier renames module-scope
 * identifiers on every build. An oracle that pins a name — `Lun`, `l_e`,
 * `RBt` — therefore reports "Claude Code changed" on a release that changed
 * nothing, and because `npm test` chains on `&&` it takes the other nine test
 * files down with it. These patterns pin what Anthropic actually decides:
 * literal values, argument order, field order. The names are holes.
 *
 *   `{}`  — any minified identifier, captured
 *   `{2}` — whatever the 2nd hole captured, again (ties two names together)
 *
 * Everything else in the shape is matched literally.
 */
const minified = (shape) =>
	new RegExp(
		shape
			.split(/(\{\d*\})/)
			.map((part) => {
				if (part === "{}") return "([A-Za-z_$][A-Za-z0-9_$]*)";
				const backreference = /^\{(\d+)\}$/.exec(part);
				return backreference ? `\\${backreference[1]}` : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			})
			.join(""),
	);

// ---------------------------------------------------------------------------
console.log("claude-code oracle");
{
	const { CLAUDE_CODE_VERSION, CLAUDE_CODE_IDENTITY } = await jiti.import(`${KIT_ROOT}/lib/wire/claude-code.ts`);

	// Constants are verified against the release itself, never against a
	// third-party copy of it.
	//
	// Two properties are structural here, and both were bugs once:
	//
	//   - **A rename is not a change.** Claude Code ships minified and the
	//     bundler renames every module-scope identifier per release, so these
	//     match through `minified` with the names as holes. Pinning `Lun` or
	//     `RBt` made the suite red on releases that changed nothing.
	//   - **The same names report either way.** Whether or not a binary is
	//     installed, this block emits one result per oracle — checked, or
	//     skipped by name. A single blanket skip would make the number of checks
	//     a property of the machine rather than of the code.
	//
	// Every oracle here is structural, and every one is a hard failure: the
	// version number is read off this same binary at load, so it cannot fall
	// behind, and what is left can only go red when Anthropic changes the shape
	// of the wire — which is a real bug in this harness's mimicry and needs a
	// human to re-read the binary.
	const claudeLink = path.join(os.homedir(), ".local/bin/claude");
	const binary = fs.existsSync(claudeLink) ? fs.realpathSync(claudeLink) : undefined;
	const strings =
		binary === undefined ? "" : execFileSync("strings", ["-n", "6", binary], { maxBuffer: 512 * 1024 * 1024, encoding: "latin1" });

	// The salt's name is a hole, and the hash shape below reuses whatever name
	// this build gave it — so the two facts can never drift apart.
	const salt = minified('{}="59cf53e54c78"').exec(strings);
	// Shapes are built by these, so the near-miss checks are the same patterns
	// with one fact altered rather than a second transcription of them.
	// Parameters and locals are holes too: 2.1.258 renamed `t`/`u` to `n`/`d`
	// without touching the hash, and a pin on a local name is a pin on nothing.
	const hashShape = (samples, saltName) =>
		`function {}({},{}){let {}=[${samples}].map(({})=>{2}[{5}]||"0").join(""),{}=\`\${${saltName}}\${{4}}\${{3}}\`;` +
		'return {}("sha256").update({6}).digest("hex").slice(0,3)}';
	// Seven interpolations since 2.1.284, which appended the turn position after
	// 2.1.277's `cc_turn_origin`.
	const attribution = "x-anthropic-billing-header: cc_version=${{}}; cc_entrypoint=${{}};${{}}${{}}${{}}${{}}${{}}${{}}${{}}`";
	const fieldsSwapped = attribution.replace("cc_version", "cc_swap").replace("cc_entrypoint", "cc_version").replace("cc_swap", "cc_entrypoint");
	const oneSlotMore = `${attribution.slice(0, -1)}\${{}}\``;
	const oneSlotFewer = attribution.replace("${{}}`", "`");
	// Both indexes go through one bounds check, with 0 and 1 as the floors; the
	// check's own body is then read under the name this call gave it.
	const positionShape = (promptFloor, turnFloor) =>
		`{}={}?.promptIndex,{}={2}?.turnIndex,{}={}({1},${promptFloor})&&{5}({3},${turnFloor})&&{}==="firstParty"&&{}()?\` cc_prompt_index=\${{1}}; cc_turn_index=\${{3}};\``;
	const position = minified(positionShape(0, 1)).exec(strings);
	const boundsShape = (name, ceiling) =>
		`function ${name}({},{}){return typeof {1}==="number"&&Number.isInteger({1})&&{1}>={2}&&{1}<=${ceiling}}`;

	const oracles = [
		["the identity line is still what Claude Code sends", () => strings.includes(`"${CLAUDE_CODE_IDENTITY}"`)],
		["the billing salt is unchanged", () => salt !== null],
		["the version hash still samples chars 4, 7, 20", () => salt !== null && minified(hashShape("4,7,20", salt[1])).test(strings)],
		["the attribution line's field order is unchanged", () => minified(attribution).test(strings)],
		// A pattern that matches anything is the same hole as a pattern pinned to
		// a minified name: it stops reporting. Each shape must reject a near miss.
		[
			"the shapes discriminate — a near miss is rejected",
			() =>
				salt !== null &&
				!minified(hashShape("4,7,21", salt[1])).test(strings) &&
				!minified(hashShape("4,7,20", "notTheSalt")).test(strings) &&
				!minified(fieldsSwapped).test(strings) &&
				!minified(oneSlotMore).test(strings) &&
				!minified(oneSlotFewer).test(strings) &&
				!minified(positionShape(1, 0)).test(strings) &&
				(position === null || !minified(boundsShape(position[5], "1e6")).test(strings)) &&
				!minified("function {}(){return {}.getStore()?.payload}").test(strings),
		],
		["cc_is_subagent still means agentType subagent off the main session", () => strings.includes(' cc_is_subagent=true;"')],
		["the session-id header name is unchanged", () => strings.includes('"X-Claude-Code-Session-Id"')],
		[
			"the agent-id header names are unchanged",
			() => strings.includes('"x-claude-code-agent-id"') && strings.includes('"x-claude-code-parent-agent-id"'),
		],
		[
			"the user-agent is still claude-cli/<version> (external, <entrypoint>…)",
			() => strings.includes("`claude-cli/${") && minified('(external, ${{}.CLAUDE_CODE_ENTRYPOINT??"cli"}').test(strings),
		],
		["cc_workload still comes from the cron-only store", () => minified("function {}(){return {}.getStore()?.workload}").test(strings)],
		["cc_turn_origin still takes a lowercase word on a first-party turn", () => minified("` cc_turn_origin=${{}};`").test(strings)],
		[
			"cc_prompt_index/cc_turn_index still read promptIndex/turnIndex, floored at 0/1, on a first-party turn",
			() => position !== null,
		],
		["the turn indexes are still integers capped at 1e7", () => position !== null && minified(boundsShape(position[5], "1e7")).test(strings)],
	];

	const SOURCED = "oracle: the wire version is the installed Claude Code's";
	if (binary === undefined) {
		skip(`${SOURCED} (no binary installed)`);
		for (const [name] of oracles) skip(`oracle: ${name} (no binary installed)`);
	} else {
		// Not a pin: this fails only if the resolver in `lib/wire/claude-code.ts` stops
		// reading the installed version, which is this repo's bug, not Anthropic's.
		check(SOURCED, path.basename(binary) === CLAUDE_CODE_VERSION, `installed ${path.basename(binary)}, on the wire ${CLAUDE_CODE_VERSION}`);
		for (const [name, ok] of oracles) check(`oracle: ${name}`, ok());
	}
}

await finish();
