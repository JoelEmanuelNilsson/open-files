import type { ImageContent } from "@earendil-works/pi-ai";
import { isKeyRelease, type TUI } from "@earendil-works/pi-tui";

import type { FocusTarget, FocusTheme, PromptFocus } from "../../lib/session/prompt-focus.ts";
import { promptTargetClaimsInput, samePromptTarget, setPromptTarget } from "../../lib/session/prompt-target.ts";
import { focusedPromptEditor, ThreadScreen } from "./thread-screen.ts";

/** What the prompt focus controller needs from the main seat. */
export interface PromptFocusHost {
	notify(message: string, level: "info" | "warning" | "error"): void;
	isMainIdle(): boolean;
	theme(): FocusTheme | undefined;
}

/** One main session's prompt focus: which target the prompt talks to, on screen and in the input path. */
export class PromptFocusController implements PromptFocus {
	readonly #sessionId: string;
	readonly #host: PromptFocusHost;
	readonly #screen: ThreadScreen;
	#tui: TUI | undefined;
	#focused: FocusTarget | undefined;
	#mainCompacting = false;

	public constructor(sessionId: string, cwd: string, host: PromptFocusHost) {
		this.#sessionId = sessionId;
		this.#host = host;
		this.#screen = new ThreadScreen(cwd);
	}

	public bindTui(tui: TUI): void {
		this.#tui = tui;
	}

	public get focused(): FocusTarget | undefined {
		return this.#focused;
	}

	public focus(target: FocusTarget): boolean {
		const current = this.#focused;
		if (current !== undefined && samePromptTarget(current.target, target.target)) return true;
		const label = target.target.kind === "side" ? "side mode" : "agent view";
		const tui = this.#tui;
		const theme = this.#host.theme();
		if (tui === undefined || theme === undefined) {
			this.#host.notify(`${label} needs the interactive screen`, "warning");
			return false;
		}
		this.#focused = undefined;
		current?.leave("switch");
		const drift = this.#screen.enter(tui, theme, target);
		if (drift !== undefined) {
			setPromptTarget(this.#sessionId, undefined);
			this.#host.notify(`${label} refused: ${drift}`, "warning");
			tui.requestRender();
			return false;
		}
		this.#focused = target;
		setPromptTarget(this.#sessionId, target.target);
		tui.requestRender();
		return true;
	}

	public exit(): void {
		const current = this.#focused;
		this.#focused = undefined;
		current?.leave("exit");
		setPromptTarget(this.#sessionId, undefined);
		this.#screen.leave();
		this.#tui?.requestRender();
	}

	public refresh(): void {
		this.#screen.refresh();
	}

	public setMainCompacting(on: boolean): void {
		this.#mainCompacting = on;
	}

	public handleInput(event: { text: string; source: string; images?: ImageContent[] }): { action: "handled" } | undefined {
		const target = this.#focused;
		if (target === undefined || !promptTargetClaimsInput(this.#sessionId, event)) return undefined;
		this.#submit(target, event.text, event.images, "enter");
		return { action: "handled" };
	}

	public submitToFocus(text: string, images: ImageContent[] | undefined): void {
		const target = this.#focused;
		if (target !== undefined) this.#submit(target, text, images, "enter");
	}

	public handleTerminalInput(data: string): { consume: true } | undefined {
		const target = this.#focused;
		const tui = this.#tui;
		if (isKeyRelease(data) || target === undefined || tui === undefined) return undefined;
		const editor = focusedPromptEditor(tui);
		if (editor === undefined || editor.isShowingAutocomplete()) return undefined;
		const followUpKey = editor.keybindings.matches(data, "app.message.followUp");
		const submitKey = !followUpKey && editor.keybindings.matches(data, "tui.input.submit");
		if (this.#mainCompacting && !this.#host.isMainIdle() && (followUpKey || submitKey)) {
			const text = editor.getExpandedText().trim();
			const { line, col } = editor.getCursor();
			const bashCommand = (text.startsWith("!!") ? text.slice(2) : text.slice(1)).trim();
			const enterStaysMain = submitKey && ((editor.getLines()[line] ?? "")[col - 1] === "\\" || (text.startsWith("!") && bashCommand !== ""));
			if (text !== "" && !enterStaysMain) {
				this.#host.notify("Main is compacting — send again when it's done.", "warning");
				return { consume: true };
			}
		}
		if (editor.keybindings.matches(data, "app.interrupt")) {
			if (target.interrupt() === "leave") this.exit();
			return { consume: true };
		}
		if (followUpKey && target.takesFollowUpKey()) {
			const text = editor.getExpandedText().trim();
			if (text === "" || text.startsWith("/")) return undefined;
			editor.addToHistory(text);
			editor.setText("");
			this.#submit(target, text, undefined, "followUp");
			return { consume: true };
		}
		return undefined;
	}

	public shutdown(): void {
		this.exit();
		this.#tui = undefined;
	}

	#submit(target: FocusTarget, text: string, images: ImageContent[] | undefined, how: "enter" | "followUp"): void {
		const outcome = target.submit(text, images, how);
		if (outcome.kind === "refused") {
			this.#host.notify(outcome.reason, "warning");
			const editor = this.#tui === undefined ? undefined : focusedPromptEditor(this.#tui);
			if (editor !== undefined && editor.getText() === "") editor.setText(text);
			return;
		}
		if (outcome.kind === "queued") {
			this.#tui?.requestRender();
			return;
		}
		this.#screen.setWaiting(true);
		const settled = (): void => {
			if (this.#focused === target) this.#screen.setWaiting(false);
		};
		outcome.settles?.then(settled, settled);
	}
}
