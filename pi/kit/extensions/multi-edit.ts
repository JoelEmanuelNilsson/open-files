/**
 * multi-edit — replaces the built-in `edit` tool.
 *
 * Superset of the built-in schema:
 *   path + edits[]           one file, N replacements (identical to built-in)
 *   files[{path, edits[]}]   many files in one call
 *
 * Two things the built-in does not do:
 *   1. Dry run first. Every file is read and every replacement resolved in
 *      memory before a single byte is written, so a typo in edit 7 of 8 does
 *      not leave the tree half-edited.
 *   2. Ambiguity is an error. A non-unique `oldText` fails with the match count
 *      instead of silently taking the first hit. Pass `replaceAll` when you
 *      mean all of them.
 *
 * `details` keeps the built-in `EditToolDetails` shape ({diff, patch,
 * firstChangedLine}) so anything reading edit results downstream still works.
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	generateDiffString,
	generateUnifiedPatch,
	withFileMutationQueue,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { configuredMode, DiffView, diffPalette } from "../lib/diff-view.ts";
import { coerceDeclaredJsonArguments } from "../lib/tool-argument-coercion.ts";
import { toolHeader } from "./transcript/header.ts";
import { indented, ResultRow, resultPaints } from "./transcript/result.ts";
import { rowState, stopClock, transcriptEnabled } from "./transcript/row.ts";
import type { Summary } from "./transcript/summary.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// One definition for both uses: the wire inlines the schema per use, so a
// second copy is a second place for the field descriptions to go missing.
const editSchema = Type.Object({
	oldText: Type.String({ description: "Exact text to find. Must match the file byte for byte." }),
	newText: Type.Optional(Type.String({ description: "Replacement text. Omit it to delete the matched text." })),
	replaceAll: Type.Optional(
		Type.Boolean({ description: "Replace every occurrence. Without it, oldText must be unique." }),
	),
});

const fileSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
	edits: Type.Array(editSchema, { description: "Replacements applied to this file." }),
});

const parameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)." })),
	edits: Type.Optional(
		Type.Array(editSchema, {
			description: "Replacements applied to `path`. Each oldText is matched against the original file.",
		}),
	),
	files: Type.Optional(
		Type.Array(fileSchema, {
			description: "Edit several files in one call. Use instead of path+edits, not alongside them.",
		}),
	),
});

type Edit = { oldText: string; newText?: string; replaceAll?: boolean };
type FileEdits = { path: string; edits: Edit[] };

interface EditToolDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlf = (content.match(/\r\n/g) ?? []).length;
	const lf = (content.match(/\n/g) ?? []).length;
	return crlf > 0 && crlf >= lf / 2 ? "\r\n" : "\n";
}

const toLF = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const restoreEndings = (text: string, ending: "\r\n" | "\n") =>
	ending === "\n" ? text : text.replace(/\n/g, "\r\n");

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Collapse the differences that survive a copy/paste round trip. */
function normalizeLoosely(line: string): string {
	return line
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u2018\u2019\u201a\u201b]/g, "'")
		.replace(/[\u201c\u201d\u201e\u201f]/g, '"')
		.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
		.trimEnd();
}

type Range = { start: number; end: number; newText: string };

function findExact(content: string, needle: string): number[] {
	const hits: number[] = [];
	let from = 0;
	for (;;) {
		const index = content.indexOf(needle, from);
		if (index === -1) return hits;
		hits.push(index);
		from = index + Math.max(needle.length, 1);
	}
}

/**
 * Whole-line fallback for when the model's copy of the text drifted in
 * whitespace or unicode punctuation. Matches line windows, replaces original
 * lines, so untouched bytes stay untouched.
 */
function findLooseLineWindow(content: string, needle: string): number[] {
	const contentLines = content.split("\n");
	const needleLines = needle.replace(/\n$/, "").split("\n");
	if (needleLines.length === 0) return [];

	const offsets: number[] = [];
	let offset = 0;
	for (const line of contentLines) {
		offsets.push(offset);
		offset += line.length + 1;
	}

	const normalizedContent = contentLines.map(normalizeLoosely);
	const normalizedNeedle = needleLines.map(normalizeLoosely);

	const hits: number[] = [];
	for (let i = 0; i + normalizedNeedle.length <= normalizedContent.length; i++) {
		let ok = true;
		for (let j = 0; j < normalizedNeedle.length; j++) {
			if (normalizedContent[i + j] !== normalizedNeedle[j]) {
				ok = false;
				break;
			}
		}
		if (ok) hits.push(i);
	}
	return hits.map((lineIndex) => offsets[lineIndex]);
}

function lineWindowLength(content: string, startOffset: number, lineCount: number): number {
	let offset = startOffset;
	for (let i = 0; i < lineCount; i++) {
		const next = content.indexOf("\n", offset);
		if (next === -1) return content.length - startOffset;
		offset = next + 1;
	}
	return offset - startOffset - 1;
}

function resolveEdits(path: string, content: string, edits: Edit[]): Range[] {
	const ranges: Range[] = [];

	edits.forEach((edit, index) => {
		const label = `${path} edit ${index + 1}/${edits.length}`;
		// An absent newText is how a model says "delete this", so it means the empty string.
		const newText = edit.newText ?? "";
		if (edit.oldText === newText) {
			throw new Error(`${label}: oldText and newText are identical, nothing to do.`);
		}
		if (edit.oldText === "") {
			throw new Error(`${label}: oldText is empty. Use the write tool to create or overwrite a file.`);
		}

		let hits = findExact(content, edit.oldText);
		let matchLength = edit.oldText.length;

		if (hits.length === 0) {
			const loose = findLooseLineWindow(content, edit.oldText);
			if (loose.length === 0) {
				throw new Error(
					`${label}: oldText not found. It must match the file exactly, including indentation and line breaks.`,
				);
			}
			if (loose.length > 1 && !edit.replaceAll) {
				throw new Error(
					`${label}: oldText matches ${loose.length} places (whitespace-insensitive). Add surrounding lines to make it unique, or set replaceAll.`,
				);
			}
			hits = loose;
			matchLength = lineWindowLength(content, loose[0], edit.oldText.replace(/\n$/, "").split("\n").length);
		} else if (hits.length > 1 && !edit.replaceAll) {
			throw new Error(
				`${label}: oldText matches ${hits.length} places. Add surrounding context to make it unique, or set replaceAll.`,
			);
		}

		const targets = edit.replaceAll ? hits : [hits[0]];
		for (const start of targets) {
			const length = matchLength === edit.oldText.length ? matchLength : lineWindowLength(content, start, edit.oldText.replace(/\n$/, "").split("\n").length);
			ranges.push({ start, end: start + length, newText });
		}
	});

	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].start < sorted[i - 1].end) {
			throw new Error(
				`${path}: two edits overlap around offset ${sorted[i].start}. Merge them into a single edit.`,
			);
		}
	}
	return sorted;
}

function applyRanges(content: string, ranges: Range[]): string {
	let result = content;
	for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
		result = result.slice(0, range.start) + range.newText + result.slice(range.end);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Planning and execution
// ---------------------------------------------------------------------------

type Change = {
	path: string;
	absolutePath: string;
	before: string;
	after: string;
	bom: string;
	ending: "\r\n" | "\n";
};

// A byte-order mark is invisible to the model, so it can never be part of an
// oldText: it comes off before matching and goes back on at the write (pi's
// built-in `splitBom`).
const splitBom = (text: string): { bom: string; text: string } =>
	text.startsWith("\ufeff") ? { bom: "\ufeff", text: text.slice(1) } : { bom: "", text };

const stripAt = (path: string) => (path.startsWith("@") ? path.slice(1) : path);

function absolute(cwd: string, path: string): string {
	const clean = stripAt(path).trim();
	if (!clean) throw new Error("Empty path.");
	return isAbsolute(clean) ? resolve(clean) : resolve(cwd, clean);
}

function display(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	return rel && !rel.startsWith("..") ? rel : absolutePath;
}

async function readIfExists(absolutePath: string): Promise<string | undefined> {
	try {
		return await readFile(absolutePath, "utf8");
	} catch {
		return undefined;
	}
}

async function planFileEdits(cwd: string, targets: FileEdits[]): Promise<Change[]> {
	const changes: Change[] = [];

	for (const target of targets) {
		const absolutePath = absolute(cwd, target.path);
		const shown = display(cwd, absolutePath);

		if (target.edits.length === 0) throw new Error(`${shown}: no edits given.`);

		const raw = await readIfExists(absolutePath);
		if (raw === undefined) {
			throw new Error(`${shown}: file not found. Use the write tool to create it.`);
		}
		await access(absolutePath, constants.R_OK | constants.W_OK).catch(() => {
			throw new Error(`${shown}: not writable.`);
		});

		const { bom, text: original } = splitBom(raw);
		const ending = detectLineEnding(original);
		const before = toLF(original);
		const after = applyRanges(before, resolveEdits(shown, before, target.edits));
		if (after === before) throw new Error(`${shown}: edits produced no change.`);

		changes.push({ path: shown, absolutePath, before, after, bom, ending });
	}

	return changes;
}

async function commit(changes: Change[]): Promise<string[]> {
	const written: string[] = [];

	for (const change of changes) {
		await withFileMutationQueue(change.absolutePath, async () => {
			const onDisk = await readIfExists(change.absolutePath);
			if (onDisk !== undefined && toLF(splitBom(onDisk).text) !== change.before) {
				throw new Error(
					`${change.path}: changed on disk between the dry run and the write. Re-read it and retry.` +
						(written.length ? ` Already written: ${written.join(", ")}.` : ""),
				);
			}
			await writeFile(change.absolutePath, change.bom + restoreEndings(change.after, change.ending), "utf8");
		});
		written.push(change.path);
	}

	return written;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * What changed, counted off the diff this tool just produced.
 *
 * `generateDiffString` emits `sign + line number + text`, one row per line, and
 * `execute` prefixes each file with `File: path` when there is more than one.
 * Counting those is reading a format this file owns, not guessing at the shape
 * of some text.
 */
function changeSummary(diff: string): Summary {
	let added = 0;
	let removed = 0;
	let files = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("File: ")) files++;
		else if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const count = Math.max(files, 1);
	return { kind: "note", text: `${count} file${count === 1 ? "" : "s"}, +${added} \u2212${removed}`, tone: "muted" };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description:
			"Edit files by exact text replacement. Two forms, never both in one call: `path` + `edits[]` for one file, or `files[]` for several files. All replacements are dry run first: if any of them fails, nothing is written. Each oldText must be unique in the file unless you set replaceAll. The file must exist — use write to create one.",
		promptSnippet: "Make precise file edits with exact text replacement, across one or many files in a single call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match the file exactly)",
			"When changing several places in one file, use one edit call with multiple entries in edits[]",
			"When changing several files at once, use one edit call with files[{path, edits}] instead of one call per file",
			"Each edits[].oldText is matched against the original file, not against earlier edits in the same call. Do not emit overlapping edits.",
			"Keep edits[].oldText minimal but unique. If edit reports N matches, add surrounding context rather than retrying the same text.",
		],
		parameters,

		/** Accept the shapes older sessions and other agents emit, and a parameter sent as a string of JSON. */
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = { ...(coerceDeclaredJsonArguments(parameters, args) as Record<string, unknown>) };

			if (typeof input.oldText === "string" && (input.newText === undefined || typeof input.newText === "string")) {
				const edits = Array.isArray(input.edits) ? input.edits : [];
				input.edits = [...edits, { oldText: input.oldText, newText: input.newText }];
				delete input.oldText;
				delete input.newText;
			}

			if (Array.isArray(input.multi)) {
				const grouped = new Map<string, Edit[]>();
				for (const raw of input.multi as Array<Record<string, unknown>>) {
					const path = String(raw.path ?? input.path ?? "");
					const list = grouped.get(path) ?? [];
					list.push({ oldText: String(raw.oldText ?? ""), newText: String(raw.newText ?? "") });
					grouped.set(path, list);
				}
				const files = Array.isArray(input.files) ? (input.files as unknown[]) : [];
				input.files = [...files, ...[...grouped].map(([path, edits]) => ({ path, edits }))];
				delete input.multi;
			}

			return input;
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, edits, files } = params;
			// The two forms are exclusive in the description but not in the schema:
			// pi-ai reduces a tool's parameters to {type, properties, required} for
			// the Anthropic wire, so a top-level anyOf would never reach the model.
			if (edits?.length && files?.length) {
				throw new Error("Use `path` + `edits[]` or `files[]`, not both.");
			}

			const targets: FileEdits[] = [];
			if (edits?.length) {
				if (!path) throw new Error("`edits` needs a `path`. Use `files[]` for multiple files.");
				targets.push({ path, edits });
			}
			for (const file of files ?? []) {
				targets.push({ path: file.path ?? path ?? "", edits: file.edits });
			}
			if (targets.length === 0) {
				throw new Error("Nothing to do: provide path+edits or files[].");
			}
			const changes = await planFileEdits(ctx.cwd, targets);

			if (signal?.aborted) throw new Error("Aborted before writing.");

			const written = await commit(changes);

			const multiFile = changes.length > 1;
			const diff = changes
				.map((change) => {
					const body = generateDiffString(change.before, change.after).diff;
					return multiFile ? `File: ${change.path}\n${body}` : body;
				})
				.join("\n\n");
			const unified = changes
				.map((change) => generateUnifiedPatch(change.path, change.before, change.after))
				.join("\n");
			const firstChangedLine = generateDiffString(changes[0].before, changes[0].after).firstChangedLine;

			const summary = changes.map((change) => `Edited ${change.path}`).join("\n");

			const details: EditToolDetails = { diff, patch: unified, firstChangedLine };
			return {
				content: [{ type: "text", text: `${summary}\n(${written.length} file(s) written)` }],
				details,
			};
		},

		// One blank line above the row, no padded box: the header and the diff are
		// the frame. See `transcript/index.ts` for why the default shell is wrong for
		// a row this shape.
		renderShell: "self",

		renderCall(args, theme, context) {
			if (transcriptEnabled()) return toolHeader("edit", args, theme, context);

			const input = (args ?? {}) as {
				path?: string;
				edits?: unknown[];
				files?: Array<{ path?: string; edits?: unknown[] }>;
			};
			const text = theme.fg("toolTitle", theme.bold("edit "));

			const parts: string[] = [];
			if (input.path && input.edits) parts.push(`${input.path} (${input.edits.length})`);
			for (const file of input.files ?? []) {
				parts.push(`${file.path ?? "?"} (${file.edits?.length ?? 0})`);
			}
			return new Text(text + theme.fg("muted", parts.join(", ") || input.path || ""), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as EditToolDetails | undefined;
			const duration = stopClock(context);
			// The header drew before the edit ran, so the line it changed can only
			// reach the link from here. Both slots share `context.state`; the guard is
			// what keeps the one extra render from becoming a loop.
			const state = rowState(context);
			if (details?.firstChangedLine !== undefined && state.line === undefined) {
				state.line = details.firstChangedLine;
				// A renderer must not throw, and a caller that hands over a bare context
				// (the render tests do) is not a reason to lose the diff.
				if (typeof context.invalidate === "function") context.invalidate();
			}
			const text = result.content?.find((part) => part.type === "text");
			const output = text && "text" in text ? text.text : "";

			if (!transcriptEnabled()) {
				if (isPartial) return new Text(theme.fg("dim", "editing…"), 0, 0);
				if (!details?.diff) return new Text(theme.fg("dim", output), 0, 0);
				return new DiffView(details.diff, diffPalette(theme), configuredMode(), expanded);
			}

			const paints = resultPaints(theme);
			if (isPartial || !details?.diff) {
				const row = context.lastComponent instanceof ResultRow ? context.lastComponent : new ResultRow();
				row.set(
					{
						summary: isPartial ? null : { kind: "note", text: output.split("\n")[0] ?? "", tone: "muted" },
						tail: isPartial ? "editing…" : undefined,
						body: isPartial ? undefined : output.split("\n"),
						error: context.isError,
						duration,
						expanded,
					},
					paints,
				);
				return row;
			}

			// The diff is the answer, so it keeps its own renderer and sits under the
			// gutter rather than beside it. The line above it counts what changed, in
			// the same grammar every other tool's result line uses.
			const counted = new ResultRow();
			counted.set({ summary: changeSummary(details.diff), error: false, duration, expanded }, paints);
			const stacked = new Container();
			stacked.addChild(counted);
			stacked.addChild(indented(new DiffView(details.diff, diffPalette(theme), configuredMode(), expanded)));
			return stacked;
		},
	});
}
