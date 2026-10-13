/**
 * The `/context` views over a real measured snapshot: the usage estimate adds
 * up, the command grammar is the small one it claims, and both fullscreen
 * views keep the contract the TUI enforces — no line wider than the width it
 * was handed, no frame taller than the terminal — at every level a key can
 * reach, from narrow to wide.
 */
import { check, eq, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { identityTheme } from "../support/identity-theme.mjs";

const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const jiti = kitJiti();
const at = (file) => jiti.import(`${KIT_ROOT}/extensions/context-view/${file}`);

const { analyzeSystemPrompt } = await at("system-prompt-measure.ts");
const { buildInitialSnapshot } = await at("injection-snapshot.ts");
const { computeContextUsage, collectPreviewEntries } = await at("context-usage.ts");
const { UsageView } = await at("ui/usage-view.ts");
const { formatUsagePercent, formatUsageTokens } = await at("ui/usage-format.ts");

const theme = identityTheme;

const cwd = "/work/project";
const prompt = [
	"You are a coding agent.",
	"<project_context>",
	`<project_instructions path="${cwd}/AGENTS.md">`,
	"Project rules.\n".repeat(60),
	"</project_instructions>",
	"</project_context>",
	"APPENDED",
	`Current working directory: ${cwd}`,
	"Added by an extension.",
].join("\n");
const tools = [
	{ name: "read", description: "Read a file.", parametersJson: "{}", guidelines: [], source: "builtin" },
	{ name: "bash", description: "Run a command.", parametersJson: "{}", guidelines: [], source: "builtin" },
	{ name: "web_search", description: "Search.", parametersJson: "{}", guidelines: [], source: "npm:web" },
];
const items = analyzeSystemPrompt(prompt, { cwd, appendSystemPrompt: "APPENDED", contextFilePaths: [`${cwd}/AGENTS.md`] }, tools);
const snapshot = buildInitialSnapshot(items, "real-turn", new Date(0));
const t0 = Date.UTC(2026, 0, 2, 3, 4, 5);
const messages = [
	{ role: "user", content: "hello", timestamp: t0 + 2000 },
	{ role: "assistant", content: [{ type: "thinking", thinking: "think ".repeat(40) }, { type: "text", text: "Answer.\n".repeat(40) }, { type: "toolCall", id: "c", name: "read", arguments: { path: "a" } }], stopReason: "toolUse", timestamp: t0 + 1000 },
	{ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "line\n".repeat(60) }], isError: false, timestamp: t0 + 3000 },
	{ role: "toolResult", toolCallId: "b", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: t0 + 500 },
	{ role: "compactionSummary", summary: "Earlier work.", tokensBefore: 900, timestamp: t0 },
];
const usage = computeContextUsage({
	snapshot,
	messages,
	reported: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
	modelLabel: "claude-test",
	computedAt: new Date(0),
	autoCompactReserveTokens: 16_384,
});

section("the usage estimate");
{
	const sum = (list) => list.reduce((total, category) => total + category.tokens, 0);
	check("the estimate is the sum of the top-level categories", usage.estimatedTokens === sum(usage.categories));
	const aggregates = usage.categories.filter((category) => category.children !== undefined);
	check("and every aggregate is the sum of its breakdown", aggregates.length > 0 && aggregates.every((category) => category.tokens === sum(category.children)));
	check("empty categories are dropped", usage.categories.every((category) => category.tokens > 0));
	eq("the prompt, tools, memory and messages each get a category, in a fixed order",
		usage.categories.map((category) => category.id),
		["system-prompt", "system-tools", "custom-tools", "context-files", "user-messages", "agent-text-messages", "agent-thinking-messages", "agent-tool-call-messages", "tool-output", "compacted-data"]);
	const toolOutput = usage.categories.find((category) => category.id === "tool-output");
	eq("a breakdown lists its largest child first", toolOutput.children.map((child) => child.label), ["read", "bash"]);
	eq("but its preview reads in time order", collectPreviewEntries(toolOutput).map((entry) => entry.timestamp), [t0 + 500, t0 + 3000]);
}

section("the printed numbers");
{
	eq("token counts", [951, 3_700, 43_800, 1_000_000].map(formatUsageTokens), ["951", "3.7k", "43.8k", "1M"]);
	eq("percentages", [0.004, 0.042, 0.96].map(formatUsagePercent), ["0.4%", "4.2%", "96%"]);
}

const KEYS = { down: "\x1b[B", enter: "\r", esc: "\x1b", pgdn: "\x1b[6~", end: "\x1b[F", z: "z", wheel: "\x1b[<65;1;1M" };
const WALK = ["down", "z", "enter", "down", "enter", "pgdn", "wheel", "end", "esc", "esc", "end", "enter", "esc"];
const SIZES = [[40, 14], [60, 24], [100, 40], [140, 30]];

/** Every frame a key walk renders, at every size. */
function framesOf(makeView) {
	const frames = [];
	for (const [width, rows] of SIZES) {
		let closed = false;
		const view = makeView(() => { closed = true; }, rows);
		frames.push({ width, rows, lines: view.render(width) });
		for (const key of WALK) {
			if (closed) break;
			view.handleInput(KEYS[key]);
			frames.push({ width, rows, lines: view.render(width) });
		}
	}
	return frames;
}

for (const [name, makeView] of [
	["usage", (done, rows) => new UsageView(theme, { usage }, done, () => rows)],
]) {
	section(`the ${name} view`);
	const frames = framesOf(makeView);
	const wide = frames.filter((frame) => frame.lines.some((line) => visibleWidth(line) > frame.width));
	const tall = frames.filter((frame) => frame.lines.length > frame.rows);
	check(`no ${name} frame is wider than its width (${frames.length} frames)`, wide.length === 0, wide.map((frame) => `${frame.width}x${frame.rows}`).join(", "));
	check(`and none is taller than the terminal`, tall.length === 0, tall.map((frame) => `${frame.width}x${frame.rows}`).join(", "));
	check("and the walk reaches past the first level", frames.some((frame) => frame.lines.some((line) => line.includes("Esc Back"))));
}

section("the usage view's levels");
{
	let closed = false;
	const view = new UsageView(theme, { usage }, () => { closed = true; }, () => 40);
	const has = (text) => view.render(120).some((line) => line.includes(text));
	check("the dashboard maps the window and lists the buffer and free space", has("Context Usage") && has("Auto-Compact Buffer") && has("Free Space"));
	view.handleInput(KEYS.enter);
	check("Enter opens the selected category's block stream", has("Esc Back") && has("System Prompt"));
	view.handleInput(KEYS.esc);
	check("Esc goes back to the dashboard", has("Esc Close"));
	view.handleInput(KEYS.esc);
	check("and Esc there closes the view", closed);
}

await finish();
