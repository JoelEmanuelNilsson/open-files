import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { formatOwnedSkills } from "./owned-skills-catalogue.ts";

export const KNOWN_OPTION_KEYS = [
	"customPrompt",
	"forceSystemPrompt",
	"selectedTools",
	"hiddenTools",
	"toolSnippets",
	"toolGuidelines",
	"promptGuidelines",
	"appendSystemPrompt",
	"sections",
	"cwd",
	"contextFiles",
	"skills",
] as const;

export function validatePromptOptions(options: BuildSystemPromptOptions): string[] {
	const problems: string[] = [];
	const known = new Set<string>(KNOWN_OPTION_KEYS);
	for (const key of Object.keys(options)) {
		if (!known.has(key)) problems.push(`unmapped systemPromptOptions field "${key}" — its content would never reach the wire`);
	}
	if (typeof options.cwd !== "string") problems.push("systemPromptOptions.cwd is not a string");
	return problems;
}

export const SCAN_GUIDELINE = "Scan from the repo or a named path, never / or $HOME";

export const BASH_FILE_OPS_GUIDELINE =
	"Use bash for file operations: ls to list; search text with rg, filenames with fd, code structure with ast-grep, JSON with jq. grep -r is blocked — rg does that job";

export const CHAT_PROMPT = "You are Joel's personal chat assistant.";

export function buildChatSystemPrompt(appendSystemPrompt?: string): string {
	const append = appendSystemPrompt?.trim();
	return append ? `${CHAT_PROMPT}\n\n${append}` : CHAT_PROMPT;
}

export const PROMPT_UNAVAILABLE = [
	"This request was built without a system prompt.",
	"",
	"The harness had no prompt options when it assembled it, so none of the seat's rules, skills, project context or working directory are loaded. Nothing you would need to do the work is present, and pi's own prompt is deliberately not sent in its place.",
	"",
	"Do not attempt the request, do not guess at what was asked, and call no tools. Reply with exactly this line and nothing else:",
	"",
	"This seat has no system prompt — the harness sent a request before it could build one. Send any message to restore it, then ask again.",
].join("\n");

export const OWNED_IDENTITY = "You are Joel's personal agent, working only for Joel. You operate inside Joel's custom pi-harness, developing software with him. Everything you read stays in context for the whole session and dilutes later turns: read the lines the job needs, search before reading, stop when you have the answer.";

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
	addGuideline(SCAN_GUIDELINE);
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
	return `Guidelines:\n${guidelinesList.map((g) => `- ${wireNamed(g, tools, wireToolName)}`).join("\n")}`;
}

export type WireToolName = (tool: string) => string;

const sameName: WireToolName = (tool) => tool;

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export function promptToolNames(options: BuildSystemPromptOptions, wireToolName: WireToolName = sameName): string[] {
	return (options.selectedTools || DEFAULT_TOOLS).map(wireToolName);
}

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
	const { customPrompt, forceSystemPrompt, selectedTools, hiddenTools, toolGuidelines, promptGuidelines, appendSystemPrompt } = options;
	if (forceSystemPrompt !== undefined) return forceSystemPrompt;
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const contextFiles = dedupeContextFiles(options.contextFiles ?? []);
	const skills = options.skills ?? [];
	const tools = selectedTools || DEFAULT_TOOLS;
	const declaredTools = tools.filter((name) => !hiddenTools?.includes(name));
	const guidelines = guidelinesSection(declaredTools, toolGuidelines, promptGuidelines, wireToolName);
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

function carriesSkillReader(tools: readonly string[]): boolean {
	return tools.includes("read") || tools.includes("bash");
}

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

export function codexInstructions(prompt: string, cwd: string): string {
	return `${prompt}\n\n${cwdBlockText(cwd)}`;
}

function contextSection(files: Array<{ path: string; content: string }>): string {
	if (files.length === 0) return "";
	let section = "\n\n<project_context>\n\n";
	section += "Project-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of files) {
		section += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	return `${section}</project_context>\n`;
}

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

