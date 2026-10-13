/**
 * The write tool's receipt body: a new file's head, or an overwrite's diff,
 * under its count.
 *
 *   node test/transcript/write-receipt.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, initDarkTheme, kitJiti } from "../support/pi-package.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = kitJiti();
const { createWriteToolDefinition } = await importPi("dist/index.js");
const { DiffView } = await jiti.import(`${KIT_ROOT}/lib/transcript/diff-view.ts`);
const { executeWithOverwriteDiff, writeBody, WRITE_PREVIEW_LINES } = await jiti.import(`${KIT_ROOT}/lib/transcript/write-receipt.ts`);
const dark = await initDarkTheme();

{
	const dir = mkdtempSync(join(tmpdir(), "write-receipt-"));
	writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
	const exec = executeWithOverwriteDiff(createWriteToolDefinition(dir).execute);
	const ctx = { cwd: dir };
	const over = await exec("1", { path: "a.ts", content: "const a = 2;\n" }, undefined, () => {}, ctx);
	check("overwrite keeps a diff on details", typeof over.details?.diff === "string" && over.details.diff.includes("-1 const a = 1;"), JSON.stringify(over.details));
	const overBody = writeBody({ path: "a.ts", content: "const a = 2;\n" }, over, dark, false);
	check("overwrite shows the diff", overBody instanceof DiffView);

	const many = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n") + "\n";
	const fresh = await exec("2", { path: "b.ts", content: many }, undefined, () => {}, ctx);
	check("a new file has no diff", fresh.details?.diff === undefined, JSON.stringify(fresh.details));
	const lines = writeBody({ path: "b.ts", content: many }, fresh, dark, false).render(40);
	check(`a new file shows ${WRITE_PREVIEW_LINES} lines and counts the rest`, lines.length === WRITE_PREVIEW_LINES + 1 && lines.at(-1).includes("… +4 lines"), lines.join("|"));
	const all = writeBody({ path: "b.ts", content: many }, fresh, dark, true).render(40);
	check("expanded shows every line", all.length === 14 && !all.at(-1).includes("…"));
	const same = await exec("3", { path: "b.ts", content: many }, undefined, () => {}, ctx);
	check("rewriting identical content has no diff", same.details?.diff === undefined);
	check("empty content shows nothing", writeBody({ path: "c.ts", content: "" }, fresh, dark, false) === undefined);
	rmSync(dir, { recursive: true, force: true });
}

await finish();
