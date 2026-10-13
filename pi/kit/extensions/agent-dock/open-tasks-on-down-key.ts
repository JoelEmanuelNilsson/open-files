import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

/** What the prompt editor is doing, as far as the dock can prove it. */
export interface PromptEditorKeyState {
	readonly empty: boolean;
	readonly browsingHistory: boolean;
}

/** The key the label answers to; everything else is `other`. */
export type TasksLabelKey = "down" | "other";

/** Whether this is `↓`. A release is `other`: Kitty terminals report both, and only the press counts. */
export function tasksLabelKey(data: string): TasksLabelKey {
	if (isKeyRelease(data)) return "other";
	return matchesKey(data, Key.down) ? "down" : "other";
}

export function readPromptEditorKeyState(focused: unknown): PromptEditorKeyState | undefined {
	// SAFETY: focused is only read through typeof checks on the fields below
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
	readonly editor: PromptEditorKeyState | undefined;
	readonly liveTaskCount: number;
	readonly agentFocused?: boolean;
	readonly modalOpen: boolean;
}

export function shouldOpenTasksList(input: TasksLabelInput): boolean {
	if (input.key !== "down" || input.modalOpen || (input.liveTaskCount < 1 && input.agentFocused !== true) || input.editor === undefined) return false;
	return input.editor.empty && !input.editor.browsingHistory;
}
