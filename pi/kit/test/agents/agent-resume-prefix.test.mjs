/**
 * A settled child resumed by `SendMessage` sends the system prompt and tools it
 * sent before it settled, even when the files its prompt was read from changed
 * on disk in between: the resume must not rewrite the child's cached prefix.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, call, mainSeat, quiet, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";

{
	console.log("\nResumed child: system prompt and tools after the prompt files changed");
	const appendFile = path.join(AGENT_DIR, "APPEND_SYSTEM.md");
	fs.writeFileSync(appendFile, "Standing rule as the child was spawned.");
	const seat = await mainSeat();

	scriptFor("spawn the scribe", [[call("Agent", { description: "scribe job", prompt: "Write the first page.", name: "scribe" })], [text("spawned")]]);
	scriptFor("Write the first page.", [[text("First page written.")]]);
	await seat.session.prompt("spawn the scribe");
	await seat.session.waitForIdle();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === "scribe"), 3000);
	await quiet(seat);

	fs.writeFileSync(appendFile, "Standing rule edited after the child settled.");

	scriptFor("message the scribe", [[call("SendMessage", { to: "scribe", message: "write a second page" })], [text("resumed")]]);
	scriptFor("write a second page", [[text("Second page written.")]]);
	await seat.session.prompt("message the scribe");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed" && e.name === "scribe").length === 2, 3000);
	await quiet(seat);

	const before = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("Write the first page.")));
	const after = requests.find((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("write a second page")));
	check("the child ran before and after the resume", before !== undefined && after !== undefined);
	check("the child's first prompt carried the file as it was at spawn", before?.system?.includes("Standing rule as the child was spawned.") === true);
	check("the resumed child's system prompt equals the one before it settled", before !== undefined && before.system === after?.system, after?.system?.slice(-120));
	check("the resumed child's tools equal the ones before it settled", before !== undefined && JSON.stringify(before.tools) === JSON.stringify(after?.tools));
	seat.session.dispose();
}

await finish();
