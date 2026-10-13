/**
 * A settled child resumed by `SendMessage` sends the same Anthropic tools block
 * it sent before it settled: the resume rebuilds the child's seat exactly, so no
 * tool is redeclared and pi-ai keeps its deferred placeholder in the cached prefix.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, jiti, mainSeat, quiet, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT, importPi } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

const { stream: anthropicStream } = await importPi("node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js");
const { hasToolRedefinitions } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");

const ANTHROPIC_MODEL = {
	id: "claude-test",
	name: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8000,
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

/** The `tools` array pi-ai's Anthropic provider would send for this transcript, captured before any network. */
async function anthropicToolsBlock(messages) {
	let tools;
	const events = anthropicStream(ANTHROPIC_MODEL, { messages }, {
		apiKey: "sk-ant-offline",
		fetch: async () => {
			throw new Error("offline");
		},
		onPayload: (params) => {
			tools = params.tools;
		},
	});
	for await (const _event of events);
	return JSON.stringify(tools);
}

{
	console.log("\nResumed child: tools block");
	const seat = await mainSeat();

	scriptFor("spawn the keeper", [[call("Agent", { description: "keeper job", prompt: "Keep the first job.", name: "keeper" })], [text("spawned")]]);
	scriptFor("Keep the first job.", [[text("First job done.")]]);
	await seat.session.prompt("spawn the keeper");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "keeper"), 3000);
	await quiet(seat);

	scriptFor("message the keeper", [[call("SendMessage", { to: "keeper", message: "keep a second job" })], [text("resumed")]]);
	scriptFor("keep a second job", [[text("Second job done.")]]);
	await seat.session.prompt("message the keeper");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.name === "keeper").length === 2, 3000);
	await quiet(seat);

	const before = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("Keep the first job.")));
	const after = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("keep a second job")));
	check("the child ran before and after the resume", before !== undefined && after !== undefined);
	check("the resume redeclares no tool with a different definition", after !== undefined && !hasToolRedefinitions(after.messages));
	const beforeTools = before && (await anthropicToolsBlock(before.messages));
	const afterTools = after && (await anthropicToolsBlock(after.messages));
	check("the resumed child's Anthropic tools block is byte-identical to the one before it settled", beforeTools !== undefined && beforeTools === afterTools, `${beforeTools?.length} vs ${afterTools?.length}`);
	check("and it still carries pi-ai's deferred placeholder", afterTools?.includes("__pi_deferred_placeholder__") === true);
	seat.session.dispose();
}

await finish();
