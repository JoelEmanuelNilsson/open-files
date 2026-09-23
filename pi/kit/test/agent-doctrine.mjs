/**
 * The words the models act on (ticket 21), pinned where the engine reads them.
 *
 * Ticket 12 ruled the literal text: the six-rung ladder, the policy lines that
 * ride in the prompt, the main-seat role line. Ticket 14 ruled the playbook
 * table. Ticket 29 ruled the `edit`/`write` rule, the two thinking levels, and
 * the three report shapes. Map C21 ruled what a type file may set. None of this
 * is code — a later edit that drops a rung or softens a rule
 * would pass every other test — so this file reads the same files the seats
 * read and fails on any change to those sentences.
 *
 *   node test/agent-doctrine.mjs
 */

import "./env.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PI = `${execSync("npm root -g", { encoding: "utf8" }).trim()}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "../..");
const read = (file) => fs.readFileSync(file, "utf8");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

// ---------------------------------------------------------------------------
// The ladder and the policy lines — now in the `Agent` tool description
// ---------------------------------------------------------------------------
{
	console.log("\nthe ladder and policy (Agent tool description)");
	const { loadAgentTypes } = await jiti.import(`${ROOT}/lib/agent-types.ts`);
	const { agentToolDescription } = await jiti.import(`${ROOT}/lib/agent-tool-text.ts`);
	const { types } = loadAgentTypes(path.join(REPO, "pi/agents"));
	const description = agentToolDescription(types, true);

	const RUNGS = [
		"a few edits or one lookup \u2014 do it yourself",
		"one job with every follow-up step written into its brief \u2014 one worker",
		"an answer you need before you can continue \u2014 one worker, then `TaskOutput`",
		"several independent jobs \u2014 start them in one message",
		"the same job on many things \u2014 a `Workflow`",
		"several dependent steps while you're away \u2014 a lead",
	];
	const positions = RUNGS.map((rung) => description.indexOf(rung));
	for (const [i, rung] of RUNGS.entries()) check(`ladder: ${rung.slice(0, 40)}\u2026 verbatim`, positions[i] >= 0, rung);
	check("the six rungs are in order, first fit first", positions.every((at, i) => at >= 0 && (i === 0 || at > positions[i - 1])));
	check("the ladder is introduced as a ladder taken first-fit", description.includes("Take the first rung that fits:"));

	const POLICY = [
		"don't peek at a running agent's transcript",
		"Never fabricate or predict a pending agent's results",
		"Once you've delegated, don't also do it yourself",
		"The agent's final report is not shown to the user \u2014 relay what matters",
		"To continue a finished agent's job, `SendMessage` it: it keeps its context; a new `Agent` starts fresh",
	];
	for (const line of POLICY) check(`policy: ${line.slice(0, 40)}\u2026 verbatim`, description.includes(line), line);

	// The whole point of the move: the tool text got smaller, not larger.
	check(`the description stays under 3,200 chars (${description.length})`, description.length < 3200, String(description.length));

	// A seat launched without workflows is never told the rung: naming a tool it
	// has not got costs a turn to find out.
	const without = agentToolDescription(types, false);
	check("without workflows the description names no Workflow at all", !/workflow/i.test(without), (without.match(/.{0,40}[Ww]orkflow.{0,40}/) ?? [""])[0]);
	check("and the other five rungs survive, in order", RUNGS.filter((rung) => !rung.includes("Workflow")).every((rung, i, kept) => without.indexOf(rung) > (i === 0 ? -1 : without.indexOf(kept[i - 1]))));
	check("the two shapes differ by that rung alone", description.replace("the same job on many things \u2014 a `Workflow`; ", "") === without);
}

// ---------------------------------------------------------------------------
// The edit/write rule is gone: `edit` and `write` stand on worker seats that
// carry no `Agent`, so they say nothing about delegating. The rule's substance
// is the delegation line on `Agent`, once.
// ---------------------------------------------------------------------------
{
	console.log("\nno edit/write rule");
	const t = await jiti.import(`${ROOT}/lib/agent-tool-text.ts`);
	const { loadAgentTypes } = await jiti.import(`${ROOT}/lib/agent-types.ts`);
	const description = t.agentToolDescription(loadAgentTypes(path.join(REPO, "pi/agents")).types, true);
	check("agent-tool-text exports no edit/write rule", t.EDIT_WRITE_RULE === undefined && t.withEditWriteRule === undefined);
	check("the delegation line is on Agent, once", description.split(t.DELEGATION_LINE).length === 2);

	const tools = new Map();
	const api = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		registerShortcut: () => {},
		appendEntry: () => {},
		on: () => {},
		getThinkingLevel: () => "off",
		sendUserMessage: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	await (await jiti.import(`${ROOT}/extensions/multi-edit.ts`, { default: true }))(api);
	const edit = tools.get("edit");
	check("the kit's `edit` tool names no agent, worker or delegation", edit !== undefined && edit.description.startsWith("Edit files by exact text replacement.") && !/\bAgent\b|worker|delegat/i.test(edit.description));
}

// ---------------------------------------------------------------------------
// The type files — ~/.pi/agent/agents/*.md (C21): model, thinking, rule, body
// ---------------------------------------------------------------------------
{
	console.log("\nthe built-in types (pi/agents)");
	const { loadAgentTypes, parseAgentTypeFile } = await jiti.import(`${ROOT}/lib/agent-types.ts`);
	const dir = path.join(REPO, "pi/agents");
	const files = fs.readdirSync(dir).sort();
	check("exactly the four built-ins, lower-case, and nothing from the vendor era", files.join() === "advisor.md,explore.md,lead.md,worker.md", files.join());
	const { types, problems } = loadAgentTypes(dir);
	check("every file parses", problems.length === 0, JSON.stringify(problems));
	const byName = new Map(types.map((type) => [type.name, type]));
	const explore = byName.get("explore");
	const lead = byName.get("lead");
	const worker = byName.get("worker");
	const advisor = byName.get("advisor");
	check("explore: Luna, high, with a body", explore?.model === "luna" && explore.thinking === "high" && explore.prompt.length > 0);
	check("lead: Opus, high, with a body — judging between steps is the whole job", lead?.model === "opus" && lead.thinking === "high" && lead.prompt.length > 0);
	check("advisor: Opus, max, with a body — Claude Code's advisor as a fresh seat, and the only type whose default is max", advisor?.model === "opus" && advisor.thinking === "max" && advisor.prompt.length > 0);
	check("only the advisor defaults to max", types.every((type) => type.thinking !== "max" || type.name === "advisor"));
	check("the advisor's rule says max reasoning is for the hardest questions", /max reasoning/.test(advisor.description) && /hardest/.test(advisor.description));
	const maxOnLuna = parseAgentTypeFile("---\nname: x\nmodel: luna\nthinking: max\n---\nbody\n", "memory");
	check("max parses on any model; the spawn clamps to what the model has", maxOnLuna?.thinking === "max", JSON.stringify(maxOnLuna));
	// Ticket 29 §5 is later than C10 and wins: the worker's report shape has to
	// live somewhere the worker reads, so the worker has a body.
	check("worker: Opus high, the default coding seat, with a body", worker?.model === "opus" && worker.thinking === "high" && worker.prompt.length > 0);
	check("no type asks for a thinking level that does not exist", types.every((type) => type.thinking === undefined || ["low", "medium", "high", "xhigh", "max"].includes(type.thinking)));
	const rejected = parseAgentTypeFile("---\nname: x\nthinking: minimal\n---\nbody\n", "memory");
	check("a type file asking for another level is a visible problem, not a silent undefined", rejected?.reason?.includes('only "low", "medium", "high", "xhigh", "max" exist') === true, JSON.stringify(rejected));
	for (const type of types) check(`${type.name}: a routing rule the orchestrator can pick by`, type.description.length > 40 && !/^(You are|I am)/.test(type.description));
	for (const file of files) {
		const text = read(path.join(dir, file));
		check(`${file} sets no tools list (C4/C21)`, !/^(tools|disallowed_tools|allowed_subagents|extensions|skills|prompt_mode):/m.test(text));
	}
	check("explore's body carries the search map and the scan rule the custom-prompt build omits", explore.prompt.includes("`rg` for text, `fd` for filenames") && explore.prompt.includes("never `/` or `$HOME`"));
	check("explore returns paths + lines, not prose", explore.prompt.includes("One line per hit \u2014 absolute path, line number"));
	check("explore is read-only by prompt, Claude Code's prohibition list in substance", explore.prompt.includes("Read-only, strictly:") && explore.prompt.includes("no redirects or heredocs that write"));
	check("advisor advises and changes nothing", advisor.prompt.includes("You advise; you change nothing.") && advisor.prompt.includes("Do not restate the brief."));
	check("advisor's routing rule carries Claude Code's when-to-call and the reconcile rule", /before substantive work/.test(advisor.description) && /when stuck/.test(advisor.description) && /send the conflict back/.test(advisor.description));
	check("lead delegates and reports once", lead.prompt.includes("report once") && lead.prompt.includes("Delegate the work"));

	// Ticket 29 §5: the format is the control, so the fenced block is pinned byte
	// for byte in the file the agent actually reads.
	const WORKER_REPORT = "```\ndone: <one line>\nfiles: <paths, one line>\nverified: green | <n> red: <one-line why> | not run: <why>\nopen: <one line, only when unresolved>\n```";
	const EXPLORE_REPORT = "```\n<path>:<line>  <matching line>          (one per hit, grouped by file)\n\nanswer: <1\u20133 lines>\n```";
	const LEAD_REPORT = "```\ndone: <one line>\nfiles: <paths, one line>\nverified: green | <n> red: <one-line why> | not run: <why>\nsteps: <one line per step taken>\nopen: <one line, only when unresolved>\n```";
	const ADVISOR_REPORT = "```\nanswer: <the recommendation, one to three lines>\nwhy: <the deciding constraints, one line each>\nrisks: <what could make this wrong, one line each, only when real>\nopen: <what you could not settle from the brief and repo, only when unresolved>\n```";
	check("advisor: answer/why/risks/open, verbatim, max 20 lines", advisor.prompt.includes(ADVISOR_REPORT) && advisor.prompt.includes("Your report is the rule that matters. Max 20 lines"));
	check("worker: the eight-line report shape, verbatim, marked as the rule that matters", worker.prompt.includes(WORKER_REPORT) && worker.prompt.includes("Your report is the rule that matters. Max 8 lines"));
	check("explore: hits then a 1\u20133 line answer, verbatim", explore.prompt.includes(EXPLORE_REPORT) && explore.prompt.includes('No prose above the hits, no "I searched\u2026"'));
	check("lead: the worker block plus `steps:`, verbatim, max 15 lines", lead.prompt.includes(LEAD_REPORT) && lead.prompt.includes("Your report is the rule that matters. Max 15 lines"));

	// Ticket 29 §6: the instruction is a prompt line, and Opus ignores a single
	// mention — so the Opus types repeat it as the last line of the file.
	for (const [name, type] of [["worker", worker], ["explore", explore], ["lead", lead], ["advisor", advisor]]) {
		check(`${name}: the token-efficiency line`, type.prompt.includes("Be token-efficient:"));
	}
	// A worker or lead reports to the seat above it, never to Joel: the
	// writing-for-Joel paragraph is the main seat's and ends no child file.
	for (const [name, type] of [["worker", worker], ["lead", lead], ["advisor", advisor]]) {
		const tail = type.prompt.trimEnd().split("\n").filter((line) => line.trim().length > 0).at(-1);
		check(`${name}: the last line is the token-efficiency repeat (29 §6), not a writing rule for Joel`, tail?.startsWith("Be token-efficient:") === true && !type.prompt.includes("writing for Joel"), tail);
	}

	// Ticket 29 §7: the comment rules live in `coding-standards` and here.
	const COMMENT_RULES = ["one-line JSDoc on an exported symbol", "safety justification on a cast", "Smallest change that does the job; no helper for one caller"];
	check("worker carries the three allowed comment forms and the short-code rule", COMMENT_RULES.every((rule) => worker.prompt.includes(rule)));
	check("worker carries the ban list", worker.prompt.includes('Never narrate what the code does, never add section headers, essays, "Note:"'));
}

// ---------------------------------------------------------------------------
// Token efficiency in the owned system prompt — ticket 29 §6
// ---------------------------------------------------------------------------
{
	console.log("\nthe token-efficiency line (owned system prompt)");
	const { buildOwnedSystemPrompt, OWNED_IDENTITY } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const prompt = buildOwnedSystemPrompt({ selectedTools: ["read", "bash", "edit", "write"], cwd: "/tmp" });
	check("every seat's system prompt carries it in the identity line", prompt.startsWith(OWNED_IDENTITY) && OWNED_IDENTITY.includes("Everything you read stays in context for the whole session and dilutes later turns"), prompt.slice(0, 400));
}

// ---------------------------------------------------------------------------
// The skills catalogue — one capped line per skill, ours and anyone else's
// ---------------------------------------------------------------------------
{
	console.log("\nthe skills catalogue");
	const { formatOwnedSkills, SKILL_DESCRIPTION_CAP } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const long = `x${"y ".repeat(300)}`;
	const catalogue = formatOwnedSkills([
		{ name: "commit", description: "Read this skill before making git commits", filePath: `${ROOT}/skills/commit/SKILL.md` },
		{ name: "vendor", description: long, filePath: "/elsewhere/vendor/SKILL.md" },
		{ name: "folded", description: "First line.\n\nSecond paragraph a vendor wrote to its own budget.", filePath: `${ROOT}/skills/folded/SKILL.md` },
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
