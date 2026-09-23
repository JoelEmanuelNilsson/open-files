/**
 * notify — desktop notification when pi finishes and wants you back.
 *
 * Fires on `agent_settled` (not `agent_end`), so automatic retries and
 * auto-compaction do not each produce a ping. Turns shorter than
 * `PI_NOTIFY_MIN_SECONDS` are skipped: if you were watching, you already know.
 *
 * The duration comes from the shared turn clock, which `zen-chrome` owns, so
 * the number in the ping is the number the user watched in the prompt-box
 * frame. It used to be a second clock kept here, anchored on a different event;
 * the two could not disagree while neither was on screen, and now one is.
 *
 * The limit that buys, stated: only a `tui` session publishes the clock, so a
 * headless `pi -p` run has no duration and sends nothing. A subagent cannot be
 * told apart from a top-level print session by mode alone, and one writer
 * matters more than notifying a script.
 *
 * Transports, picked by terminal, overridable with `PI_NOTIFY_MODE`:
 *   osc777    Ghostty, WezTerm, iTerm2, rxvt-unicode
 *   kitty     OSC 99
 *   osascript macOS fallback for Terminal.app and anything else
 *   bell      just \a
 *   off       nothing
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { terminalWrite } from "../lib/notice.ts";
import { isSideSession } from "../lib/side-flag.ts";
import { elapsedMs, ownsTurnClock, readTurnClock } from "../lib/turn-clock.ts";

type Mode = "osc777" | "kitty" | "osascript" | "bell" | "off";

const MODES: Mode[] = ["osc777", "kitty", "osascript", "bell", "off"];

const DEFAULT_MIN_SECONDS = 12;

function detectMode(): Mode {
	const forced = process.env.PI_NOTIFY_MODE as Mode | undefined;
	if (forced && MODES.includes(forced)) return forced;

	const term = process.env.TERM ?? "";
	const program = process.env.TERM_PROGRAM ?? "";

	if (term.includes("kitty") || program === "kitty") return "kitty";
	if (/ghostty|WezTerm|iTerm\.app|rio/i.test(program)) return "osc777";
	if (term.startsWith("rxvt-unicode")) return "osc777";
	if (process.platform === "darwin") return "osascript";
	return "bell";
}

function minSeconds(): number {
	const raw = Number(process.env.PI_NOTIFY_MIN_SECONDS);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_SECONDS;
}

/** Escape sequence payloads must not carry control characters or separators. */
function sanitize(text: string, max: number): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/[;\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Strip the markdown that would read as noise in a one-line notification. */
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

/**
 * The escape-sequence transports go through {@link terminalWrite}, which drops
 * them when no emulator is attached. Nothing here touches a stream directly, so
 * "no kit file writes to a process stream" stays a grep with one exempt module.
 */
function send(mode: Mode, title: string, body: string): void {
	switch (mode) {
		case "off":
			return;
		case "bell":
			terminalWrite("\u0007");
			return;
		case "osc777":
			terminalWrite(`\u001b]777;notify;${title};${body}\u0007`);
			return;
		case "kitty":
			terminalWrite(`\u001b]99;i=pi:d=0;${title}\u001b\\`);
			if (body) terminalWrite(`\u001b]99;i=pi:d=1:p=body;${body}\u001b\\`);
			return;
		case "osascript": {
			const escape = (value: string) => value.replace(/["\\]/g, "\\$&");
			execFile(
				"osascript",
				["-e", `display notification "${escape(body)}" with title "${escape(title)}"`],
				() => {},
			);
			return;
		}
	}
}

type TextPart = { type: "text"; text: string };

function isTextPart(part: unknown): part is TextPart {
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
	// A side thread finishing is not "pi is waiting for you".
	if (isSideSession()) return;

	let lastMessages: Array<{ role?: string; content?: unknown }> = [];
	let muted = false;

	pi.on("agent_end", (event) => {
		if (event.messages?.length) lastMessages = event.messages;
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Only the session the clock describes may report it. pi runs subagents
		// in-process on this same extension set, and a background agent finishing
		// is not "pi is waiting for you" — nor is its duration the one on screen.
		if (muted || !ownsTurnClock(ctx)) return;

		// Read rather than measured, and read in a way that does not care whether
		// zen-chrome's handler has already closed the turn: while one is running
		// this is its elapsed time, and once it has settled it is its total.
		const elapsed = elapsedMs(readTurnClock(), Date.now());
		if (elapsed === null) return;

		const elapsedSeconds = elapsed / 1000;
		if (elapsedSeconds < minSeconds()) return;

		const summary = sanitize(flattenMarkdown(lastAssistantText(lastMessages)), 180);
		const project = ctx.cwd.split("/").filter(Boolean).pop() ?? "pi";
		send(detectMode(), `π ${project} · ${Math.round(elapsedSeconds)}s`, summary || "Ready for input");
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
				send(detectMode(), "π test", "If you can read this, notifications work.");
			}
			ctx.ui.notify(
				`transport=${detectMode()} minSeconds=${minSeconds()} muted=${muted}`,
				"info",
			);
		},
	});
}
