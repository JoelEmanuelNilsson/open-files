import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component as TuiComponent, Spacer } from "@earendil-works/pi-tui";
import { noticeOnce } from "../lib/process/human-notice.ts";
import { ThinkingStrip } from "../lib/ui/thinking-strip.ts";
import { envSwitchOff } from "../lib/transcript/env-switch.ts";
import { patchPrototypeMethod } from "../lib/ui/prototype-patch.ts";

interface ThinkingBlock {
	type: string;
}
interface MessageWithThinking {
	content: ThinkingBlock[];
}

const FULL_MESSAGE = Symbol.for("pi.kit.quiet-thinking.message");

interface Component {
	hideThinkingBlock: boolean;
	isStreaming: boolean;
	outputPad: number;
	contentContainer: { addChild(child: TuiComponent): void };
	lastMessage?: MessageWithThinking;
	[FULL_MESSAGE]?: MessageWithThinking;
}

export function withoutThinkingBlocks<T extends MessageWithThinking>(message: T): T {
	const content = message?.content;
	if (!Array.isArray(content)) return message;
	if (!content.some((block) => block?.type === "thinking")) return message;
	return { ...message, content: content.filter((block) => block?.type !== "thinking") };
}

function sourceMessage(component: Component, message: MessageWithThinking): MessageWithThinking {
	const parked = component[FULL_MESSAGE];
	if (parked !== undefined && message === component.lastMessage) return parked;
	return message;
}

/** Whether the model is thinking right now: the message is still streaming and its last block is thinking. */
export function thinkingInFlight(message: MessageWithThinking, isStreaming: boolean): boolean {
	const content = message?.content;
	return isStreaming && Array.isArray(content) && content.at(-1)?.type === "thinking";
}

function hasExpectedShape(component: Component): boolean {
	try {
		return typeof component.hideThinkingBlock === "boolean" && typeof component.contentContainer?.addChild === "function" && typeof component.outputPad === "number";
	} catch {
		return false;
	}
}

type UpdateContent = (this: Component, message: MessageWithThinking, ...rest: [boolean?]) => void;

const WRAPPED = Symbol.for("pi.kit.quiet-thinking.update-content");

export function enableQuietThinking(onFailure: (error: unknown) => void = () => {}): () => void {
	return patchPrototypeMethod<UpdateContent>(AssistantMessageComponent.prototype, "updateContent", WRAPPED, (original) => function (this: Component, message: MessageWithThinking, ...rest: [boolean?]) {
		if (!hasExpectedShape(this)) {
			onFailure(new Error("hideThinkingBlock, contentContainer or outputPad is missing or has another type"));
			original.call(this, message, ...rest);
			return;
		}
		let next = message;
		let source = message;
		try {
			source = sourceMessage(this, message);
			this[FULL_MESSAGE] = source;
			next = this.hideThinkingBlock ? withoutThinkingBlocks(source) : source;
		} catch (error) {
			next = message;
			onFailure(error);
		}
		original.call(this, next, ...rest);
		try {
			if (this.hideThinkingBlock && thinkingInFlight(source, this.isStreaming)) {
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new ThinkingStrip(this.outputPad));
			}
		} catch (error) {
			onFailure(error);
		}
	});
}

export default function (pi: ExtensionAPI) {
	let unquiet: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || envSwitchOff("PI_QUIET_THINKING")) return;
		const failed = (error: unknown) =>
			noticeOnce(ctx, "quiet-thinking", `quiet-thinking is off: pi's message component changed (${error instanceof Error ? error.message : String(error)})`, "warning");
		try {
			unquiet = enableQuietThinking(failed);
		} catch (error) {
			failed(error);
		}
	});

	pi.on("session_shutdown", () => {
		unquiet?.();
		unquiet = undefined;
	});
}
