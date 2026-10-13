/**
 * Creating an agent worktree sweeps the leftovers of earlier ones: a worktree
 * is removed when it is clean, its HEAD is merged into main, nothing has it as a
 * working directory and it has been still for two hours. Its branch stays.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SINK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-worktree-sweep-")));
process.env.TMPDIR = SINK;

const jiti = kitJiti({ moduleCache: false });
const { createAgentWorktree, processExec } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-worktree.ts`);

const repo = path.join(SINK, "repo");
fs.mkdirSync(repo);
const git = (args, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd, message) => git(`-c user.email=t@t -c user.name=t commit -q --allow-empty -m ${message}`, cwd);
git("init -q -b main");
commit(repo, "init");
const exec = async (command, args, options) => {
	try {
		return { code: 0, stdout: execSync(`${command} ${args.map((a) => `'${a}'`).join(" ")}`, { cwd: options?.cwd ?? repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
	} catch (error) {
		return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? String(error) };
	}
};

/** An existing worktree that has sat for `ageHours`, made without the sweep that creating one runs. */
const leftover = (name, ageHours, { lock, where = "pi-agent-worktrees" } = {}) => {
	const dir = path.join(SINK, where, `${name}-aaaa`);
	git(`worktree add -q ${lock === undefined ? "" : `--lock --reason '${lock}'`} -b agent/${name} ${dir} main`);
	const old = new Date(Date.now() - ageHours * 3_600_000);
	const gitdir = path.join(repo, ".git", "worktrees", `${name}-aaaa`);
	for (const file of [dir, path.join(gitdir, "HEAD"), path.join(gitdir, "index")]) if (fs.existsSync(file)) fs.utimesSync(file, old, old);
	return dir;
};

fs.mkdirSync(path.join(repo, "node_modules"));
fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "/node_modules\n/.scratch\n");
const stale = leftover("stale", 3);
fs.symlinkSync(path.join(repo, "node_modules"), path.join(stale, "node_modules"));
fs.utimesSync(stale, new Date(Date.now() - 3 * 3_600_000), new Date(Date.now() - 3 * 3_600_000));
const young = leftover("young", 1);
const dirty = leftover("dirty", 3);
fs.writeFileSync(path.join(dirty, "work.txt"), "x");
fs.utimesSync(dirty, new Date(Date.now() - 3 * 3_600_000), new Date(Date.now() - 3 * 3_600_000));
const unmerged = leftover("unmerged", 3);
commit(unmerged, "agent-work");
const livePi = leftover("livepi", 3, { lock: `pi ${process.pid}` });
const deadPid = await new Promise((resolve) => { const child = spawn("true"); child.on("exit", () => resolve(child.pid)); });
const crashed = leftover("crashed", 3, { lock: `pi ${deadPid}` });
const foreignLock = leftover("foreign", 3, { lock: "someone else" });
const byHand = leftover("byhand", 3, { where: "elsewhere" });
const deep = leftover("deep", 3);
fs.mkdirSync(path.join(deep, ".scratch", "a", "b", "c"), { recursive: true });
fs.writeFileSync(path.join(deep, ".scratch", "a", "b", "c", "out.txt"), "x");
for (const dir of [deep, path.join(deep, ".scratch"), path.join(deep, ".scratch", "a"), path.join(deep, ".scratch", "a", "b"), path.join(deep, ".scratch", "a", "b", "c")]) fs.utimesSync(dir, new Date(Date.now() - 3 * 3_600_000), new Date(Date.now() - 3 * 3_600_000));
const occupied = leftover("occupied", 3);
const holder = spawn("sleep", ["60"], { cwd: occupied, stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 300));

const fresh = await createAgentWorktree(exec, repo, "fresh");
const listed = git("worktree list --porcelain");
const present = (dir) => listed.includes(`worktree ${dir}\n`) && fs.existsSync(dir);
check("a clean, merged worktree (node_modules linked) untouched for 2 h is removed", !fs.existsSync(stale) && !listed.includes(stale));
check("but its branch stays", git("branch --list agent/stale").includes("agent/stale"));
check("one touched within 2 h stays", present(young));
check("one with uncommitted work stays", present(dirty));
check("one whose HEAD is not in main stays", present(unmerged));
check("one a process has as its working directory stays", present(occupied));
check("one with a file written within 2 h deep inside (ignored) stays", present(deep));
check("a command killed at its timeout does not read as an exit code a caller accepts", (await processExec("sleep", ["5"], { timeout: 100 })).code > 1);
check("one locked by a live pi stays", present(livePi));
check("one locked by a pi that is gone is removed", !fs.existsSync(crashed) && !listed.includes(crashed));
check("one locked for another reason stays", present(foreignLock));
check("a worktree outside the agent root is swept by the same rule", !fs.existsSync(byHand) && !listed.includes(byHand));
check("the main checkout stays", fs.existsSync(repo) && listed.includes(`worktree ${repo}\n`));
check("a new worktree is locked by this pi", listed.split("\n\n").some((entry) => entry.includes(`worktree ${fresh.path}\n`) && entry.includes(`locked pi ${process.pid}`)));
check("the worktree just created is there", present(fresh.path));

holder.kill();
execSync(`git worktree prune`, { cwd: repo });
fs.rmSync(SINK, { recursive: true, force: true });
await finish();
