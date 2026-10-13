import { readFileSync } from "node:fs";
import { stripFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SkillRef } from "./skill-catalogue.ts";

/** customType of the injected skill message. Matches the renderer in index.ts. */
export const SKILL_MESSAGE = "pi-kit-skill";

/** pi's own framing, byte for byte, so the transcript and the model see what `/skill:name` produces. */
export function frameSkillBlock(skill: SkillRef): string {
	const body = stripFrontmatter(readFileSync(skill.path, "utf-8")).trim();
	return `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

/** Skills already in this branch's context, reset at each compaction boundary. */
export function loadedSkillPaths(ctx: ExtensionContext): Set<string> {
	const paths = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		// SAFETY: session entries are a union of shapes; the optional fields are read only after the type tag checks
		const candidate = entry as { type?: string; customType?: string; details?: { path?: string } };
		if (candidate.type === "compaction") paths.clear();
		if (candidate.type !== "custom_message" || candidate.customType !== SKILL_MESSAGE) continue;
		if (candidate.details?.path) paths.add(candidate.details.path);
	}
	return paths;
}
