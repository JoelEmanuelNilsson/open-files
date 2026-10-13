/**
 * A spawn or a resume whose child never starts: the child loader throws. The
 * caller gets the error, and nothing the start set up outlives it — no live
 * mark, no child seat, no record left queued.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, jiti, modelRuntime, runtimeOver } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import fs from "node:fs";
import path from "node:path";

const { liveAgentsOf } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
const { childSeatOf } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
const scripted = modelRuntime.getModel("scripted", "scripted-1");
const seatOver = (sessionId) =>
	runtimeOver({
		sessionId, sessionDir: path.join(AGENT_DIR, "sessions"), cwd: KIT_ROOT, model: () => scripted, resolveModel: () => scripted, exactModel: () => scripted, modelRuntime,
		childLoader: async () => { throw new Error("the loader broke"); },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }), sleep: async () => {},
	}, records[sessionId] ?? []);
const records = {};

{
	console.log("\na spawn whose child loader throws");
	const runtime = await seatOver("failed-spawn-seat");
	const thrown = await runtime.spawn({ description: "never starts", prompt: "Start.", name: "stillborn" }).then(() => "spawned", (error) => error.message);
	check("the spawn rejects with the loader's error", thrown === "the loader broke", thrown);
	check("and leaves no live mark under its owner", liveAgentsOf("failed-spawn-seat").size === 0, [...liveAgentsOf("failed-spawn-seat")].join());
	const record = runtime.registry.byName("stillborn");
	check("its record is settled as an error, not left queued", record?.status === "error" && record.error === "the loader broke", `${record?.status} ${record?.error}`);
	check("and its child seat is forgotten", childSeatOf(record.sessionId) === undefined);
	check("the caller has had the error, so nobody is offered it again", record.readBy === "spawner");
}

{
	console.log("\na resume whose child loader throws");
	const sessionFile = path.join(AGENT_DIR, "resume-me.jsonl");
	fs.writeFileSync(sessionFile, "");
	records["failed-resume-seat"] = [{ name: "sleeper", taskId: "t-sleeper", ownerSessionId: "failed-resume-seat", type: "worker", description: "d", status: "completed", depth: 1, sessionFile, sessionId: "s-sleeper", cwd: KIT_ROOT, branch: undefined, model: "scripted/scripted-1", result: "done", error: undefined, readBy: "conversation", readAt: Date.now(), toolUses: 0, costUsd: 0, totalTokens: 0, outputTokens: 0, startedAt: Date.now(), completedAt: Date.now(), toolCallId: undefined, workflowChild: false }];
	const runtime = await seatOver("failed-resume-seat");
	const thrown = await runtime.send("sleeper", "Wake up.", false, "seat").then(() => "resumed", (error) => error.message);
	check("the resume rejects with the loader's error", thrown === "the loader broke", thrown);
	check("and leaves no live mark under its owner", liveAgentsOf("failed-resume-seat").size === 0, [...liveAgentsOf("failed-resume-seat")].join());
	const record = runtime.registry.byName("sleeper");
	check("its record is settled as an error, not left queued", record?.status === "error" && record.error === "the loader broke", `${record?.status} ${record?.error}`);
}

finish();
