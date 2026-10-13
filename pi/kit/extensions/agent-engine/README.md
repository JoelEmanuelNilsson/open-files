# `agent-engine` — the owned agent engine

The harness's own (orchestration map C1; ticket 19 has the build, ticket 20
removed the vendor package it replaced). Five tools under Claude Code's names, because Claude models are
trained on them: `Agent`, `SendMessage`, `ListAgents`, `TaskOutput`,
`TaskStop`. Registered on every seat with the same text — so the depth cap (4),
an unknown type and a thinking level that does not exist are refusals when the
tool runs — and limited on a worker seat, whose type file lists `Agent(explore)` only. The words are in `lib/agents/agent-tool-text.ts` and `lib/agents/agent-role-tails.ts`, every rule
stated once on the tool where the seat acts on it and never naming a tool the
reading seat might not carry (so `edit`/`write` carry no delegation text); the types
come off `~/.pi/agent/agents/*.md` (`lib/agents/agent-type-files.ts`) and are rendered
into the `Agent` description at session start, `(model, thinking)` where
Claude Code prints `(Tools: …)`, and their names are the `subagent_type` enum.

A child is an in-process pi session (`createAgentSession`), run by
`lib/agents/agent-runtime.ts`: a worker or lead on its parent's owned prompt bytes
(so its first request reads the parent's tools+system cache entry), or on its
type's body when the file has one; the role tail goes in its first *user*
message, never a system block (ticket 02 measured the difference: one system
block costs every message of the prefix). Any model; 5m cache. Thinking is `medium`, `high` or `xhigh` and nothing else — a spawn
that asks for another level, `max` included, is refused; a level the model cannot run is clamped to its own map.

The registry (`lib/agents/agent-registry.ts`) is custom entries in the seat's own
session file, one per status change, latest wins per name; it survives
`/resume` and `/fork`, and a record whose owner is another session
is not this seat's. `SendMessage` to a finished or lost agent reopens its transcript and runs it again under the
same name with a fresh task id — Claude Code's "a send resumes it from its
transcript". A seat's send to an agent idle past the 5-minute cache window is
refused (`cold`): the resume would re-bill its whole context, and a fresh agent
with a brief costs a fraction.

Delivery, once (C7): a finished child does not wake the main seat; its
result waits, the dock shows ✓, and everything settled by the time the next
turn starts is injected as one `subagent-notification` message at
`before_agent_start`. `wake: true` opts one agent in; a headless parent is
always woken, because nobody types its next turn — which is also how a
lead's run terminates: a child is done when its session is idle *and* it
owns no live agents. A child may run bash with `run_in_background`; its
notification wakes it while it runs, but a task still running when the child
ends is killed and named in its result (command, task number, "killed when the
agent ended"); a child that needs a task's result waits for it with
`TaskOutput {task}` first. `ListAgents` and `TaskOutput` show what holds an
idle child (its agents) and its last reply.

`TaskOutput` is the explicit wait and returns each reply whole, once; it returns early with `interrupted by Joel — N of M
done` the moment Joel types (pi's `input` event, `lib/agents/agent-wait-board.ts`), the
children untouched and Joel's message going on as the steer pi was queuing.

Worktree isolation (C19): `isolation: "worktree"` checks out branch
`agent/<name>` under `$TMPDIR/pi-agent-worktrees/`; the child commits there;
the directory, ignored files included, is removed when it has no uncommitted
change and no commit outside main, the branch is never deleted, and the result
says which (`lib/agents/agent-worktree.ts`). A resumed agent gets its worktree
back: locked where it is, or checked out again from its branch.

The dock and the rows are untouched: the four `subagents:*` events carry the
same fields, the `Agent` tool keeps `description` / `subagent_type` in and
`{displayName, description, subagentType, toolUses, tokens, status, agentId}`
out, and `subagents:rpc:stop` is answered on its reply channel. Children this
engine makes load the seat's extension set minus the vendor package;
`PI_AGENT_CHILD_EXTENSIONS` (a `:`-separated path list) replaces that set,
which is how the suite runs children on the engine alone.

Esc ends every engine tool call within 2 s (`lib/tools/tool-abort-bound.ts`,
the one way the kit registers a tool). What a cut-short call leaves behind
is fixed: a `TaskStop` still finishes stopping in the background and says
so; an `Agent` spawn or a `SendMessage` resume aborted before the child's
first prompt is scheduled is abandoned — no live mark, no child seat, the
record settled `stopped` and read (`AgentStartCancelled`), no prompt sent.
