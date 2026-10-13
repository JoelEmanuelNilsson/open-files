import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/** Opens the owned skills catalogue; context-view/system-prompt-measure.ts and the tests key on it. */
export const SKILLS_OPEN = "**SKILLS — READ BEFORE YOU ACT**";

type OwnedSkill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

/** The longest a catalogue description may run, in characters, before it is cut at a word. */
export const SKILL_DESCRIPTION_CAP = 200;

const FOREIGN_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
	plannotator: "Plannotator CLI: review plans and code, annotate files, URLs, folders, or a running app, and share Guided Reviews.",
};

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
	return `\n\n${SKILLS_OPEN}\n\nEach skill below is a file${where}. It holds the rules for one kind of task.\n\n**Read relevant skills before acting, unless already in context.**\n\n**If unsure whether it matches, treat it as relevant.** Paths inside a skill are relative to its directory.\n\n${entries.join("\n")}\n`;
}
