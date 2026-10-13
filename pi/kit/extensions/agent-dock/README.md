# `agent-dock` — background agents, counted in the rule

```
╰─ main ────────────── 2 tasks ↓ ───── 31.4% ─╯
```

How many agents this session is waiting on, and one key to manage them. Nothing
at zero tasks, no hint row anywhere, and no widget with anything in it — the
arrow in the label is the whole affordance. One `↓` at an empty prompt opens a
modal with one row per agent: `↑↓` selects, Enter focuses the prompt on that
agent (its conversation replaces main's transcript until you leave; see
`side-chat`'s agent view), `x` stops it, Esc closes. While an agent is focused,
the first row is `main`, with main's `working` or `idle`; Enter on it goes back
to main, like Esc in the view. Enter on a nested agent's row only says it can't be
opened: that agent belongs to the child that started it. `x` still stops it. A row reads `● worker opus Research: prices` — the type,
then the model in the same word the top rule uses, then the
description. The model rides every lifecycle payload, so the row reads it off
the task.

**`↓` only ever opens it at an empty prompt that is not browsing history.** That
is the one state where the arrow carries no editing meaning: pi's editor turns
`↓` into forward-through-history while browsing, end-of-line on the last visual
line, or cursor-down — and an empty line has no end to jump to. "Cursor on the
last line" would have stolen the end-of-line jump from anyone typing a
paragraph.

The focus test and that state read are the same act. Extension input listeners
fire *before* the focused component, so a listener that only asked
`getEditorText()` would take `↓` from every dialog and menu — each of which reads
as an empty editor while it holds the keyboard. Here the state can only be read
off a component with a prompt buffer *and* a history cursor, and nothing else in
pi has both, so an unrecognised focus owner means the key is handed straight
back. Not knowing always means not consuming.

The rows come from the engine's four lifecycle events. A nested child reports
through whoever owns it and never reaches this bus; a workflow's agent does
reach it, carrying `workflowChild`, and is kept out of the list and out of the
count — it is waited on by its run, and the run is one row under a
`Dynamic workflows` header. It is still held, because the run's own view is
drawn from those rows. So the list is exactly the agents this seat is waiting
on. An RPC-spawned agent emits no
`subagents:created` at all, so a task is created by whichever event arrives
first, and a late event never walks a settled agent backwards into the count.
`session_start` clears the list: a `/new`, `/resume` or `/fork` is a different
conversation, and the last one's agents are not this one's tasks.

A running row says nothing about running: the chat box's wave rolls across its
tags and description, and motion is the only thing in the dock that means a
child is alive. A word repeating the dot is width spent twice, and a duration
that refreshes only when something else happens is a number that lies most of
the time. The wave costs a frame clock, so the clock exists only while a view is
attached and that view asks for frames — nothing live, no timer. A settled row
is still, and says the duration the engine measured and the context it burned —
`2m 26s · 48k context`, no `done`, no tool count — unless it did not complete,
in which case `failed`, `stopped` or `aborted` goes in front. No dollars: a row
answers how long and how big, and money is a question Joel asks deliberately
(`/stats`, `ListAgents`).

The dollars come off the settling event's `usage.cost.total`, pi's own spelling
of spend, and `/stats` rolls them up — the seat's own turns, one branch per
agent, then the total. A running agent says `running` rather than `$0.00`,
because its usage only exists once it settles. Sub-cent spend reads `<$0.01`:
`$0.00` says free, and nothing here is. Dollars are a proxy for quota and useful
as a *ratio* between choices; the allowance that actually runs out is the
server's, and only the meter in the status bar can see it. **None of it is
model-facing** — an agent told what it costs optimises for the meter instead of
the job.

`x` sends `subagents:rpc:stop` and the row says `stopping…` until the agent's own
failure event lands. A refusal comes back as a notice and the row goes back to
`running`, and so does a stop nobody answered inside five seconds — a session
with no engine seat has no handler on that channel, and a row claiming a stop
that never happened is the worst of the three states.

A workflow run is one row, not a crowd. Its children never reach the top-level
list or the bottom-rule count — they are the script's business, not the seat's,
and a run that starts eight agents used to bury the two the seat was actually
waiting on. Enter on the run's row opens the run view: the phases in order, each
with its agents, each agent carrying state, model, tokens, tool calls and
duration, read from the run store per render so the counts cannot go stale
between lifecycle events. The view outlives the run — a run that finishes while
you are reading it settles in place instead of vanishing.

Enter again opens one agent: its prompt, an Activity block of its last three
tool calls, and its outcome. Each tool call is one line the way `transcript`
writes it — `Bash(npm test)` — because eight agents on a screen get a handful of
rows each, not the full receipt feed a single agent's box still gets. `x` stops
that one agent through the same path as anywhere else.

The extension registers one widget that draws nothing. A widget factory is the
only place pi hands an extension the `TUI` object, and the TUI is the only way to
ask which component holds the keyboard; `widgetContainerBelow` has `minSize: 0`,
so a widget rendering no lines costs no row. `PI_AGENT_DOCK=off` turns the count,
the key and the modal off together.

