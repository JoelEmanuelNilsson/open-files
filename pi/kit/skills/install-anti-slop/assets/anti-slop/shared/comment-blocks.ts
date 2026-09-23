/**
 * A comment block is what a reader sees as one comment, and it is what both
 * comment rules judge: the parser hands out one `//` line at a time, so a
 * fifteen-line essay arrives as fifteen comments that are individually legal.
 */

/** The parser's comment, narrowed to the fields the comment rules read. */
export interface ParsedComment {
	readonly type: string;
	readonly value: string;
	readonly loc: {
		readonly start: { readonly line: number; readonly column: number };
		readonly end: { readonly line: number };
	};
}

/** One delimited comment, or a run of `//` lines on consecutive lines. */
export interface SlopCommentBlock {
	/** Non-empty lines of prose, delimiters and JSDoc asterisks stripped. */
	readonly proseLines: readonly string[];
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
}

/** Lines of prose one comment block may run to before it is an essay. */
export const DEFAULT_MAX_COMMENT_LINES = 3;

/** Openers that announce what the code below does instead of why it exists. */
export const DEFAULT_NARRATING_OPENERS = [
	"This function",
	"This method",
	"This class",
	"This module",
	"This file",
	"This component",
	"This type",
	"This interface",
	"This helper",
	"This code",
	"This block",
	"This loop",
	"This variable",
	"This constant",
	"Here we",
	"Here, we",
	"Here's",
	"Now we",
	"We then",
	"We now",
	"We first",
	"Note that",
	"Note:",
	"Notice that",
	"Remember that",
	"First,",
	"Second,",
	"Third,",
	"Then,",
	"Next,",
	"Finally,",
	"Lastly,",
	"The following",
	"As mentioned",
	"As you can see",
	"In this function",
	"In this method",
	"In other words",
	"Obviously,",
	"Basically,",
	"Simply put",
	"Helper function",
	"Helper to",
	"Utility function",
	"Loop over",
	"Loop through",
	"Iterate over",
	"Iterate through",
] as const;

const DIRECTIVE = /^(?:eslint-disable|eslint-enable|eslint-env|eslint\s|oxlint-disable|oxlint-enable|globals?\s|prettier-ignore|biome-ignore|dprint-ignore|deno-lint-ignore|@ts-(?:expect-error|ignore|nocheck)|istanbul ignore|[cv]8 ignore|node:coverage)/iu;

const LICENCE_OPENER = /^(?:copyright\b|\(c\)\s|©|spdx-licen[cs]e-identifier\s*:|@licen[cs]e\b|licen[cs]ed under\b)/iu;

const SAFETY_JUSTIFICATION = /^SAFETY\s*:/u;

const LICENCE_HEADER_LINES = 3;

interface OpenBlock {
	proseLines: string[];
	startLine: number;
	startColumn: number;
	endLine: number;
}

function proseOf(value: string): string[] {
	return value
		.split(/\r?\n/u)
		.map((line) => line.replace(/^\s*\*+\s?/u, "").trim())
		.filter((line) => line.length > 0);
}

function isDirective(proseLines: readonly string[]): boolean {
	const first = proseLines[0];
	return first === undefined || DIRECTIVE.test(first);
}

function isJustification(proseLines: readonly string[]): boolean {
	if (proseLines.some((line) => SAFETY_JUSTIFICATION.test(line))) return true;
	return proseLines.slice(0, LICENCE_HEADER_LINES).some((line) => LICENCE_OPENER.test(line));
}

/**
 * Group a file's comments into blocks, minus what neither rule judges:
 * shebangs, directives, licence headers, `SAFETY:` justifications. A directive
 * drops before grouping and a justification after: one interrupts a run, one is a run.
 */
export function commentBlocks(comments: readonly ParsedComment[]): readonly SlopCommentBlock[] {
	const blocks: OpenBlock[] = [];
	let run: OpenBlock | undefined;
	for (const comment of comments) {
		if (comment.type !== "Line" && comment.type !== "Block") continue;
		const proseLines = proseOf(comment.value);
		if (isDirective(proseLines)) continue;
		if (comment.type === "Line" && run !== undefined && run.endLine + 1 === comment.loc.start.line) {
			run.proseLines.push(...proseLines);
			run.endLine = comment.loc.end.line;
			continue;
		}
		const block: OpenBlock = {
			proseLines,
			startLine: comment.loc.start.line,
			startColumn: comment.loc.start.column,
			endLine: comment.loc.end.line,
		};
		blocks.push(block);
		run = comment.type === "Line" ? block : undefined;
	}
	return blocks.filter((block) => !isJustification(block.proseLines));
}

function opensWith(line: string, opener: string): boolean {
	const prefix = opener.toLowerCase();
	const candidate = line.toLowerCase();
	if (!candidate.startsWith(prefix)) return false;
	const lastPrefixCharacter = prefix.at(-1) ?? "";
	if (!/[\p{L}\p{N}]/u.test(lastPrefixCharacter)) return true;
	const nextCharacter = candidate.charAt(prefix.length);
	return nextCharacter === "" || !/[\p{L}\p{N}]/u.test(nextCharacter);
}

/** The configured prose-line cap, or the default when the option is absent or unusable. */
export function commentLineCap(option: unknown): number {
	if (typeof option !== "object" || option === null || !("maxLines" in option)) {
		return DEFAULT_MAX_COMMENT_LINES;
	}
	const configured = option.maxLines;
	if (typeof configured !== "number" || !Number.isInteger(configured) || configured < 1) {
		return DEFAULT_MAX_COMMENT_LINES;
	}
	return configured;
}

/** The configured openers, or the defaults when the option is absent or unusable. */
export function narratingOpeners(option: unknown): readonly string[] {
	if (typeof option !== "object" || option === null || !("openers" in option)) {
		return DEFAULT_NARRATING_OPENERS;
	}
	const configured = option.openers;
	if (!Array.isArray(configured)) return DEFAULT_NARRATING_OPENERS;
	const openers = configured.flatMap((opener) =>
		typeof opener === "string" && opener.trim().length > 0 ? [opener.trim()] : [],
	);
	return openers.length > 0 ? openers : DEFAULT_NARRATING_OPENERS;
}

/** The opener this block narrates with, or undefined when it opens with a reason. */
export function narratingOpener(block: SlopCommentBlock, openers: readonly string[]): string | undefined {
	const first = block.proseLines[0];
	if (first === undefined) return undefined;
	return openers.find((opener) => opensWith(first, opener));
}
