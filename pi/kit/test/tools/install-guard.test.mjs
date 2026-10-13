/**
 * The install guard (extensions/tool-call-guard/install-guard.ts): no dependency install in a linked worktree,
 * and through the handler only in an agent seat of an opted-in repo.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const { installRefusal } = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/install-guard.ts`);
const { declareChildSeat, forgetChildSeat } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-install-")));
const main = path.join(root, "main");
const worktree = path.join(root, "wt");
const plain = path.join(root, "plain");
const git = (...args) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
fs.mkdirSync(path.join(main, ".pi"), { recursive: true });
fs.writeFileSync(path.join(main, ".pi", "kit-guards.json"), JSON.stringify({ agentGuards: true }));
fs.mkdirSync(plain);
git("init", "-q");
git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
git("worktree", "add", "-q", "-b", "wt", worktree);

const refused = (command, cwd) => installRefusal("bash", { command }, cwd) !== undefined;

console.log("install-guard: only a linked worktree");
{
	check("npm install, i, ci and add are refused in a worktree", ["npm install", "npm i", "npm ci", "npm add left-pad", "npm install --no-audit", "npm --prefix . i", "cd . && npm install"].every((c) => refused(c, worktree)));
	check("pnpm, yarn and bun installs and adds are refused in a worktree", ["pnpm install", "pnpm i", "pnpm add left-pad", "pnpm --filter web install", "yarn", "yarn install", "yarn add left-pad", "yarn --frozen-lockfile", "bun install", "bun i", "bun add left-pad", "bun --cwd web install"].every((c) => refused(c, worktree)));
	check("other pnpm, yarn and bun commands are not judged", ["pnpm test", "pnpm run build", "yarn build", "yarn --version", "yarn run test", "bun run dev", "bun test", "bunx foo"].every((c) => !refused(c, worktree)) && ["pnpm install", "yarn add x", "bun install"].every((c) => !refused(c, main)));
	check("and from a subdirectory of it", refused("npm install", path.join(worktree)) && refused("cd .. && npm ci", fs.mkdirSync(path.join(worktree, "sub")) ?? path.join(worktree, "sub")));
	check("the main checkout installs", ["npm install", "npm ci", "npm i"].every((c) => !refused(c, main)));
	check("a directory that is no repo installs", !refused("npm install", plain));
	check("a cd into the worktree is judged there, and a cd out of it is too", refused("cd ../wt && npm install", main) && !refused(`cd ${main} && npm install`, worktree));
	check("other npm commands and other tools are not judged", ["npm run build", "npm test", "npm ls", "npm pkg get name", "echo npm install"].every((c) => !refused(c, worktree)) && installRefusal("Read", { command: "npm install" }, worktree) === undefined);
	check("the refusal says the lander installs", installRefusal("bash", { command: "npm ci" }, worktree).includes("the lander installs"));
}

console.log("install-guard: through the handler");
{
	const mod = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/index.ts`);
	const handlers = new Map();
	mod.default({ on: (event, handler) => handlers.set(event, handler) });
	declareChildSeat("agent-seat", { name: "a", role: "worker", depth: 1, parentSessionId: "main-session", workflowChild: false, workflows: false, prompt: { kind: "inherit" } });
	const run = (cwd, sessionId, command) => handlers.get("tool_call")({ toolName: "bash", input: { command }, toolCallId: "t" }, { cwd, sessionManager: { getSessionId: () => sessionId } });

	check("a worker in a worktree of an opted-in repo is blocked", run(worktree, "agent-seat", "npm install")?.block === true);
	check("a worker in the main checkout installs", run(main, "agent-seat", "npm install") === undefined);
	check("the main seat installs anywhere", run(worktree, "main-session", "npm install") === undefined);
	check("a worker in a repo that has not opted in installs", run(plain, "agent-seat", "npm install") === undefined);
	forgetChildSeat("agent-seat");
}

fs.rmSync(root, { recursive: true, force: true });
await finish();
