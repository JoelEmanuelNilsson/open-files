import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { renderContext as ctx, sgrTheme as themeStub } from "../support/tool-row-fixtures.mjs";
process.env.TMUX = "test";

const { getCapabilities, setCapabilities } = await importPi("node_modules/@earendil-works/pi-tui/dist/terminal-image.js");
const { existsSync } = await import("node:fs");
const jiti = kitJiti();
const receipt = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-receipt.ts`);
const link = await jiti.import(`${KIT_ROOT}/lib/ui/file-link.ts`);

// The path is a hyperlink only when the file is really there to open.
const linked = (path, args = {}) => {
	const component = receipt.toolHeader("read", { path, ...args }, themeStub, ctx({ cwd: KIT_ROOT }));
	return component.render(80)[0];
};
setCapabilities({ ...getCapabilities(), hyperlinks: true });
eq("an existing file is clickable", linked(`${KIT_ROOT}/package.json`).includes("\x1b]8;;"), true);
eq("a missing one is not", linked(`${KIT_ROOT}/nothing-here.json`).includes("\x1b]8;;"), false);
setCapabilities({ ...getCapabilities(), hyperlinks: false });
eq("a terminal without OSC 8 gets no escapes", linked(`${KIT_ROOT}/package.json`).includes("\x1b]8;;"), false);

// ---------------------------------------------------------------------------
// Where a click goes. `file://` opens whatever LaunchServices thinks owns the
// extension — QuickTime Player, for a `.ts` file on this machine — so the rows
// link a scheme of their own instead, and carry the line with it.
// ---------------------------------------------------------------------------

const asked = (choice) => {
	if (choice === undefined) delete process.env.PI_TRANSCRIPT_OPEN;
	else process.env.PI_TRANSCRIPT_OPEN = choice;
	link.resetFileLinkScheme();
};

asked("pi-open");
eq("a link carries the line the call is about", link.fileLinkUrl("/w/a.ts", 42), "pi-open:///w/a.ts?line=42");
eq("and says nothing when there is no line", link.fileLinkUrl("/w/a.ts"), "pi-open:///w/a.ts");
// `?` and `#` are URL syntax, and the handler splits the line off at the first
// `?`, so a filename containing one has to be encoded or it takes the line with it.
eq("URL syntax in a filename is encoded", link.fileLinkUrl("/w/a b#c?.ts", 1), "pi-open:///w/a%20b%23c%3F.ts?line=1");
asked("file");
eq("the old behaviour is one variable away", link.fileLinkUrl("/w/a.ts", 42), "file:///w/a.ts");
asked("off");
eq("and no links at all is another", link.fileLinkUrl("/w/a.ts", 42), undefined);
asked(undefined);
eq("the default follows whether the handler is installed", link.fileLinkScheme(), existsSync(link.PI_OPEN_HANDLER) ? "pi-open" : "file");

asked("pi-open");
setCapabilities({ ...getCapabilities(), hyperlinks: true });
const target = (line) => {
	const match = /\x1b]8;;([^\x1b\x07]*)/.exec(line);
	return match ? match[1] : undefined;
};
eq("a read with an offset opens at that line", target(linked(`${KIT_ROOT}/package.json`, { offset: 12 })), `pi-open://${KIT_ROOT}/package.json?line=12`);
eq("a read of the whole file opens at the top", target(linked(`${KIT_ROOT}/package.json`)), `pi-open://${KIT_ROOT}/package.json`);
// `edit` learns its line from the result, one render after the header drew.
const edited = ctx({ cwd: KIT_ROOT, state: {} });
receipt.toolHeader("edit", { path: "package.json", edits: [1] }, themeStub, edited);
edited.state.line = 278;
eq("an edit opens at the line it changed", target(receipt.toolHeader("edit", { path: "package.json", edits: [1] }, themeStub, edited).render(80)[0]), `pi-open://${KIT_ROOT}/package.json?line=278`);
setCapabilities({ ...getCapabilities(), hyperlinks: false });
asked(undefined);

await finish();
