/** The custom message type results arrive on; `agent-rows` renders it. */
export const AGENT_NOTIFICATION_TYPE = "subagent-notification";

export function deliveredAgentTaskIds(entries: ReadonlyArray<{ type: string; customType?: string; content?: unknown }>): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== AGENT_NOTIFICATION_TYPE) continue;
		const content = entry.content;
		const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(blockText).join("") : "";
		for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
			// SAFETY: match[1] is a required capture group of the regex, so it is always a string
			ids.add(match[1] as string);
		}
	}
	return ids;
}

function blockText(block: unknown): string {
	if (typeof block !== "object" || block === null) return "";
	// SAFETY: block was checked to be a non-null object; fields are read through typeof checks
	const { type, text } = block as { type?: unknown; text?: unknown };
	return type === "text" && typeof text === "string" ? text : "";
}
