/** The custom message type results arrive on; `agent-rows` renders it. */
export const AGENT_NOTIFICATION_TYPE = "subagent-notification";

/**
 * The task ids whose result notification is in these session entries: the
 * results that conversation received, seen in the file rather than inferred
 * from a record's `handed` mark.
 */
export function deliveredAgentTaskIds(entries: ReadonlyArray<{ type: string; customType?: string; content?: unknown }>): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== AGENT_NOTIFICATION_TYPE) continue;
		const content = entry.content;
		const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(blockText).join("") : "";
		for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) ids.add(match[1] as string);
	}
	return ids;
}

/** A content block read from the file is whatever the file holds: a text block's text, or nothing. */
function blockText(block: unknown): string {
	if (typeof block !== "object" || block === null) return "";
	// Safe: a non-null object, and both fields are read as unknown and checked.
	const { type, text } = block as { type?: unknown; text?: unknown };
	return type === "text" && typeof text === "string" ? text : "";
}
