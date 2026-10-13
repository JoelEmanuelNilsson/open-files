import { dirname } from "node:path";

/** One mentionable skill: its name, what it says it does, and where its SKILL.md lives. */
export interface SkillRef {
	name: string;
	description: string;
	path: string;
	baseDir: string;
	scope: string;
}

/** The slice of pi's ExtensionAPI the catalogue reads. */
export type SkillCommands = {
	getCommands(): Array<{
		name: string;
		description?: string;
		source: string;
		sourceInfo: { path: string; baseDir?: string; scope: string };
	}>;
};

/** Live skill list, rebuilt per call so `/reload` shows up immediately. */
export function loadSkillCatalogue(pi: SkillCommands): Map<string, SkillRef> {
	const skills = new Map<string, SkillRef>();
	for (const command of pi.getCommands()) {
		if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
		const name = command.name.slice("skill:".length);
		skills.set(name, {
			name,
			description: command.description ?? "",
			path: command.sourceInfo.path,
			baseDir: command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path),
			scope: command.sourceInfo.scope,
		});
	}
	return skills;
}
