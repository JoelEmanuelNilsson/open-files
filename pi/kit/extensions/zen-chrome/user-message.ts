import { type Theme, type ThemeColor, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Paint } from "../../lib/ui/labelled-rule.ts";
import { patchPrototypeMethod } from "../../lib/ui/prototype-patch.ts";
import { frameUserMessageBox, INSET, MIN_WIDTH } from "./user-message-box.ts";

const LABEL = "User";

const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07";
const ZONE_FINAL = "\x1b]133;C\x07";
const ZONES = [ZONE_START, ZONE_END, ZONE_FINAL];

type Render = (this: unknown, width: number) => string[];

const WRAPPED = Symbol.for("zen-chrome.user-message-render");

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

function painter(getTheme: () => Theme, color: ThemeColor): Paint {
	try {
		const theme = getTheme();
		return (text) => theme.fg(color, text);
	} catch {
		return (text) => text;
	}
}

export function frameUserMessages(getTheme: () => Theme): () => void {
	return patchPrototypeMethod<Render>(UserMessageComponent.prototype, "render", WRAPPED, (original) => function (this: unknown, width: number): string[] {
		try {
			if (width >= MIN_WIDTH) {
				const body = original.call(this, width - INSET).map(withoutZones);
				const border = painter(getTheme, "borderMuted");
				const label = [{ text: LABEL, paint: painter(getTheme, "accent") }];
				const framed = frameUserMessageBox(body, width, label, border);
				if (framed.length > 0) return withZones(framed);
			}
		} catch {}
		return original.call(this, width);
	});
}
