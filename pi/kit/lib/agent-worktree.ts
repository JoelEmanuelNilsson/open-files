/**
 * Worktree isolation for an agent (map C19): branch `agent/<name>` checked
 * out in its own directory, the agent commits there, the parent merges.
 *
 * The harness removes the directory only when it is clean — no uncommitted
 * change and no commit past the base — and never deletes a branch. A kept
 * worktree is reported, not hidden: the child's result carries the branch
 * and the path, so the parent can merge or look.
 *
 * Plain git through `exec`; there is no pi machinery in a worktree (ticket
 * 05 §7). What is kept from the vendor: the base-SHA no-change check and
 * best-effort cleanup on a failed create. What is not: `--detach` (C19 wants
 * a named branch), `--no-verify` commits (the agent commits itself), and
 * returning `undefined` for every git failure — a create that fails says why.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** The slice of pi's `exec` a worktree needs. */
export type WorktreeExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A checked-out worktree an agent works in. */
export interface AgentWorktree {
	readonly path: string;
	readonly branch: string;
	/** HEAD of the repo when the worktree was made; a branch still here has no commits. */
	readonly baseSha: string;
	/** The repository the worktree belongs to (its top level). */
	readonly repoRoot: string;
}

/** Why a worktree could not be made. */
export class AgentWorktreeError extends Error {
	readonly _tag = "AgentWorktreeError" as const;
	constructor(
		readonly step: "not-a-repo" | "rev-parse" | "worktree-add",
		detail: string,
	) {
		super(`Agent worktree could not be created (${step}): ${detail}`);
	}
}

/** What settling did with the worktree once the agent finished. */
export interface AgentWorktreeSettlement {
	readonly branch: string;
	readonly path: string;
	/** True when the directory stays because it holds work. */
	readonly kept: boolean;
	/** `clean` removed the directory; otherwise why it was kept. */
	readonly reason: "clean" | "uncommitted-changes" | "commits" | "remove-failed";
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
	const path = join(tmpdir(), "pi-agent-worktrees", `${branch.slice("agent/".length)}-${Math.random().toString(16).slice(2, 10)}`);
	const added = await exec("git", ["worktree", "add", "-b", branch, path, "HEAD"], { cwd, timeout: 30_000 });
	if (added.code !== 0) throw new AgentWorktreeError("worktree-add", added.stderr.trim());
	return { path, branch, baseSha: head.stdout.trim(), repoRoot: top.stdout.trim() };
}

/**
 * Remove the worktree directory when it is clean; keep it, and say why, when
 * it holds uncommitted changes or commits past the base. The branch stays
 * either way (C19).
 */
export async function settleAgentWorktree(exec: WorktreeExec, worktree: AgentWorktree): Promise<AgentWorktreeSettlement> {
	const { path, branch } = worktree;
	const status = await exec("git", ["status", "--porcelain"], { cwd: path, timeout: 10_000 });
	if (status.code !== 0 || status.stdout.trim() !== "") return { branch, path, kept: true, reason: "uncommitted-changes" };
	const tip = await exec("git", ["rev-parse", "HEAD"], { cwd: path, timeout: 5000 });
	if (tip.code !== 0 || tip.stdout.trim() !== worktree.baseSha) return { branch, path, kept: true, reason: "commits" };
	const removed = await exec("git", ["worktree", "remove", "--force", path], { cwd: worktree.repoRoot, timeout: 10_000 });
	if (removed.code !== 0) return { branch, path, kept: true, reason: "remove-failed" };
	return { branch, path, kept: false, reason: "clean" };
}

/** The line appended to a result about where the work went. */
export function worktreeReportLine(settlement: AgentWorktreeSettlement): string {
	if (!settlement.kept) return `Worktree on branch \`${settlement.branch}\` had no changes and was removed.`;
	const why = settlement.reason === "commits" ? "commits" : settlement.reason === "uncommitted-changes" ? "uncommitted changes" : "could not be removed";
	return `Worktree kept at ${settlement.path} (branch \`${settlement.branch}\`, ${why}). Merge the branch yourself.`;
}
