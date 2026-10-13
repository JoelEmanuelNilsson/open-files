const MENTION = /(?<![\w$\\])\$([a-z0-9][a-z0-9-]*)/g;

/** The `$…` being typed: token start, cursor anywhere in the token, empty allowed. */
export const MENTION_BEING_TYPED = /(?:^|[\s(\[{"'])\$([a-zA-Z0-9-]*)$/;

/** Mentioned skill names, first occurrence order, unknown names ignored. */
export function findSkillMentions(text: string, known: ReadonlySet<string>): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const name = match[1];
		if (!name || !known.has(name) || found.includes(name)) continue;
		found.push(name);
	}
	return found;
}
