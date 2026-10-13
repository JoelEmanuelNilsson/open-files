/**
 * Esc ends every tool call (lib/tools/tool-abort-bound.ts). pi's `abort()` waits
 * for the running call, so one execute deaf to its signal held a seat for 53
 * minutes. Two halves:
 *
 * - the source: no kit file registers a tool except through
 *   `registerAbortBoundedTool`. A registration that bypasses it is exactly how a
 *   deaf tool would come back, and no test that drives a tool can see a tool
 *   that is not there yet, so this reads the source, as renderers.test.mjs does;
 * - a real seat: a tool whose work never resolves, aborted the way Esc aborts
 *   (`session.abort()`), returns within the bound with a result that says it
 *   was cancelled and what goes on without it.
 *
 * Tools the kit does not register are outside the first check; each was read and
 * honours its signal: `web_search` and `url_context` (pi-web-search, fetch and
 * SSE reads take it) and plannotator's plan submit (its browser wait listens).
 *
 *   node test/tools/tool-abort-bound.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, jiti, mainSeat, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { loadPerCore, until } from "../support/async-waits.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import path from "node:path";

const { registerAbortBoundedTool, TOOL_ABORT_BOUND_MS } = await jiti.import(`${KIT_ROOT}/lib/tools/tool-abort-bound.ts`);
const HELPER = path.join(KIT_ROOT, "lib/tools/tool-abort-bound.ts");

function sources(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sources(full));
		else if (/\.tsx?$/.test(entry.name)) found.push(full);
	}
	return found;
}

/** Source with comments blanked, so prose naming `registerTool` is not a registration. */
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

{
	console.log("\nno kit tool is registered around the abort bound");
	const files = [...sources(path.join(KIT_ROOT, "extensions")), ...sources(path.join(KIT_ROOT, "lib"))];
	const bypasses = files.filter((file) => file !== HELPER && /\bregisterTool\b/.test(codeOf(fs.readFileSync(file, "utf8"))));
	check("only lib/tools/tool-abort-bound.ts names pi's registerTool", bypasses.length === 0, bypasses.map((file) => path.relative(KIT_ROOT, file)).join(", "));
	const bounded = files.filter((file) => /\bregisterAbortBoundedTool\(pi\b/.test(codeOf(fs.readFileSync(file, "utf8")))).map((file) => path.relative(KIT_ROOT, file));
	const expected = ["extensions/agent-engine/index.ts", "extensions/bash/index.ts", "extensions/multi-edit/index.ts", "extensions/transcript/builtin-tool-overrides.ts", "extensions/workflow/index.ts"];
	check("and every file that registers a tool registers through it", expected.every((file) => bounded.includes(file)), bounded.join(", "));
	check("the check sees a bypass when there is one", /\bregisterTool\b/.test(codeOf("pi.registerTool({ name })")) && !/\bregisterTool\b/.test(codeOf("// hand it to `registerTool`\n/** registerTool */")));
}

let hangStarted = false;
let finishLate;
let listening = false;
let honestAborts = 0;
const hungTools = (pi) => {
	registerAbortBoundedTool(pi, {
		name: "Hang",
		label: "Hang",
		description: "Never returns and ignores its signal.",
		parameters: { type: "object", properties: {} },
		execute: () => {
			hangStarted = true;
			return new Promise((resolve) => (finishLate = resolve));
		},
	}, () => "The hang goes on in the background.");
	registerAbortBoundedTool(pi, {
		name: "Listen",
		label: "Listen",
		description: "Returns when aborted.",
		parameters: { type: "object", properties: {} },
		execute: (_id, _params, signal) =>
			new Promise((_resolve, reject) => {
				listening = true;
				signal.addEventListener("abort", () => {
					honestAborts++;
					reject(new Error("Listen heard the abort"));
				}, { once: true });
			}),
	});
};

const seat = await mainSeat({ persisted: false, extraFactories: [hungTools] });
const resultText = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

{
	console.log("\nEsc on a tool whose work never resolves");
	scriptFor("hang here", [[call("Hang", {})], [text("after the hang")]]);
	const prompting = seat.session.prompt("hang here").catch(() => {});
	check("the tool is running", await until(() => hangStarted, 5000));
	const escAt = performance.now();
	await seat.session.abort();
	const waited = performance.now() - escAt;
	await prompting;
	check(`abort returns within the bound (${TOOL_ABORT_BOUND_MS} ms) plus scheduling slack`, waited >= TOOL_ABORT_BOUND_MS - 50 && waited < TOOL_ABORT_BOUND_MS + 1500 * loadPerCore(), `${Math.round(waited)} ms`);
	const result = seat.toolResults().at(-1);
	const said = result === undefined ? "" : resultText(result);
	check("the result is an error that says the call was cancelled", result?.isError === true && said.startsWith("Cancelled: Hang did not finish within 2 s of the abort"), said);
	check("and names the work that goes on", said.includes("The hang goes on in the background."), said);
	finishLate({ content: [{ type: "text", text: "late" }], details: undefined });
	await new Promise((resolve) => setImmediate(resolve));
	check("the late result changes nothing that was answered", resultText(seat.toolResults().at(-1)) === said);
}

{
	console.log("\nEsc on a tool that honours its signal");
	scriptFor("listen here", [[call("Listen", {})], [text("after listening")]]);
	const prompting = seat.session.prompt("listen here").catch(() => {});
	check("the tool is running", await until(() => listening, 5000));
	const escAt = performance.now();
	await seat.session.abort();
	const waited = performance.now() - escAt;
	await prompting;
	check("it answers for itself, well inside the bound", honestAborts === 1 && waited < (TOOL_ABORT_BOUND_MS / 2) * loadPerCore(), `${Math.round(waited)} ms, ${honestAborts} abort(s) heard`);
	const said = resultText(seat.toolResults().at(-1));
	check("with its own words, not the cut-short text", said === "Listen heard the abort", said);
}

finish();
