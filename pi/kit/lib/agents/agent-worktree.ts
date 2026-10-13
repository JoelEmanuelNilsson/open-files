import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** The slice of pi's `exec` a worktree needs. */
export type WorktreeExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

const KILLED = 124;

/** Run a command as this process: `pi.exec` refuses once its session is replaced. */
export const processExec: WorktreeExec = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout, encoding: "utf8", maxBuffer: Number.POSITIVE_INFINITY }, (error, stdout, stderr) => {
			resolve({ code: error === null ? 0 : error.killed || error.signal ? KILLED : typeof error.code === "number" ? error.code : 1, stdout, stderr });
		});
	});

/** A checked-out worktree an agent works in. */
export interface AgentWorktree {
	readonly path: string;
	readonly branch: string;
	readonly baseSha: string;
	readonly repoRoot: string;
	readonly nodeModulesNote?: string;
}

/** Why a worktree could not be made. */
export class AgentWorktreeError extends Error {
	readonly _tag = "AgentWorktreeError" as const;
	constructor(
		readonly step: "not-a-repo" | "rev-parse" | "worktree-add" | "reattach",
		detail: string,
	) {
		super(`Agent worktree could not be created (${step}): ${detail}`);
	}
}

/** What settling did with the worktree once the agent finished. */
export interface AgentWorktreeSettlement {
	readonly branch: string;
	readonly path: string;
	readonly kept: boolean;
	readonly reason: "clean" | "uncommitted-changes" | "commits" | "remove-failed";
	readonly nodeModulesNote?: string;
}

/** The branch an agent gets: `agent/<name>`, with a numeric suffix when the name is taken. */
export function worktreeBranchFor(name: string, existingBranches: ReadonlySet<string>): string {
	const base = `agent/${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
	if (!existingBranches.has(base)) return base;
	for (let n = 2; ; n++) if (!existingBranches.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Make the worktree for `name` off the repo at `cwd`. */
export async function createAgentWorktree(exec: WorktreeExec, cwd: string, name: string): Promise<AgentWorktree> {
	const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 });
	if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new AgentWorktreeError("not-a-repo", `${cwd} is not inside a git work tree`);
	const head = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
	const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
	if (head.code !== 0 || top.code !== 0) throw new AgentWorktreeError("rev-parse", (head.stderr || top.stderr).trim());
	const branches = await exec("git", ["branch", "--list", "--format=%(refname:short)"], { cwd, timeout: 5000 });
	const existing = new Set(branches.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
	const branch = worktreeBranchFor(name, existing);
	const root = join(tmpdir(), "pi-agent-worktrees");
	await sweepWorktrees(exec, top.stdout.trim()).catch(() => {});
	const path = join(root, `${branch.slice("agent/".length)}-${Math.random().toString(16).slice(2, 10)}`);
	const added = await exec("git", ["worktree", "add", "--lock", "--reason", `pi ${process.pid}`, "-b", branch, path, "HEAD"], { cwd, timeout: 30_000 });
	if (added.code !== 0) throw new AgentWorktreeError("worktree-add", added.stderr.trim());
	const repoRoot = top.stdout.trim();
	const nodeModulesNote = await provideNodeModules(exec, repoRoot, path);
	return { path, branch, baseSha: head.stdout.trim(), repoRoot, nodeModulesNote };
}

/** Take a settled agent's worktree back for a resume: lock it where it still is, or check its branch out again at the same path. */
export async function reattachAgentWorktree(exec: WorktreeExec, cwd: string, path: string, branch: string): Promise<AgentWorktree> {
	const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
	if (top.code !== 0) throw new AgentWorktreeError("not-a-repo", `${cwd} is not inside a git work tree`);
	const repoRoot = top.stdout.trim();
	const reason = ["--reason", `pi ${process.pid}`];
	const readd = !existsSync(path);
	const attached = readd ? await exec("git", ["worktree", "add", "--lock", ...reason, path, branch], { cwd: repoRoot, timeout: 30_000 }) : await exec("git", ["worktree", "lock", ...reason, path], { cwd: repoRoot, timeout: 10_000 });
	if (attached.code !== 0 && !attached.stderr.includes("already locked")) throw new AgentWorktreeError("reattach", attached.stderr.trim());
	const base = await exec("git", ["merge-base", branch, "HEAD"], { cwd: repoRoot, timeout: 5000 });
	const nodeModulesNote = readd ? await provideNodeModules(exec, repoRoot, path) : undefined;
	return { path, branch, baseSha: base.stdout.trim(), repoRoot, nodeModulesNote };
}

async function provideNodeModules(exec: WorktreeExec, repoRoot: string, worktreePath: string): Promise<string | undefined> {
	const listed = await exec("git", ["ls-files", "-z", "--", "*package.json"], { cwd: repoRoot, timeout: 10_000 });
	const dirs = listed.stdout.split("\0").filter((file) => basename(file) === "package.json" && !file.split("/").includes("node_modules")).map((file) => dirname(file));
	const notes = await Promise.all(dirs.map((dir) => provideOne(exec, join(repoRoot, dir, "node_modules"), join(worktreePath, dir, "node_modules"), worktreePath, dir)));
	const text = notes.filter((note) => note !== undefined).join(" ");
	return text === "" ? undefined : text;
}

async function provideOne(exec: WorktreeExec, source: string, target: string, worktreePath: string, dir: string): Promise<string | undefined> {
	const label = join(dir, "node_modules");
	try {
		if (!statSync(source, { throwIfNoEntry: false })?.isDirectory() || lstatSync(target, { throwIfNoEntry: false }) !== undefined) return undefined;
		const cloneArgs = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
		const cloned = await exec("cp", [...cloneArgs, source, target], { timeout: 300_000 });
		let note: string | undefined;
		if (cloned.code !== 0) {
			rmSync(target, { recursive: true, force: true });
			symlinkSync(realpathSync(source), target);
			note = `${label} could not be cloned (${cloned.stderr.trim() || `cp exit ${cloned.code}`}), so it is a symlink to the repo's: an install in it changes the repo's copy.`;
		}
		if ((await exec("git", ["check-ignore", "-q", label], { cwd: worktreePath, timeout: 5000 })).code === 0) return note;
		const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktreePath, timeout: 5000 });
		if (common.code !== 0) return common.stderr.trim();
		appendFileSync(join(common.stdout.trim(), "info", "exclude"), `/${label}\n`);
		return note;
	} catch (error) {
		return `${label} was not provided: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** Unlock the worktree and remove its directory, ignored files included, when it has no uncommitted change and no commit outside main; the branch is never deleted. */
export async function settleAgentWorktree(exec: WorktreeExec, worktree: AgentWorktree): Promise<AgentWorktreeSettlement> {
	const { path, branch } = worktree;
	await exec("git", ["worktree", "unlock", path], { cwd: worktree.repoRoot, timeout: 10_000 });
	const status = await exec("git", ["status", "--porcelain"], { cwd: path, timeout: 10_000 });
	if (status.code !== 0 || status.stdout.trim() !== "") return { branch, path, kept: true, reason: "uncommitted-changes", nodeModulesNote: worktree.nodeModulesNote };
	const tip = await exec("git", ["rev-parse", "HEAD"], { cwd: path, timeout: 5000 });
	if (tip.code !== 0 || (tip.stdout.trim() !== worktree.baseSha && !(await inMain(exec, worktree.repoRoot, tip.stdout.trim())))) return { branch, path, kept: true, reason: "commits", nodeModulesNote: worktree.nodeModulesNote };
	const removed = await exec("git", ["worktree", "remove", "--force", path], { cwd: worktree.repoRoot, timeout: 10_000 });
	if (removed.code !== 0) return { branch, path, kept: true, reason: "remove-failed", nodeModulesNote: worktree.nodeModulesNote };
	return { branch, path, kept: false, reason: "clean", nodeModulesNote: worktree.nodeModulesNote };
}

async function inMain(exec: WorktreeExec, repoRoot: string, sha: string): Promise<boolean> {
	for (const main of ["main", "master"]) {
		if ((await exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${main}`], { cwd: repoRoot, timeout: 5000 })).code !== 0) continue;
		return (await exec("git", ["merge-base", "--is-ancestor", sha, `refs/heads/${main}`], { cwd: repoRoot, timeout: 5000 })).code === 0;
	}
	return false;
}

const SWEEP_IDLE_MS = 2 * 60 * 60 * 1000;

async function workingDirectories(exec: WorktreeExec): Promise<string[] | undefined> {
	const listed = await exec("lsof", ["-a", "-d", "cwd", "-Fn"], { timeout: 10_000 });
	return listed.code > 1 || listed.stdout === "" ? undefined : listed.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

function lockIsStale(reason: string): boolean {
	const pid = /^pi (\d+)$/.exec(reason)?.[1];
	if (pid === undefined) return false;
	try {
		process.kill(Number(pid), 0);
		return false;
	} catch (error) {
		// SAFETY: errors thrown by process.kill are NodeJS.ErrnoException
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export async function sweepWorktrees(exec: WorktreeExec, repoRoot: string): Promise<string[]> {
	const listed = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, timeout: 10_000 });
	if (listed.code !== 0) return [];
	const entries = listed.stdout.split("\n\n").filter((entry) => entry.startsWith("worktree ")).map((entry) => entry.split("\n"));
	const candidates = entries.slice(1).flatMap((lines) => {
		if (lines.includes("bare") || lines.includes("prunable")) return [];
		const path = lines[0].slice("worktree ".length);
		const lock = lines.find((line) => line === "locked" || line.startsWith("locked "));
		return path === realpathSync(repoRoot) || (lock !== undefined && !lockIsStale(lock.slice("locked ".length))) ? [] : [{ path, locked: lock !== undefined }];
	});
	if (candidates.length === 0) return [];
	const cwds = await workingDirectories(exec);
	if (cwds === undefined) return [];
	const removed: string[] = [];
	for (const { path, locked } of candidates) {
		if (cwds.some((cwd) => cwd === path || cwd.startsWith(path + sep))) continue;
		const status = await exec("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: path, timeout: 10_000 });
		if (status.code !== 0 || status.stdout.trim() !== "") continue;
		const tip = await exec("git", ["rev-parse", "HEAD"], { cwd: path, timeout: 5000 });
		if (tip.code !== 0 || !(await inMain(exec, repoRoot, tip.stdout.trim()))) continue;
		if (!(await idleFor(exec, path, SWEEP_IDLE_MS))) continue;
		if (locked) await exec("git", ["worktree", "unlock", path], { cwd: repoRoot, timeout: 10_000 });
		if ((await exec("git", ["worktree", "remove", path], { cwd: repoRoot, timeout: 10_000 })).code === 0) removed.push(path);
	}
	return removed;
}

async function idleFor(exec: WorktreeExec, path: string, idleMs: number): Promise<boolean> {
	try {
		const gitdir = resolve(path, readFileSync(join(path, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
		if (![join(gitdir, "HEAD"), join(gitdir, "index")].every((file) => (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < Date.now() - idleMs)) return false;
	} catch {
		return false;
	}
	const recent = await exec("find", [path, "(", "-name", "node_modules", "-o", "-name", ".git", ")", "-prune", "-o", "-mmin", `-${Math.ceil(idleMs / 60_000)}`, "-print", "-quit"], { timeout: 60_000 });
	return recent.code === 0 && recent.stdout === "";
}

/** The line appended to a result about where the work went. */
export function worktreeReportLine(settlement: AgentWorktreeSettlement): string {
	const linkNote = settlement.nodeModulesNote === undefined ? "" : ` ${settlement.nodeModulesNote}`;
	if (!settlement.kept) return `Worktree on branch \`${settlement.branch}\` had no changes and was removed.${linkNote}`;
	const why = settlement.reason === "commits" ? "commits" : settlement.reason === "uncommitted-changes" ? "uncommitted changes" : "could not be removed";
	return `Worktree kept at ${settlement.path} (branch \`${settlement.branch}\`, ${why}). Merge the branch yourself.${linkNote}`;
}
