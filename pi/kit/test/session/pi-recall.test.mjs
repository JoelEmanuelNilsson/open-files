/**
 * `bin/pi-recall.mjs`, the way back to an old session's raw history that every
 * continuation's first message names: list, grep, show and seat, against a
 * fixture session file with an abandoned branch in it.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

console.log("the recall script");
{
	const RECALL = `${KIT_ROOT}/bin/pi-recall.mjs`;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-"));
	const file = path.join(dir, "old.jsonl");
	// A branch with a dead side branch (entry x, parent u1) the model never saw at the end.
	const lines = [
		{ type: "session", id: "h", version: 3, timestamp: "t0" },
		{ type: "model_change", id: "mc", parentId: null, provider: "p", modelId: "m" },
		{ type: "message", id: "u1", parentId: "mc", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "Fix the cache TTL bug\nin session-mode" }] } },
		{ type: "message", id: "x", parentId: "u1", timestamp: "tx", message: { role: "assistant", content: [{ type: "text", text: "ABANDONED BRANCH" }] } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm TTL" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x.ts" } }] } },
		{ type: "message", id: "r1", parentId: "a1", timestamp: "t3", message: { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: `const TTL = 300; // ${"z".repeat(200)} end` }] } },
		{ type: "custom", id: "k", parentId: "r1", customType: "agent-record", data: { name: "secret-TTL-record" } },
		{ type: "custom_message", id: "cm", parentId: "k", timestamp: "t4", customType: "handoff-nudge", content: "[handoff] Context is at 150k" },
		{ type: "message", id: "u2", parentId: "cm", timestamp: "t5", message: { role: "user", content: "Now the ping" } },
		{ type: "message", id: "b1", parentId: "u2", timestamp: "t6", message: { role: "bashExecution", command: "npm test", output: "ERR_UNIQUE_9187", exitCode: 1 } },
		{ type: "message", id: "b2", parentId: "b1", timestamp: "t7", message: { role: "bashExecution", command: "ls", output: "HIDDEN_9187", excludeFromContext: true } },
		{ type: "custom", id: "hs", parentId: "b2", customType: "handoff-seat", data: { side: "continuation", model: "p/m", thinking: "medium", wanted: { model: "p/big", thinking: "high" }, carried: false } },
	];
	fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const run = (...args) => {
		try {
			return { code: 0, out: execFileSync("node", [RECALL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
		} catch (error) {
			return { code: error.status, out: error.stdout ?? "", err: error.stderr ?? "" };
		}
	};
	const listed = run(file, "list");
	check("list: every user message, numbered by branch position, one line each", listed.code === 0 && listed.out === "1  Fix the cache TTL bug in session-mode\n5  Now the ping\n", JSON.stringify(listed));
	const grepped = run(file, "grep", "ttl");
	check("grep: case-insensitive, numbered, with a snippet, over messages and custom messages", grepped.code === 0 && grepped.out.includes("[1 user] t1") && grepped.out.includes("[2 assistant] t2") && grepped.out.includes("[3 toolResult read] t3") && grepped.out.trim().endsWith("3 entries match"), grepped.out);
	check("grep: the abandoned branch and extension bookkeeping are never seen", !grepped.out.includes("ABANDONED") && !run(file, "grep", "secret").out.includes("secret-TTL-record") && run(file, "grep", "ABANDONED").out.trim() === "0 entries match");
	check("grep: --limit caps and says so", run(file, "grep", "ttl", "--limit", "1").out.includes("1 of 3 shown"));
	const bashed = run(file, "grep", "ERR_UNIQUE_9187");
	check("grep: a user's !command output is in context, a !!command's is not", bashed.out.includes("[6 bashExecution] t6") && bashed.out.trim().endsWith("1 entries match") && run(file, "grep", "HIDDEN_9187").out.trim() === "0 entries match", bashed.out);
	const shown = run(file, "show", "3");
	check("show: the entry whole, by the number list and grep printed", shown.code === 0 && shown.out.startsWith("[3 toolResult read] t3\nconst TTL = 300;") && shown.out.includes("end"));
	check("show: --max cuts and says how to see all", run(file, "show", "3", "--max", "20").out.includes("more characters; --max"));
	check("show: a custom message is reachable", run(file, "show", "4").out.includes("[4 custom handoff-nudge]"));
	check("show: an unknown number is an error naming the branch size", run(file, "show", "9").code === 1 && run(file, "show", "9").err.includes("the branch has 6"));
	check("usage on a bad command, a bad regex, a bad number", run(file, "nope").code === 1 && run(file, "grep", "(").err.includes("bad regex") && run(file, "show", "x").err.includes("entry number"));
	// The flag that does not exist is named, not swallowed into the positionals
	// and answered with a usage blob that never mentions it (issues/49).
	check("an unknown flag is named, with the reason there is no -i", run(file, "grep", "-i", "ttl").err.includes("no such option -i") && run(file, "grep", "-i", "ttl").err.includes("always case-insensitive"));
	check("and the usage says the same thing", run(file, "nope").err.includes("always case-insensitive"));
	const seated = run(file, "seat");
	check("seat: the model and level the session ran on, and that a handoff did not keep the seat", seated.code === 0 && seated.out === "model p/m\ncontinuation on p/m at medium — the seat was NOT kept; it wanted p/big at high\n", JSON.stringify(seated));
	check("a missing file is an error, not a stack trace", run(path.join(dir, "missing.jsonl"), "list").err.startsWith("cannot read"));
	fs.rmSync(dir, { recursive: true, force: true });
}

await finish();
