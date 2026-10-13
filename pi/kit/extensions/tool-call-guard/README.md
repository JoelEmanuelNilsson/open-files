# `tool-call-guard` — no scan starts at `/`

**And a scan is refused rather than survived.** pi's `grep`/`find` spawn an
rg/fd child that takes no timeout and that no extension has a handle on, so
for those two prevention is the only lever there is. A call rooted at `/` or
`$HOME` comes back `{block: true, reason}`, and the reason reaches the model,
which retries against a real path. Built-in calls are judged on the resolved
root, defaults included — pi resolves an absent `path` to `.`, so a session
sitting in `$HOME` is refused exactly like one that spelled it out. Bash
commands are judged on their literal tokens (`/`, `~`, `$HOME`, the home path)
for `find`, `rg`, `fd`, `ag` and `ack`: best effort on purpose, since matching
a shell command properly is not possible and pretending otherwise buys false
blocks. `find .` is ordinary work and stays ordinary work.

**Recursive grep is refused at any root, not just broad ones.** `rg` does the
identical job strictly faster — measured over the same 550k-file tree:
`grep -r … | head` hit the 120 s kill, `rg` took 0.96 s — so `grep -r` has no
correct use on this machine, and training-data reflex types it anyway. The
refusal names `rg` and the one semantic difference (gitignored files need
`-uu`); the standing half of the rule is the owned prompt's file-operations
bullet, which maps each search to its owner — text `rg`, filenames `fd`,
syntax `ast-grep`, JSON `jq`. Non-recursive grep — pipes, single files — is
untouched.

**A kill reaches only this session's own processes.** `pkill`, `killall`,
`xargs kill`, `kill 0`, a negative pid (a process group) and any target the
guard cannot read (`kill $(pgrep …)`, a variable not assigned from `$!`) are
refused; a literal pid passes only when it descends from this pi process, so a
pid whose shell already exited (reparented to launchd) is refused too. `$!`,
`%job` and `kill -l` pass. The refusal points at `npm run stop-mine` only when a
`scripts/stop-mine.mjs` exists at or above the working directory. The rule is `kill-guard.ts`.

**An agent seat in an opted-in repo has no host shell and does not poll.** A
repo opts in with `.pi/kit-guards.json` (`{"agentGuards": true}`), read from the
working directory upward by `agent-guard-opt-in.ts`; the main seat is never
judged. `host-sleep-guard.ts` refuses `ssh`, `scp`, `rsync`, `mosh`, `aws ssm
start-session`, `aws ec2-instance-connect` and `<wrapper> ssh` for each wrapper the repo lists in
`hostWrappers` (also behind
`timeout`, `nohup`, `nice`), `sleep` over 5 s or of unreadable length, and any
`sleep` in a `while`/`until` command. The refusal names the blocking commands
that replace the wait, followed by the repo's own `waitWith` text. `install-guard.ts`, under the same opt-in, refuses
`npm install`, `i`, `ci` and `add` in a linked git worktree (its `.git` is a
file; a literal `cd` earlier in the command counts): the harness links the
worktree's `node_modules` from the main checkout, and the lander installs.

**An agent in a linked worktree does not name the main checkout.** `worktree-fence.ts` gets the main root from `lib/git/checkout-layout.ts` (the `.git` file, then git's `commondir`; no subprocess, cached per cwd) and, for child seats only, resolves paths and refuses any that lands inside that root outside the worktree and `<root>/.scratch`. `edit`/`write` are checked on every target path of `lib/tools/edit-tool-params.ts` (`path`, `file_path`, `files[].path`, after the tool's own argument preparation). `bash` is read with `programSegments`: every argument and redirection target is resolved against the tracked cwd (a literal `cd` counts) and `~`, so relative and `..` paths are caught. Reads that name main by bash are refused too; use `git show main:<path>`, or the `read` tool, which stays open.

The real limit: bash is checked by the paths it names. A command or script that computes a path at run time (variables, `eval`, `$(...)` output, a script that writes elsewhere, the program path itself) is not seen. A literal "never" would need a kernel sandbox.

`tool_call` fires before any tool's `execute`, owned or built-in, so the guard
covers the kit's own `bash` as well as pi's `grep`/`find`; bash's deadline is
that tool's own business.

The scan rule is `bash-scan-guard.ts`, reading commands through
`lib/tools/shell-command-segments.ts`. `grep`, `find` and `ls` are never active: pi leaves
them off and the transcript extension does not re-register them, so bash takes the work on the one
tool that takes a timeout.
