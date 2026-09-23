/**
 * Puts the transcript's user messages in the same box as the prompt.
 *
 * pi has no hook for rendering a plain user message. `registerMarkdownTransformer`
 * is the only documented seam, and it hands the text back to pi's own Markdown
 * renderer, which rewraps and restyles it: `**bold**` loses four visible columns
 * on the way through, so a border drawn in the transformer drifts out of true on
 * exactly the messages people write. Framing has to happen after the render.
 *
 * So this wraps `render` on `UserMessageComponent`, which pi exports. The wrapper
 * never renders text itself — it asks the original for a two-column-narrower
 * render and decorates the lines that come back, the same trick `ChromeEditor`
 * plays on the editor. It knows two things about that render: the box pads the
 * text with a blank row above and below, and pi marks the first and last line as
 * a shell prompt zone. If either changes, the frame degrades to no frame instead
 * of a broken one, because every path out of the wrapper falls back to the
 * untouched render.
 *
 * The fill inside the box is the theme's `userMessageBg`, not ours. A theme
 * that sets it to nothing draws no slab behind the frame, which is the same
 * grouping said twice.
 */

import { type Theme, type ThemeColor, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Paint } from "./chrome.ts";
import { frame, INSET, MIN_WIDTH } from "./message.ts";

/** The label let into the top edge. */
const LABEL = "User";

/**
 * OSC 133 prompt-zone markers. pi puts them on the message's first and last line
 * so terminals can jump from one prompt to the next; the frame becomes the first
 * and last line, so they move out onto it.
 */
const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07";
const ZONE_FINAL = "\x1b]133;C\x07";
const ZONES = [ZONE_START, ZONE_END, ZONE_FINAL];

type Render = (this: unknown, width: number) => string[];

/** The wrapper carries the method it replaced, so a reload can put it back. */
const WRAPPED = Symbol.for("zen-chrome.user-message-render");
type Wrapper = Render & { [WRAPPED]?: Render };

function prototypeOf(): { render: Wrapper } {
	return UserMessageComponent.prototype as unknown as { render: Wrapper };
}

function withoutZones(line: string): string {
	let out = line;
	for (const zone of ZONES) out = out.split(zone).join("");
	return out;
}

function withZones(lines: string[]): string[] {
	const marked = [...lines];
	marked[0] = ZONE_START + marked[0];
	marked[marked.length - 1] = ZONE_END + ZONE_FINAL + marked[marked.length - 1];
	return marked;
}

/**
 * A painter for `color`. Every getter on the extension context asserts the
 * runner is still active, so a read during teardown throws; an unpainted frame
 * beats no frame.
 */
function painter(getTheme: () => Theme, color: ThemeColor): Paint {
	try {
		const theme = getTheme();
		return (text) => theme.fg(color, text);
	} catch {
		return (text) => text;
	}
}

/**
 * Frames sent messages until the returned handle is called.
 *
 * The prototype is process-wide, and pi hands every session in the process the
 * same copy of this module — including the subagents it runs in-process. So
 * "one of ours is installed" is not the same question as "this one is mine to
 * remove": only the session that framed gets a handle, and a subagent shutting
 * down holds nothing, so it takes nothing down.
 */
export function frameUserMessages(getTheme: () => Theme): () => void {
	// A reload re-imports this module, so drop the previous wrapper before
	// installing one that would otherwise nest inside it.
	dropFrame();

	const prototype = prototypeOf();
	const original = prototype.render as Render;

	const wrapper: Wrapper = function (this: unknown, width: number): string[] {
		try {
			if (width >= MIN_WIDTH) {
				const body = original.call(this, width - INSET).map(withoutZones);
				const border = painter(getTheme, "borderMuted");
				const label = [{ text: LABEL, paint: painter(getTheme, "accent") }];
				const framed = frame(body, width, label, border);
				if (framed.length > 0) return withZones(framed);
			}
		} catch {}
		return original.call(this, width);
	};
	wrapper[WRAPPED] = original;
	prototype.render = wrapper;

	return () => {
		// Only ever restore over this wrapper: anything installed after it — a
		// reload's frame, someone else's patch — belongs to whoever installed it,
		// and its callers still expect it to be there.
		if (prototypeOf().render === wrapper) prototype.render = original;
	};
}

/**
 * Takes down a frame left behind by an earlier copy of this module, which a
 * reload has no handle to. The symbol is global, so it is found across copies.
 */
function dropFrame(): void {
	const prototype = prototypeOf();
	const original = prototype.render?.[WRAPPED];
	if (original) prototype.render = original;
}
