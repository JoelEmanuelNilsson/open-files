# `bash` — the kit's own shell, in Claude Code's shape

pi's bash kills a command at its timeout and had no timeout at all unless the
model passed one. The kit used to patch that from outside at three seams — a
schema rewrite on the wire, a `tool_call` intercept for `run_in_background`, a
`tool_result` rewrite telling the model to retry in the background after a kill
— and a watchdog nagged on top. The one behaviour that mattered, *keep the
process and hand back the output so far*, was unreachable: pi's tool held the
child and killed its tree from a private timer.

pi exposes exactly the seam that fixes this. `createBashToolDefinition(cwd,
{ operations: { exec } })` takes the process as a parameter and keeps
everything else — the output accumulator, truncation and its temp file, the
streaming partial render with the ticking `Elapsed` line. `extensions/bash/index.ts`
registers the result under the built-in's name, which replaces it;
`bash-execution.ts` supplies `exec` from a `BashRun` (`bash-process.ts`) built
per call, and `background-notice-row.ts` draws the notice. The numbers and the
schema are `lib/tools/bash-tool.ts`; the result's words are
`lib/tools/bash-result-notices.ts`, the notification and the stall rule
`lib/tools/background-task-notification.ts`, the log
`lib/tools/background-task-log.ts`.

A command's life:

| | |
|---|---|
| no `timeout` passed | **120 s** of foreground |
| the model may request | up to **600**, and is told so |
| hard ceiling, clamped | **1800** (30 min) |
| the timeout arrives | the command is **moved to the background**, not killed |
| `run_in_background: true` | the same move at t=0 |
| `ctrl+b` | the same move, now, for every running command |
| the shell exits, leaving processes in its group (`&`, `nohup`, a subshell) | the same move: they are the task, and it ends when the last of them exits |
| Esc | still a kill |

Every run logs from the start — stdout and stderr go to pi's accumulator *and*
to a `0600` file under the kit's state dir — so a move loses nothing. The
result the model gets is pi's own output so far plus one sentence: still
running as task N, output continues at the log, you will be notified. When the
process exits, a `<background-task-notification>` arrives through
`pi.sendMessage` as a steered message that triggers a turn, so it wakes an idle
session and reaches a busy one at its next step. A background task whose log has not
grown for 45 s and whose tail looks like a y/n prompt sends one stall notice
naming the process group to kill. Under tmux the hint says `ctrl+b ctrl+b`,
because the prefix eats the first press.

A command that finishes in the foreground is returned as Claude Code 2.1.282
returns it, on every seat, cut from that same log rather than from pi's last
2000 lines or 50KB:

| output | the model gets |
|---|---|
| up to 30,000 characters | all of it; the log is removed |
| longer, exit 0 | Claude Code's `<persisted-output>` block: the size, `Full output saved to: <log>`, and a 2,000-character preview ending on a line break |
| longer than 11,024 characters, non-zero exit or killed | the first and last 5,000 characters, `... [N characters truncated] ...` between them, then `Full output saved to: <log>` |

The log is read in 1 MB chunks, so a command that prints gigabytes is measured
without being held in memory. pi's own temp file is deleted, because the log
already holds the same bytes. Log names carry the run's start time, because task ids restart
when pi restarts and a log that is kept must never be appended to. Within one pi
process a session's task ids keep counting across reloads. Logs older than a week are
pruned at session start. The numbers are `BASH_INLINE_MAX_CHARS`,
`BASH_PREVIEW_CHARS` and `BASH_FAILURE_EXCERPT_CHARS` in `lib/tools/bash-tool.ts`,
and the tool description states them.

An agent the engine started backgrounds exactly like the main session. Each
background task is registered under its session (`lib/tools/background-tasks.ts`)
until its result reaches exactly one place: a `TaskOutput` wait, its
notification in the conversation, or the end of its session. A task belongs to
the agent that started it: when the agent ends or is stopped, a task still
running is killed, and the agent's result names each task its end took, killed
or finished but unread, with its log.

A child session no engine runner waits on keeps the kill: its session ends with
its task, so a late notification has nowhere to land. There the timeout is pi's
timeout in pi's words, up to 1800 s, and a call that asks for the background is
refused with the remedy, and processes a shell leaves running are killed and
named in the result. The seat is known at `before_agent_start` and decides
behaviour only; every seat carries the one schema and description. Nothing
outlives the session: shutdown, a reload's included, kills every process group
it started. A process that leaves its group (`setsid`, `ssh -f`, `docker`) is
out of reach and is neither tracked nor killed. herdr owns anything meant to last.

The rows are the transcript's: two extensions cannot claim one tool name, so
this one registers bash and wears `lib/transcript/tool-receipt.ts`, whose live line
carries the offer (`⎿  building…  +12 lines · ctrl+b to background`) and
gives it up first on a narrow pane. With `PI_TRANSCRIPT=off` pi's own render
stands, with the same hint under it.

A non-zero exit is reported, not thrown: pi's bash fails the call on the last
exit code, and a chain's last link is a probe as often as it is a failure. The
code is taken from the settled run, pi is handed a clean exit, and
`exitCodeNotice` in `lib/tools/bash-result-notices.ts` puts the number on the
end of the result text.

The scan-refusal guard in `extensions/tool-call-guard/index.ts` runs first:
`tool_call` fires before any tool's `execute`, so a `find /` is refused before
this extension sees it.

`PI_KIT_BACKGROUND_DIR` moves the logs. `ctrl+b` is released from the
editor's cursor-left binding in `pi/keybindings.json` (`left` remains), so pi
does not report a conflict at startup.
