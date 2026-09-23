/**
 * read-memo — a `read` that would hand back bytes already sitting in this
 * conversation comes back as one line instead of the whole file.
 *
 * Re-reading is not a mistake; it is how a seat checks whether its own edit
 * landed, or re-orients after a long detour. The waste is only in the reply:
 * when the file has not moved, the second copy is the first copy, and the
 * model has both. Claude Code ships the same idea (FILE_UNCHANGED_STUB in
 * tools/FileReadTool) — the one thing in that harness worth taking outright,
 * because it costs nothing standing and pays per re-read.
 *
 * **Ground truth, not memory.** The obvious build is a Set of hashes per
 * session. That Set is wrong the moment the conversation it describes changes
 * shape underneath it: compaction drops older results, a rewind or fork moves
 * the leaf, `--continue` starts a process whose Set is empty while the
 * transcript is not. Each of those needs its own invalidation, and the failure
 * is silent and expensive — a stub pointing at content the model can no longer
 * see, which reads as amnesia.
 *
 * So nothing is remembered. Every decision asks
 * `sessionManager.buildContextEntries()`, which *is* the compaction-aware path
 * from the current leaf — the same projection pi feeds the model. Compaction,
 * rewind, fork and resume are then handled by construction rather than by four
 * more handlers, and there is no state left to desync.
 *
 * The check is byte equality on the returned text, so it answers the question
 * a re-read is actually asking. Same bytes: nothing changed, say so. One byte
 * different: the full new content goes back untouched.
 *
 * Deliberately narrow:
 *   - `read` only. Bash can `cat`, but bash output is not addressable this way
 *     and guessing at it would stub things that only look identical.
 *   - Single text block only. An image read carries a text note *and* an image
 *     block; the note repeats, the image is the payload, and a match on the
 *     note would drop the picture.
 *   - Nothing under {@link MIN_STUB_CHARS}, where the stub costs about what it
 *     saves and only adds a hop.
 *   - Errors pass through. A failed read is not a copy of anything.
 *
 * Two reads of one file inside a single parallel batch both return in full:
 * neither is appended when the other is judged. That is the fail-safe
 * direction — a missed saving, never a dangling pointer.
 *
 * Total. `tool_result` handlers chain, and a throw here would put pi's error
 * path between a seat and a file it asked for; anything unexpected degrades to
 * "send the file", which is exactly pi's own behaviour.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notice } from "../lib/notice.ts";

/**
 * What stands in for the file. Worded for what is actually known — that these
 * exact bytes are already above — rather than for a path, which two identical
 * files would make a lie.
 */
export const UNCHANGED_STUB =
	"Unchanged since an earlier read in this conversation — that content is still current, reuse it instead of re-reading.";

/** Under this, the stub costs about what it saves, so the file just goes back. */
export const MIN_STUB_CHARS = 400;

interface TextBlock {
	type: "text";
	text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The text of a plain text read, or undefined for anything else — an image
 * read, an empty result, a shape this module has not been taught.
 */
export function soleText(content: unknown): string | undefined {
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block = content[0];
	if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
	return block.text;
}

/**
 * Every text a `read` has already returned on the live context path.
 *
 * Fed `buildContextEntries()`, so what it reports is what the model can still
 * see: entries summarized away by compaction are already gone from the input,
 * and so is anything off the current branch.
 */
export function priorReadTexts(entries: unknown): Set<string> {
	const texts = new Set<string>();
	if (!Array.isArray(entries)) return texts;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (typeof message.toolName !== "string" || message.toolName.toLowerCase() !== "read") continue;
		const text = soleText(message.content);
		if (text !== undefined) texts.add(text);
	}
	return texts;
}

/**
 * The replacement content for one read result, or undefined to leave it alone.
 * Pure, so the whole rule is testable as bytes in, bytes out.
 */
export function stubFor(content: unknown, isError: boolean, priorTexts: ReadonlySet<string>): TextBlock[] | undefined {
	if (isError) return undefined;
	const text = soleText(content);
	if (text === undefined || text.length < MIN_STUB_CHARS) return undefined;
	return priorTexts.has(text) ? [{ type: "text", text: UNCHANGED_STUB }] : undefined;
}

export default function readMemo(pi: ExtensionAPI) {
	pi.on("tool_result", (event, ctx) => {
		try {
			if (event.toolName.toLowerCase() !== "read") return undefined;
			const content = stubFor(event.content, event.isError, priorReadTexts(ctx.sessionManager.buildContextEntries()));
			return content ? { content } : undefined;
		} catch (error) {
			notice(ctx, `read-memo: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
	});
}
