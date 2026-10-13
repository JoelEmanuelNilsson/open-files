/**
 * The first-prompt stagger, offline: a cold fan-out staggers its siblings, the
 * stagger counts the launch batch rather than the living, and `onFirstPrompt`
 * fires as a child's first prompt goes out. The runtimes' sleep is scripted,
 * so the order is pinned without a wall clock.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, DefaultResourceLoader, call, getAgentDir, jiti, lastUserText, modelRuntime, requests, runtimeOver, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import path from "node:path";

// ---------------------------------------------------------------------------
// A cold fan-out staggers its siblings' first prompts (issues/31 (i))
//
// The runtime is built here rather than driven through a seat, because the
// point is the delay: the host's timer is scripted, so the order is pinned
// without a wall clock. A sibling is *created* at once either way — only its
// first prompt waits, so the dock shows it immediately.

// ---------------------------------------------------------------------------
{
	console.log("\na cold fan-out staggers its siblings");
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const { liveAgentCount } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
	const { childSeatOf } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
	const slept = [];
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const host = {
		sessionId: "stagger-seat",
		sessionFile: undefined,
		sessionDir: path.join(AGENT_DIR, "sessions"),
		cwd: KIT_ROOT,
		agentDir: AGENT_DIR,
		depth: 0,
		role: "main",
		types: [],
		model: () => scripted,
		thinkingLevel: () => "off",
		resolveModel: () => scripted, exactModel: () => scripted,
		modelRuntime,
		persist: () => {},
		emit: () => {},
		deliver: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		hasPendingInput: () => false,
		childLoader: async ({ cwd }) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			return loader;
		},
		log: () => {},
		sleep: (ms) => new Promise((resolve) => slept.push({ ms, resolve })),
	};
	const runtime = await runtimeOver(host);
	const names = ["sib-1", "sib-2", "sib-3", "sib-4", "sib-5", "sib-6", "sib-7"];
	for (const name of names) scriptFor(`Fan out, ${name}.`, [{ delay: 4000, content: [text(`${name} done`)] }]);
	await runtime.spawn({ description: "first of the fan-out", prompt: `Fan out, ${names[0]}.`, name: names[0] });
	check("a lone child is not staggered: nothing else is live", slept.length === 0, JSON.stringify(slept.map((s) => s.ms)));
	const seatOfChild = (name) => childSeatOf(runtime.registry.byName(name).sessionId);
	check("a child of a main seat inherits its workflows", seatOfChild(names[0])?.workflows === true, JSON.stringify(seatOfChild(names[0])));
	check("and it prompts at once, writing the prefix", await until(() => requests.some((r) => lastUserText({ messages: r.messages }).includes(`Fan out, ${names[0]}.`)), 5000));
	for (const name of names.slice(1)) await runtime.spawn({ description: "sibling of the fan-out", prompt: `Fan out, ${name}.`, name });
	check("every sibling past the first waits a step longer, capped at five seconds", slept.map((s) => s.ms).join() === "1000,2000,3000,4000,5000,5000", slept.map((s) => s.ms).join());
	const asked = (name) => requests.some((r) => lastUserText({ messages: r.messages }).includes(`Fan out, ${name}.`));
	check("a staggered sibling has sent nothing while it waits", names.slice(1).every((name) => !asked(name)), names.slice(1).filter(asked).join());
	check("but the dock sees it at once: created and running before the prompt", runtime.registry.live().length === names.length, String(runtime.registry.live().length));
	slept[0].resolve();
	check("and it prompts when its turn comes", await until(() => asked(names[1]), 5000));
	check("the ones behind it are still waiting", !asked(names[2]));
	for (const pending of slept) pending.resolve();
	await runtime.retire("shutdown");
	check("every agent has settled after the retire", await until(() => liveAgentCount() === 0, 8000), String(liveAgentCount()));
}

// ---------------------------------------------------------------------------
// The stagger counts the launch batch, not every live child (38's finding 8).
// A run that has ended a turn has written the cache prefix already, so a child
// spawned behind it reads one and waits for nothing.
// ---------------------------------------------------------------------------
{
	console.log("\nthe stagger counts the launch batch, not the living");
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const { AgentRegistry } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);
	const { liveAgentCount } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
	const slept = [];
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const host = {
		sessionId: "batch-seat",
		sessionFile: undefined,
		sessionDir: path.join(AGENT_DIR, "sessions"),
		cwd: KIT_ROOT,
		agentDir: AGENT_DIR,
		depth: 0,
		role: "main",
		types: [],
		model: () => scripted,
		thinkingLevel: () => "off",
		resolveModel: () => scripted, exactModel: () => scripted,
		modelRuntime,
		persist: () => {},
		emit: () => {},
		deliver: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		hasPendingInput: () => false,
		childLoader: async ({ cwd }) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			return loader;
		},
		log: () => {},
		sleep: (ms) => new Promise((resolve) => slept.push({ ms, resolve })),
	};
	const runtime = await runtimeOver(host);
	// One tool call, then a long silence: the first assistant message ends, so the
	// run leaves the batch while it is still very much alive.
	scriptFor("Work, then wait.", [[call("read", { path: `${KIT_ROOT}/package.json` })], { delay: 30000, content: [text("first done")] }]);
	scriptFor("Come in behind it.", [{ delay: 30000, content: [text("second done")] }]);
	await runtime.spawn({ description: "first of the pair", prompt: "Work, then wait.", name: "batch-1" });
	const ended = await until(() => requests.filter((r) => lastUserText({ messages: r.messages }).includes("Work, then wait.")).length === 2, 8000);
	check("the first child has ended a turn: it wrote the prefix", ended);
	await runtime.spawn({ description: "second of the pair", prompt: "Come in behind it.", name: "batch-2" });
	check("a child spawned behind it is not staggered: there is a prefix to read", slept.length === 0, JSON.stringify(slept.map((s) => s.ms)));
	check("and it prompts at once", await until(() => requests.some((r) => lastUserText({ messages: r.messages }).includes("Come in behind it.")), 5000));
	await runtime.retire("shutdown");
	check("every agent has settled after the retire", await until(() => liveAgentCount() === 0, 8000), String(liveAgentCount()));
}

// ---------------------------------------------------------------------------
// `onFirstPrompt` is when a child starts acting on the world: a workflow reads
// its journal `after` there, so it fires after every hold and before the
// prompt, and never for a child stopped while it was held.
// ---------------------------------------------------------------------------
{
	console.log("\na child's onFirstPrompt fires as its first prompt goes out");
	const { AgentRuntime } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
	const { AgentWaitBoard } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-wait-board.ts`);
	const { liveAgentCount } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
	const slept = [];
	const scripted = modelRuntime.getModel("scripted", "scripted-1");
	const deps = {
		cwd: KIT_ROOT,
		agentDir: AGENT_DIR,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		childLoader: async ({ cwd }) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			return loader;
		},
		sleep: (ms) => new Promise((resolve) => slept.push({ ms, resolve })),
		waitBoard: new AgentWaitBoard(),
	};
	const port = {
		sessionId: "first-prompt-seat",
		sessionFile: undefined,
		sessionDir: path.join(AGENT_DIR, "sessions"),
		depth: 0,
		role: "main",
		types: [],
		model: () => scripted,
		resolveModel: () => scripted, exactModel: () => scripted,
		modelRuntime,
		persist: () => {},
		emit: () => {},
		deliver: () => false,
		log: () => {},
		hasPendingInput: () => false,
	};
	const runtime = new AgentRuntime(deps, port, []);
	const asked = (prompt) => requests.some((r) => lastUserText({ messages: r.messages }).includes(prompt));
	// Each hook call notes whether the prompt had already been sent: it must not have been.
	const fired = [];
	const onFirstPrompt = (prompt) => () => fired.push({ prompt, sent: asked(prompt) });
	const prompts = ["Lead the batch.", "Wait your turn.", "Be stopped while held."];
	for (const prompt of prompts) scriptFor(prompt, [{ delay: 30000, content: [text("done")] }]);
	await runtime.spawn({ description: "lead", prompt: prompts[0], name: "fp-lead", onFirstPrompt: onFirstPrompt(prompts[0]) });
	check("a child that is not held fires it at once", await until(() => fired.length === 1, 5000) && fired[0].prompt === prompts[0]);
	await runtime.spawn({ description: "held", prompt: prompts[1], name: "fp-held", onFirstPrompt: onFirstPrompt(prompts[1]) });
	const heldTask = (await runtime.spawn({ description: "stopped", prompt: prompts[2], name: "fp-stopped", onFirstPrompt: onFirstPrompt(prompts[2]) })).taskId;
	check("both siblings are held by the stagger", slept.length === 2, JSON.stringify(slept.map((s) => s.ms)));
	check("and neither has fired it while held", fired.length === 1, JSON.stringify(fired));
	await runtime.stop(heldTask, "cascade");
	slept[0].resolve();
	check("the held child fires it once its hold ends", await until(() => fired.length === 2, 5000) && fired[1].prompt === prompts[1], JSON.stringify(fired));
	check("before its prompt is sent", fired.every((f) => !f.sent), JSON.stringify(fired));
	check("and its prompt then goes out", await until(() => asked(prompts[1]), 5000));
	for (const pending of slept) pending.resolve();
	await runtime.retire("shutdown");
	check("every agent has settled after the retire", await until(() => liveAgentCount() === 0, 8000), String(liveAgentCount()));
	check("a child stopped while held never fires it: it never started", !fired.some((f) => f.prompt === prompts[2]), JSON.stringify(fired));
}

await finish();
