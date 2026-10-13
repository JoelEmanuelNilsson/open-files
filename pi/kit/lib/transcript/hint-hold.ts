/** One line of a running command's output, and how many it is standing in front of. */
export interface Hint {
	line: string;
	hidden: number;
}

export interface HintHold {
	hint?: { shown: Hint; at: number; timer?: ReturnType<typeof setTimeout> };
}

export const HINT_HOLD_MS = 700;

export function heldHint(hold: HintHold, hint: Hint | undefined, settled: boolean, invalidate: () => void, now = Date.now()): Hint | undefined {
	const held = hold.hint;
	if (settled || hint === undefined) {
		if (held?.timer !== undefined) clearTimeout(held.timer);
		hold.hint = undefined;
		return hint;
	}
	if (held === undefined) {
		hold.hint = { shown: hint, at: now };
		return hint;
	}
	if (held.shown.line === hint.line) {
		held.shown = hint;
		return hint;
	}
	const left = HINT_HOLD_MS - (now - held.at);
	if (left <= 0) {
		hold.hint = { shown: hint, at: now };
		return hint;
	}
	if (held.timer === undefined) {
		// raw-timer: a TUI component timer: a row's hint hold
		const timer = setTimeout(() => {
			held.timer = undefined;
			try {
				invalidate();
			} catch {
			}
		}, left);
		timer.unref?.();
		held.timer = timer;
	}
	return held.shown;
}
