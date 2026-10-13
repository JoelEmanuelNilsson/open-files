/**
 * The owned system prompt (lib/wire/owned-prompt.ts) against the installed pi's
 * own sections, and the /context parser that reads it back.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti, PI_ROOT } from "../support/pi-package.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { APPEND, ownedPromptOptions } from "../support/owned-prompt-options.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
console.log("owned-prompt");
{
	const { buildOwnedSystemPrompt, validatePromptOptions, KNOWN_OPTION_KEYS, SCAN_GUIDELINE, BASH_FILE_OPS_GUIDELINE, OWNED_IDENTITY } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const { formatOwnedSkills, SKILLS_OPEN } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-skills-catalogue.ts`);
	const { CLAUDE_CODE_TOOL_NAMES, claudeCodeToolName } = await jiti.import(`${KIT_ROOT}/lib/wire/claude-code.ts`);
	// buildSystemPrompt is not re-exported from pi's index; reach into dist.
	const piDist = path.join(PI_ROOT, "dist");
	const pi = await import(path.join(piDist, "core/system-prompt.js"));
	const piSkills = await import(path.join(piDist, "core/skills.js"));
	const measure = await jiti.import(`${KIT_ROOT}/extensions/context-view/system-prompt-measure.ts`);
	const { dir, agentsPath, linkPath, options } = ownedPromptOptions();

	// The drift guard reborn: the owned builder must equal the installed pi's,
	// section content by section content, under exactly the deviations named in
	// `lib/wire/owned-prompt.ts`'s header and marked below. pi 0.86 assembles its prompt as tagged, separately replaceable
	// sections, so that is where the comparison is made — against pi's own bytes
	// rather than a copy of ours, so a silent divergence cannot be absorbed by
	// updating a fixture.
	const ours = buildOwnedSystemPrompt(options);
	const sections = pi.buildSystemPromptSections(options);
	const contentOf = (name) => (name === "preamble" ? sections[name] : sections[name].slice(name.length + 3, -(name.length + 4)));
	check(
		"pi still builds the sections the owned builder maps, in this order",
		Object.keys(sections).join(",") === "preamble,tools,rules,docs,addendum,project_context,skills,cwd,handoff",
		Object.keys(sections).join(","),
	);
	check(
		"and wraps every section but the preamble in a tag of its own name",
		Object.entries(sections).every(([name, text]) => name === "preamble" || text === `<${name}>\n${contentOf(name)}\n</${name}>`),
	);
	check("pi still emits its docs block, which ours drops entirely", contentOf("docs").startsWith("Pi documentation ("), contentOf("docs").slice(0, 80));
	// The list *and* the sentence that only makes sense standing under it.
	check(
		"pi still lists its tools with the sentence under them, which ours drops",
		contentOf("tools").includes("- read: Read file contents") && contentOf("tools").includes("In addition to the tools above"),
		contentOf("tools"),
	);
	const PI_BASH_GUIDELINE = "- Use bash for file operations like ls, rg, find";
	// Named deviation — the identity paragraph (issues/34): pi's stock one is
	// replaced by the user's own. Pinned as a byte-exact replace of pi's text,
	// so if pi rewrites its opening this fails and gets mapped deliberately.
	const PI_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
	check("pi still opens with its stock identity paragraph", contentOf("preamble") === PI_IDENTITY, contentOf("preamble"));
	// Named deviation — the conciseness bullet: pi's standing one is dropped,
	// verbosity lives in APPEND_SYSTEM.md's COMMUNICATION block, one home per fact.
	const PI_CONCISE_GUIDELINE = "\n- Be concise in your responses";
	check("pi still emits its standing conciseness bullet", contentOf("rules").includes(PI_CONCISE_GUIDELINE));
	// Tool guidelines arrive keyed by tool since pi 0.86; both builders fold them
	// into the same list, so a tool's rules reaching the wire is pinned here.
	check("pi still folds a tool's own guidelines into its rules", contentOf("rules").includes("\n- Read a file before editing it"), contentOf("rules"));
	// Named deviation — the skills catalogue: pi's XML block becomes the owned
	// lean list — root stated once, one `name: description` line per skill.
	const vendorSkillsBlock = piSkills.formatSkillsForPrompt(options.skills);
	check("pi still formats skills as XML", vendorSkillsBlock.includes("<available_skills>") && contentOf("skills") === vendorSkillsBlock.trim());
	check("pi still keeps a muted skill out of its own catalogue", !vendorSkillsBlock.includes("herdr"));
	check("the owned catalogue keeps a muted skill out too", !formatOwnedSkills(options.skills).includes("herdr"), formatOwnedSkills(options.skills));
	check("a catalogue of nothing but muted skills is no catalogue", formatOwnedSkills(options.skills.filter((s) => s.disableModelInvocation)) === "");
	// Which seats get a catalogue at all. pi picks the tool that will open the
	// SKILL.md out of `["read", "bash"]` and names it in its own text; this
	// builder names no tool, so it only has to agree on the set. The bash-only
	// seat is the case that distinguishes the two rules, and the one the drift
	// guard's fixture cannot reach -- it always carries `read`.
	const catalogued = (selectedTools) => buildOwnedSystemPrompt({ ...options, selectedTools }).includes(SKILLS_OPEN);
	const piCatalogued = (selectedTools) => pi.buildSystemPromptSections({ ...options, selectedTools }).skills !== undefined;
	for (const seat of [["read", "bash"], ["read"], ["bash"], ["edit", "write"], []]) {
		check(`the catalogue reaches [${seat}] exactly when pi's does`, catalogued(seat) === piCatalogued(seat), `ours ${catalogued(seat)}, pi ${piCatalogued(seat)}`);
	}
	check("a bash-only seat is told its skills exist", catalogued(["bash"]));
	check("and a seat that can open no file is not", !catalogued(["edit", "write"]));
	const PI_FILE_PATHS_GUIDELINE = "- Show file paths clearly when working with files";
	check("pi still emits the file-paths bullet ours follows", contentOf("rules").includes(PI_FILE_PATHS_GUIDELINE));
	// Named deviation — the cwd: it is not in the body at all. It is the
	// one line that differs between two otherwise identical seats, so the wire
	// sends it as its own block after the cache breakpoint.
	check("pi still carries the cwd as a section of the body, which ours drops", contentOf("cwd") === dir.replace(/\\/g, "/"), contentOf("cwd"));
	// An extension's own section is nobody's to rewrite: it is emitted in pi's
	// framing, after everything this builder assembles.
	check("pi carries an extension's section verbatim, last", contentOf("handoff") === options.sections.handoff);
	const expected =
		OWNED_IDENTITY +
		`\n\nGuidelines:\n${contentOf("rules").replace(PI_BASH_GUIDELINE, `- ${BASH_FILE_OPS_GUIDELINE}\n- ${SCAN_GUIDELINE}`).replace(PI_CONCISE_GUIDELINE, "").replace(`\n${PI_FILE_PATHS_GUIDELINE}`, "")}` +
		`\n\n${contentOf("addendum")}` +
		`\n\n<project_context>\n\n${contentOf("project_context")}\n\n</project_context>\n` +
		formatOwnedSkills(options.skills) +
		`\n\n${sections.handoff}`;
	check("owned prompt is pi's sections, minus the docs block, the tools list, the conciseness bullet and the cwd, with the owned file-ops bullet, the scan guideline, the owned identity and the owned skills catalogue", ours === expected, ours.slice(0, 400));
	check("owned prompt never mentions pi docs", !ours.includes("Pi documentation"));
	check("owned prompt carries no tools list", !ours.includes("Available tools:") && !ours.includes("In addition to the tools above"));
	check("owned prompt keeps the identity line and the guidelines", ours.startsWith(OWNED_IDENTITY) && ours.includes("\n\nGuidelines:\n- "));

	// The broad-scan rule (issues/29) reaches every seat, wherever the seat's
	// tool set puts the rest of the list, and reaches it once.
	const guidelinesOf = (prompt) => {
		const start = prompt.indexOf("\n\nGuidelines:");
		const end = prompt.indexOf("\n\n", start + 2);
		return end === -1 ? prompt.slice(start) : prompt.slice(start, end);
	};
	const bashSeat = buildOwnedSystemPrompt({ cwd: dir, selectedTools: ["read", "bash", "edit", "write"] });
	const exploreSeat = buildOwnedSystemPrompt({ cwd: dir, selectedTools: ["read", "grep", "find", "ls"] });
	check("a bash seat is told where a scan may start", guidelinesOf(bashSeat).includes(`\n- ${SCAN_GUIDELINE}`), guidelinesOf(bashSeat));
	check("so is an Explore-shaped seat, which has the scan tools", guidelinesOf(exploreSeat).includes(`\n- ${SCAN_GUIDELINE}`), guidelinesOf(exploreSeat));
	check(
		"and exactly once, even when a tool declares the same line",
		bashSeat.split(SCAN_GUIDELINE).length === 2 &&
			buildOwnedSystemPrompt({ cwd: dir, selectedTools: ["read", "bash"], promptGuidelines: [SCAN_GUIDELINE] }).split(SCAN_GUIDELINE).length === 2,
	);

	// customPrompt branch carries pi's own sections — the caller's prompt, the
	// addendum, the context files, the skills and any extension section — once
	// the two named deviations are taken out: the skills catalogue, and the
	// Guidelines section pi skips on this branch (issues/50 §4).
	const customOptions = { ...options, customPrompt: "You are a subagent." };
	const custom = buildOwnedSystemPrompt(customOptions);
	const customSections = pi.buildSystemPromptSections(customOptions);
	const customContentOf = (name) => customSections[name].slice(name.length + 3, -(name.length + 4));
	check(
		"pi builds no tools, rules or docs section on the customPrompt branch",
		Object.keys(customSections).join(",") === "preamble,addendum,project_context,skills,cwd,handoff",
		Object.keys(customSections).join(","),
	);
	check(
		"customPrompt branch matches pi exactly, skills catalogue and guidelines aside",
		custom.replace(guidelinesOf(custom), "") ===
			customSections.preamble +
				`\n\n${customContentOf("addendum")}` +
				`\n\n<project_context>\n\n${customContentOf("project_context")}\n\n</project_context>\n` +
				formatOwnedSkills(options.skills) +
				`\n\n${customSections.handoff}`,
		custom.replace(guidelinesOf(custom), ""),
	);
	// pi returns a forced prompt as the whole prompt and assembles nothing, and it
	// decides that on presence, not on truth. The empty prompt is the case the two
	// tests differ on, so it is the one pinned.
	check(
		"a forced prompt is the whole prompt, assembled with nothing",
		buildOwnedSystemPrompt({ ...options, forceSystemPrompt: "You are something else entirely." }) === "You are something else entirely.",
	);
	check(
		"and a forced empty prompt is empty, not the owned one",
		buildOwnedSystemPrompt({ ...options, forceSystemPrompt: "" }) === "",
		buildOwnedSystemPrompt({ ...options, forceSystemPrompt: "" }).slice(0, 80),
	);
	check(
		"a seat running an agent definition's own body is told the tool's rules",
		guidelinesOf(custom).includes("\n- Trust but verify subagent results") && guidelinesOf(custom).includes(`\n- ${SCAN_GUIDELINE}`),
		guidelinesOf(custom),
	);

	// The Guidelines name tools the way the request will. pi-ai renames a tool to
	// Claude Code's casing on an Anthropic OAuth request, so prose that says
	// `read` would point at a tool the model was never offered.
	const piAiDist = path.dirname(jiti.esmResolve("@earendil-works/pi-ai").replace("file://", ""));
	const anthropicSource = fs.readFileSync(path.join(piAiDist, "api/anthropic-messages.js"), "utf8");
	const table = anthropicSource.slice(anthropicSource.indexOf("const claudeCodeTools = ["));
	const renameTable = [...table.slice(0, table.indexOf("];")).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
	check("CLAUDE_CODE_TOOL_NAMES is pi-ai's rename table", renameTable.join(",") === CLAUDE_CODE_TOOL_NAMES.join(","), renameTable.join(","));
	check(
		"pi-ai still applies it to tool definitions exactly on an OAuth request",
		anthropicSource.includes("name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name"),
	);

	// The live guideline strings: pi's own for read/write/bash, the kit's for edit.
	const { api: editApi, tools: editTools } = fakeExtensionApi();
	await (await jiti.import(`${KIT_ROOT}/extensions/multi-edit/index.ts`, { default: true }))(editApi);
	const liveGuidelines = [
		...(await import(path.join(piDist, "core/tools/read.js"))).readToolSystemPromptContribution.guidelines,
		...(await import(path.join(piDist, "core/tools/write.js"))).writeToolSystemPromptContribution.guidelines,
		...(await import(path.join(piDist, "core/tools/bash.js"))).bashToolSystemPromptContribution.guidelines,
		...editTools.get("edit").promptGuidelines,
	];
	const seatTools = ["read", "bash", "edit", "write"];
	const withGuidelines = { ...options, customPrompt: undefined, selectedTools: seatTools, promptGuidelines: liveGuidelines };
	const oauthGuidelines = guidelinesOf(buildOwnedSystemPrompt(withGuidelines, claudeCodeToolName));
	const misnamed = [...oauthGuidelines.matchAll(/[A-Za-z]+/g)]
		.map((match) => match[0])
		.filter((word) => seatTools.includes(word.toLowerCase()) && word !== claudeCodeToolName(word));
	check("every tool the Guidelines name is spelled the way the wire spells it", misnamed.length === 0, `${misnamed.join(", ")}\n${oauthGuidelines}`);
	check(
		"and a request with no rename keeps the seat's own names",
		guidelinesOf(buildOwnedSystemPrompt(withGuidelines)).includes("- Use read to examine files"),
		guidelinesOf(buildOwnedSystemPrompt(withGuidelines)),
	);

	// The options schema is pinned against the installed pi package: a new
	// field pi adds would be silently dropped from the wire, so it must show
	// up here first.
	const dts = fs.readFileSync(path.join(piDist, "core/system-prompt.d.ts"), "utf8");
	const ifaceStart = dts.indexOf("interface BuildSystemPromptOptions");
	const iface = dts.slice(ifaceStart, dts.indexOf("\n}", ifaceStart));
	const declaredKeys = [...iface.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]);
	check(
		"KNOWN_OPTION_KEYS matches pi's BuildSystemPromptOptions",
		declaredKeys.length === KNOWN_OPTION_KEYS.length && declaredKeys.every((k) => KNOWN_OPTION_KEYS.includes(k)),
		`pi declares: ${declaredKeys.join(", ")}`,
	);
	check("clean options validate clean", validatePromptOptions(options).length === 0);
	check("an unmapped field is called out", validatePromptOptions({ ...options, newThing: 1 }).some((p) => p.includes("newThing")));

	// pi dedupes context files by path string, so a symlink is loaded twice.
	const doubledOptions = {
		cwd: dir,
		contextFiles: [
			{ path: linkPath, content: "Solve the system, not the result." },
			{ path: agentsPath, content: "Solve the system, not the result." },
		],
	};
	const doubled = buildOwnedSystemPrompt(doubledOptions);
	check("content dedupe keeps one copy", doubled.split("Solve the system, not the result.").length === 2);
	check("content dedupe keeps the first path", doubled.includes(`path="${linkPath}"`) && !doubled.includes(`path="${agentsPath}"`));

	// The purity invariant (issues/25): the builder makes no syscall, so the
	// same options yield the same bytes no matter what disk does between
	// builds. Each state below changed the realpath-keyed build (issues/21).
	fs.rmSync(agentsPath); // 1: symlink target deleted — linkPath dangles
	const afterDangling = buildOwnedSystemPrompt(doubledOptions);
	fs.rmSync(linkPath); // 2: both paths gone
	const afterGone = buildOwnedSystemPrompt(doubledOptions);
	fs.writeFileSync(path.join(dir, "moved-AGENTS.md"), "Solve the system, not the result."); // 3: target moved
	const afterMoved = buildOwnedSystemPrompt(doubledOptions);
	fs.writeFileSync(linkPath, "Solve the system, not the result."); // 4: symlink replaced by a real copy
	const afterCopy = buildOwnedSystemPrompt(doubledOptions);
	check(
		"the prompt is a pure function of its options (disk mutated four ways)",
		afterDangling === doubled && afterGone === doubled && afterMoved === doubled && afterCopy === doubled,
	);
	// Restore the fixture for the rest of the block.
	fs.rmSync(linkPath);
	fs.rmSync(path.join(dir, "moved-AGENTS.md"));
	fs.writeFileSync(agentsPath, "Solve the system, not the result.");
	fs.symlinkSync(agentsPath, linkPath);

	// The dedupe keys on bytes, not names: distinct content never collapses.
	const distinct = buildOwnedSystemPrompt({
		cwd: dir,
		contextFiles: [
			{ path: path.join(dir, "one.md"), content: "one policy" },
			{ path: path.join(dir, "two.md"), content: "another policy" },
		],
	});
	check("different content from different paths both emit", distinct.includes("one policy") && distinct.includes("another policy"));

	// The whole point of matching pi's framing: /context still parses it.
	const items = measure.analyzeSystemPrompt(ours, {
		cwd: dir,
		appendSystemPrompt: APPEND,
		contextFilePaths: [agentsPath],
		skills: [{ name: "tdd", description: "Red-green-refactor", filePath: path.join(dir, "tdd/SKILL.md") }],
	});
	const contextItem = items.find((item) => item.id === `context-file:${agentsPath}`);
	check("measure.ts still finds the context file", contextItem?.text === "Solve the system, not the result.", JSON.stringify(contextItem?.text));
	check("measure.ts labels the appended prompt", items.some((item) => item.kind === "append-prompt"));
	check("measure.ts finds the skills block", items.some((item) => item.kind === "skills"));

	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Token efficiency in the owned system prompt — ticket 29 §6
// ---------------------------------------------------------------------------
{
	console.log("\nthe token-efficiency line (owned system prompt)");
	const { buildOwnedSystemPrompt, OWNED_IDENTITY } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const prompt = buildOwnedSystemPrompt({ selectedTools: ["read", "bash", "edit", "write"], cwd: "/tmp" });
	check("every seat's system prompt carries it in the identity line", prompt.startsWith(OWNED_IDENTITY) && OWNED_IDENTITY.includes("Everything you read stays in context for the whole session and dilutes later turns"), prompt.slice(0, 400));
}

// ---------------------------------------------------------------------------
// The skills catalogue — one capped line per skill, ours and anyone else's
// ---------------------------------------------------------------------------
{
	console.log("\nthe skills catalogue");
	const { formatOwnedSkills, SKILL_DESCRIPTION_CAP } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-skills-catalogue.ts`);
	const long = `x${"y ".repeat(300)}`;
	const catalogue = formatOwnedSkills([
		{ name: "commit", description: "Read this skill before making git commits", filePath: `${KIT_ROOT}/skills/commit/SKILL.md` },
		{ name: "vendor", description: long, filePath: "/elsewhere/vendor/SKILL.md" },
		{ name: "folded", description: "First line.\n\nSecond paragraph a vendor wrote to its own budget.", filePath: `${KIT_ROOT}/skills/folded/SKILL.md` },
		{ name: "plannotator", description: long, filePath: "/elsewhere/plannotator/SKILL.md" },
	]);
	const entries = catalogue.split("\n").filter((line) => /^[a-z-]+[ :(]/.test(line));
	check("one line per skill", entries.length === 4, entries.join(" | "));
	check(`no entry is longer than the name plus ${SKILL_DESCRIPTION_CAP} chars`, entries.every((line) => line.length <= line.split(":")[0].length + SKILL_DESCRIPTION_CAP + 4), entries.map((line) => line.length).join());
	check("a third-party description is truncated with an ellipsis", entries[1].endsWith("\u2026"));
	check("a multi-line description is squeezed onto one line", catalogue.includes("folded: First line. Second paragraph a vendor wrote to its own budget."));
	check("a short description is untouched", catalogue.includes("commit: Read this skill before making git commits"));
	check("a foreign skill we have words for uses ours, not the package's", catalogue.includes("plannotator (/elsewhere/plannotator/SKILL.md): Plannotator CLI:") && !catalogue.includes("plannotator/SKILL.md): x"));
}

// ---------------------------------------------------------------------------
// The prompt used to restate the tool set as a bulleted list, and the cut had
// to be applied to it so it could not advertise a dropped tool. As of
// issues/31 there is no list to keep honest: `payload.tools` carries name,
// description and schema structurally, so the restatement was deleted rather
// than filtered. What survives is the part the payload does *not* carry — the
// cross-tool guidelines — and those still key off the standing set.
console.log("\nowned-prompt: no tools list to keep honest, and guidelines that still are");
{
	const { buildOwnedSystemPrompt, SCAN_GUIDELINE, BASH_FILE_OPS_GUIDELINE } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-owned-prompt-"));
	const snippets = {
		read: "Read file contents",
		bash: "Execute bash commands",
		edit: "Edit files",
		grep: "Search file contents for patterns",
		find: "Find files by glob pattern",
		ls: "List directory contents",
	};
	const promptFor = (selectedTools) => buildOwnedSystemPrompt({ cwd: dir, selectedTools, toolSnippets: snippets });
	const seats = {
		bash: promptFor(["read", "bash", "edit", "grep", "find", "ls"]),
		bashOnly: promptFor(["read", "bash", "edit", "write"]),
		readOnly: promptFor(["read", "grep", "find", "ls"]),
		defaulted: buildOwnedSystemPrompt({ cwd: dir, toolSnippets: snippets }),
	};

	for (const [seat, prompt] of Object.entries(seats)) {
		check(`the ${seat} seat gets no Available tools list`, !prompt.includes("Available tools:"), prompt.slice(0, 200));
		check(`nor the sentence that dangled under it (${seat})`, !prompt.includes("In addition to the tools above"));
		// A snippet is only ever rendered into that list, so none may survive.
		check(`no tool snippet reaches the ${seat} seat's prompt`, !Object.values(snippets).some((snippet) => prompt.includes(snippet)));
		check(`the ${seat} seat still gets the broad-scan rule, once`, prompt.split(SCAN_GUIDELINE).length === 2, prompt);
	}

	check("a bash seat is told which tool owns which kind of search", seats.bash.includes(`- ${BASH_FILE_OPS_GUIDELINE}`));
	check("and so is a seat that never asked for the built-ins", seats.bashOnly.includes(`- ${BASH_FILE_OPS_GUIDELINE}`));
	check("the map names every owner and the one ban", ["rg", "fd", "ast-grep", "jq", "grep -r"].every((word) => BASH_FILE_OPS_GUIDELINE.includes(word)));
	check("a seat with no shell is not told to use a bash it does not have", !seats.readOnly.includes("Use bash for file operations"));
	check("the guideline order is fixed: file ops, then the scan rule", seats.bash.includes(`Guidelines:\n- ${BASH_FILE_OPS_GUIDELINE}\n- ${SCAN_GUIDELINE}`), seats.bash);

	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A tool's own guidelines still reach the prompt: pi collects `promptGuidelines`
// off every registered definition, and the builder adds each one once, in a
// fixed slot. No rewrite table stands between them any more — every agent
// guideline is written where the Agent tool is registered.
console.log("\nowned-prompt: a tool's own guidelines, unrewritten");
{
	const { buildOwnedSystemPrompt, AGENT_GUIDELINE_REWRITES } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	check("no vendor guideline rewrite table survives", AGENT_GUIDELINE_REWRITES === undefined);
	const prompt = buildOwnedSystemPrompt({ cwd: os.tmpdir(), selectedTools: ["read", "bash"], promptGuidelines: ["Delegate wide work to Agent", "Delegate wide work to Agent"] });
	check("a tool's guideline reaches the prompt verbatim", prompt.includes("- Delegate wide work to Agent"));
	check("and exactly once, however many tools declare it", prompt.split("- Delegate wide work to Agent").length === 2, prompt);
}

// ---------------------------------------------------------------------------
// pi's builder drops a hidden tool from the declared set before it writes the
// tool list and the rules (dist/core/system-prompt.js: `declaredTools`). The owned
// prompt has no list, so the hidden tool must be absent from its guidelines.
console.log("\nowned-prompt: hiddenTools");
{
	const { buildOwnedSystemPrompt, BASH_FILE_OPS_GUIDELINE } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const toolGuidelines = { bash: ["Bash-only rule"], read: ["Read rule"] };
	const build = (hiddenTools) => buildOwnedSystemPrompt({ cwd: os.tmpdir(), selectedTools: ["read", "bash"], hiddenTools, toolGuidelines });
	const visible = build([]);
	const hidden = build(["bash"]);
	check("a tool in hiddenTools is absent from the owned prompt's tool list", visible.includes(BASH_FILE_OPS_GUIDELINE) && !hidden.includes(BASH_FILE_OPS_GUIDELINE) && !hidden.includes("Bash-only rule"), hidden);
	check("a tool not in hiddenTools keeps its guidelines", hidden.includes("Read rule"));
}

// ---------------------------------------------------------------------------
// A `context: none` seat: the loader hands the builder no context files, no
// skills and no append text (extensions/agent-engine/index.ts childLoader).
console.log("\nowned-prompt: a context: none seat");
{
	const { buildOwnedSystemPrompt } = await jiti.import(`${KIT_ROOT}/lib/wire/owned-prompt.ts`);
	const { parseAgentTypeFile } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-type-files.ts`);
	const type = parseAgentTypeFile("---\nname: x\ncontext: none\ntools: read, bash\n---\nYou gather facts.\n", "memory");
	const prompt = buildOwnedSystemPrompt({ customPrompt: type.prompt, selectedTools: ["read", "bash"], cwd: os.tmpdir(), contextFiles: [], skills: [], appendSystemPrompt: undefined });
	check("the type parses as context: none", type.context === "none");
	check("it gets no project_context and no skills catalogue", !prompt.includes("<project_context>") && !prompt.includes("Skills") && !prompt.includes("SKILL.md"), prompt);
	check("it is the body and the guidelines", prompt.startsWith("You gather facts.\n\nGuidelines:"));
}

await finish();
