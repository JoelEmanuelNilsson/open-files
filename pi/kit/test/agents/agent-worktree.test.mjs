/**
 * Worktree isolation (C19), offline: the branch is agent/<name>, only a clean
 * worktree is removed, no branch is deleted, and through the tool the child
 * works in its worktree and reports the settlement.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, jiti, lastUserText, mainSeat, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Worktree isolation (C19): branch agent/<name>, clean-only removal, no branch deleted
// ---------------------------------------------------------------------------
{
	const { createAgentWorktree, settleAgentWorktree, worktreeBranchFor, worktreeReportLine } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-worktree.ts`);
	console.log("\nworktree isolation");
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-worktree-repo-"));
	const git = (args, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init -q -b main");
	git('-c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
	const exec = async (command, args, options) => {
		try {
			return { code: 0, stdout: execSync(`${command} ${args.map((a) => `'${a}'`).join(" ")}`, { cwd: options?.cwd ?? repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
		} catch (error) {
			return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? String(error) };
		}
	};
	check("the branch is agent/<name>, suffixed when taken", worktreeBranchFor("fix tests", new Set()) === "agent/fix-tests" && worktreeBranchFor("x", new Set(["agent/x", "agent/x-2"])) === "agent/x-3");

	const clean = await createAgentWorktree(exec, repo, "tidy");
	check("a worktree is checked out on its branch", fs.existsSync(clean.path) && git("rev-parse --abbrev-ref HEAD", clean.path) === "agent/tidy");
	const cleanSettle = await settleAgentWorktree(exec, clean);
	check("a clean worktree is removed", cleanSettle.kept === false && !fs.existsSync(clean.path));
	check("but its branch is never deleted", git("branch --list agent/tidy").includes("agent/tidy"));

	const dirty = await createAgentWorktree(exec, repo, "messy");
	fs.writeFileSync(path.join(dirty.path, "new.txt"), "work");
	const dirtySettle = await settleAgentWorktree(exec, dirty);
	check("uncommitted changes keep the worktree and say so", dirtySettle.kept === true && dirtySettle.reason === "uncommitted-changes" && fs.existsSync(dirty.path));
	check("the report names the branch and the path", worktreeReportLine(dirtySettle) === `Worktree kept at ${dirty.path} (branch \`agent/messy\`, uncommitted changes). Merge the branch yourself.`);

	const committed = await createAgentWorktree(exec, repo, "done");
	fs.writeFileSync(path.join(committed.path, "done.txt"), "work");
	git("add -A", committed.path);
	git('-c user.email=t@t -c user.name=t commit -q -m "agent work"', committed.path);
	const committedSettle = await settleAgentWorktree(exec, committed);
	check("commits past the base keep the worktree", committedSettle.kept === true && committedSettle.reason === "commits");

	const landed = await createAgentWorktree(exec, repo, "landed");
	fs.writeFileSync(path.join(landed.path, "landed.txt"), "work");
	git("add -A", landed.path);
	git('-c user.email=t@t -c user.name=t commit -q -m "landed work"', landed.path);
	git("merge -q --ff-only agent/landed");
	const landedSettle = await settleAgentWorktree(exec, landed);
	check("a clean worktree whose commits are already in main is removed, its branch kept", landedSettle.kept === false && !fs.existsSync(landed.path) && git("branch --list agent/landed").includes("agent/landed"), JSON.stringify(landedSettle));

	const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
	let refused;
	try { await createAgentWorktree(exec, notRepo, "x"); } catch (error) { refused = error; }
	check("outside a repo the create fails with the step named", refused?._tag === "AgentWorktreeError" && refused.step === "not-a-repo");

	// Through the tool: the child's cwd is the worktree, its tail says so, and the result reports the settlement.
	const seat = await mainSeat({ cwd: repo });
	scriptFor("isolate one", [[call("Agent", { description: "isolated job", prompt: "Work in isolation.", name: "island", isolation: "worktree" })], [text("ok")]]);
	scriptFor("Work in isolation.", [[text("Nothing to change.")]]);
	await seat.session.prompt("isolate one");
	await seat.session.waitForIdle();
	check("the launch names the branch", seat.toolResults()[0]?.content[0].text.includes("Branch: agent/island"));
	await until(() => seat.events.some((e) => e.channel === "subagents:completed"), 5000);
	const islandRequest = requests.find((r) => lastUserText({ messages: r.messages }).includes("Work in isolation."));
	check("the tail carries the worktree line with the branch", islandRequest !== undefined && lastUserText({ messages: islandRequest.messages }).includes("You work in your own copy of the repo on branch `agent/island`. Commit there."));
	const completed = seat.events.find((e) => e.channel === "subagents:completed");
	check("the result ends with the settlement: clean, removed", completed?.result.endsWith("Worktree on branch `agent/island` had no changes and was removed."), completed?.result);
	// Through the tool: `cwd` starts the child in a named linked worktree; the refusals come back as tool errors.
	{
		const shared = path.join(os.tmpdir(), `agent-cwd-shared-${process.pid}`);
		git(`worktree add -q -b shared-branch '${shared}'`);
		const cwdSeat = await mainSeat({ cwd: repo });
		scriptFor("share one", [[call("Agent", { description: "shared job", prompt: "Work in the shared tree.", name: "tenant", cwd: shared })], [text("ok")]]);
		scriptFor("Work in the shared tree.", [[call("bash", { command: "pwd" })], [text("Done.")]]);
		await cwdSeat.session.prompt("share one");
		await cwdSeat.session.waitForIdle();
		await until(() => cwdSeat.events.some((e) => e.channel === "subagents:completed" && e.name === "tenant"), 5000);
		await cwdSeat.session.waitForIdle();
		const pwdRequest = requests.find((r) => !JSON.stringify(r.messages).includes("share one") && JSON.stringify(r.messages).includes("Work in the shared tree.") && r.messages.some((m) => m.role === "toolResult"));
		check("the child's bash runs in the named worktree", pwdRequest !== undefined && JSON.stringify(pwdRequest.messages).includes(fs.realpathSync(shared)), String(pwdRequest && JSON.stringify(pwdRequest.messages.at(-1))));
		const refusals = [["with isolation", { cwd: shared, isolation: "worktree" }, "cwd and isolation are exclusive"], ["the main checkout", { cwd: repo }, "not the top of a linked git worktree"]];
		for (const [label, extra, message] of refusals) {
			const before = cwdSeat.toolResults().length;
			scriptFor(`refuse ${label}`, [[call("Agent", { description: "refused job", prompt: "Never runs.", ...extra })], [text("noted")]]);
			await cwdSeat.session.prompt(`refuse ${label}`);
			await cwdSeat.session.waitForIdle();
			const result = cwdSeat.toolResults()[before];
			check(`cwd ${label} is a tool error`, result?.isError === true && result.content[0].text.includes(message), JSON.stringify(result));
		}
		cwdSeat.session.dispose();
		execSync(`git worktree remove --force '${shared}'`, { cwd: repo });
	}
	seat.session.dispose();
	for (const wt of [dirty, committed]) execSync(`git worktree remove --force '${wt.path}'`, { cwd: repo });
	fs.rmSync(repo, { recursive: true, force: true });
	fs.rmSync(notRepo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// node_modules: a worktree under the system tmpdir cannot resolve the repo's, so each package dir gets a clone
// ---------------------------------------------------------------------------
{
	const { createAgentWorktree, settleAgentWorktree, worktreeReportLine } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-worktree.ts`);
	console.log("\nworktree node_modules clone");
	const makeRepo = (gitignore, packageDirs = ["."]) => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-worktree-nm-")));
		const run = (args, cwd = dir) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		run("init -q -b main");
		if (gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
		for (const pkg of packageDirs) {
			fs.mkdirSync(path.join(dir, pkg), { recursive: true });
			fs.writeFileSync(path.join(dir, pkg, "package.json"), "{}");
		}
		run("add -A");
		run('-c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
		return { dir, run };
	};
	const execIn = (dir) => async (command, args, options) => {
		try {
			return { code: 0, stdout: execSync(`${command} ${args.map((a) => `'${a}'`).join(" ")}`, { cwd: options?.cwd ?? dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
		} catch (error) {
			return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? String(error) };
		}
	};
	for (const [label, gitignore] of [["no .gitignore", undefined], ["`node_modules/` in .gitignore", "node_modules/\n"]]) {
		const { dir, run } = makeRepo(gitignore, [".", "pkg/inner"]);
		for (const nm of ["node_modules", "pkg/inner/node_modules"]) {
			fs.mkdirSync(path.join(dir, nm));
			fs.writeFileSync(path.join(dir, nm, "dep.txt"), "source");
		}
		const exec = execIn(dir);
		const wt = await createAgentWorktree(exec, dir, "cloned");
		for (const nm of ["node_modules", "pkg/inner/node_modules"]) {
			const copy = path.join(wt.path, nm);
			check(`${label}: ${nm} in the worktree is a real directory, not a symlink`, fs.lstatSync(copy, { throwIfNoEntry: false })?.isDirectory() === true && fs.readFileSync(path.join(copy, "dep.txt"), "utf8") === "source");
			fs.writeFileSync(path.join(copy, "dep.txt"), "changed in worktree");
			check(`${label}: writing in the worktree's ${nm} leaves the repo's copy alone`, fs.readFileSync(path.join(dir, nm, "dep.txt"), "utf8") === "source");
		}
		check(`${label}: a clone reports nothing`, wt.nodeModulesNote === undefined);
		check(`${label}: the clones leave status clean`, run("status --porcelain", wt.path) === "");
		const settled = await settleAgentWorktree(exec, wt);
		check(`${label}: the clean worktree is removed`, settled.kept === false && !fs.existsSync(wt.path));
		const second = await createAgentWorktree(exec, dir, "again");
		check(`${label}: a second worktree is cloned and clean`, fs.lstatSync(path.join(second.path, "pkg/inner/node_modules")).isDirectory() && run("status --porcelain", second.path) === "");
		check(`${label}: the exclude line is written once`, (fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8").match(/^\/node_modules$/gm) ?? []).length <= 1);
		await settleAgentWorktree(exec, second);
		fs.rmSync(dir, { recursive: true, force: true });
	}
	{
		const { dir } = makeRepo(undefined);
		const wt = await createAgentWorktree(execIn(dir), dir, "bare");
		check("no node_modules in the repo: nothing copied", fs.lstatSync(path.join(wt.path, "node_modules"), { throwIfNoEntry: false }) === undefined);
		fs.rmSync(wt.path, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
	{
		const { dir } = makeRepo(undefined, []);
		fs.mkdirSync(path.join(dir, "node_modules"));
		const wt = await createAgentWorktree(execIn(dir), dir, "no-package");
		check("a node_modules with no tracked package.json beside it is not copied", fs.lstatSync(path.join(wt.path, "node_modules"), { throwIfNoEntry: false }) === undefined);
		fs.rmSync(wt.path, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
	{
		const { dir, run } = makeRepo(undefined);
		fs.mkdirSync(path.join(dir, "node_modules"));
		fs.writeFileSync(path.join(dir, "node_modules", "tracked.txt"), "x");
		run("add -f node_modules/tracked.txt");
		run('-c user.email=t@t -c user.name=t commit -q -m track');
		const wt = await createAgentWorktree(execIn(dir), dir, "tracked");
		check("a worktree that already has node_modules keeps its own", fs.lstatSync(path.join(wt.path, "node_modules")).isDirectory());
		fs.rmSync(wt.path, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
	{
		const { dir, run } = makeRepo("node_modules/\n");
		fs.mkdirSync(path.join(dir, "node_modules"));
		const base = execIn(dir);
		const exec = async (command, args, options) => (command === "cp" ? { code: 1, stdout: "", stderr: "clonefile failed: cross-device" } : base(command, args, options));
		const wt = await createAgentWorktree(exec, dir, "fallback");
		const link = path.join(wt.path, "node_modules");
		check("a clone that fails falls back to a symlink to the repo's", fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === path.join(dir, "node_modules"));
		const line = worktreeReportLine({ branch: wt.branch, path: wt.path, kept: false, reason: "clean", nodeModulesNote: wt.nodeModulesNote });
		check("the fallback is reported on the worktree line", line.includes("could not be cloned") && line.includes("cross-device") && line.includes("symlink"));
		check("the symlink fallback leaves status clean", run("status --porcelain", wt.path) === "");
		fs.rmSync(wt.path, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
	{
		const { dir } = makeRepo(undefined);
		fs.mkdirSync(path.join(dir, "node_modules"));
		const base = execIn(dir);
		const exec = async (command, args, options) => (command === "git" && args[0] === "check-ignore" ? { code: 1, stdout: "", stderr: "" } : base(command, args, options));
		fs.chmodSync(path.join(dir, ".git", "info", "exclude"), 0o400);
		const wt = await createAgentWorktree(exec, dir, "failing");
		fs.chmodSync(path.join(dir, ".git", "info", "exclude"), 0o600);
		check("a copy that cannot be finished keeps the agent going and is reported", typeof wt.nodeModulesNote === "string" && worktreeReportLine({ branch: wt.branch, path: wt.path, kept: false, reason: "clean", nodeModulesNote: wt.nodeModulesNote }).includes("node_modules was not provided"));
		fs.rmSync(wt.path, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

await finish();
