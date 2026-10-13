/**
 * A spawn's `cwd`, offline: a child starts in the linked git worktree it names, and a
 * directory that is missing, not a linked worktree's top, or the main checkout refuses the spawn.
 */

import { check, finish } from "../support/check-harness.mjs";
import { inFlightRig, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

{
	console.log("\na spawn with a cwd");
	const { AgentRuntime, repo, deps, port, lastOf } = await inFlightRig();
	const persisted = [];
	const runtime = new AgentRuntime(deps(), port("cwd-seat", persisted), []);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cwd-plain-"));
	const sibling = path.join(os.tmpdir(), `spawn-cwd-wt-${process.pid}`);
	execSync(`git worktree add -q -b cwd-test ${sibling}`, { cwd: repo, stdio: "pipe" });
	const refused = async (cwd) => (await runtime.spawn({ description: "x", prompt: "Refused child.", name: "refused", cwd }).then(() => "spawned", (error) => error.message));
	check("a missing directory refuses the spawn, naming cwd", /cwd .*does not exist/.test(await refused(path.join(outside, "nope"))));
	check("a directory outside git refuses the spawn, naming cwd", /cwd .*top of a linked git worktree/.test(await refused(outside)));
	fs.mkdirSync(path.join(sibling, "sub"));
	check("the main checkout refuses the spawn, saying only a linked worktree's top is accepted", /cwd .*top of a linked git worktree/.test(await refused(repo)));
	check("a subdirectory of a linked worktree refuses the spawn", /cwd .*top of a linked git worktree/.test(await refused(path.join(sibling, "sub"))));
	scriptFor("Placed child works.", [[text("placed done")]]);
	await runtime.spawn({ description: "placed", prompt: "Placed child works.", name: "placed", cwd: sibling });
	check("a worktree starts the child there", fs.realpathSync(lastOf(persisted, "placed")?.cwd ?? "/nonexistent") === fs.realpathSync(sibling), lastOf(persisted, "placed")?.cwd);
	await runtime.retire("shutdown");
	fs.rmSync(outside, { recursive: true, force: true });
	execSync(`git worktree remove --force ${sibling}`, { cwd: repo, stdio: "pipe" });
}

await finish();
