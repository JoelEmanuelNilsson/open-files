const SKILL_OPEN_TAG = /^<skill name="([^"\r\n]+)"(?: location="[^"\r\n]*")?>\r?$/gm;
const ANY_SKILL_OPEN_TAG = /^<skill(?:\s|>)[^\r\n]*\r?$/gm;
const SKILL_CLOSE_TAG = /^<\/skill>\r?$/gm;

/** One display segment from a user message containing attached skills. */
export type SkillPreviewSegment =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "skill"; readonly name: string };

interface TagSpan {
	readonly start: number;
	readonly end: number;
}

interface SkillOpenTag extends TagSpan {
	readonly name: string;
}

export function splitSkillPreview(text: string): SkillPreviewSegment[] {
	const openings = collectOpenTags(text);
	const openingBoundaries = collectTagSpans(text, ANY_SKILL_OPEN_TAG);
	const closings = collectTagSpans(text, SKILL_CLOSE_TAG);
	const segments: SkillPreviewSegment[] = [];
	let textStart = 0;
	let openingBoundaryIndex = 0;
	let closingIndex = 0;

	for (let openingIndex = 0; openingIndex < openings.length; openingIndex++) {
		const opening = openings[openingIndex];
		if (opening === undefined || opening.start < textStart) continue;
		while ((closings[closingIndex]?.start ?? text.length) < opening.end) closingIndex++;
		const closing = closings[closingIndex];
		if (closing === undefined) continue;

		while ((openingBoundaries[openingBoundaryIndex]?.start ?? text.length) <= opening.start) {
			openingBoundaryIndex++;
		}
		const nextOpening = openingBoundaries[openingBoundaryIndex];
		if (nextOpening !== undefined && nextOpening.start < closing.start) continue;

		pushTextSegment(segments, text.slice(textStart, opening.start));
		segments.push({ type: "skill", name: opening.name });
		textStart = closing.end;
		closingIndex++;
	}

	pushTextSegment(segments, text.slice(textStart));
	return segments;
}

function collectOpenTags(text: string): SkillOpenTag[] {
	return [...text.matchAll(SKILL_OPEN_TAG)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
		name: match[1] ?? "",
	}));
}

function collectTagSpans(text: string, expression: RegExp): TagSpan[] {
	return [...text.matchAll(expression)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}

function pushTextSegment(segments: SkillPreviewSegment[], text: string): void {
	if (text.length > 0) segments.push({ type: "text", text });
}
