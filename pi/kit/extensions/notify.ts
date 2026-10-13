import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { elapsedMs, ownsTurnClock, readTurnClock } from "../lib/session/turn-clock.ts";

const DEFAULT_MIN_SECONDS = 12;

function minSeconds(): number {
	const raw = Number(process.env.PI_NOTIFY_MIN_SECONDS);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_SECONDS;
}

function sanitize(text: string, max: number): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/[;\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function flattenMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " (code) ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}[-*+]\s+/gm, "• ")
		.replace(/(\*\*|__|\*|_|~~)/g, "");
}

function send(title: string, body: string): void {
	const escape = (value: string) => value.replace(/["\\]/g, "\\$&");
	execFile("osascript", ["-e", `display notification "${escape(body)}" with title "${escape(title)}"`], () => {});
}

type TextPart = { type: "text"; text: string };

function isTextPart(part: unknown): part is TextPart {
	// SAFETY: the Boolean(part) && typeof object guard makes the property read safe; type is compared, not trusted
	return Boolean(part) && typeof part === "object" && (part as TextPart).type === "text";
}

function lastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter(isTextPart)
				.map((part) => part.text)
				.join("\n");
		}
		return "";
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	let lastMessages: Array<{ role?: string; content?: unknown }> = [];
	let muted = false;

	pi.on("agent_end", (event) => {
		if (event.messages?.length) lastMessages = event.messages;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (muted || !ownsTurnClock(ctx)) return;

		const elapsed = elapsedMs(readTurnClock(), Date.now());
		if (elapsed === null) return;

		const elapsedSeconds = elapsed / 1000;
		if (elapsedSeconds < minSeconds()) return;

		const summary = sanitize(flattenMarkdown(lastAssistantText(lastMessages)), 180);
		const project = ctx.cwd.split("/").filter(Boolean).pop() ?? "pi";
		send(`π ${project} · ${Math.round(elapsedSeconds)}s`, summary || "Ready for input");
	});

	pi.registerCommand("notify", {
		description: "[test|mute|unmute] — desktop notification settings",
		getArgumentCompletions: (prefix) =>
			["test", "mute", "unmute"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (command === "mute" || command === "unmute") {
				muted = command === "mute";
				ctx.ui.notify(`Notifications ${muted ? "muted" : "unmuted"}`, "info");
				return;
			}
			if (command === "test") {
				send("π test", "If you can read this, notifications work.");
			}
			ctx.ui.notify(
				`minSeconds=${minSeconds()} muted=${muted}`,
				"info",
			);
		},
	});
}
