/**
 * Does a re-read of unchanged bytes come back as one line?
 *
 * The rule is a pure function of the returned content and the texts already on
 * the context path, so the test is content in, content out — no session, no
 * tool, no model.
 *
 *   node test/read-memo.mjs
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { MIN_STUB_CHARS, UNCHANGED_STUB, priorReadTexts, soleText, stubFor } = await jiti.import(`${ROOT}/extensions/read-memo.ts`);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
	if (ok) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}${detail ? `\n  ${detail}` : ""}`);
};

const BIG = "x".repeat(MIN_STUB_CHARS);
const text = (t) => [{ type: "text", text: t }];
const readResult = (t) => ({ type: "message", message: { role: "toolResult", toolName: "read", content: text(t) } });

// --- soleText: only a plain text read is a candidate ------------------------
console.log("read-memo: what counts as a text read");
check("a single text block yields its text", soleText(text("hi")) === "hi");
check("an image read yields nothing", soleText([{ type: "text", text: "note" }, { type: "image", data: "…" }]) === undefined);
check("an empty result yields nothing", soleText([]) === undefined);
check("a non-array yields nothing", soleText(undefined) === undefined);
check("an unknown block shape yields nothing", soleText([{ type: "text" }]) === undefined);

// --- priorReadTexts: only reads, only on the path ---------------------------
console.log("\nread-memo: what the model can still see");
check("a prior read is collected", priorReadTexts([readResult("a")]).has("a"));
check("a bash result is not a read", priorReadTexts([{ type: "message", message: { role: "toolResult", toolName: "bash", content: text("a") } }]).size === 0);
check("an assistant message is not a result", priorReadTexts([{ type: "message", message: { role: "assistant", content: text("a") } }]).size === 0);
check("a non-message entry is skipped", priorReadTexts([{ type: "compaction", summary: "…" }]).size === 0);
check("display casing still matches", priorReadTexts([{ type: "message", message: { role: "toolResult", toolName: "Read", content: text("a") } }]).has("a"));
check("a non-array degrades to empty", priorReadTexts(null).size === 0);
// buildContextEntries already drops summarized and off-branch entries, so a
// compacted read is absent from the input rather than filtered here.
check("nothing is remembered between calls", priorReadTexts([]).size === 0);

// --- stubFor: the rule ------------------------------------------------------
console.log("\nread-memo: the substitution");
const seen = new Set([BIG]);
check("identical bytes are stubbed", stubFor(text(BIG), false, seen)?.[0]?.text === UNCHANGED_STUB);
check("one byte different sends the file", stubFor(text(`${BIG}!`), false, seen) === undefined);
check("an unseen file sends the file", stubFor(text(BIG), false, new Set()) === undefined);
check("an error result is never stubbed", stubFor(text(BIG), true, seen) === undefined);
check("an image read is never stubbed", stubFor([{ type: "text", text: BIG }, { type: "image", data: "…" }], false, seen) === undefined);

const small = "y".repeat(MIN_STUB_CHARS - 1);
check("below the floor the file goes back", stubFor(text(small), false, new Set([small])) === undefined);
check("at the floor it is stubbed", stubFor(text("z".repeat(MIN_STUB_CHARS)), false, new Set(["z".repeat(MIN_STUB_CHARS)])) !== undefined);

// The stub must be cheaper than what it replaces, or the whole thing is a loss.
check("the stub is smaller than the floor", UNCHANGED_STUB.length < MIN_STUB_CHARS, `${UNCHANGED_STUB.length} vs ${MIN_STUB_CHARS}`);

// --- end to end -------------------------------------------------------------
console.log("\nread-memo: against a context path");
const entries = [readResult("unrelated"), readResult(BIG), { type: "compaction", summary: "…" }];
check("a re-read of a file on the path is stubbed", stubFor(text(BIG), false, priorReadTexts(entries)) !== undefined);
check("a first read of a new file is not", stubFor(text(`${BIG}new`), false, priorReadTexts(entries)) === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
