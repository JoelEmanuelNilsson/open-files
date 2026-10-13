/**
 * `$skill` mentions (extensions/skill-mentions/index.ts): the catalogue, finding
 * mentions in typed input, the suggestions, and the skill block's renderer.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
console.log("skill-mentions");
{
	const { suggest } = await jiti.import(`${KIT_ROOT}/extensions/skill-mentions/index.ts`);
	const { loadSkillCatalogue } = await jiti.import(`${KIT_ROOT}/extensions/skill-mentions/skill-catalogue.ts`);
	const { findSkillMentions } = await jiti.import(`${KIT_ROOT}/extensions/skill-mentions/skill-mention-parse.ts`);
	const { frameSkillBlock, SKILL_MESSAGE } = await jiti.import(`${KIT_ROOT}/extensions/skill-mentions/skill-message.ts`);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-skill-"));
	const skillFile = (name, body) => {
		const file = path.join(dir, `${name}.md`);
		fs.writeFileSync(file, `---\nname: ${name}\ndescription: does ${name}\n---\n\n${body}\n`);
		return file;
	};
	const tddPath = skillFile("tdd", "# TDD\n\nRed, green, refactor.");
	const commitPath = skillFile("commit", "# Commit\n\nWrite the message.");
	const command = (name, file, scope = "user") => ({
		name: `skill:${name}`,
		description: `does ${name}`,
		source: "skill",
		sourceInfo: { path: file, baseDir: dir, scope, source: "test", origin: "top-level" },
	});
	const commands = [
		{ name: "btw", description: "side chat", source: "extension", sourceInfo: { path: "/x", scope: "user" } },
		command("tdd", tddPath),
		command("commit", commitPath, "project"),
	];

	const skills = loadSkillCatalogue({ getCommands: () => commands });
	check("catalogue keeps skills only", skills.size === 2 && skills.has("tdd") && !skills.has("btw"));
	check("catalogue carries path and baseDir", skills.get("tdd").path === tddPath && skills.get("tdd").baseDir === dir);

	const known = new Set(skills.keys());
	check("mention mid-sentence", JSON.stringify(findSkillMentions("now please $tdd this module", known)) === '["tdd"]');
	check("mention on a later line", JSON.stringify(findSkillMentions("one\ntwo\n$commit", known)) === '["commit"]');
	check("two mentions keep order", JSON.stringify(findSkillMentions("$commit then $tdd", known)) === '["commit","tdd"]');
	check("repeat mention collapses", JSON.stringify(findSkillMentions("$tdd and $tdd", known)) === '["tdd"]');
	check("env vars never match", findSkillMentions("echo $PATH $HOME $1", known).length === 0);
	check("unknown names pass through", findSkillMentions("$nope", known).length === 0);
	check("backslash escapes", findSkillMentions("\\$tdd", known).length === 0);
	check("mid-token dollars are not mentions", findSkillMentions("price is 3$tdd", known).length === 0);

	const block = frameSkillBlock(skills.get("tdd"));
	check("block matches pi's own framing", block.startsWith(`<skill name="tdd" location="${tddPath}">`) && block.endsWith("</skill>"));
	check("block strips frontmatter", !block.includes("description: does tdd") && block.includes("Red, green, refactor."));
	check("block states the base dir", block.includes(`References are relative to ${dir}.`));

	const list = [...skills.values()];
	check("empty query lists all, sorted", suggest(list, "").map((i) => i.value).join(",") === "$commit,$tdd");
	check("query filters", suggest(list, "td")[0].value === "$tdd");
	check("non-user scope is labelled", suggest(list, "commit")[0].description.includes("[project]"));

	// Provider: `$` triggers anywhere, completion replaces the token and adds a space.
	const base = {
		triggerCharacters: ["@", "#"],
		getSuggestions: async () => ({ items: [{ value: "base", label: "base" }], prefix: "" }),
		applyCompletion: () => ({ lines: ["base"], cursorLine: 0, cursorCol: 4 }),
		shouldTriggerFileCompletion: () => true,
	};
	let provider;
	let skillRenderer;
	const api = {
		on: (event, handler) => handlers.set(event, handler),
		registerMessageRenderer: (_type, renderer) => { skillRenderer = renderer; },
		registerEntryRenderer: () => {},
		getCommands: () => commands,
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	const handlers = new Map();
	const sent = [];
	const notices = [];
	await (await jiti.import(`${KIT_ROOT}/extensions/skill-mentions/index.ts`, { default: true }))(api);

	const branch = [];
	const sctx = {
		cwd: dir,
		mode: "tui",
		sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
		ui: {
			notify: (message, level) => notices.push({ message, level }),
			addAutocompleteProvider: (factory) => { provider = factory(base); },
		},
	};
	await handlers.get("session_start")({}, sctx);

	check("provider adds $ to triggers", provider.triggerCharacters.includes("$") && provider.triggerCharacters.includes("@"));
	let s = await provider.getSuggestions(["write a test with $td"], 0, 21, { signal: new AbortController().signal });
	check("suggests mid-line", s.prefix === "$td" && s.items[0].value === "$tdd");
	s = await provider.getSuggestions(["$"], 0, 1, { signal: new AbortController().signal });
	check("a bare $ opens the list", s.items.length === 2);
	s = await provider.getSuggestions(["nothing here"], 0, 12, { signal: new AbortController().signal });
	check("delegates when no $ token", s.items[0].value === "base");
	const applied = provider.applyCompletion(["write a test with $td"], 0, 21, { value: "$tdd", label: "$tdd" }, "$td");
	check("completion replaces the token", applied.lines[0] === "write a test with $tdd " && applied.cursorCol === 23, applied.lines[0]);

	const input = handlers.get("input");
	await input({ text: "$commit and $tdd please", source: "interactive" }, sctx);
	check("one message per mention", sent.length === 2 && sent.every((s) => s.message.customType === SKILL_MESSAGE));
	check("idle delivery joins this turn", sent.every((s) => s.options.deliverAs === "nextTurn"));
	check("message carries the skill block", sent[0].message.content.includes("<skill name=\"commit\""));
	check("details carry the path", sent[1].message.details.path === tddPath);

	await input({ text: "$tdd again", source: "interactive" }, sctx);
	check("a loaded skill is not re-sent", sent.length === 2);
	check("and says so", notices.at(-1).message.includes("already loaded"));

	await handlers.get("session_compact")({}, sctx);
	await input({ text: "$tdd", source: "interactive" }, sctx);
	check("compaction makes it loadable again", sent.length === 3);

	await input({ text: "$tdd", source: "extension" }, sctx);
	check("extension messages are left alone", sent.length === 3);
	await input({ text: "/skill:tdd with $commit", source: "interactive" }, sctx);
	check("slash commands are left alone", sent.length === 3);

	await input({ text: "$commit", source: "interactive", streamingBehavior: "steer" }, sctx);
	check("steering keeps the delivery mode", sent.at(-1).options.deliverAs === "steer");

	// A resumed session rebuilds what the branch already carries.
	const resumed = [
		{ type: "custom_message", customType: SKILL_MESSAGE, details: { path: tddPath } },
		{ type: "compaction" },
		{ type: "custom_message", customType: SKILL_MESSAGE, details: { path: commitPath } },
	];
	const rctx = { ...sctx, sessionManager: { getSessionId: () => "s2", getBranch: () => resumed } };
	await handlers.get("session_start")({}, rctx);
	const before = sent.length;
	await input({ text: "$commit and $tdd", source: "interactive" }, rctx);
	check("replay skips what survived compaction", sent.length === before + 1 && sent.at(-1).message.details.name === "tdd");

	// The row a loaded skill leaves behind. pi's own component is a padded Box
	// under a Spacer: three blank lines above one line of text and two below.
	// This is the receipt every tool call already wears — one line, no padding.
	const skillTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, dim: (t) => t };
	const skillMessage = { customType: SKILL_MESSAGE, content: frameSkillBlock(skills.get("tdd")) };
	const rowOf = (expanded) => skillRenderer(skillMessage, { expanded, outputPad: 1 }, skillTheme).render(60);
	check("a loaded skill is one row", rowOf(false).length === 1, JSON.stringify(rowOf(false)));
	check("in the transcript's grammar", rowOf(false)[0] === "● Skill(tdd)", JSON.stringify(rowOf(false)[0]));
	const opened = rowOf(true);
	check(
		"and ctrl+o puts its text under the gutter",
		opened.length > 2 && opened[1].startsWith("  ⎿  ") && opened.slice(2).every((l) => l.startsWith("     ")),
		JSON.stringify(opened),
	);
	check("a message that is not a skill block draws nothing", skillRenderer({ customType: SKILL_MESSAGE, content: "plain text" }, { expanded: false }, skillTheme) === undefined);
}

await finish();
