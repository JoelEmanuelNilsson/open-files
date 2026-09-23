/**
 * prose-links — a file path written in a message opens in nvim, not TextEdit.
 *
 * pi's markdown renderer turns `[label](target)` into an OSC-8 hyperlink with
 * `target` written to the terminal verbatim (pi-tui `components/markdown.js`,
 * the `link` case). So a link to a file on this machine arrives at the terminal
 * as a bare path or a `file://` URL, and both mean the same thing to macOS:
 * hand it to LaunchServices, which opens `.md` in TextEdit, `.ts` in QuickTime
 * Player and `.json` in a browser.
 *
 * With a tiling window manager that follows focus, that is worse than wrong.
 * TextEdit's window lives in room 3, so clicking a path in the terminal raises
 * that window and drags you into another room to look at it.
 *
 * The transcript's rows already solved this for tool output: they link
 * `pi-open:`, the scheme owned by `~/Applications/Pi Open.app`, which runs
 * `~/dotfiles/bin/pi-open` and lands the file in nvim in a split beside the
 * pane that was clicked. This does the same for prose, by rewriting the target
 * before pi renders it — one shared `linkTo`, so both kinds of click land in
 * the same place and `PI_TRANSCRIPT_OPEN` still governs both.
 *
 * Only unambiguous local targets are touched: `/abs/path`, `~/path`, and
 * `file://…`. Anything with another scheme, and anything relative, is left
 * exactly as written. Fenced blocks and inline code are skipped, because a
 * `](…)` in either of those is text being shown, not a link being made.
 *
 * Display only. The session, and what the model sees, keep the original text.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { linkTo } from "./transcript/link.ts";

/** ```` ``` ```` or `~~~`, indented up to three spaces, per CommonMark. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A run of backticks and everything to its matching run: an inline code span. */
const CODE_SPAN = /(`+[^`]*`+)/;

/** `](target)` and `](target "title")`. Targets with spaces are not this shape. */
const LINK = /\]\(([^()\s]+)(\s+"[^"]*")?\)/g;

/** `?line=42`, `#L42` and `:42` all say the same thing at the end of a path. */
const TAIL = /(?:\?line=|#L|:)(\d+)$/;

/** The `pi-open:` URL for one link target, or nothing if it is not ours to touch. */
function retarget(target: string): string | undefined {
	let path = target;
	if (path.startsWith("file://")) path = path.slice("file://".length);
	else if (path.startsWith("~/")) path = homedir() + path.slice(1);
	if (!path.startsWith("/")) return undefined;

	let line: number | undefined;
	const tail = TAIL.exec(path);
	if (tail) {
		line = Number(tail[1]);
		path = path.slice(0, tail.index);
	}

	// The path is inside a URL, so it may be percent-encoded; `linkTo` encodes
	// what it is given. Decode first or a space becomes `%2520`.
	let decoded = path;
	try {
		decoded = decodeURI(path);
	} catch {
		// A stray `%` is not an encoding. Take the path as written.
	}
	return linkTo(decoded, line);
}

/** Rewrite the link targets in one line of prose, leaving code spans alone. */
function rewriteLine(line: string): string {
	return line
		.split(CODE_SPAN)
		.map((piece) =>
			piece.startsWith("`")
				? piece
				: piece.replace(LINK, (whole, target: string, title?: string) => {
						const url = retarget(target);
						return url === undefined ? whole : `](${url}${title ?? ""})`;
					}),
		)
		.join("");
}

/** Rewrite every file link in a markdown message. Exported for the tests. */
export function rewriteFileLinks(markdown: string): string {
	if (!markdown.includes("](")) return markdown;
	let fence: string | undefined;
	const lines = markdown.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const opener = FENCE.exec(lines[i] as string);
		if (opener) {
			const mark = (opener[1] as string)[0] as string;
			if (fence === undefined) fence = mark;
			else if (fence === mark) fence = undefined;
			continue;
		}
		if (fence === undefined) lines[i] = rewriteLine(lines[i] as string);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, { isStreaming }) => {
		// A half-arrived link has no closing paren yet, so there is nothing to
		// rewrite and no click to catch. The finalized message is transformed
		// again, and that is the one on screen when the mouse arrives.
		if (isStreaming) return markdown;
		return rewriteFileLinks(markdown);
	});
}
