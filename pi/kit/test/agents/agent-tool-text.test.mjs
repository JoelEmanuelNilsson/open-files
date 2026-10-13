/**
 * The agent engine's words, offline: agent type files read off disk, and the
 * ruled text of the five tools and the role tails, pinned through their own
 * exports so they change only with this file.
 */

import { check, finish } from "../support/check-harness.mjs";
import { jiti } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Agent types on disk
// ---------------------------------------------------------------------------
{
	const { parseAgentTypeFile, loadAgentTypes, renderAgentTypeList, AGENT_TYPE_LIST_OPEN } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-type-files.ts`);
	console.log("\nagent types on disk");
	const folded = parseAgentTypeFile(
		["---", "# a comment", "name: explore", "description: >-", "  Fast read-only search.", "  Paths and lines, not prose.", "tools: read, bash", "model: haiku", "effort: medium", "---", "", "You search.", ""].join("\n"),
		"/x/explore.md",
	);
	check("folded description joins with spaces", folded.description === "Fast read-only search. Paths and lines, not prose.", folded.description);
	check("effort is read as thinking", folded.thinking === "medium");
	check("model is read", folded.model === "haiku");
	check("body is the prompt, trimmed", folded.prompt === "You search.");
	check("tools is a list of names", JSON.stringify(folded.tools) === JSON.stringify([{ name: "read" }, { name: "bash" }]), JSON.stringify(folded.tools));
	const delegating = parseAgentTypeFile("---\nname: lead\ntools: read, bash, Agent(explore, worker), TaskOutput\ncompact_at: 300000\ncontext: none\n---\n", "/x/lead.md");
	check("Agent(type, …) keeps its types, even with commas inside", JSON.stringify(delegating.tools) === JSON.stringify([{ name: "read" }, { name: "bash" }, { name: "Agent", agentTypes: ["explore", "worker"] }, { name: "TaskOutput" }]), JSON.stringify(delegating.tools));
	check("compact_at is a token count and context is none", delegating.compactAt === 300000 && delegating.context === "none");
	check("no tools, compact_at or context: pi's selection, never compacts, full context", (({ tools, compactAt, context }) => tools === undefined && compactAt === undefined && context === "full")(parseAgentTypeFile("---\nname: a\n---\n", "/x/a.md")));
	check("a compact_at that is not a positive number is a problem", ["abc", "0", "1.5"].every((value) => parseAgentTypeFile(`---\nname: a\ncompact_at: ${value}\n---\n`, "/x/a.md").reason?.startsWith("compact_at:")));
	check("a context other than none or full is a problem", parseAgentTypeFile("---\nname: a\ncontext: some\n---\n", "/x/a.md").reason === 'context: "some" — only "none" and "full" exist');
	const thinking = parseAgentTypeFile("---\nname: lead\nthinking: medium\n---\nOwn it.", "/x/lead.md");
	check("pi's thinking key works too", thinking.thinking === "medium" && thinking.prompt === "Own it.");
	check("no body is an empty prompt", parseAgentTypeFile("---\nname: worker\ndescription: One job.\n---\n", "/x/w.md").prompt === "");
	check("enabled: false disables the type", parseAgentTypeFile("---\nenabled: false\n---\nnope", "/x/plan.md") === undefined);
	check("no name is a problem, not a type", parseAgentTypeFile("---\ndescription: x\n---\n", "/x/anon.md").reason === "frontmatter has no name");
	check("no frontmatter is a problem", parseAgentTypeFile("just prose", "/x/p.md").reason === "no frontmatter block");
	// Ticket 29 §4: a level that does not exist is a problem the seat can see,
	// not a silent `undefined` that quietly takes pi's default.
	check("a level outside medium..xhigh is a problem, naming the ones that exist", parseAgentTypeFile("---\nname: a\nthinking: enormous\n---\n", "/x/a.md").reason === 'thinking: "enormous" — only "medium", "high", "xhigh" exist');
	check("off, minimal and low are not agent levels", ["off", "minimal", "low"].every((level) => parseAgentTypeFile(`---\nname: a\nthinking: ${level}\n---\n`, "/x/a.md").reason !== undefined));
	// every level, medium to xhigh, on any model: what a model lacks is clamped at spawn, not refused here.
	for (const model of ["model: opus", "model: luna", ""]) {
		for (const level of ["medium", "high", "xhigh"]) {
			check(`${level} parses on ${model || "an inherited model"}`, parseAgentTypeFile(`---\nname: a\n${model}\nthinking: ${level}\n---\n`, "/x/a.md").thinking === level);
		}
	}
	check("quoted scalars are unquoted", parseAgentTypeFile('---\nname: "quoted name"\n---\n', "/x/q.md").name === "quoted name");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-types-"));
	fs.writeFileSync(path.join(dir, "worker.md"), "---\nname: worker\ndescription: One job, one result.\n---\n");
	fs.writeFileSync(path.join(dir, "explore.md"), "---\nname: explore\ndescription: Find things.\nmodel: haiku\nthinking: medium\n---\nSearch.\n");
	fs.writeFileSync(path.join(dir, "Plan.md"), "---\nenabled: false\n---\n");
	fs.writeFileSync(path.join(dir, "broken.md"), "no frontmatter here");
	fs.writeFileSync(path.join(dir, "notes.txt"), "not an agent");
	const loaded = loadAgentTypes(dir);
	check("loads enabled .md files in name order", loaded.types.map((t) => t.name).join() === "explore,worker", loaded.types.map((t) => t.name).join());
	check("reports the broken file by path", loaded.problems.length === 1 && loaded.problems[0].source.endsWith("broken.md"));
	check("a missing directory is an empty list", loadAgentTypes(path.join(dir, "missing")).types.length === 0);
	const rendered = renderAgentTypeList(loaded.types);
	const expected = [
		AGENT_TYPE_LIST_OPEN,
		"- explore: Find things. (haiku, medium)",
		"- worker: One job, one result. (parent's model, default thinking)",
	].join("\n");
	check("renders Claude Code's registry format with (model, thinking)", rendered === expected, rendered);
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The ruled words (ticket 12), pinned so they change only with this file
// ---------------------------------------------------------------------------
{
	const t = await jiti.import(`${KIT_ROOT}/lib/agents/agent-tool-text.ts`);
	const tails = await jiti.import(`${KIT_ROOT}/lib/agents/agent-role-tails.ts`);
	const { parseAgentTypeFile } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-type-files.ts`);
	console.log("\nthe ruled words");
	const description = t.agentToolDescription([{ name: "explore", description: "Find things.", model: "haiku", thinking: "medium", delivery: "batch", prompt: "", source: "" }, { name: "reviewer", description: "Reviews.", model: "haiku", thinking: "xhigh", delivery: "batch", prompt: "", source: "" }, { name: "worker", description: "Works.", model: undefined, thinking: undefined, delivery: "single", prompt: "", source: "" }], true);
	check("Agent opens with Claude Code's first sentence, then the fresh-start rule", description.startsWith("Launch a new agent to handle complex, multi-step tasks. Every agent starts fresh: it reads its brief, not your conversation."));
	check("the delivery paragraph replaces the notify line", description.includes(t.deliveryParagraph([{ name: "explore", delivery: "batch" }, { name: "reviewer", delivery: "batch" }])) && !description.includes("you'll be notified when one completes"));
	check("the spawn-permission line is gone", t.SPAWN_PERMISSION_LINE === undefined && !description.includes("permission to spawn"));
	check("the thinking parameter has its own rule", typeof t.AGENT_PARAMS.thinking === "string" && /reasoning level/.test(t.AGENT_PARAMS.thinking));
	check("the type list is rendered in, with (model, thinking)", description.includes("- explore: Find things. (haiku, medium)") && description.trimEnd().endsWith("- worker: Works. (parent's model, default thinking)"));
	check("delivery is read from the type file, single by default, and a bad value is a problem", parseAgentTypeFile("---\nname: a\ndelivery: batch\n---\n", "/x/a.md").delivery === "batch" && parseAgentTypeFile("---\nname: a\n---\n", "/x/a.md").delivery === "single" && parseAgentTypeFile("---\nname: a\ndelivery: some\n---\n", "/x/a.md").reason?.startsWith("delivery:"));
	const { loadAgentTypes } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-type-files.ts`);
	const shipped = loadAgentTypes(path.join(KIT_ROOT, "../agents")).types;
	const withWorkflows = t.agentToolDescription(shipped, true);
	const withoutWorkflows = t.agentToolDescription(shipped, false);
	check(`the description stays under 4,200 chars with the shipped types (${withWorkflows.length})`, withWorkflows.length < 4200);
	check("without workflows the description names no Workflow at all", !/workflow/i.test(withoutWorkflows));
	check("the two shapes differ by the workflow rung alone", withWorkflows.replace("the same job on many things \u2014 a `Workflow`; ", "") === withoutWorkflows);
	const taskOutputDescription = t.taskOutputDescription(shipped);
	check("TaskOutput is not deprecated and names the yield", !taskOutputDescription.includes("DEPRECATED") && taskOutputDescription.includes('("interrupted by Joel" or "interrupted by your parent (…)")'));
	const batching = shipped.filter((type) => type.delivery === "batch").map((type) => type.name);
	check("TaskOutput names every shipped type that returns with its batch", batching.length === 2 && batching.every((name) => new RegExp(`\\b${name}\\b`).test(taskOutputDescription)), `${batching.join()}: ${taskOutputDescription}`);
	check("and with no batching type, no batch sentence", !t.taskOutputDescription([{ name: "worker", delivery: "single" }]).includes("together"));
	check("three batching types read as a list", t.deliveryParagraph([{ name: "a", delivery: "batch" }, { name: "b", delivery: "batch" }, { name: "c", delivery: "batch" }]).includes("a, b and c agents together"));
	// Every rule once, and never on a tool the reading seat might not carry: `edit`/`write` say nothing about delegating.
	check("no edit/write rule exists any more; the delegation line is on Agent", t.EDIT_WRITE_RULE === undefined && t.withEditWriteRule === undefined && description.includes(t.DELEGATION_LINE));
	check("subagent_type prose defers to the schema enum", t.AGENT_PARAMS.subagent_type === "The agent type. Default: worker.");
	const { validateToolArguments } = await import("@earendil-works/pi-ai");
	const withMaxTurns = validateToolArguments({ name: "Agent", description: "", parameters: t.agentParamsFor(["worker"]) }, { type: "toolCall", id: "1", name: "Agent", arguments: { description: "d", prompt: "p", max_turns: 3 } });
	check("Agent has no max_turns property, and a call that passes one is not refused by the schema", t.agentParamsFor(["worker"]).properties.max_turns === undefined && withMaxTurns !== undefined);
	check("a seat that cannot start a worker is not told worker is the default", t.agentParamsFor(["explore"]).properties.subagent_type.description === "The agent type." && t.agentParamsFor(["explore", "worker"]).properties.subagent_type.description === "The agent type. Default: worker.");
	check("TaskOutput timeout: 10 minutes default, 2 hours max", t.TASK_OUTPUT_DEFAULT_TIMEOUT_MS === 600000 && t.TASK_OUTPUT_MAX_TIMEOUT_MS === 7200000);
	check("the model enum is opus, sonnet, luna and haiku, nothing else", t.AGENT_MODEL_ALIASES.join() === "opus,sonnet,luna,haiku");
	check("the model rule keeps sonnet as the default, opus for better-written code, design and retries, haiku for fact gathering, scoped review and no-judgment worker jobs, luna not recommended", /sonnet — the worker default/.test(t.AGENT_MODEL_RULE) && /opus — code that must be written better, design that must be reasoned through, or a retry after a sonnet worker failed on a hard problem rather than a thin brief/.test(t.AGENT_MODEL_RULE) && /haiku — fact gathering, scoped review, and worker jobs that need no judgment: bookkeeping, doc rewrites, mechanical edits the brief spells out; never design judgment/.test(t.AGENT_MODEL_RULE) && /luna — selectable, not recommended\./.test(t.AGENT_MODEL_RULE));
	check("the model rule puts fan-outs on haiku with one judge", /one at a time, never one per lane/.test(t.AGENT_MODEL_RULE) && /run on haiku, and one sonnet or opus judges/.test(t.AGENT_MODEL_RULE));
	check("the model rule no longer restricts thinking", !/max/.test(t.AGENT_MODEL_RULE));
	check("the wait tools are Agent and TaskOutput", t.AGENT_WAIT_TOOL_NAMES.join() === "Agent,TaskOutput");
	check("SendMessage says a new job goes to a fresh Agent", /new job goes to a fresh `Agent`/.test(t.SEND_MESSAGE_DESCRIPTION));
	const worker = tails.renderRoleTail({ role: "worker", name: "w1", depth: 2, liveCount: 3, files: { kind: "shared" } });
	check("the worker tail, verbatim", worker === "<sub_agent_context>\nYou are a **worker** named `w1`, depth 2 of 4. 3 agents are live. Your parent reads only your final reply \u2014 put everything that matters in it, including answers to its messages; SendMessage reaches only agents you started. Don't wait for or poll agents you didn't start.\nOnly your last message is delivered. Put the whole report in it. A message that refers to an earlier message \u2014 \"as above\", \"see the report\" \u2014 delivers nothing.\nYou share this directory with other agents. Edit only the files your job needs. Never revert or reformat someone else's change. If you must touch a file outside your job, say so in your report.\n</sub_agent_context>", worker);
	const lead = tails.renderRoleTail({ role: "lead", name: "boss", depth: 1, liveCount: 1, files: { kind: "worktree", branch: "agent/boss", path: "/tmp/x" }, workflowChild: true });
	const plainLead = tails.renderRoleTail({ role: "lead", name: "boss", depth: 1, liveCount: 1, files: { kind: "shared" } });
	check("the lead tail adds the lead line, then the worktree line; a workflow child gets no reply rule", lead.includes("You are a **lead** named `boss`") && lead.indexOf("Own this end to end. Delegate the work to your own workers; don't implement it yourself. Report to your parent once, when it's done.") < lead.indexOf("You work in your own copy of the repo on branch `agent/boss`. Commit there. Your report must name the branch and the files you changed.") && lead.includes(tails.WORKFLOW_CHILD_CONTRACT) && !lead.includes("answers to its messages") && !lead.includes(tails.LAST_MESSAGE_LINE));
	check("a workflow child is told its return contract once; a lead outside a workflow is not", lead.split("IS the return value").length === 2 && !plainLead.includes("Return raw data"));
	const explorer = tails.renderRoleTail({ role: "explorer", name: "x", depth: 1, liveCount: 1, files: { kind: "shared" } });
	check("the explorer tail, verbatim", explorer === "<sub_agent_context>\nYou are an **explorer** named `x`, depth 1 of 4. 1 agents are live. Your parent reads only your final reply \u2014 put everything that matters in it, including answers to its messages; SendMessage reaches only agents you started. Don't wait for or poll agents you didn't start.\nOnly your last message is delivered. Put the whole report in it. A message that refers to an earlier message \u2014 \"as above\", \"see the report\" \u2014 delivers nothing.\nYou are read-only: report what you found and any change it calls for; your parent makes the change.\n</sub_agent_context>", explorer);
	check("an explorer in a worktree still reads the read-only line", !tails.renderRoleTail({ role: "explorer", name: "x", depth: 1, liveCount: 1, files: { kind: "worktree", branch: "b", path: "/p" } }).includes("copy of the repo"));
	check("roleOfType: explore is an explorer, lead leads, reviewer and design-review keep their names, anything else works", ["explore", "lead", "worker", "reviewer", "design-review", "custom"].map(tails.roleOfType).join() === "explorer,lead,worker,reviewer,design-review,worker");
	check("only the seats with a write tool and no protocol of their own carry the reply formats", ["worker", "lead", "reviewer"].every(tails.roleUsesReplyFormats) && !tails.roleUsesReplyFormats("explorer") && !tails.roleUsesReplyFormats("design-review"));
	const reviewer = tails.renderRoleTail({ role: "reviewer", name: "r1", depth: 1, liveCount: 1, files: { kind: "shared" } });
	check("a reviewer's tail carries no files line: reviewer.md says what it may write", reviewer.includes("You are a **reviewer** named `r1`") && !reviewer.includes("You share this directory") && !reviewer.includes("read-only") && !reviewer.includes("copy of the repo") && tails.REVIEWER_FILES_LINE === undefined);
	const designReview = tails.renderRoleTail({ role: "design-review", name: "d1", depth: 1, liveCount: 1, files: { kind: "shared" } });
	check("design-review reads the read-only line and names no Edit or Write", designReview.includes(tails.READ_ONLY_LINE) && !/Edit|Write/.test(designReview));
	check("a read-only seat's tail names no tool it lacks", !/Edit|Write/.test(explorer));
	check("the fork is gone from the role tails", tails.renderForkDirective === undefined && tails.FORK_DIRECTIVE === undefined);
	// Ticket 57: the child cannot read "your final reply" as "your final thought".
	check("a lead is told the same thing about its last message", plainLead.includes(tails.LAST_MESSAGE_LINE) && tails.LAST_MESSAGE_LINE.startsWith("Only your last message is delivered.") && tails.LAST_MESSAGE_LINE.endsWith("delivers nothing."), tails.LAST_MESSAGE_LINE);
}

await finish();
