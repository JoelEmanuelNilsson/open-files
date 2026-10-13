import type { Rgb } from "./rgb-color.ts";
import { processShared } from "../process/process-shared-state.ts";

/** The subset of the TUI this needs: a byte sink and a tap on raw input. */
export interface SlotTerminal {
	write(data: string): void;
	addInputListener(listener: (data: string) => { consume?: boolean; data?: string }): () => void;
}

/** The key the terminal background is filed under; OSC 11 is not a slot. */
export const BACKGROUND = -1;

const SLOTS = Array.from({ length: 16 }, (_, slot) => slot);

const REPLY = /\x1b\](?:4;(\d+)|(11));rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})(?:\x07|\x1b\\)/g;

const MAX_PENDING = 64;

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

export function splitPending(rest: string): { pending: string; passed: string } {
	const start = rest.lastIndexOf("\x1b]");
	if (start === -1) return { pending: "", passed: rest };
	const tail = rest.slice(start);
	if (tail.includes("\x07") || tail.includes("\x1b\\")) return { pending: "", passed: rest };
	const plausible = "\x1b]4;".startsWith(tail.slice(0, 4)) || "\x1b]11;".startsWith(tail.slice(0, 5));
	if (!plausible || tail.length > MAX_PENDING) return { pending: "", passed: rest };
	return { pending: tail, passed: rest.slice(0, start) };
}

const REPLY_TIMEOUT_MS = 500;

const SILENCE_LIMIT = 3;

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

	get version(): number {
		return this.stamp;
	}

	get known(): boolean {
		return this.colors.size > 0;
	}

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

	background(): Rgb | undefined {
		return this.colors.get(BACKGROUND);
	}

	refresh(): void {
		if (this.stop !== null || this.terminal === null || this.silent >= SILENCE_LIMIT) return;
		this.answered = false;
		this.stop = this.terminal.addInputListener((data) => this.receive(data));
		// raw-timer: a TUI component timer: the terminal's colour reply timeout
		this.timer = setTimeout(() => {
			this.silent = this.answered ? 0 : this.silent + 1;
			this.settle();
		}, REPLY_TIMEOUT_MS);
		this.terminal.write(`${SLOTS.map((slot) => `\x1b]4;${slot};?\x07`).join("")}\x1b]11;?\x07`);
	}

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
	return processShared(SEAM, () => new SlotColors());
}
