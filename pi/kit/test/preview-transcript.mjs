/**
 * Renders a real transcript through pi's own `ToolExecutionComponent`, with the
 * real theme and the real registered tools, so the layout can be looked at
 * instead of reasoned about. Not part of `npm test`.
 *
 *   node test/preview-transcript.mjs [width]
 *   PI_PREVIEW_EXPANDED=1 node test/preview-transcript.mjs
 *   PI_PREVIEW_THEME=ansi node test/preview-transcript.mjs   # the kit's own theme
 *
 * `PI_PREVIEW_THEME` takes a theme pi knows or one of the kit's own files.
 * With the kit's, run it in the terminal you actually use: its colours are
 * slots, and the diff rows are mixed from what that terminal shows for them.
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { existsSync } = await import("node:fs");
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// The `(ctrl+o to expand)` hint is read from pi's keybinding registry, which a
// session installs and a bare script does not. Without this the preview quietly
// draws the hintless variant and hides what a real pane shows.
const { setKeybindings } = await import(`${PI}/node_modules/@earendil-works/pi-tui/dist/keybindings.js`);
const { KeybindingsManager } = await import(`${PI}/dist/core/keybindings.js`);
setKeybindings(KeybindingsManager.create());

const themeModule = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
const { AssistantMessageComponent, ToolExecutionComponent } = await import(
	`${PI}/dist/modes/interactive/components/index.js`
);

const wanted = process.env.PI_PREVIEW_THEME || "dark";
if (existsSync(`${ROOT}/themes/${wanted}.json`)) {
	themeModule.setThemeInstance(themeModule.loadThemeFromPath(`${ROOT}/themes/${wanted}.json`));
} else {
	themeModule.initTheme(wanted, false);
}
const theme = themeModule.theme;

// A theme painting in slots leaves the diff rows with nothing to mix until the
// terminal says what those slots are, which a real session asks through the
// editor. Here stdio is the terminal, and the answers are given a moment to
// arrive before anything is drawn.
const { slotColors } = await jiti.import(`${ROOT}/lib/slot-colors.ts`);
if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	slotColors().attach({
		write: (data) => process.stdout.write(data),
		addInputListener: (listener) => {
			const onData = (chunk) => listener(chunk.toString("binary"));
			process.stdin.on("data", onData);
			return () => process.stdin.off("data", onData);
		},
	});
	await new Promise((done) => setTimeout(done, 400));
	process.stdin.setRawMode(false);
	process.stdin.pause();
}

const width = Number(process.argv[2] || 100);
const expanded = process.env.PI_PREVIEW_EXPANDED === "1";

// ---------------------------------------------------------------------------
// An assistant message with thinking, prose, and a list.
// ---------------------------------------------------------------------------

const message = {
	role: "assistant",
	content: [
		{
			type: "thinking",
			thinking:
				"The user wants me to run a series of commands in order, keeping replies short. Let me break this down before starting.\n\nTwo paragraphs, so wrapping is exercised.",
		},
		{ type: "text", text: "Two things changed.\n\n- The first one, which is *emphasised* here.\n- The second, with `code` in it." },
	],
	stopReason: "stop",
};

const component = new AssistantMessageComponent(message);
const rendered = component.render(width);

// `PI_PREVIEW_ANSI=1` keeps the escapes; by default the shape is what matters.
const plain = process.env.PI_PREVIEW_ANSI !== "1";
const bare = (lines) =>
	lines
		.map((l) => {
			const stripped = l.replace(/\x1b\][0-9;]*;?[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
			return `|${plain ? stripped.replace(/\x1b\[[0-9;]*m/g, "") : stripped}`;
		})
		.join("\n");
console.log(`--- assistant message @ ${width}\n${bare(rendered)}\n`);

// ---------------------------------------------------------------------------
// Tool rows, through pi's own shell.
// ---------------------------------------------------------------------------

const tools = new Map();
const register = (extension) =>
	extension({
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerWidget: () => ({ update: () => {}, setHideWhenComplete: () => {} }),
		on: () => {},
	});
register(await jiti.import(`${ROOT}/extensions/transcript/index.ts`, { default: true }));
register(await jiti.import(`${ROOT}/extensions/multi-edit.ts`, { default: true }));
// `extensions/bash.ts` owns the shell and borrows the transcript's receipt, and
// building its real definition needs a session. The rows are what this file
// draws, so it wears the same receipt over pi's own bash definition.
const { receipt } = await jiti.import(`${ROOT}/extensions/transcript/receipt.ts`);
tools.set("bash", { name: "bash", ...receipt("bash") });

const ui = { requestRender: () => {} };
const CWD = ROOT;
/** A 1x1 PNG, enough for `getImageDimensions` to read a header from. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function row(tool, args, result, options) {
	return built(tool, args, result, options).render(width);
}

function built(tool, args, result, { partial = false, error = false, wait = 0, details, id } = {}) {
	const definition = tools.get(tool);
	const component = new ToolExecutionComponent(tool, id ?? `id-${Math.random()}`, args, { showImages: true }, definition, ui, CWD);
	component.setExpanded(expanded);
	component.setArgsComplete();
	component.markExecutionStarted();
	const state = component.rendererState ?? undefined;
	// The clock is real, so a duration has to be faked by moving its start back
	// before the result lands and stops it.
	if (wait > 0 && state?.startedAt !== undefined) state.startedAt -= wait;
	if (result !== undefined) {
		const content = typeof result === "string" ? [{ type: "text", text: result }] : result;
		component.updateResult({ content, details, isError: error }, partial);
	}
	return component;
}

const lines = [
	...row("read", { path: `${ROOT}/extensions/transcript/line.ts` }, Array.from({ length: 412 }, () => "x").join("\n")),
	...row("grep", { pattern: "renderCall", path: `${ROOT}/extensions`, glob: "*.ts" }, "a.ts:1: x\na.ts-2- y\nb.ts:9: x"),
	...row("grep", { pattern: "qwertyuiop", path: `${ROOT}` }, "No matches found"),
	...row("find", { pattern: "**/*.test.ts" }, "No files found matching pattern"),
	...row("ls", { path: ROOT }, "extensions\nlib\nskills\ntest\nthemes\ntools"),
	...row("bash", { command: "npm test" }, "> pi-kit@0.1.0 test\n> node test/smoke.mjs\n\nall 41 checks ok", { wait: 2400 }),
	...row("bash", { command: "npm run build" }, Array.from({ length: 40 }, (_, i) => `line ${i + 1} of build output`).join("\n"), { wait: 9100 }),
	...row(
		"bash",
		{ command: 'ls -la ~/dotfiles/pi/ && echo "===SETTINGS===" && cat ~/dotfiles/pi/settings.json && cat ~/dotfiles/pi/keybindings.json && echo done' },
		"total 0",
	),
	...row("bash", { command: "npx vitest run --reporter verbose --coverage --changed origin/main" }, "PASS src/split-diff.test.ts", { partial: true }),
	...row("bash", { command: "cat /tmp/nope.ts" }, "cat: /tmp/nope.ts: No such file or directory\n\nCommand exited with code 1", { error: true }),
	...row("write", { path: `${ROOT}/tmp/out.ts`, content: "a\nb\nc\n" }, "Successfully wrote 6 bytes to tmp/out.ts"),
	...row(
		"read",
		{ path: "/Users/joel/screenshots/shot.png" },
		[
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: PNG, mimeType: "image/png" },
		],
	),
	...row("edit", { path: `${ROOT}/lib/split-diff.ts`, edits: [1] }, "Edited lib/split-diff.ts\n(1 file(s) written)", {
		details: {
			diff: [" 276          invalidate() {", " 277              cachedLines = undefined;", "-278          }", "+278          },"].join("\n"),
			patch: "",
			firstChangedLine: 278,
		},
	}),
];

console.log(`--- tool rows @ ${width}${expanded ? " (expanded)" : ""}\n${bare(lines)}`);

// ---------------------------------------------------------------------------
// The same turn once it has settled: seven receipts, one line.
// ---------------------------------------------------------------------------

const group = await jiti.import(`${ROOT}/extensions/transcript/group.ts`);
const turn = [
	built("ls", { path: ROOT }, "extensions\nlib\nskills", { id: "t1" }),
	built("bash", { command: "whoami" }, "joel", { id: "t2" }),
	built("bash", { command: "date" }, "Thu Aug 27 22:25:51 CEST 2026", { id: "t3" }),
	built("bash", { command: "uname -a" }, "Darwin arm64", { id: "t4" }),
	built("read", { path: `${ROOT}/package.json` }, "a\nb\nc", { id: "t5" }),
	built("bash", { command: "cat /tmp/nope" }, "cat: /tmp/nope: No such file or directory", { id: "t6", error: true }),
	built("bash", { command: "echo done" }, "done", { id: "t7" }),
];
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const answer = (id, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], isError } });
group.regroup([
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "run 7 shell commands random" }] } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [call("t1", "ls"), call("t2", "bash"), call("t3", "bash"), call("t4", "bash"), call("t5", "read"), call("t6", "bash"), call("t7", "bash")],
		},
	},
	...["t1", "t2", "t3", "t4", "t5"].map((id) => answer(id)),
	answer("t6", true),
	answer("t7"),
]);
await new Promise((resolve) => setTimeout(resolve, 0));
console.log(`\n--- a settled turn @ ${width}${expanded ? " (expanded)" : ""}\n${bare(turn.flatMap((c) => c.render(width)))}`);

// ---------------------------------------------------------------------------
// The same turn three seconds in: what is running, and nothing about what is
// done. Two of the seven have come back and neither of them is on screen.
// ---------------------------------------------------------------------------

const flying = [
	built("ls", { path: ROOT }, "extensions\nlib\nskills", { id: "f1" }),
	built("read", { path: `${ROOT}/package.json` }, "a\nb\nc", { id: "f2" }),
	built("bash", { command: "npm test" }, "PASS test/smoke.mjs", { id: "f3", partial: true }),
	built("bash", { command: "npx vitest run --changed origin/main" }, undefined, { id: "f4" }),
	built("grep", { pattern: "renderCall", path: `${ROOT}/extensions` }, undefined, { id: "f5" }),
];
group.regroup(
	[
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "check the whole thing" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					call("f1", "ls", { path: ROOT }),
					call("f2", "read", { path: `${ROOT}/package.json` }),
					call("f3", "bash", { command: "npm test" }),
					call("f4", "bash", { command: "npx vitest run --changed origin/main" }),
					call("f5", "grep", { pattern: "renderCall", path: `${ROOT}/extensions` }),
				],
			},
		},
		answer("f1"),
		answer("f2"),
	],
	true,
);
await new Promise((resolve) => setTimeout(resolve, 0));
console.log(`\n--- a turn in flight @ ${width}${expanded ? " (expanded)" : ""}\n${bare(flying.flatMap((c) => c.render(width)))}`);
