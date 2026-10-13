import {
	getMarkdownTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, type AutocompleteItem, type AutocompleteProvider, type Component } from "@earendil-works/pi-tui";
import { promptTargetClaimsInput } from "../../lib/session/prompt-target.ts";
import { CallHeader, headerPaints } from "../../lib/transcript/call-header.ts";
import { ResultRow, resultPaints } from "../../lib/transcript/result-row.ts";
import { setKnownSkills } from "../../lib/transcript/skill-read.ts";
import { transcriptEnabled } from "../../lib/transcript/tool-row.ts";
import { loadSkillCatalogue, type SkillRef } from "./skill-catalogue.ts";
import { findSkillMentions, MENTION_BEING_TYPED } from "./skill-mention-parse.ts";
import { frameSkillBlock, loadedSkillPaths, SKILL_MESSAGE } from "./skill-message.ts";

const MAX_SUGGESTIONS = 20;

const SKILL_LABEL = "Skill";

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

function mentionProvider(current: AutocompleteProvider, skills: () => SkillRef[]): AutocompleteProvider {
	return {
		triggerCharacters: [...(current.triggerCharacters ?? []), "$"],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const typed = (lines[cursorLine] ?? "").slice(0, cursorCol).match(MENTION_BEING_TYPED);
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
	const loaded = new Map<string, Set<string>>();
	const branch = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId() ?? "";
		let paths = loaded.get(id);
		if (!paths) {
			paths = loadedSkillPaths(ctx);
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
		setKnownSkills([...loadSkillCatalogue(pi)].map(([name, skill]) => [name, skill.path]));
		loaded.set(ctx.sessionManager.getSessionId() ?? "", loadedSkillPaths(ctx));
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) =>
			mentionProvider(current, () => [...loadSkillCatalogue(pi).values()]),
		);
	});

	pi.on("session_compact", (_event, ctx) => branch(ctx).clear());

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		if (promptTargetClaimsInput(ctx.sessionManager.getSessionId(), event)) return;
		if (event.text.startsWith("/")) return;

		const skills = loadSkillCatalogue(pi);
		const names = findSkillMentions(event.text, new Set(skills.keys()));
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
				content = frameSkillBlock(skill);
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
				{ deliverAs: event.streamingBehavior ?? "nextTurn" },
			);
		}
	});
}
