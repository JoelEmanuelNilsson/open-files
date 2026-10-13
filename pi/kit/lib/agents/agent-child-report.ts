import type { AgentSession } from "@earendil-works/pi-coding-agent";

function lastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function closingTexts(session: AgentSession): string[] {
	const texts: string[] = [];
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role === "custom") continue;
		if (message?.role !== "assistant") break;
		if (message.content.some((block) => block.type === "toolCall")) break;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) texts.unshift(text);
	}
	return texts;
}

/** Said at the end of a report the child did not end with, so the seat knows why it has two messages. */
export const SIGN_OFF_NOTE = "[report taken from the message before the sign-off]";

export function childReport(session: AgentSession, lastText: string): string | undefined {
	const closing = closingTexts(session);
	const tail = lastText || closing[closing.length - 1] || lastAssistantText(session);
	if (tail === "") return undefined;
	if (closing[closing.length - 1] !== tail) return tail;
	if (!closing.some((text) => text.length > tail.length)) return tail;
	return [...closing, SIGN_OFF_NOTE].join("\n\n");
}
