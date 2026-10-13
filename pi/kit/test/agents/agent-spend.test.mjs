/**
 * What an agent has cost: its session file's recorded usage plus every agent it
 * spawned, recursively (`agentSpendUsd`, `lib/agents/agent-spend.ts`).
 *
 *   node test/agents/agent-spend.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { agentSpendUsd } = await kitJiti().import(`${KIT_ROOT}/lib/agents/agent-spend.ts`);
const { AGENT_RECORD_ENTRY } = await kitJiti().import(`${KIT_ROOT}/lib/agents/agent-registry.ts`);

console.log("agentSpendUsd: own usage plus the tree below");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-spend-"));
const message = (total) => JSON.stringify({ type: "message", message: { role: "assistant", usage: { cost: { total } } } });
const spawned = (owner, name, sessionId, taskId = `a${name}`) =>
	JSON.stringify({ type: "custom", customType: AGENT_RECORD_ENTRY, data: { name, taskId, ownerSessionId: owner, type: "worker", description: "d", status: "completed", depth: 1, sessionFile: path.join(dir, `${sessionId}.jsonl`), sessionId, cwd: "/", model: "m", toolUses: 0, costUsd: 99, totalTokens: 0, outputTokens: 0, startedAt: 1, laterMessages: [], workflowChild: false } });
const session = (id, lines) => {
	fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
	return { sessionId: id, sessionFile: path.join(dir, `${id}.jsonl`) };
};
session("grand", [message(0.5), JSON.stringify({ type: "message", message: { role: "user" } })]);
session("kid1", [message(0.25), spawned("kid1", "grand", "grand"), message(0.25)]);
session("kid2", [message(1), JSON.stringify({ type: "compaction", usage: { cost: { total: 0.125 } } }), "{ not json"]);
const parent = session("parent", [message(2), spawned("parent", "kid1", "kid1"), spawned("parent", "kid2", "kid2")]);
check("a parent with two children and a grandchild sums all four", agentSpendUsd(parent) === 2 + (0.25 + 0.25 + 0.5) + 1.125, String(agentSpendUsd(parent)));
check("a child alone is its own usage and its own children's", agentSpendUsd({ sessionId: "kid1", sessionFile: path.join(dir, "kid1.jsonl") }) === 1, "kid1");
check("the persisted record's own cost is never read", agentSpendUsd({ sessionId: "kid2", sessionFile: path.join(dir, "kid2.jsonl") }) === 1.125, "kid2");
check("a session with no file costs nothing", agentSpendUsd({ sessionId: "x", sessionFile: undefined }) === 0 && agentSpendUsd({ sessionId: "x", sessionFile: path.join(dir, "missing.jsonl") }) === 0, "missing");
session("run1", [message(3)]);
session("run2", [message(4)]);
const reuse = session("reuse", [spawned("reuse", "same", "run1", "t1"), spawned("reuse", "same", "run2", "t2")]);
check("a reused name counts every run", agentSpendUsd(reuse) === 7, String(agentSpendUsd(reuse)));
fs.rmSync(dir, { recursive: true, force: true });
await finish();
