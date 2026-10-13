/**
 * Does a path written in a message become a click that lands in nvim?
 *
 * The extension rewrites markdown link targets to the `pi-open:` scheme before
 * pi renders them. The rewrite is a pure string function, so the test is the
 * string in and the string out — no terminal, no renderer, no click.
 *
 *   node test/transcript/prose-links.test.mjs
 */

import { finish, is } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();

const { rewriteFileLinks } = await jiti.import(`${KIT_ROOT}/extensions/prose-links.ts`);
const { resetFileLinkScheme } = await jiti.import(`${KIT_ROOT}/lib/ui/file-link.ts`);

const HOME = process.env.HOME;


// The handler is installed on this machine, so `auto` resolves to `pi-open`.
// Pin it anyway: the suite must not depend on what is in ~/Applications.
process.env.PI_TRANSCRIPT_OPEN = "pi-open";
resetFileLinkScheme();

// --- the targets that are ours ---------------------------------------------

is("absolute path",
	rewriteFileLinks("see [README](/Users/joel/dotfiles/aerospace/README.md)"),
	"see [README](pi-open:///Users/joel/dotfiles/aerospace/README.md)");

is("tilde expands",
	rewriteFileLinks("[cfg](~/dotfiles/zshrc)"),
	`[cfg](pi-open://${HOME}/dotfiles/zshrc)`);

is("file:// becomes pi-open",
	rewriteFileLinks("[hosts](file:///etc/hosts)"),
	"[hosts](pi-open:///etc/hosts)");

is("a title survives",
	rewriteFileLinks(`[x](/etc/hosts "the hosts file")`),
	`[x](pi-open:///etc/hosts "the hosts file")`);

is("two links on one line",
	rewriteFileLinks("[a](/tmp/a.ts) and [b](/tmp/b.ts)"),
	"[a](pi-open:///tmp/a.ts) and [b](pi-open:///tmp/b.ts)");

is("a space is encoded once",
	rewriteFileLinks("[n](file:///tmp/my%20notes.md)"),
	"[n](pi-open:///tmp/my%20notes.md)");

// --- line numbers, however they are spelled --------------------------------

is("colon line number",
	rewriteFileLinks("[row](/Users/joel/dotfiles/pi/kit/lib/transcript/tool-row.ts:42)"),
	"[row](pi-open:///Users/joel/dotfiles/pi/kit/lib/transcript/tool-row.ts?line=42)");

is("#L line number",
	rewriteFileLinks("[row](/tmp/row.ts#L42)"),
	"[row](pi-open:///tmp/row.ts?line=42)");

is("?line= passes through",
	rewriteFileLinks("[row](/tmp/row.ts?line=42)"),
	"[row](pi-open:///tmp/row.ts?line=42)");

// --- the targets that are not ----------------------------------------------

const untouched = (label, markdown) => is(label, rewriteFileLinks(markdown), markdown);

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

is("prose after a fence closes is rewritten",
	rewriteFileLinks("```\n[a](/tmp/a.md)\n```\nthen [b](/tmp/b.md)"),
	"```\n[a](/tmp/a.md)\n```\nthen [b](pi-open:///tmp/b.md)");

is("code span on a line with a real link",
	rewriteFileLinks("`](/no)` but [yes](/tmp/y.md)"),
	"`](/no)` but [yes](pi-open:///tmp/y.md)");

// --- the switch still governs ----------------------------------------------

process.env.PI_TRANSCRIPT_OPEN = "off";
resetFileLinkScheme();
untouched("links off", "[README](/tmp/README.md)");

process.env.PI_TRANSCRIPT_OPEN = "file";
resetFileLinkScheme();
is("file scheme on a machine without the handler",
	rewriteFileLinks("[README](/tmp/README.md)"),
	"[README](file:///tmp/README.md)");

process.env.PI_TRANSCRIPT_OPEN = "pi-open";
resetFileLinkScheme();

await finish();
