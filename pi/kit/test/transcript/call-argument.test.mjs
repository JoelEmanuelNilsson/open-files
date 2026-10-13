import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";

const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const jiti = kitJiti();
const describe = await jiti.import(`${KIT_ROOT}/lib/transcript/call-argument.ts`);
const { HOME_GLYPH } = await jiti.import(`${KIT_ROOT}/lib/ui/home-glyph.ts`);

// ---------------------------------------------------------------------------
// Paths are spelled the shortest honest way, and clipped from the right end.
// ---------------------------------------------------------------------------

eq("inside the session goes relative", describe.shortDisplayPath("/w/kit/lib/a.ts", "/w/kit", "/home/j"), "lib/a.ts");
eq("under home goes to the home glyph", describe.shortDisplayPath("/home/j/other/a.ts", "/w/kit", "/home/j"), `${HOME_GLYPH}/other/a.ts`);
// The glyph stands in one column, exactly like the `~` it replaces, so every
// width the transcript computes for a path is unchanged.
eq("and it costs one column", visibleWidth(describe.shortDisplayPath("/home/j/a", "/w/kit", "/home/j")), 3);
eq("a sibling that shares home's prefix stays absolute", describe.shortDisplayPath("/home/jx/a.ts", "/w/kit", "/home/j"), "/home/jx/a.ts");
eq("elsewhere stays absolute", describe.shortDisplayPath("/etc/hosts", "/w/kit", "/home/j"), "/etc/hosts");
eq("relative input is left alone", describe.shortDisplayPath("lib/a.ts", "/w/kit", "/home/j"), "lib/a.ts");

const at = (tool, args) => describe.describeCallArgument(tool, args, "/w/kit", "/home/j");
eq("bash shows the command", at("bash", { command: "npm test" }).text, "npm test");
eq("a multi-line command is flattened", at("bash", { command: "a &&\n  b" }).text, "a && b");
eq("a command is clipped from its tail", at("bash", { command: "npm test" }).clip, "tail");
eq("a path is clipped from its head", at("read", { path: "/w/kit/lib/a.ts" }).clip, "head");
eq("read shows the path", at("read", { path: "/w/kit/lib/a.ts" }).text, "lib/a.ts");
eq("read shows the window", at("read", { path: "a.ts", offset: 10, limit: 20 }).text, "a.ts 10-29");
eq("and the offset is the line the link opens at", at("read", { path: "a.ts", offset: 10 }).line, 10);
eq("a whole-file read names no line", at("read", { path: "a.ts" }).line, undefined);
eq("edit names the file", at("edit", { path: "/w/kit/lib/a.ts", edits: [1, 2] }).text, "lib/a.ts");
eq("edit names every file", at("edit", { files: [{ path: "/w/kit/a.ts" }, { path: "/w/kit/b.ts" }] }).text, "a.ts, b.ts");
eq("an unknown tool contributes no argument", at("mcp__x__y", { anything: 1 }).text, "");

eq("a path argument carries its file", at("read", { path: "/w/kit/lib/a.ts" }).file, "/w/kit/lib/a.ts");
eq("a relative path is resolved for the link", at("read", { path: "lib/a.ts" }).file, "/w/kit/lib/a.ts");
eq("a command does not", at("bash", { command: "cat a.ts" }).file, undefined);
eq("a multi-file edit does not", at("edit", { files: [{ path: "/a.ts" }, { path: "/b.ts" }] }).file, undefined);

await finish();
