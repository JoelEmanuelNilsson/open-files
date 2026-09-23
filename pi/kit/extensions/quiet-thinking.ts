/**
 * quiet-thinking — hidden thinking draws nothing at all.
 *
 * With `hideThinkingBlock` on, pi still spends two lines on every reasoning
 * run: a blank line and the word `Thinking...`. On a thinking model that is a
 * two-line stub above every message and above most tool batches, and it says
 * exactly what pi's own spinner already said.
 *
 * The two lines come from one method. `AssistantMessageComponent.updateContent`
 * (`dist/modes/interactive/components/assistant-message.js`) counts a thinking
 * block as visible content, which buys the leading `Spacer(1)`, and then draws
 * `Text(theme.italic(theme.fg("thinkingText", label)))` for each run of them.
 *
 * `ctx.ui.setHiddenThinkingLabel("")` is not the fix. `theme.fg` wraps even an
 * empty string in escape codes, so `Text` is handed a non-empty string and
 * draws a line anyway — the label goes and its line stays, which is two blank
 * lines instead of one blank and a word. pi also resets that label whenever it
 * rebinds a session (`interactive-mode.js resetExtensionUI`), so the setting
 * would not survive a `/reload` either.
 *
 * So the fix is upstream of the drawing: **the component never sees the
 * thinking blocks while it is hiding them.** One wrapper on `updateContent`
 * hands the original a message with the thinking content filtered out. No
 * spacer, because nothing visible is left to space; no label, because the
 * branch that draws it is never reached; and every other branch of that method
 * — text, tool calls, `length`/`aborted`/`error` — runs on pi's own code with
 * pi's own content. The same seam and the same style as
 * `transcript/click.ts`'s wrapper on `TuiAltScreen.handleViewportInput`.
 *
 * When `hideThinkingBlock` is off, the message is passed through untouched and
 * pi's behaviour is exactly pi's.
 *
 * **Declared limit.** Thinking draws nothing, including when it sits *between*
 * two runs of prose in one message: those two runs then close up, because the
 * blank line under them was the thinking block's own. One rule, no exceptions —
 * a "sometimes it leaves a blank" rule is a rule you have to read the reasoning
 * to predict.
 *
 * `PI_QUIET_THINKING=off` restores pi's `Thinking...`.
 */

import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The parts of pi's `AssistantMessage` this reads. Restated, not deep-imported. */
interface ThinkingBlock {
	type: string;
}
interface MessageWithThinking {
	content: ThinkingBlock[];
}

/**
 * The unfiltered message a component was last handed, parked on the component.
 *
 * It has to be parked somewhere, because the original writes whatever it is
 * given to its own `lastMessage`, and `invalidate()`, `setOutputPad()` and
 * `setHideThinkingBlock(false)` all re-render from that field. Without the
 * original, turning thinking back on mid-session would show a message whose
 * reasoning had been filtered away.
 *
 * On the instance under a global symbol rather than in a module-scope WeakMap,
 * because pi loads every extension file with its own jiti and `moduleCache:
 * false`: a `/reload` builds a new module with an empty map, while the
 * components on screen live on. The symbol is process-global, so the new copy
 * of this module finds what the old copy parked.
 */
const FULL_MESSAGE = Symbol.for("pi.kit.quiet-thinking.message");

interface Component {
	hideThinkingBlock: boolean;
	lastMessage?: MessageWithThinking;
	[FULL_MESSAGE]?: MessageWithThinking;
}

/**
 * The same message without its thinking blocks, or the same object when it has
 * none. Tool calls, text, images and every other block are kept, so
 * `hasToolCalls` and the stop-reason branches see what they always saw.
 */
export function withoutThinkingBlocks<T extends MessageWithThinking>(message: T): T {
	const content = message?.content;
	if (!Array.isArray(content)) return message;
	if (!content.some((block) => block?.type === "thinking")) return message;
	return { ...message, content: content.filter((block) => block?.type !== "thinking") };
}

/**
 * The message to render from: the one pi just handed over, or the unfiltered
 * one parked earlier when pi is re-rendering from its own `lastMessage`.
 */
function sourceMessage(component: Component, message: MessageWithThinking): MessageWithThinking {
	const parked = component[FULL_MESSAGE];
	if (parked !== undefined && message === component.lastMessage) return parked;
	return message;
}

type UpdateContent = (this: Component, message: MessageWithThinking, ...rest: [boolean?]) => void;

/** The wrapper carries the method it replaced, so a reload can put it back. */
const WRAPPED = Symbol.for("pi.kit.quiet-thinking.update-content");
type Wrapper = UpdateContent & { [WRAPPED]?: UpdateContent };

// `updateContent` is the one method that rebuilds `contentContainer`: the
// constructor, every streaming event, `invalidate()` and all three setters go
// through it, so wrapping it covers a message however it arrived.
function prototypeOf(): { updateContent: Wrapper } {
	return AssistantMessageComponent.prototype as unknown as { updateContent: Wrapper };
}

/**
 * Stops hidden thinking from drawing anything, and hands back the undo.
 *
 * The prototype is process-wide and shared by every session in the process,
 * subagents included, so the returned handle is what says whose wrapper it is:
 * only the runtime that installed one takes it down.
 */
export function enableQuietThinking(): () => void {
	// A reload re-imports this module, so drop the previous wrapper before
	// installing one that would otherwise nest inside it.
	dropQuietThinking();

	const prototype = prototypeOf();
	const original = prototype.updateContent as UpdateContent;
	const wrapper: Wrapper = function (this: Component, message: MessageWithThinking, ...rest: [boolean?]) {
		let next = message;
		try {
			const source = sourceMessage(this, message);
			this[FULL_MESSAGE] = source;
			next = this.hideThinkingBlock ? withoutThinkingBlocks(source) : source;
		} catch {
			// A message shaped in a way this does not recognise is pi's to render,
			// exactly as pi would have rendered it.
			next = message;
		}
		return original.call(this, next, ...rest);
	};
	wrapper[WRAPPED] = original;
	prototype.updateContent = wrapper;

	return () => {
		// Only ever restore over this wrapper: anything installed after it belongs
		// to whoever installed it, and its callers still expect it to be there.
		if (prototypeOf().updateContent === wrapper) prototype.updateContent = original;
	};
}

/**
 * Takes down a wrapper left behind by an earlier copy of this module, which a
 * reload has no handle to. The symbol is global, so it is found across copies.
 */
function dropQuietThinking(): void {
	const prototype = prototypeOf();
	const original = prototype.updateContent?.[WRAPPED];
	if (original) prototype.updateContent = original;
}

function off(name: string): boolean {
	return (process.env[name] ?? "").toLowerCase() === "off";
}

export default function (pi: ExtensionAPI) {
	let unquiet: (() => void) | undefined;

	// Installed per session rather than once at load, so pi rebinding a session
	// — `/reload`, a fork, a resume — reinstalls over whatever that left behind.
	// Only the TUI draws assistant messages at all.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || off("PI_QUIET_THINKING")) return;
		unquiet = enableQuietThinking();
	});

	pi.on("session_shutdown", () => {
		unquiet?.();
		unquiet = undefined;
	});
}
