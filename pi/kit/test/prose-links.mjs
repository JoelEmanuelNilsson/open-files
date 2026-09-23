/**
 * Does a path written in a message become a click that lands in nvim?
 *
 * The extension rewrites markdown link targets to the `pi-open:` scheme before
 * pi renders them. The rewrite is a pure string function, so the test is the
 * string in and the string out — no terminal, no renderer, no click.
 *
 *   node test/prose-links.mjs
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { rewriteFileLinks } = await jiti.import(`${ROOT}/extensions/prose-links.ts`);
const { resetScheme } = await jiti.import(`${ROOT}/extensions/transcript/link.ts`);

const HOME = process.env.HOME;

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
	if (actual === expected) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}\n  expected ${expected}\n  actual   ${actual}`);
};

// The handler is installed on this machine, so `auto` resolves to `pi-open`.
// Pin it anyway: the suite must not depend on what is in ~/Applications.
process.env.PI_TRANSCRIPT_OPEN = "pi-open";
resetScheme();

// --- the targets that are ours ---------------------------------------------

eq("absolute path",
	rewriteFileLinks("see [README](/Users/joel/dotfiles/aerospace/README.md)"),
	"see [README](pi-open:///Users/joel/dotfiles/aerospace/README.md)");

eq("tilde expands",
	rewriteFileLinks("[cfg](~/dotfiles/zshrc)"),
	`[cfg](pi-open://${HOME}/dotfiles/zshrc)`);

eq("file:// becomes pi-open",
	rewriteFileLinks("[hosts](file:///etc/hosts)"),
	"[hosts](pi-open:///etc/hosts)");

eq("a title survives",
	rewriteFileLinks(`[x](/etc/hosts "the hosts file")`),
	`[x](pi-open:///etc/hosts "the hosts file")`);

eq("two links on one line",
	rewriteFileLinks("[a](/tmp/a.ts) and [b](/tmp/b.ts)"),
	"[a](pi-open:///tmp/a.ts) and [b](pi-open:///tmp/b.ts)");

eq("a space is encoded once",
	rewriteFileLinks("[n](file:///tmp/my%20notes.md)"),
	"[n](pi-open:///tmp/my%20notes.md)");

// --- line numbers, however they are spelled --------------------------------

eq("colon line number",
	rewriteFileLinks("[row](/Users/joel/dotfiles/pi/kit/extensions/transcript/row.ts:42)"),
	"[row](pi-open:///Users/joel/dotfiles/pi/kit/extensions/transcript/row.ts?line=42)");

eq("#L line number",
	rewriteFileLinks("[row](/tmp/row.ts#L42)"),
	"[row](pi-open:///tmp/row.ts?line=42)");

eq("?line= passes through",
	rewriteFileLinks("[row](/tmp/row.ts?line=42)"),
	"[row](pi-open:///tmp/row.ts?line=42)");

// --- the targets that are not ----------------------------------------------

const untouched = (label, markdown) => eq(label, rewriteFileLinks(markdown), markdown);

untouched("http", "[pi](https://pi.dev/docs)");
untouched("relative path", "[skill](kit/skills/commit/SKILL.md)");
untouched("in-page anchor", "[top](#the-rooms)");
untouched("mailto", "[mail](mailto:joel@example.com)");
untouched("already pi-open", "[x](pi-open:///tmp/x.ts)");
untouched("no link at all", "A path in prose: /Users/joel/dotfiles/zshrc");

// --- code is shown, not linked ---------------------------------------------

untouched("inline code span", "write `[x](/tmp/x.md)` to link a file");
untouched("fenced block", "```md\n[x](/tmp/x.md)\n```");
untouched("tilde fence", "~~~\n[x](/tmp/x.md)\n~~~");

eq("prose after a fence closes is rewritten",
	rewriteFileLinks("```\n[a](/tmp/a.md)\n```\nthen [b](/tmp/b.md)"),
	"```\n[a](/tmp/a.md)\n```\nthen [b](pi-open:///tmp/b.md)");

eq("code span on a line with a real link",
	rewriteFileLinks("`](/no)` but [yes](/tmp/y.md)"),
	"`](/no)` but [yes](pi-open:///tmp/y.md)");

// --- the switch still governs ----------------------------------------------

process.env.PI_TRANSCRIPT_OPEN = "off";
resetScheme();
untouched("links off", "[README](/tmp/README.md)");

process.env.PI_TRANSCRIPT_OPEN = "file";
resetScheme();
eq("file scheme on a machine without the handler",
	rewriteFileLinks("[README](/tmp/README.md)"),
	"[README](file:///tmp/README.md)");

process.env.PI_TRANSCRIPT_OPEN = "pi-open";
resetScheme();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
