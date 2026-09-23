/**
 * The owned system payload: every block of `system` that reaches Anthropic is
 * produced here, from pi's structured BuildSystemPromptOptions — never by
 * stripping or patching pi's generated prose. Text pi emits that this builder
 * does not map can therefore never appear on the wire (leak-proof by
 * construction); the only drift surface left is the options schema itself,
 * which `validatePromptOptions` guards and a unit test pins against the
 * installed pi package.
 *
 * `customPrompt` is the one input emitted verbatim, because it is the caller's
 * own text — with a single exception the caller resolves before calling here:
 * a subagent's inherited parent prompt is pi's text handed back to us, and
 * `inherited-prompt.ts` replaces that half with owned material first.
 *
 * `buildOwnedSystemPrompt` mirrors pi's dist/core/system-prompt.js section by
 * section — same preamble, guidelines, append/context/skills content, in pi's
 * order. Its framing is the owned one (context-view/measure.ts parses these
 * markers structurally): pi 0.86 wraps every section in a tag of its own name
 * so it can patch sections mid-conversation, which the owned prompt does not do
 * — it is rebuilt whole per request. Beyond framing, these are the deliberate
 * deviations, named rather than numbered: `test/smoke.mjs` asserts each one
 * against the installed pi, and an ordinal kept in two files is a fact that can
 * drift while both copies still look right.
 *
 *   - the "Pi documentation" block is not emitted; that content lives in the
 *     `self-modify` skill and loads only when working on the harness.
 *   - context files are deduped by content: ~/.pi/agent/AGENTS.md is a
 *     symlink to ~/dotfiles/pi/AGENTS.md, so a single policy file can never
 *     be collected twice by pi's global + ancestor-walk discovery.
 *   - the "Available tools" list is not emitted at all (issues/31). pi's own
 *     docs call it decoration a caller opts into — "Use `promptSnippet` for a
 *     short one-line entry in the `Available tools` section in the default
 *     system prompt. If omitted, custom tools are left out of that section"
 *     (docs/extensions.md) — while `payload.tools` carries every tool's name,
 *     description and JSON schema in full, structurally, on the same request.
 *     The list was a lossy restatement of material the API already delivers,
 *     so it is gone, and with it the sentence that only made sense standing
 *     under it ("In addition to the tools above, you may have access to other
 *     custom tools depending on the project"). The Guidelines section stays:
 *     its bullets are cross-tool workflow rules, not schema repeats.
 *   - the Guidelines section is emitted on the `customPrompt` branch too,
 *     which pi's builder skips (issues/50 §4). A seat running an agent
 *     definition's own body — every worker, lead and explore seat — got a
 *     tool's guidelines dropped on the floor, and got `tool-policy.ts`'s
 *     broad-scan refusal without ever being told the rule it broke. A
 *     guideline written and not delivered is a lie.
 *   - pi's file-operations bullet ("like ls, rg, find") is replaced by
 *     {@link BASH_FILE_OPS_GUIDELINE}: pi's line advertises `find`, whose job
 *     `fd` does faster here, and names no owner for any other kind of search
 *     — the gap that let a seat type `grep -r` into a million-file tree
 *     (120 s, killed) with `rg` installed. One line of map; the argument
 *     lives in tool-policy.ts's refusal, paid only on a mistake.
 *   - the identity paragraph: pi's stock "expert coding assistant" opening is
 *     replaced by Joel's own (issues/34). Pinned byte-exact against pi's text,
 *     so pi rewriting its opening is a failure to map rather than a silent
 *     inheritance.
 *   - pi's standing conciseness bullet ("Be concise in your responses") is
 *     dropped. Verbosity is settled in APPEND_SYSTEM.md's COMMUNICATION block,
 *     and one fact gets one home.
 *   - the skills catalogue is the lean list, not pi's XML block: the root
 *     stated once, then one `name: description` line per skill. Which seats
 *     get one at all is *not* a deviation — {@link carriesSkillReader} is pi's
 *     own rule.
 *   - the cwd footer is not part of the body at all ({@link cwdBlockText}).
 *     It is the one line of the prompt that differs between two otherwise
 *     identical seats, and Anthropic caches the prefix up to the last
 *     breakpoint — so the wire sends it as its own uncached block after the
 *     prompt, and two seats in different directories share one tools+system
 *     entry. The body ends where its last section ends, with no trailing
 *     newline on either branch.
 *
 * `standingTools` is still applied even with no list to build, because pi's
 * guideline logic keys off the same set: the file-operations bullet is added
 * exactly when bash stands and grep/find/ls do not, and the deleted built-ins
 * (map C6) have to be cut here as well as on the wire for that to be true.
 *
 * Invariant: this builder makes no syscall — the bytes it produces are a pure
 * function of the options captured at turn start. The cached prefix therefore
 * cannot change because disk did (issues/25); the mutation test in smoke.mjs
 * enforces it.
 *
 * Nothing here concerns Claude Code: the blocks that exist to identify the
 * client — attribution line, identity line, headers — live in
 * `claude-code.ts`, and the two are only ever assembled together by the wire
 * extension.
 */

import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { standingTools } from "./tool-policy.ts";

/**
 * Every field of BuildSystemPromptOptions this builder accounts for. A field
 * pi adds that is not listed here would be silently dropped from the wire —
 * that is exactly what validatePromptOptions exists to catch, loudly.
 *
 * Accounted for is not the same as emitted: `toolSnippets` is deliberately
 * dropped now that the "Available tools" list is gone (see the header). It
 * stays listed because it is still pi's field, and its disappearance from
 * pi's schema should be noticed like any other change.
 */
export const KNOWN_OPTION_KEYS = [
	"customPrompt",
	"forceSystemPrompt",
	"selectedTools",
	"toolSnippets",
	"toolGuidelines",
	"promptGuidelines",
	"appendSystemPrompt",
	"sections",
	"cwd",
	"contextFiles",
	"skills",
] as const;

/**
 * Problems that mean the builder would drop or misread prompt material.
 * Empty array = the options schema is exactly what the builder maps.
 */
export function validatePromptOptions(options: BuildSystemPromptOptions): string[] {
	const problems: string[] = [];
	const known = new Set<string>(KNOWN_OPTION_KEYS);
	for (const key of Object.keys(options)) {
		if (!known.has(key)) problems.push(`unmapped systemPromptOptions field "${key}" — its content would never reach the wire`);
	}
	if (typeof options.cwd !== "string") problems.push("systemPromptOptions.cwd is not a string");
	return problems;
}

/**
 * The one guideline this harness adds to every seat: the prompt half of the
 * broad-scan guard (issues/29). `tool-policy.ts`'s `scanRefusal` enforces the
 * same rule at `tool_call` and its refusal text names the same two roots and
 * the same remedy, so a blocked call reads as a rule the seat was already
 * told, not a surprise. Stated as a rule about where a scan starts rather
 * than about a tool, because the tools that scan differ per seat.
 */
export const SCAN_GUIDELINE = "Scan from the repo or a named path, never / or $HOME";

/**
 * The bash seat's file-operations bullet, replacing pi's "ls, rg, find" line
 * (fourth deviation, module header). A map of which tool owns which search —
 * text, filenames, syntax, JSON — and the one ban the guard enforces, so a
 * blocked `grep -r` reads as a rule the seat was already told. Tool-specific
 * on purpose, unlike {@link SCAN_GUIDELINE}: it is only ever added to seats
 * that hold bash, where these commands exist.
 */
export const BASH_FILE_OPS_GUIDELINE =
	"Use bash for file operations: ls to list; search text with rg, filenames with fd, code structure with ast-grep, JSON with jq. grep -r is blocked — rg does that job";

/**
 * The chat seat's identity — one sentence, ~10 tokens. The wire extension
 * sends it as the only system block after the Claude Code invariant when
 * PI_CHAT=1; everything else this module builds stays off that seat.
 */
export const CHAT_PROMPT = "You are Joel's personal chat assistant.";

/**
 * The chat seat's whole owned system block: the identity sentence plus the
 * caller's append text (APPEND_SYSTEM.md, as pi read it at startup) — how
 * Joel wants to be spoken to is not a coding-seat concern, and chat is the
 * seat that does nothing *but* speak.
 *
 * The append text is taken from the same captured options a coding seat
 * builds from rather than re-read here, so there is one source of those bytes
 * on the wire and this stays a pure function of what pi captured. A chat
 * request with no capture yet falls back to the sentence alone: the seat's
 * identity and tool cut never depend on capture, only its manner does.
 */
export function buildChatSystemPrompt(appendSystemPrompt?: string): string {
	const append = appendSystemPrompt?.trim();
	return append ? `${CHAT_PROMPT}\n\n${append}` : CHAT_PROMPT;
}

/**
 * The system prompt of a coding request that has no options to build one
 * from: a refusal, not a thin agent.
 *
 * On every Anthropic request, keyed or OAuth, because the rule it serves is
 * this harness's own: the seat sends prose it wrote or it sends nothing. On
 * OAuth that is also what keeps the client honest — pi's prompt behind the
 * Claude Code identity block is the shape Anthropic refuses as a third-party
 * app — but a Console key earns the same answer for the older reason.
 *
 * A request cannot be cancelled from `before_provider_request` — returning
 * nothing and throwing both send pi's own payload — so the only way to not
 * answer is to say so. The alternative was a skeleton built from `{ cwd }`:
 * a seat with no project rules, no skills and no context files, answering
 * confidently and wrongly, with nothing on the wire to show why. A seat that
 * declares its own absence is recoverable in one message; a silently lesser
 * one is not.
 */
export const PROMPT_UNAVAILABLE = [
	"This request was built without a system prompt.",
	"",
	"The harness had no prompt options when it assembled it, so none of the seat's rules, skills, project context or working directory are loaded. Nothing you would need to do the work is present, and pi's own prompt is deliberately not sent in its place.",
	"",
	"Do not attempt the request, do not guess at what was asked, and call no tools. Reply with exactly this line and nothing else:",
	"",
	"This seat has no system prompt — the harness sent a request before it could build one. Send any message to restore it, then ask again.",
].join("\n");

/**
 * The owned identity paragraph (issues/34, user's own words). Replaces pi's
 * stock "expert coding assistant" opening; the Claude Code identity line is a
 * separate wire block (claude-code.ts) and is not this text's business.
 *
 * Delegating read-heavy work is not named here: the Agent tool's own
 * description owns that, and a fact already in a tool schema is not repeated
 * in the prompt (placement rule, `self-modify`).
 */
export const OWNED_IDENTITY = "You are Joel's personal agent, working only for Joel. You operate inside Joel's custom pi-harness, developing software with him. When you are doing programming work, you help by reading files, executing commands, editing code, and writing new files. Everything you read stays in context for the whole session and dilutes later turns: read the lines the job needs, search before reading, stop when you have the answer.";

/**
 * The full owned system prompt for one request. Mirrors pi's buildSystemPrompt
 * (same branch semantics for customPrompt) minus the Pi documentation block
 * and the Available tools list.
 *
 * `wireToolName` is how the caller's transport spells a tool; the guidelines
 * are written in those names.
 */
/** Opens the owned skills catalogue; measure.ts and the tests key on it. */
export const SKILLS_OPEN = "**SKILLS — READ BEFORE YOU ACT**";

type OwnedSkill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

/**
 * The owned skills catalogue (sixth named deviation). pi's XML formatter
 * spends ~25 tokens of markup plus a repeated absolute path on every skill
 * — ~2,100 tokens for the full catalogue, over half of it overhead. Every
 * skill is a directory at `<root>/<name>/SKILL.md`, so the root is stated
 * once and an entry is `name: description`. A skill whose path breaks the
 * pattern carries its full path inline — correctness beats the trim.
 *
 * The preamble is deliberately instruction-heavy: models under-trigger on
 * a passive "read when relevant" hint, so it names the moment (before the
 * first tool call), the steps, and the default for doubt (read it). Bold
 * and numbered steps are the cheapest emphasis that measurably helps.
 *
 * Every description is squeezed onto one line and capped at
 * {@link SKILL_DESCRIPTION_CAP}: a third-party skill's description is written
 * to its own budget, not ours, and the catalogue is read on every turn.
 *
 * Muted skills are dropped here, exactly as pi's formatter drops them: a
 * skill with `disable-model-invocation: true` in its frontmatter is one the
 * user hid from the model with `/skills`, and naming it in the catalogue is
 * both an invitation to use it and the tokens they were trying to reclaim.
 * The filter lives inside the formatter, not at the call sites, so no future
 * caller can forget it.
 */
export const SKILL_DESCRIPTION_CAP = 200;

/**
 * A skill we do not own, described in our words. The package's own text is
 * written for its README; the catalogue line is paid on every turn.
 */
export const FOREIGN_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
	plannotator: "Plannotator CLI: review plans and code, annotate files, URLs, folders, or a running app, and share Guided Reviews.",
};

/** One line, at most {@link SKILL_DESCRIPTION_CAP} characters, cut at a word boundary. */
function cappedDescription(description: string): string {
	const line = description.replace(/\s+/g, " ").trim();
	if (line.length <= SKILL_DESCRIPTION_CAP) return line;
	const cut = line.slice(0, SKILL_DESCRIPTION_CAP);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > SKILL_DESCRIPTION_CAP / 2 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, "")}\u2026`;
}

export function formatOwnedSkills(allSkills: readonly OwnedSkill[]): string {
	const skills = allSkills.filter((skill) => !skill.disableModelInvocation);
	if (skills.length === 0) return "";
	const suffixOf = (skill: OwnedSkill) => `/${skill.name}/SKILL.md`;
	const roots = new Map<string, number>();
	for (const skill of skills) {
		if (!skill.filePath.endsWith(suffixOf(skill))) continue;
		const root = skill.filePath.slice(0, -suffixOf(skill).length);
		roots.set(root, (roots.get(root) ?? 0) + 1);
	}
	let root: string | undefined;
	let best = 0;
	for (const [candidate, count] of roots) if (count > best) { root = candidate; best = count; }
	const entries = skills.map((skill) => {
		const description = cappedDescription(FOREIGN_SKILL_DESCRIPTIONS[skill.name] ?? skill.description);
		return root !== undefined && skill.filePath === `${root}${suffixOf(skill)}`
			? `${skill.name}: ${description}`
			: `${skill.name} (${skill.filePath}): ${description}`;
	});
	const where = root === undefined ? "" : `: ${root}/<name>/SKILL.md`;
	return `\n\n${SKILLS_OPEN}\n\nEach skill below is a file${where}. It holds the rules for one kind of task.\n\n**On every request, before your first tool call:**\n**1. Scan the list.**\n**2. If a description matches the request, read that SKILL.md.**\n**3. Only then start the work.**\n\n**If unsure whether it matches, read it.** Paths inside a skill are relative to its directory.\n\n${entries.join("\n")}\n`;
}

/**
 * The Guidelines section, `- ` bullets and all. One assembly for both branches:
 * a seat running an agent definition's own body lives under the same refusals
 * as any other, so it gets the same rules (issues/50 §4) — and a
 * branch cannot drop them by forgetting to build them.
 */
function guidelinesSection(
	tools: readonly string[],
	toolGuidelines: Readonly<Record<string, readonly string[]>> | undefined,
	promptGuidelines: readonly string[] | undefined,
	wireToolName: WireToolName,
): string {
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string) => {
		if (guidelinesSet.has(guideline)) return;
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};
	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	if (hasBash || hasPowerShell) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline(BASH_FILE_OPS_GUIDELINE);
		}
	}
	// Deterministic position, and next to the file-operations line it qualifies:
	// addGuideline is order-preserving and deduping, so this lands in the same
	// slot on every request and exactly once even if a tool declares it too.
	addGuideline(SCAN_GUIDELINE);
	// A tool's own guidelines, verbatim: every tool whose words matter is
	// registered by this harness, so they are written where the tool is. Keyed by
	// tool since pi 0.86, and read through the standing set so a tool this seat
	// does not carry cannot teach it rules for a tool it does not have.
	for (const tool of tools) {
		for (const guideline of toolGuidelines?.[tool] ?? []) {
			const normalized = guideline.trim();
			if (normalized.length > 0) addGuideline(normalized);
		}
	}
	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) addGuideline(normalized);
	}
	addGuideline("Show file paths clearly when working with files");
	return `Guidelines:\n${guidelinesList.map((g) => `- ${wireNamed(g, tools, wireToolName)}`).join("\n")}`;
}

/**
 * How the transport spells one of this seat's tools on the wire. Identity for
 * every sender but an Anthropic OAuth request, which pi-ai renames to Claude
 * Code's casing (`claudeCodeToolName`).
 */
export type WireToolName = (tool: string) => string;

const sameName: WireToolName = (tool) => tool;

/** pi's default active tools, for a capture that names none. */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * The tool names a prompt built from `options` is written in, under one wire's
 * spelling. Two spellings that agree here build byte-identical prompts, because
 * the spelling reaches the text only through these names.
 */
export function promptToolNames(options: BuildSystemPromptOptions, wireToolName: WireToolName = sameName): string[] {
	return standingTools(options.selectedTools || DEFAULT_TOOLS).map(wireToolName);
}

/**
 * A guideline names a tool the way the request will. A line that says `read`
 * while the wire offers `Read` points at a tool the model was never given,
 * which is how a rule becomes noise.
 */
function wireNamed(guideline: string, tools: readonly string[], wireToolName: WireToolName): string {
	let text = guideline;
	for (const tool of tools) {
		const wire = wireToolName(tool);
		if (wire === tool) continue;
		text = text.replace(new RegExp(`\\b${tool.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\b`, "gi"), wire);
	}
	return text;
}

export function buildOwnedSystemPrompt(options: BuildSystemPromptOptions, wireToolName: WireToolName = sameName): string {
	const { customPrompt, forceSystemPrompt, selectedTools, toolGuidelines, promptGuidelines, appendSystemPrompt } = options;
	// A prompt a `before_agent_start` handler forced is the whole prompt, by pi's
	// contract: the caller's own text, emitted as given and assembled with nothing.
	// Tested for presence, not for truth, because pi tests `!== undefined` -- a
	// handler that forces the empty prompt means the empty prompt, and truthiness
	// would answer it with the whole owned one.
	if (forceSystemPrompt !== undefined) return forceSystemPrompt;
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const contextFiles = dedupeContextFiles(options.contextFiles ?? []);
	const skills = options.skills ?? [];
	const tools = standingTools(selectedTools || DEFAULT_TOOLS);
	const guidelines = guidelinesSection(tools, toolGuidelines, promptGuidelines, wireToolName);
	const extraSections = customSections(options.sections);

	if (customPrompt) {
		let prompt = `${customPrompt}\n\n${guidelines}`;
		if (appendSection) prompt += appendSection;
		prompt += contextSection(contextFiles);
		if (carriesSkillReader(tools) && skills.length > 0) prompt += formatOwnedSkills(skills);
		return prompt + extraSections;
	}

	let prompt = `${OWNED_IDENTITY}

${guidelines}`;
	if (appendSection) prompt += appendSection;
	prompt += contextSection(contextFiles);
	if (carriesSkillReader(tools) && skills.length > 0) prompt += formatOwnedSkills(skills);
	return prompt + extraSections;
}

/**
 * Whether this seat can open a SKILL.md, and so whether the catalogue is worth
 * sending it. pi's rule (`skillFileReadTool` in dist/core/system-prompt.js):
 * `read` or `bash`, either one.
 *
 * Both, not `read` alone, because the question the gate asks is whether the file
 * can be opened -- and `cat` opens it. A seat carrying bash and no read can use
 * every skill in the list, so withholding the list only hides them from it.
 *
 * One function for both branches of the builder, which held two spellings of
 * this rule and could drift apart. Asked of the standing tools rather than the
 * raw list: a deleted built-in is not a way to read anything.
 *
 * pi also names the tool it picked inside its catalogue text. This one does not
 * need to -- {@link formatOwnedSkills} says to read the file without naming a
 * tool to do it with, which is true on either seat.
 */
function carriesSkillReader(tools: readonly string[]): boolean {
	return tools.includes("read") || tools.includes("bash");
}

/**
 * Sections an extension asked pi to carry, in pi's own framing: the key is the
 * tag name (pi 0.86). They are another extension's words, so they are emitted
 * as given rather than mapped — dropping them is the one thing this builder may
 * not do.
 */
function customSections(sections: Readonly<Record<string, string>> | undefined): string {
	let text = "";
	for (const [name, content] of Object.entries(sections ?? {})) {
		if (content) text += `\n\n<${name}>\n${content}\n</${name}>`;
	}
	return text;
}

/** The cwd footer, rendered one way for every sender: the wire's own block, never the body. */
export function cwdBlockText(cwd: string): string {
	return `Current working directory: ${cwd.replace(/\\/g, "/")}`;
}

/**
 * A Codex request's `instructions`: the owned prompt, then the cwd footer. The
 * Responses API takes one string where Anthropic takes blocks, so the footer
 * joins the body there.
 */
export function codexInstructions(prompt: string, cwd: string): string {
	return `${prompt}\n\n${cwdBlockText(cwd)}`;
}

/** pi's exact project_context framing, down to the trailing newlines. */
function contextSection(files: Array<{ path: string; content: string }>): string {
	if (files.length === 0) return "";
	let section = "\n\n<project_context>\n\n";
	section += "Project-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of files) {
		section += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	return `${section}</project_context>\n`;
}

/**
 * Keep the first entry per byte-identical content. Two names for one file
 * always carry the same bytes, so the symlink case collapses without asking
 * the filesystem which names are one file — keeping the builder pure.
 */
export function dedupeContextFiles(
	files: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
	const seen = new Set<string>();
	const kept: Array<{ path: string; content: string }> = [];
	for (const file of files) {
		if (seen.has(file.content)) continue;
		seen.add(file.content);
		kept.push(file);
	}
	return kept;
}

