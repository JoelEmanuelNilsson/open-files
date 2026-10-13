/**
 * A spawn or a resume whose tool call is aborted (Esc) before the child's first
 * prompt is scheduled is abandoned: the caller gets `AgentStartCancelled`, the
 * record settles `stopped` and read, and nothing the start set up outlives it —
 * no live mark, no child seat, no prompt sent. Held at the child loader
 * (runtime creation) and at the child's `session_start` (the bind in `#start`),
 * the two steps that can take long. The Agent tool's own call has already
 * returned by then, cut short at the abort bound (test/tools/tool-abort-bound.test.mjs).
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, DefaultResourceLoader, getAgentDir, jiti, lastUserText, modelRuntime, requests, runtimeOver } from "../support/agent-engine-seat.mjs";
import { until } from "../support/async-waits.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import path from "node:path";

const { liveAgentsOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
const { childSeatOf } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
const scripted = modelRuntime.getModel("scripted", "scripted-1");

/** A hold the test opens; `reached` says the start is waiting on it. */
const hold = () => {
	let open;
	const held = { reached: false, promise: new Promise((resolve) => (open = resolve)) };
	held.open = open;
	return held;
};

/** A runtime whose child loader waits on `atLoader`, and whose child's `session_start` waits on `atBind`, when given. */
const seatOver = (sessionId, { atLoader, atBind }, records = []) =>
	runtimeOver({
		sessionId, sessionDir: path.join(AGENT_DIR, "sessions"), cwd: KIT_ROOT, model: () => scripted, resolveModel: () => scripted, exactModel: () => scripted, modelRuntime,
		childLoader: async ({ cwd }) => {
			if (atLoader) {
				atLoader.reached = true;
				await atLoader.promise;
			}
			const bindHold = (pi) => pi.on("session_start", async () => {
				if (!atBind) return;
				atBind.reached = true;
				await atBind.promise;
			});
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [bindHold] });
			await loader.reload();
			return loader;
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }), sleep: async () => {},
	}, records);

const prompted = (prompt) => requests.some((request) => lastUserText({ messages: request.messages }).includes(prompt));

async function abandonedSpawn(label, holds, at) {
	console.log(`\na spawn aborted while held at ${label}`);
	const sessionId = `cancelled-spawn-${label}`;
	const runtime = await seatOver(sessionId, holds);
	const esc = new AbortController();
	const prompt = `Never run (${label}).`;
	const spawning = runtime.spawn({ description: "cancelled", prompt, name: `unborn-${label}`, signal: esc.signal }).then(() => "spawned", (error) => error);
	check("the start reaches the hold", await until(() => at.reached, 5000));
	esc.abort();
	at.open();
	const outcome = await spawning;
	check("the spawn rejects as cancelled", outcome?._tag === "AgentStartCancelled", String(outcome));
	check("and leaves no live mark under its owner", liveAgentsOf(sessionId).size === 0, [...liveAgentsOf(sessionId)].join());
	const record = runtime.registry.byName(`unborn-${label}`);
	check("its record is settled stopped and read, not left queued", record?.status === "stopped" && record.readBy === "spawner" && record.completedAt !== undefined, `${record?.status} ${record?.readBy}`);
	check("its child seat is forgotten", childSeatOf(record.sessionId) === undefined);
	check("and the child was never prompted", !prompted(prompt));
}

{
	const atLoader = hold();
	await abandonedSpawn("loader", { atLoader }, atLoader);
}
{
	const atBind = hold();
	await abandonedSpawn("bind", { atBind }, atBind);
}

{
	console.log("\na resume aborted while held at the child loader");
	const sessionId = "cancelled-resume-seat";
	const sessionFile = path.join(AGENT_DIR, "cancelled-resume.jsonl");
	fs.writeFileSync(sessionFile, "");
	const atLoader = hold();
	const runtime = await seatOver(sessionId, { atLoader }, [{ name: "sleeper", taskId: "t-sleeper", ownerSessionId: sessionId, type: "worker", description: "d", status: "completed", depth: 1, sessionFile, sessionId: "s-sleeper", cwd: KIT_ROOT, branch: undefined, model: "scripted/scripted-1", result: "done", error: undefined, readBy: "conversation", readAt: Date.now(), toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: Date.now(), completedAt: Date.now(), toolCallId: undefined, workflowChild: false }]);
	const esc = new AbortController();
	const sending = runtime.send("sleeper", "Wake up, cancelled.", false, "seat", "call_resume", esc.signal).then(() => "resumed", (error) => error);
	check("the resume reaches the hold", await until(() => atLoader.reached, 5000));
	esc.abort();
	atLoader.open();
	const outcome = await sending;
	check("the resume rejects as cancelled", outcome?._tag === "AgentStartCancelled", String(outcome));
	check("and leaves no live mark", liveAgentsOf(sessionId).size === 0);
	const record = runtime.registry.byName("sleeper");
	check("its record is settled stopped and read", record?.status === "stopped" && record.readBy === "spawner", `${record?.status} ${record?.readBy}`);
	check("and the message was never delivered", !prompted("Wake up, cancelled."));
}

finish();
