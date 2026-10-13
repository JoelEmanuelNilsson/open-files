/** One replacement as the model asked for it; an absent `newText` deletes the match. */
export type TextEdit = { oldText: string; newText?: string; replaceAll?: boolean };

function normalizeLoosely(line: string): string {
	return line
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u2018\u2019\u201a\u201b]/g, "'")
		.replace(/[\u201c\u201d\u201e\u201f]/g, '"')
		.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
		.trimEnd();
}

/** One resolved replacement: the span of the original text it covers, and what goes there. */
export type EditRange = { start: number; end: number; newText: string };

type Match = { start: number; length: number };

function findExact(content: string, needle: string): Match[] {
	const hits: Match[] = [];
	let from = 0;
	for (;;) {
		const index = content.indexOf(needle, from);
		if (index === -1) return hits;
		hits.push({ start: index, length: needle.length });
		from = index + Math.max(needle.length, 1);
	}
}

function findLooseLineWindow(content: string, needle: string): Match[] {
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
	const breakAfter = needle.endsWith("\n") ? 1 : 0;
	return hits.map((lineIndex) => {
		const start = offsets[lineIndex];
		const length = lineWindowLength(content, start, normalizedNeedle.length);
		return { start, length: content[start + length] === "\n" ? length + breakAfter : length };
	});
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

export function resolveEditRanges(path: string, content: string, edits: TextEdit[]): EditRange[] {
	const ranges: EditRange[] = [];

	edits.forEach((edit, index) => {
		const label = `${path} edit ${index + 1}/${edits.length}`;
		const newText = edit.newText ?? "";
		if (edit.oldText === newText) {
			throw new Error(`${label}: oldText and newText are identical, nothing to do.`);
		}
		if (edit.oldText === "") {
			throw new Error(`${label}: oldText is empty. Use the write tool to create or overwrite a file.`);
		}

		let hits = findExact(content, edit.oldText);

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
		} else if (hits.length > 1 && !edit.replaceAll) {
			throw new Error(
				`${label}: oldText matches ${hits.length} places. Add surrounding context to make it unique, or set replaceAll.`,
			);
		}

		const targets = edit.replaceAll ? hits : [hits[0]];
		for (const { start, length } of targets) ranges.push({ start, end: start + length, newText });
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

/** `content` with every range replaced, applied back to front so earlier offsets stay true. */
export function applyEditRanges(content: string, ranges: EditRange[]): string {
	let result = content;
	for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
		result = result.slice(0, range.start) + range.newText + result.slice(range.end);
	}
	return result;
}
