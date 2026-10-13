import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const line = await jiti.import(`${KIT_ROOT}/lib/transcript/row-text.ts`);

// ---------------------------------------------------------------------------
// Clipping: which end goes is which half you would have read first.
// ---------------------------------------------------------------------------

eq("what fits is left alone", line.clip("abcdef", 6), "abcdef");
eq("a command keeps its head", line.clip("npm run build --watch", 10), "npm run b…");
eq("a path keeps its tail", line.clip("lib/deep/split-diff.ts", 10, "head"), "…t-diff.ts");
eq("one column is the ellipsis", line.clip("abcdef", 1), "…");
eq("no columns is nothing", line.clip("abcdef", 0), "");
eq("wrapping breaks a token wider than the column", line.wrap("aaaaaa bb", 4), ["aaaa", "aa", "bb"]);

await finish();
