/**
 * A child compacts at its type's `compact_at`, set through its in-memory
 * settings over whatever the settings file says; a type without one never
 * compacts. The registry record carries the brief and the later messages the
 * child's compaction pins. Offline, on `support/agent-engine-seat.mjs`, with a
 * child extension that records each `session_before_compact` and cancels it.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, SCRIPTED_MODEL, call, jiti, mainSeat, quiet, scriptFor, streamSimple, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { childExtensionsList } from "../support/child-extensions.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";

// The file also overrides reserveTokens for the scripted model: a type's compact_at is its own explicit threshold, so the override must not move it.
// The file says compact everything early, so a child that does not compact proves its type turned it off.
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 199_990, keepRecentTokens: 1, modelOverrides: { "scripted/scripted-1": { reserveTokens: 5000 } } } }));
fs.writeFileSync(path.join(AGENT_DIR, "agents", "small.md"), "---\nname: small\ndescription: Compacts early.\ncompact_at: 20\n---\n");
const PROBE = path.join(AGENT_DIR, "compaction-probe.ts");
fs.writeFileSync(
	PROBE,
	`export default function (pi) {
	pi.on("session_before_compact", (event, ctx) => {
		(globalThis.__compactions ??= []).push({ sessionId: ctx.sessionManager.getSessionId(), settings: event.preparation.settings });
		return { cancel: true };
	});
}
`,
);
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts", PROBE);

console.log("\na child compacts at its type's compact_at; a type without one never does");
{
	const seat = await mainSeat({ extraFactories: [(pi) => pi.on("session_before_compact", () => ({ cancel: true }))] });
	const brief = "Small job.\n\n  Step one, then step two.\n";
	scriptFor("start both", [[call("Agent", { description: "small job", prompt: brief, subagent_type: "small", name: "smally" }), call("Agent", { description: "plain job", prompt: "Plain job.", subagent_type: "worker", name: "plain" })], [text("started")]]);
	scriptFor("Small job.", [[call("bash", { command: "true" })], [text("small done")]]);
	scriptFor("Plain job.", [[call("bash", { command: "true" })], [text("plain done")]]);
	await seat.session.prompt("start both");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length === 2, 5000);
	await quiet(seat);
	const records = () => new Map(seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => [e.data.name, e.data]));
	const compactions = globalThis.__compactions ?? [];
	const small = compactions.filter((c) => c.sessionId === records().get("smally")?.sessionId);
	check("the compact_at child compacted, at window − compact_at (200000 − 20)", small.length > 0 && small[0].settings.enabled === true && small[0].settings.reserveTokens === 199_980, JSON.stringify(compactions));
	check("a type without compact_at never compacts, whatever the settings file says", !compactions.some((c) => c.sessionId === records().get("plain")?.sessionId), JSON.stringify(compactions));
	check("the brief is on the record exactly as the parent wrote it", records().get("smally")?.brief === brief, JSON.stringify(records().get("smally")?.brief));

	scriptFor("message plain", [[call("SendMessage", { to: "plain", message: "ALSO-THIS" })], [text("sent")]]);
	scriptFor("ALSO-THIS", [[text("also done")]]);
	await seat.session.prompt("message plain");
	await seat.session.waitForIdle();
	await until(() => records().get("plain")?.status === "completed" && (records().get("plain")?.laterMessages ?? []).length > 0, 5000);
	const later = records().get("plain")?.laterMessages ?? [];
	check("a later message from the parent is on the record, raw, with its sender", later.length === 1 && later[0].from === "main" && later[0].text === "ALSO-THIS", JSON.stringify(later));
	await quiet(seat);
	seat.session.dispose();
}

console.log("\nHaiku compacts at 95000 whatever its type says; other families follow their type");
{
	const model = (id) => ({ ...SCRIPTED_MODEL, id, name: id, contextWindow: 1_000_000 });
	const family = (pi) => pi.registerProvider("families", { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: [model("claude-haiku-4-5"), model("claude-sonnet-4-5")] });
	fs.writeFileSync(path.join(AGENT_DIR, "agents", "bare.md"), "---\nname: bare\ndescription: No compact_at.\n---\n");
	fs.writeFileSync(path.join(AGENT_DIR, "agents", "scout.md"), "---\nname: scout\ndescription: A Haiku type with no compact_at.\nmodel: haiku\n---\n");
	fs.writeFileSync(path.join(AGENT_DIR, "agents", "greedy.md"), "---\nname: greedy\ndescription: A Haiku type that asks for more.\nmodel: haiku\ncompact_at: 300000\n---\n");
	const seat = await mainSeat({ extraFactories: [family, (pi) => pi.on("session_before_compact", () => ({ cancel: true }))] });
	const spawn = (name, args) => [call("Agent", { description: name, prompt: `Job ${name}.`, name, ...args })];
	scriptFor("start families", [[...spawn("hworker", { subagent_type: "worker", model: "haiku" }), ...spawn("hscout", { subagent_type: "scout" }), ...spawn("hgreedy", { subagent_type: "greedy" }), ...spawn("sworker", { subagent_type: "worker", model: "sonnet", thinking: "medium" }), ...spawn("splain", { subagent_type: "bare", model: "sonnet", thinking: "medium" })], [text("started")]]);
	for (const name of ["hworker", "hscout", "hgreedy", "sworker", "splain"]) scriptFor(`Job ${name}.`, [[call("bash", { command: "true" })], [text("done")]]);
	globalThis.__compactions = [];
	globalThis.__billedInput = 96_000;
	await seat.session.prompt("start families");
	await seat.session.waitForIdle();
	await until(() => seat.events.filter((e) => e.channel === "subagents:completed").length >= 5, 8000);
	await quiet(seat);
	delete globalThis.__billedInput;
	const records = new Map(seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record").map((e) => [e.data.name, e.data]));
	const reserveOf = (name) => globalThis.__compactions.find((c) => c.sessionId === records.get(name)?.sessionId)?.settings.reserveTokens;
	check("a Haiku worker compacts at 95000 (reserve = window − 95000)", reserveOf("hworker") === 905_000, JSON.stringify(globalThis.__compactions));
	check("a Haiku type without compact_at compacts at 95000, as explore and reviewer do", reserveOf("hscout") === 905_000);
	check("a type cannot raise Haiku above 95000", reserveOf("hgreedy") === 905_000);
	check("a sonnet worker keeps its type's 300000 and has not reached it", reserveOf("sworker") === undefined);
	check("a non-Haiku type without compact_at never compacts", reserveOf("splain") === undefined);
	seat.session.dispose();
}

await finish();
