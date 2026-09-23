/**
 * The one key that opens the tasks list from the prompt, and when it may.
 *
 * **One `↓` at an empty prompt opens the list.** Claude Code's flow selects
 * the label first and opens on the second press; that was tried here and read
 * as a key that had to be held, because the only feedback for the first press
 * was an inverse pill in the rule that nobody was looking at. A press either
 * opens the list or reaches the editor — there is no state in between.
 *
 * **`↓` opens only at an empty prompt that is not browsing history.** That
 * is the only state in which `↓` carries no editing meaning. pi's editor turns
 * `↓` into one of three things (`pi-tui/dist/components/editor.js`,
 * `tui.editor.cursorDown`): forward through prompt history while browsing it,
 * jump to the end of the line when the cursor is already on the last visual
 * line, or move the cursor down. On an empty buffer only the second applies and
 * an empty line has no end to jump to — so an empty, non-browsing editor is the
 * one place a consumed `↓` costs the user nothing. "Cursor on the last line"
 * would steal the end-of-line jump from anyone typing a paragraph.
 *
 * The focus test and the state read are the same act. Extension input listeners
 * fire *before* the focused component (`pi-tui/dist/tui.js:560`), so a listener
 * that only looked at `getEditorText()` would steal `↓` from every dialog and
 * menu, which read as an empty editor while they hold the keyboard
 * (an upstream defect in the vendor extension this engine replaced). Here the
 * state can only be read off a component that has
 * a prompt buffer and a history cursor, and nothing else in pi has both — so an
 * unrecognised focus owner yields `undefined` and the key is never consumed.
 * Not knowing always means not consuming.
 */

import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

/** What the prompt editor is doing, as far as the dock can prove it. */
export interface PromptEditorKeyState {
	/** The buffer is a single empty line. */
	readonly empty: boolean;
	/** The user is stepping through prompt history, so `↓` still has work to do. */
	readonly browsingHistory: boolean;
}

/** The key the label answers to; everything else is `other`. */
export type TasksLabelKey = "down" | "other";

/** Whether this is `↓`. A release is `other`: Kitty terminals report both, and only the press counts. */
export function tasksLabelKey(data: string): TasksLabelKey {
	if (isKeyRelease(data)) return "other";
	return matchesKey(data, Key.down) ? "down" : "other";
}

/**
 * Read the prompt editor's state off whichever component holds the keyboard, or
 * `undefined` when that component is not a prompt editor.
 *
 * Structural, not `instanceof`: pi loads every extension file through its own
 * jiti, so a class identity imported here is not guaranteed to be the one pi
 * constructed. The two members read are the two the rule needs, which makes the
 * shape check and the state read the same thing.
 */
export function readPromptEditorKeyState(focused: unknown): PromptEditorKeyState | undefined {
	const editor = focused as { isEditorEmpty?: unknown; historyIndex?: unknown } | null | undefined;
	if (typeof editor?.isEditorEmpty !== "function" || typeof editor.historyIndex !== "number") return undefined;
	try {
		return { empty: editor.isEditorEmpty() === true, browsingHistory: editor.historyIndex > -1 };
	} catch {
		return undefined;
	}
}

/** Everything the decision depends on, so the rule itself stays pure. */
export interface TasksLabelInput {
	readonly key: TasksLabelKey;
	/** The prompt editor's state, or undefined when something else has the keyboard. */
	readonly editor: PromptEditorKeyState | undefined;
	/** Agents still running. Nothing opens at zero — there is nothing to manage. */
	readonly liveTaskCount: number;
	/** The list is already up and owns its own keys. */
	readonly modalOpen: boolean;
}

/**
 * Whether this key opens the list. Opening always consumes the key; not
 * opening never does, so the editor sees exactly the keys the list did not use.
 */
export function shouldOpenTasksList(input: TasksLabelInput): boolean {
	if (input.key !== "down" || input.modalOpen || input.liveTaskCount < 1 || input.editor === undefined) return false;
	return input.editor.empty && !input.editor.browsingHistory;
}
