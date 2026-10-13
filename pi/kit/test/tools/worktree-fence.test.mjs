/**
 * The worktree fence (extensions/tool-call-guard/worktree-fence.ts): a child seat in a linked worktree never writes the main checkout.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const { declareChildSeat, forgetChildSeat } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-fence-")));
const main = path.join(root, "main");
const worktree = path.join(main, "wt");
fs.mkdirSync(main);
const git = (...args) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
git("init", "-q");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--allow-empty");
git("worktree", "add", "-q", "-b", "wt", worktree);

const mod = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/index.ts`);
const handlers = new Map();
mod.default({ on: (event, handler) => handlers.set(event, handler) });
declareChildSeat("agent-seat", { name: "a", role: "worker", depth: 1, parentSessionId: "main-session", workflowChild: false, workflows: false, prompt: { kind: "inherit" } });
const run = (sessionId, toolName, input) => handlers.get("tool_call")({ toolName, input, toolCallId: "t" }, { cwd: worktree, sessionManager: { getSessionId: () => sessionId } });
const blocked = (toolName, input, sessionId = "agent-seat") => run(sessionId, toolName, input)?.block === true;

console.log("worktree-fence");
const refusal = run("agent-seat", "edit", { path: path.join(main, "src", "a.ts") });
check("edit into main is refused", refusal?.block === true);
check("the refusal names the worktree, the same path inside it, and git show", refusal.reason.includes(`worktree ${worktree}`) && refusal.reason.includes(path.join(worktree, "src", "a.ts")) && refusal.reason.includes("git show main:"));
check("edit into main/.scratch is allowed", !blocked("edit", { path: path.join(main, ".scratch", "r", "audit.md") }) && !blocked("write", { path: path.join(main, ".scratch", "x") }));
check("edit inside the worktree is allowed even when it lies under main", !blocked("edit", { path: path.join(worktree, "src", "a.ts") }) && !blocked("write", { path: "rel.txt" }));
check("bash with git -C <root> is refused", blocked("bash", { command: `git -C ${main} mv a b` }));
check("bash cat <root>/.scratch/x is allowed", !blocked("bash", { command: `cat ${main}/.scratch/x` }));
check("bash naming the worktree itself is allowed", !blocked("bash", { command: `cd ${worktree} && ls` }));
check("invariant: edit through files[] into main is refused", blocked("edit", { files: [{ path: path.join(worktree, "ok.ts"), edits: [] }, { path: path.join(main, "src", "a.ts"), edits: [] }] }));
check("invariant: files[] sent as a JSON string is still checked", blocked("edit", { files: JSON.stringify([{ path: path.join(main, "src", "a.ts"), edits: [] }]) }));
check("invariant: files[] inside the worktree is allowed", !blocked("edit", { files: [{ path: "a.ts", edits: [] }] }));
check("invariant: a relative path from the worktree into main is refused", blocked("write", { path: "../src/a.ts" }) && blocked("bash", { command: "touch ../src/a.ts" }));
check("invariant: a '..' path that leaves the worktree is resolved, not matched as text", blocked("bash", { command: `rm ${worktree}/../src/a.ts` }) && !blocked("bash", { command: `rm ${worktree}/sub/../a.ts` }));
check("invariant: a literal cd into main puts later relative paths in main", blocked("bash", { command: "cd .. && rm a.ts" }));
check("invariant: a redirection target is a path", blocked("bash", { command: `echo x > ${main}/a.ts` }) && blocked("bash", { command: "echo x >> ../a.ts" }));
check("read stays allowed", !blocked("read", { path: path.join(main, "src", "a.ts") }));
check("a main session is not fenced", !blocked("edit", { path: path.join(main, "src", "a.ts") }, "main-session") && !blocked("bash", { command: `git -C ${main} status` }, "main-session"));

forgetChildSeat("agent-seat");
fs.rmSync(root, { recursive: true, force: true });
await finish();
