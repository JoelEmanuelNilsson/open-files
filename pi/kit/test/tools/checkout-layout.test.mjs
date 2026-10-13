/**
 * The checkout layout (lib/git/checkout-layout.ts): one owner of "which checkout is this cwd, and where is its main root".
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { checkoutLayout } = await kitJiti({ moduleCache: false }).import(`${KIT_ROOT}/lib/git/checkout-layout.ts`);
const { replyDetailPath } = await kitJiti({ moduleCache: false }).import(`${KIT_ROOT}/lib/agents/reply-formats.ts`);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-layout-")));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
const main = path.join(root, "main");
const worktree = path.join(root, "wt");
fs.mkdirSync(main);
git(main, "init", "-q");
git(main, "commit", "-qm", "i", "--allow-empty");
git(main, "worktree", "add", "-q", "-b", "wt", worktree);
const separate = path.join(root, "sep");
fs.mkdirSync(separate);
fs.mkdirSync(path.join(root, "elsewhere"));
git(separate, "init", "-q", "--separate-git-dir", path.join(root, "elsewhere", "sep.git"));
fs.mkdirSync(path.join(separate, "src"));

console.log("checkout-layout");
check("invariant: a main checkout is its own main root, with no worktree", JSON.stringify(checkoutLayout(path.join(main))) === JSON.stringify({ mainRoot: main }));
check("invariant: a linked worktree names itself and the main checkout, from any subdirectory", (() => {
	fs.mkdirSync(path.join(worktree, "a"));
	const layout = checkoutLayout(path.join(worktree, "a"));
	return layout?.worktree === worktree && layout.mainRoot === main;
})());
check("invariant: --separate-git-dir is a main checkout rooted where .git sits, not at '/'", checkoutLayout(path.join(separate, "src"))?.mainRoot === separate && checkoutLayout(separate)?.worktree === undefined);
check("invariant: outside a repository there is no layout", checkoutLayout(root) === undefined);
check("invariant: replyDetailPath uses the main root for a worktree and a separate-git-dir checkout", replyDetailPath(worktree, "r", "a") === path.join(main, ".scratch", "r", "a") && replyDetailPath(path.join(separate, "src"), "r", "a") === path.join(separate, ".scratch", "r", "a"));

fs.rmSync(root, { recursive: true, force: true });
await finish();
