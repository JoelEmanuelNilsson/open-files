/**
 * The completion notice: a background agent that landed is the same header and
 * one outcome line, a group is one pair per agent, and a bad payload never
 * throws.
 *
 *   node test/agent-ui/agent-completion-notice.test.mjs
 */

import { check, finish, is } from "../support/check-harness.mjs";
import { KIT_ROOT, initDarkTheme, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();

const theme = await initDarkTheme();

const notice = await jiti.import(`${KIT_ROOT}/extensions/agent-rows/agent-completion-notice.ts`);

const WIDTH = 80;
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "");

function noticeLines(details, expanded = false) {
	const component = notice.renderSubagentNotification({ details }, { expanded }, theme);
	return component === undefined ? [] : component.render(WIDTH).map(plain).filter((line) => line !== "");
}
function noticeRaw(details) {
	const component = notice.renderSubagentNotification({ details }, { expanded: false }, theme);
	return component === undefined ? [] : component.render(WIDTH).map(plain);
}

{
	const drawn = noticeLines({
		id: "explore-1",
		description: "where the parser lives",
		status: "completed",
		toolUses: 45,
		outputTokens: 12_300,
		totalCost: 0.42,
		durationMs: 681_000,
		resultPreview: "The parser is in src/lex/parse.ts",
	});
	is("the notice is the same header", drawn[0], "● Agent(where the parser lives)");
	is("and one line of outcome", drawn[1], "  ⎿  Done · 45 tools · 12.3k out · $0.42 · 11m 21s");
	is("two lines, not four", drawn.length, 2);
}
{
	const drawn = noticeLines({
		id: "a-1",
		description: "audit the error paths",
		status: "error",
		toolUses: 2,
		outputTokens: 900,
		durationMs: 4000,
		error: "watchdog: aborted after 15m\nstack",
		resultPreview: "No output.",
	});
	is("a failed notice says the first line of the reason", drawn[1], "  ⎿  Failed · watchdog: aborted after 15m · 4.0s");
}
{
	const drawn = noticeLines({
		id: "a-1",
		description: "first",
		status: "completed",
		toolUses: 1,
		outputTokens: 10,
		durationMs: 1000,
		resultPreview: "one",
		others: [{ id: "a-2", description: "second", status: "completed", toolUses: 2, outputTokens: 20, durationMs: 2000, resultPreview: "two" }],
	});
	is("a group notice draws one pair per agent", drawn.length, 4);
	is("the first", drawn[0], "● Agent(first)");
	is("and the second", drawn[2], "● Agent(second)");
	const raw = noticeRaw({
		id: "a-1",
		description: "first",
		status: "completed",
		toolUses: 1,
		outputTokens: 10,
		durationMs: 1000,
		resultPreview: "one",
		others: [{ id: "a-2", description: "second", status: "completed", toolUses: 2, outputTokens: 20, durationMs: 2000, resultPreview: "two" }],
	});
	is("with the same blank margin between them a tool row gets", raw[2], "");
	is("and none above the first", raw[0], "● Agent(first)");
}
is("a notice with no details falls back to pi", notice.renderSubagentNotification({}, { expanded: false }, theme), undefined);

try {
	notice.renderSubagentNotification({ details: { others: "not an array" } }, { expanded: false }, theme);
	check("the notice does not throw on a bad payload", true);
} catch (err) {
	check("the notice does not throw on a bad payload", false, err.message);
}

await finish();
