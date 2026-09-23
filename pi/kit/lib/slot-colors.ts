/**
 * What the terminal currently shows for its ANSI colour slots, and for the
 * background behind them.
 *
 * A theme that paints in indices never names a hex, so anything that has to mix
 * colours — the wave rolling along the frame, the tint under a diff row — has
 * nothing to interpolate until the terminal is asked. OSC 4
 * (`ESC ] 4 ; slot ; ? BEL`) returns the colour a slot resolves to right now and
 * OSC 11 returns the background, both following the terminal's own theme and
 * every reload of it. The slots stay the source of truth; this is only reading
 * them back.
 *
 * One cache per process, held on `globalThis`: the answers describe the
 * terminal, not a session, and every seat sharing this process is looking at
 * the same window. Whoever holds a TUI calls `attach`; everyone else just reads.
 * Each stored answer bumps `version`, so a component that cached painted lines
 * can tell they are stale — which is also how a macOS appearance flip repaints
 * diffs already on screen.
 */

import type { Rgb } from "./rgb.ts";
import { shared } from "./shared.ts";

/** The subset of the TUI this needs: a byte sink and a tap on raw input. */
export interface SlotTerminal {
	write(data: string): void;
	addInputListener(listener: (data: string) => { consume?: boolean; data?: string }): () => void;
}

/** The key the terminal background is filed under; OSC 11 is not a slot. */
export const BACKGROUND = -1;

/** The sixteen slots a theme can paint in. */
const SLOTS = Array.from({ length: 16 }, (_, slot) => slot);

/** One `ESC ] 4 ; slot ; rgb:…` or `ESC ] 11 ; rgb:…` reply, BEL- or ST-terminated. */
const REPLY = /\x1b\](?:4;(\d+)|(11));rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})(?:\x07|\x1b\\)/g;

/** How much of a half-arrived reply is worth holding back; longer is not a reply. */
const MAX_PENDING = 64;

/** Terminals answer in 8- or 16-bit channels; the top byte is the colour. */
function channel(hex: string): number {
	return Number.parseInt(hex.slice(0, 2), 16);
}

/** Every complete answer in `data`, and the input left once they are removed. */
export function parseSlotReplies(data: string): { colors: Array<[number, Rgb]>; rest: string } {
	const colors: Array<[number, Rgb]> = [];
	const rest = data.replace(REPLY, (_match, slot: string | undefined, _osc11, r: string, g: string, b: string) => {
		colors.push([slot === undefined ? BACKGROUND : Number(slot), { r: channel(r), g: channel(g), b: channel(b) }]);
		return "";
	});
	return { colors, rest };
}

/**
 * The tail of `rest` that could be the front of a reply still arriving, and the
 * input to hand on without it.
 *
 * A burst of seventeen queries comes back in whatever chunks the pty feels like,
 * so a reply can be split across two reads. Without this the fragment reaches
 * the editor as if the user had typed it.
 */
export function splitPending(rest: string): { pending: string; passed: string } {
	const start = rest.lastIndexOf("\x1b]");
	if (start === -1) return { pending: "", passed: rest };
	const tail = rest.slice(start);
	// Terminated already means it was not a reply we know; let it through.
	if (tail.includes("\x07") || tail.includes("\x1b\\")) return { pending: "", passed: rest };
	const plausible = "\x1b]4;".startsWith(tail.slice(0, 4)) || "\x1b]11;".startsWith(tail.slice(0, 5));
	if (!plausible || tail.length > MAX_PENDING) return { pending: "", passed: rest };
	return { pending: tail, passed: rest.slice(0, start) };
}

/** How long a terminal gets to answer before the query is abandoned. */
const REPLY_TIMEOUT_MS = 500;

/** Silent refreshes before this stops asking; a terminal without OSC 4 answers none. */
const SILENCE_LIMIT = 3;

/**
 * A cache of terminal colours, refreshed on demand. `get` and `background`
 * answer from the last successful read; `refresh` asks the terminal again and
 * swaps the answers in as they arrive.
 */
export class SlotColors {
	private readonly colors = new Map<number, Rgb>();
	private terminal: SlotTerminal | null = null;
	private onChange: (() => void) | null = null;
	private stop: (() => void) | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending = "";
	private silent = 0;
	private answered = false;
	private stamp = 0;

	/**
	 * Which read the current answers came from. Anything that caches painted
	 * colour compares this to what it painted with.
	 */
	get version(): number {
		return this.stamp;
	}

	/** Whether the terminal has ever answered; until it has, callers paint without a mix. */
	get known(): boolean {
		return this.colors.size > 0;
	}

	/**
	 * Hand the cache the terminal to ask, and a way to say the answers changed.
	 * Called again on every `/new` or `/resume`, so the latest TUI wins.
	 */
	attach(terminal: SlotTerminal, onChange?: () => void): void {
		this.settle();
		this.terminal = terminal;
		this.onChange = onChange ?? null;
		this.silent = 0;
		this.refresh();
	}

	get(slot: number): Rgb | undefined {
		return this.colors.get(slot);
	}

	/** What the terminal draws behind everything, or undefined until it says. */
	background(): Rgb | undefined {
		return this.colors.get(BACKGROUND);
	}

	/**
	 * Ask the terminal for all sixteen slots and the background. A refresh already
	 * in flight is left to finish, and a terminal that has stayed silent through
	 * `SILENCE_LIMIT` reads is not asked again this session.
	 */
	refresh(): void {
		if (this.stop !== null || this.terminal === null || this.silent >= SILENCE_LIMIT) return;
		this.answered = false;
		this.stop = this.terminal.addInputListener((data) => this.receive(data));
		this.timer = setTimeout(() => {
			this.silent = this.answered ? 0 : this.silent + 1;
			this.settle();
		}, REPLY_TIMEOUT_MS);
		this.terminal.write(`${SLOTS.map((slot) => `\x1b]4;${slot};?\x07`).join("")}\x1b]11;?\x07`);
	}

	/** Stop listening; safe to call more than once. */
	dispose(): void {
		this.settle();
	}

	private receive(data: string): { consume?: boolean; data?: string } {
		const combined = this.pending + data;
		if (this.pending === "" && !combined.includes("\x1b]")) return {};
		const { colors, rest } = parseSlotReplies(combined);
		let changed = false;
		for (const [slot, rgb] of colors) {
			this.answered = true;
			const held = this.colors.get(slot);
			if (held === undefined || held.r !== rgb.r || held.g !== rgb.g || held.b !== rgb.b) changed = true;
			this.colors.set(slot, rgb);
		}
		const { pending, passed } = splitPending(rest);
		this.pending = pending;
		if (changed) {
			this.stamp++;
			this.onChange?.();
		}
		return passed.length === 0 ? { consume: true } : { data: passed };
	}

	private settle(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.stop?.();
		this.stop = null;
		this.pending = "";
	}
}

const SEAM = Symbol.for("pi-kit.slot-colors");

/** The one cache in this process. */
export function slotColors(): SlotColors {
	return shared(SEAM, () => new SlotColors());
}
