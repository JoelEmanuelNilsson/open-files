/**
 * skill-mentions — `$name` pulls a skill into the turn, from anywhere in the draft.
 *
 * Codex has this; pi has all the parts but no wiring. The parts:
 *
 *   1. Autocomplete providers declare `triggerCharacters`, and the editor builds
 *      its trigger regex from them as `(?:^|\s)[@#$][^\s]*$`. That is already
 *      Codex's rule: token start, anywhere in the draft, empty token allowed, so
 *      a bare `$` opens the popup. Slash commands are the ones pinned to
 *      position 0 of line 0.
 *   2. `pi.getCommands()` rebuilds the skill list from the resource loader on
 *      every call, so `/reload` lands without a restart, and it includes
 *      `disable-model-invocation` skills, which are exactly the ones that want
 *      an explicit trigger.
 *   3. The `input` event fires inside `session.prompt()` before skill and
 *      template expansion and before the streaming branch, so one hook covers
 *      idle, steer, and follow-up.
 *
 * What it does NOT do is rewrite the message. pi only pretty-renders one
 * `<skill>` block per user message (`parseSkillBlock` is anchored), so a
 * transform would turn two mentions into a wall of raw XML in the transcript.
 * Instead each skill is sent as its own custom message carrying pi's exact
 * `<skill>` framing and folded into context as a user-role message. Any number
 * of mentions, each one a `● Skill(name)` row, and the message you typed stays
 * the message you typed.
 *
 * The row is the transcript's, not pi's. pi's `SkillInvocationMessageComponent`
 * is a `Box` with a column of padding, and `CustomMessageComponent` puts a
 * `Spacer` above it, so one line of text arrived with three blank lines above
 * and two below — five rows to say `design-page`. `skillRow` below is the same
 * receipt every tool call wears: one blank above, one line, nothing after.
 *
 * A skill loads once per branch. Asking for it again is a no-op with a toast,
 * because a second copy costs the same tokens and tells the model nothing new.
 * Compaction resets that: the text is gone, so the next `$name` reloads it.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	getMarkdownTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, type AutocompleteItem, type AutocompleteProvider, type Component } from "@earendil-works/pi-tui";
import { isSideSession } from "../lib/side-flag.ts";
import { CallHeader, headerPaints } from "./transcript/header.ts";
import { ResultRow, resultPaints } from "./transcript/result.ts";
import { transcriptEnabled } from "./transcript/row.ts";

/** customType of the injected skill message. Matches the renderer below. */
export const SKILL_MESSAGE = "pi-kit-skill";

const MAX_SUGGESTIONS = 20;

/** Skill names are lowercase per the Agent Skills spec, so `$PATH` can never match one. */
const MENTION = /(?<![\w$\\])\$([a-z0-9][a-z0-9-]*)/g;

/** The `$…` being typed: token start, cursor anywhere in the token, empty allowed. */
const TYPING = /(?:^|[\s(\[{"'])\$([a-zA-Z0-9-]*)$/;

export interface SkillRef {
	name: string;
	description: string;
	path: string;
	baseDir: string;
	scope: string;
}

type Commands = {
	getCommands(): Array<{
		name: string;
		description?: string;
		source: string;
		sourceInfo: { path: string; baseDir?: string; scope: string };
	}>;
};

/** Live skill list, rebuilt per call so `/reload` shows up immediately. */
export function catalogue(pi: Commands): Map<string, SkillRef> {
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

/** Mentioned skill names, first occurrence order, unknown names ignored. */
export function mentionsIn(text: string, known: ReadonlySet<string>): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const name = match[1];
		if (!name || !known.has(name) || found.includes(name)) continue;
		found.push(name);
	}
	return found;
}

/** The bold name on a skill's row. Not a tool, but it wears a tool's receipt. */
const SKILL_LABEL = "Skill";

/**
 * The row a loaded skill leaves behind: `● Skill(design-page)`, one line.
 *
 * Collapsed it is the header alone. `ctrl+o` puts the skill's own text under
 * the gutter, verbatim — which is the text the model was handed, and needs no
 * Markdown renderer and so no initialised theme to draw.
 */
export function skillRow(block: { name: string; content: string }, theme: Theme, expanded: boolean): Component {
	const header = new CallHeader();
	header.set(
		{ state: "done", name: SKILL_LABEL, argument: block.name, clipEnd: "tail", expanded },
		headerPaints(theme, "done"),
	);
	if (!expanded) return header;
	const body = new ResultRow();
	body.set(
		{ summary: null, preview: block.content.split("\n"), error: false, duration: null, expanded: true },
		resultPaints(theme),
	);
	const row = new Container();
	row.addChild(header);
	row.addChild(body);
	return row;
}

/** pi's own framing, byte for byte, so the transcript and the model see what `/skill:name` produces. */
export function skillBlock(skill: SkillRef): string {
	const body = stripFrontmatter(readFileSync(skill.path, "utf-8")).trim();
	return `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

/** Skills already in this branch's context, reset at each compaction boundary. */
function replay(ctx: ExtensionContext): Set<string> {
	const paths = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		const candidate = entry as { type?: string; customType?: string; details?: { path?: string } };
		if (candidate.type === "compaction") paths.clear();
		if (candidate.type !== "custom_message" || candidate.customType !== SKILL_MESSAGE) continue;
		if (candidate.details?.path) paths.add(candidate.details.path);
	}
	return paths;
}

function label(skill: SkillRef): AutocompleteItem {
	const scope = skill.scope === "user" ? "" : ` [${skill.scope}]`;
	return { value: `$${skill.name}`, label: `$${skill.name}`, description: `${skill.description}${scope}` };
}

export function suggest(skills: SkillRef[], query: string): AutocompleteItem[] {
	if (!query) {
		return [...skills]
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, MAX_SUGGESTIONS)
			.map(label);
	}
	return fuzzyFilter(skills, query, (skill) => `${skill.name} ${skill.description}`)
		.slice(0, MAX_SUGGESTIONS)
		.map(label);
}

/**
 * The built-in applyCompletion would treat `$name` as a file path or a command
 * argument, so mention insertion is ours: replace the token, add one space.
 */
function mentionProvider(current: AutocompleteProvider, skills: () => SkillRef[]): AutocompleteProvider {
	return {
		triggerCharacters: [...(current.triggerCharacters ?? []), "$"],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const typed = (lines[cursorLine] ?? "").slice(0, cursorCol).match(TYPING);
			if (!typed) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const items = suggest(skills(), typed[1] ?? "");
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: `$${typed[1] ?? ""}` };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$") || !item.value.startsWith("$")) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol - prefix.length);
			const insert = `${item.value} `;
			const next = [...lines];
			next[cursorLine] = before + insert + line.slice(cursorCol);
			return { lines: next, cursorLine, cursorCol: before.length + insert.length };
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI) {
	if (isSideSession()) return;

	/** sessionId -> SKILL.md paths already injected on the current branch. */
	const loaded = new Map<string, Set<string>>();
	const branch = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId() ?? "";
		let paths = loaded.get(id);
		if (!paths) {
			paths = replay(ctx);
			loaded.set(id, paths);
		}
		return paths;
	};

	pi.registerMessageRenderer(SKILL_MESSAGE, (message, options, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		const block = parseSkillBlock(text);
		if (!block) return undefined;
		if (transcriptEnabled()) return skillRow(block, theme, options.expanded);
		const component = new SkillInvocationMessageComponent(block, getMarkdownTheme());
		component.setExpanded(options.expanded);
		return component;
	});

	pi.on("session_start", (_event, ctx) => {
		loaded.set(ctx.sessionManager.getSessionId() ?? "", replay(ctx));
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) =>
			mentionProvider(current, () => [...catalogue(pi).values()]),
		);
	});

	// Compaction drops the injected text, so the next mention has to load it again.
	pi.on("session_compact", (_event, ctx) => branch(ctx).clear());

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		// `input` runs before /skill: and /template expansion; prepending anything
		// to a command would break the expander's startsWith check.
		if (event.text.startsWith("/")) return;

		const skills = catalogue(pi);
		const names = mentionsIn(event.text, new Set(skills.keys()));
		if (names.length === 0) return;

		const already = branch(ctx);
		for (const name of names) {
			const skill = skills.get(name);
			if (!skill) continue;
			if (already.has(skill.path)) {
				ctx.ui.notify(`$${name} is already loaded in this session`, "info");
				continue;
			}
			let content: string;
			try {
				content = skillBlock(skill);
			} catch (err) {
				ctx.ui.notify(`$${name}: ${err instanceof Error ? err.message : String(err)}`, "error");
				continue;
			}
			already.add(skill.path);
			pi.sendMessage(
				{
					customType: SKILL_MESSAGE,
					content,
					display: true,
					details: { name: skill.name, path: skill.path, baseDir: skill.baseDir },
				},
				// Idle: "nextTurn" lands in the turn this very prompt is building.
				// Streaming: match how the user's own message is being queued.
				{ deliverAs: event.streamingBehavior ?? "nextTurn" },
			);
		}
	});
}
