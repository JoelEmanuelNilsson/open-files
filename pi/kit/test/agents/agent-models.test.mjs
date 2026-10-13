/**
 * The model and level an agent runs on, offline: any seat may ask any level
 * and the model clamps it, and a
 * family word resolves across providers or is refused. The family-word
 * section registers providers into the shared model runtime, so it stays last.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, DefaultResourceLoader, SCRIPTED_MODEL, call, getAgentDir, jiti, lastUserText, mainSeat, modelRuntime, quiet, requests, scriptFor, streamSimple, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Every seat may run at any level, medium to max. What a model lacks is its own
// limit: the spawn clamps to its level map and records what the child runs at,
// and that level is what reaches the provider.
// ---------------------------------------------------------------------------
{
	console.log("\nany seat, any level, clamped to the model");
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const { AgentWaitBoard } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-wait-board.ts`);
	const { liveAgentCount } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	// Like Opus 4.7+ and Luna: every level through max.
	const fullRange = { ...scripted, id: "scripted-1", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
	// Like Opus 4.5: nothing past high.
	const toHigh = { ...scripted, id: "scripted-1", reasoning: true };
	const runtimeOn = (modelOf, types = []) =>
		new AgentRuntime(
			{
				cwd: KIT_ROOT, agentDir: AGENT_DIR, exec: async () => ({ code: 0, stdout: "", stderr: "" }), sleep: async () => {}, waitBoard: new AgentWaitBoard(),
				childLoader: async ({ cwd }) => {
					const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
					await loader.reload();
					return loader;
				},
			},
			{
				sessionId: `levels-seat-${Math.random().toString(16).slice(2, 8)}`, sessionFile: undefined, sessionDir: path.join(AGENT_DIR, "sessions"), depth: 0, role: "main", types,
				model: modelOf, resolveModel: modelOf, exactModel: modelOf, modelRuntime,
				persist: () => {}, emit: () => {}, deliver: () => false, log: () => {}, hasPendingInput: () => false,
			},
			[],
		);
	const lead = { name: "lead", description: "Owns work.", model: undefined, thinking: "high", prompt: "", source: "" };
	const full = runtimeOn(() => fullRange, [lead]);
	for (const level of ["medium", "high", "xhigh"]) {
		const prompt = `Run at ${level}.`;
		scriptFor(prompt, [[text(`ran at ${level}`)]]);
		const record = await full.spawn({ description: `a lead at ${level}`, prompt, subagentType: "lead", thinking: level });
		check(`a lead spawned at ${level} is recorded at ${level}`, record.thinking === level, record.thinking);
		const sent = await until(() => requests.some((r) => r.reasoning === level && lastUserText({ messages: r.messages }).includes(prompt)), 5000);
		check(`and ${level} is the level the provider is asked for`, sent, JSON.stringify(requests.filter((r) => lastUserText({ messages: r.messages }).includes(prompt)).map((r) => r.reasoning)));
	}
	// Nothing runs under medium: low is refused at the spawn like any level that does not exist.
	const lowRefused = await full.spawn({ description: "a lead asked for low", prompt: "Run low.", subagentType: "lead", thinking: "low" }).then(() => "spawned", (error) => error.message);
	check("a child asked for low is refused, naming medium to xhigh", lowRefused === 'Thinking level "low" does not exist. Only "medium", "high", "xhigh" do.', lowRefused);
	const typeDefault = await full.spawn({ description: "a lead at its default", prompt: "Run at the type's level.", subagentType: "lead" });
	check("no level asked takes the type's: a lead runs at high", typeDefault.thinking === "high", typeDefault.thinking);
	const worker = { name: "worker", description: "One job.", model: undefined, thinking: "medium", prompt: "", source: "" };
	const typed = runtimeOn(() => fullRange, [worker]);
	scriptFor("Run as a worker.", [[text("ran as a worker")]]);
	const workerDefault = await typed.spawn({ description: "a worker at its default", prompt: "Run as a worker." });
	check("a spawn with no type and no level is a worker at medium", workerDefault.type === "worker" && workerDefault.thinking === "medium", `${workerDefault.type} ${workerDefault.thinking}`);
	scriptFor("Run with no type file.", [[text("ran untyped")]]);
	const untyped = await full.spawn({ description: "a worker with no type file", prompt: "Run with no type file." });
	check("a worker with no type file on disk runs at CHILD_THINKING, medium", untyped.thinking === "medium", untyped.thinking);
	const maxRefused = await typed.spawn({ description: "a worker asked for max", prompt: "Work at max.", thinking: "max" }).then(() => "spawned", (error) => error.message);
	check("a spawn asking for max is refused", maxRefused === 'Thinking level "max" does not exist. Only "medium", "high", "xhigh" do.', maxRefused);
	const refused = await full.spawn({ description: "x", prompt: "x", thinking: "enormous" }).then(() => "spawned", (error) => error.message);
	check("a level that does not exist is refused, naming the ones that do", refused === 'Thinking level "enormous" does not exist. Only "medium", "high", "xhigh" do.', refused);
	const sonnet = runtimeOn(() => ({ ...fullRange, id: "claude-sonnet-5" }));
	const sonnetHigh = await sonnet.spawn({ description: "sonnet at high", prompt: "x", thinking: "high" }).then(() => "spawned", (error) => error.message);
	check("sonnet asked for high is refused", sonnetHigh === "sonnet runs at medium only; for more, use opus at medium or higher.", sonnetHigh);
	scriptFor("Sonnet at medium.", [[text("ok")]]);
	const sonnetMedium = await sonnet.spawn({ description: "sonnet at medium", prompt: "Sonnet at medium.", thinking: "medium" });
	check("sonnet asked for medium spawns", sonnetMedium.thinking === "medium", sonnetMedium.thinking);
	await sonnet.retire("shutdown");
	const sonnetLead = runtimeOn(() => ({ ...fullRange, id: "claude-sonnet-5" }), [{ name: "lead", description: "Owns work.", model: "sonnet", thinking: "xhigh", prompt: "", source: "" }]);
	scriptFor("Lead on sonnet.", [[text("led")]]);
	const leadRecord = await sonnetLead.spawn({ description: "a lead on sonnet", prompt: "Lead on sonnet.", subagentType: "lead" });
	check("a type file's own level is not capped: a Sonnet type file asking xhigh runs at xhigh", leadRecord.thinking === "xhigh", leadRecord.thinking);
	await sonnetLead.retire("shutdown");
	// A record spawned at xhigh, resumed on a model that tops out at high.
	let resumeModel = fullRange;
	const resumer = runtimeOn(() => resumeModel);
	scriptFor("Old xhigh job.", [[text("old job done")]]);
	const old = await resumer.spawn({ description: "an agent from before", prompt: "Old xhigh job.", name: "oldxhigh", thinking: "xhigh" });
	check("the old record says xhigh", old.thinking === "xhigh", old.thinking);
	await until(() => resumer.registry.byName("oldxhigh")?.status === "completed", 5000);
	resumeModel = toHigh;
	scriptFor("Resume the old job.", [[text("resumed")]]);
	const resumed = await resumer.send("oldxhigh", "Resume the old job.", false, "Joel");
	check("a resumed record that says max is clamped to the model's top level", resumed.record.thinking === "high", `${resumed.kind} ${resumed.record.thinking}`);
	const resumeSent = await until(() => requests.some((r) => lastUserText({ messages: r.messages }).includes("Resume the old job.")), 5000);
	check("and runs at high", resumeSent && requests.filter((r) => lastUserText({ messages: r.messages }).includes("Resume the old job.")).every((r) => r.reasoning === "high"), JSON.stringify(requests.filter((r) => lastUserText({ messages: r.messages }).includes("Resume the old job.")).map((r) => r.reasoning)));
	const narrow = runtimeOn(() => toHigh);
	const clamped = await narrow.spawn({ description: "xhigh on a model without it", prompt: "Run past your range.", thinking: "xhigh" });
	check("xhigh on a model without it is clamped to the model's top level, not refused", clamped.thinking === "high", clamped.thinking);
	// The seat reaches all of this through the Agent tool's own parameter.
	const seat = await mainSeat();
	const thinkingParam = seat.tool("Agent").parameters.properties.thinking;
	check("Agent carries a thinking parameter enumerating medium to xhigh", thinkingParam?.enum?.join() === "medium,high,xhigh", JSON.stringify(thinkingParam));
	check("and its guidance carries the sonnet medium-only rule", /sonnet runs at medium only/.test(thinkingParam?.description), thinkingParam?.description);
	scriptFor("spawn an xhigh lead", [[call("Agent", { description: "worker at xhigh", prompt: "Lead at xhigh.", subagent_type: "worker", name: "xhighlead", thinking: "xhigh" })], [text("started")]]);
	scriptFor("Lead at xhigh.", [[text("led")]]);
	await seat.session.prompt("spawn an xhigh lead");
	await seat.session.waitForIdle();
	const started = seat.toolResults().map((m) => m.content.map((c) => c.text).join("")).join("\n");
	check("the Agent tool passes thinking through to the spawn", /Agent started in background/.test(started) && !/does not exist/.test(started), started);
	await quiet(seat);
	seat.session.dispose();
	await Promise.all([full.retire("shutdown"), typed.retire("shutdown"), narrow.retire("shutdown"), resumer.retire("shutdown")]);
	check("every agent has settled after the retire", await until(() => liveAgentCount() === 0, 8000), String(liveAgentCount()));
}

// ---------------------------------------------------------------------------
// A family word names the newest model of that family on any provider, and
// nothing else: no substring answer, and no pick between two providers.
// Last in the file, because a registered provider stays in the shared runtime.
// ---------------------------------------------------------------------------
{
	console.log("\na family word resolves across providers, or is refused");
	const scriptedModel = (id) => ({ ...SCRIPTED_MODEL, id, name: id });
	const lunaProvider = (name, ids) => (pi) => {
		pi.registerProvider(name, { baseUrl: "http://scripted.invalid", apiKey: "scripted", api: "scripted-api", streamSimple, models: ids.map(scriptedModel) });
	};
	const recordOf = (seat, name) => seat.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "agent-record" && e.data.name === name).pop()?.data;

	const one = await mainSeat({ extraFactories: [lunaProvider("luna-a", ["gpt-5.6-luna", "gpt-6-luna", "opusless-substring"])] });
	scriptFor("spawn a luna seat", [[call("Agent", { description: "routine job", prompt: "Routine luna job.", model: "luna", name: "moon" })], [text("started")]]);
	scriptFor("Routine luna job.", [[text("routine done")]]);
	await one.session.prompt("spawn a luna seat");
	await until(() => recordOf(one, "moon")?.status === "completed", 10000);
	check("luna runs on the newest luna, not the first id containing the word", recordOf(one, "moon")?.model === "luna-a/gpt-6-luna", recordOf(one, "moon")?.model);
	await quiet(one);

	const before = one.toolResults().length;
	scriptFor("spawn an opus seat", [[call("Agent", { description: "judgment job", prompt: "Opus job.", model: "opus", name: "sun" })], [text("refused")]]);
	await one.session.prompt("spawn an opus seat");
	await quiet(one);
	const noOpus = one.toolResults()[before];
	check("an id that merely contains the word is no answer: opus with no opus model is refused", noOpus?.isError === true && noOpus.content[0].text.includes('No model for agent type "worker" (asked for "opus")'), noOpus?.content?.[0]?.text);
	one.session.dispose();

	const two = await mainSeat({ extraFactories: [lunaProvider("luna-b", ["gpt-6-luna"])] });
	scriptFor("spawn a luna on two providers", [[call("Agent", { description: "routine job", prompt: "Ambiguous luna job.", model: "luna", name: "eclipse" })], [text("refused")]]);
	await two.session.prompt("spawn a luna on two providers");
	await quiet(two);
	const ambiguous = two.toolResults()[0];
	const said = ambiguous?.content?.[0]?.text ?? "";
	check("a family two providers carry is refused, not picked", ambiguous?.isError === true && said.startsWith('Model "luna" is ambiguous:'), said);
	check("and the refusal names both", said.includes("luna-a/gpt-6-luna") && said.includes("luna-b/gpt-6-luna"), said);
	check("no agent was started", recordOf(two, "eclipse") === undefined);
	two.session.dispose();
}

await finish();
