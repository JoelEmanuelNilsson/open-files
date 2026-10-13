/**
 * What the chrome's light reads out of the terminal
 * (lib/ui/terminal-slot-colors.ts). A theme that paints in ANSI indices names no
 * channels, so the only way to mix against its colours is to ask the terminal
 * what each slot shows. The replies arrive on the same stream as keystrokes and
 * must never reach the editor, whole or half-arrived.
 */

import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();
const { BACKGROUND, parseSlotReplies, splitPending, SlotColors } = await jiti.import(`${KIT_ROOT}/lib/ui/terminal-slot-colors.ts`);

console.log("slots: OSC 4 and OSC 11 replies are read off the input and kept out of the editor");
{
	const reply = "\x1b]4;8;rgb:7878/8282/9696\x07\x1b]4;12;rgb:8c/aa/ff\x1b\\";
	const parsed = parseSlotReplies(`${reply}abc`);
	eq("16-bit and 8-bit channels both land as bytes", parsed.colors, [[8, { r: 120, g: 130, b: 150 }], [12, { r: 140, g: 170, b: 255 }]]);
	eq("keystrokes in the same chunk survive", parsed.rest, "abc");
	eq("the background answers under its own key", parseSlotReplies("\x1b]11;rgb:0808/0b0b/2020\x07").colors, [[BACKGROUND, { r: 8, g: 11, b: 32 }]]);

	let written = "";
	let listener = null;
	const terminal = {
		write: (data) => { written += data; },
		addInputListener: (fn) => { listener = fn; return () => { listener = null; }; },
	};
	let changes = 0;
	const slots = new SlotColors();
	slots.attach(terminal, () => { changes++; });
	eq("one query per slot, then the background", written, `${Array.from({ length: 16 }, (_, i) => `\x1b]4;${i};?\x07`).join("")}\x1b]11;?\x07`);
	eq("nothing is known before the terminal answers", slots.known, false);
	eq("a chunk that is only replies is consumed", listener(reply), { consume: true });
	eq("and the colours are readable afterwards", slots.get(12), { r: 140, g: 170, b: 255 });
	eq("an answer that changed something is announced once", changes, 1);
	eq("and stamps a new version", slots.version, 1);
	eq("the same answers again change nothing", (listener(reply), [changes, slots.version]), [1, 1]);
	eq("unrelated input passes through untouched", listener("x"), {});
	eq("a reply mixed with a keystroke hands the keystroke on", listener(`${reply}y`), { data: "y" });
	slots.dispose();
	eq("dispose stops listening", listener, null);
}

console.log("\nslots: a reply split across two reads is held, not typed into the editor");
{
	eq("a half-arrived reply is held back", splitPending("ab\x1b]4;3;rgb:11"), { pending: "\x1b]4;3;rgb:11", passed: "ab" });
	eq("so is the bare start of one", splitPending("\x1b]"), { pending: "\x1b]", passed: "" });
	eq("an OSC that is not a colour reply is not ours to hold", splitPending("\x1b]0;title\x07"), { pending: "", passed: "\x1b]0;title\x07" });
	eq("plain input is never held", splitPending("hello"), { pending: "", passed: "hello" });

	let listener = null;
	const slots = new SlotColors();
	slots.attach({ write: () => {}, addInputListener: (fn) => { listener = fn; return () => { listener = null; }; } });
	eq("the front half is swallowed", listener("\x1b]4;3;rgb:aaaa/"), { consume: true });
	eq("the back half completes the answer", listener("bbbb/cccc\x07z"), { data: "z" });
	eq("and the colour arrived whole", slots.get(3), { r: 170, g: 187, b: 204 });
	slots.dispose();
}

await finish();
