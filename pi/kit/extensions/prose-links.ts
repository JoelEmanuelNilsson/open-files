import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileLinkUrl } from "../lib/ui/file-link.ts";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const CODE_SPAN = /(`+[^`]*`+)/;

const LINK = /\]\(([^()\s]+)(\s+"[^"]*")?\)/g;

const TAIL = /(?:\?line=|#L|:)(\d+)$/;

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

	let decoded = path;
	try {
		decoded = decodeURI(path);
	} catch {
	}
	return fileLinkUrl(decoded, line);
}

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
		// SAFETY: i < lines.length bounds the index; noUncheckedIndexedAccess is the only reason for the cast
		const opener = FENCE.exec(lines[i] as string);
		if (opener) {
			// SAFETY: FENCE's group 1 is non-optional, so a match always has opener[1] with at least one character
			const mark = (opener[1] as string)[0] as string;
			if (fence === undefined) fence = mark;
			else if (fence === mark) fence = undefined;
			continue;
		}
		if (fence === undefined) {
			// SAFETY: i < lines.length bounds the index
			lines[i] = rewriteLine(lines[i] as string);
		}
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, { isStreaming }) => {
		if (isStreaming) return markdown;
		return rewriteFileLinks(markdown);
	});
}
