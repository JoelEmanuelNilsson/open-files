# pi-kit

Everything pi loads: twenty-two extensions, twenty-eight skills. A local
package, installed by path, so editing a file and running `/reload` is the whole
loop.

```bash
npm test          # the edit engine, the transcript rows, render paths
```

Every test file ends with a `N passed, M failed` trailer, so the suite reports
its own size and nothing has to count it by hand. `test/run.mjs` runs them,
`test/files.mjs` is the one list of them, and two rules hold there:

- **One file's verdict never decides whether another file runs.** The suite
  used to be ten `node test/…` calls chained with `&&`; a stale check in
  `smoke.mjs` took 517 checks dark and nothing said so.
- **Nothing red is optional.** The suite once had a second, softer red for the
  pinned Claude Code release no longer being the installed one. That pin is
  gone: the version is read off the installed binary, so it cannot fall behind,
  and every remaining oracle checks the *structure* of the wire — a real bug in
  our mimicry when it moves, so it fails the run.

Skipped checks still count toward the suite's size, so the number
the HTML pages carry is a property of the code and not of the machine that ran
it.

`package.json` names two directories and nothing else, so a new file in
`extensions/` or `skills/` is picked up without touching the
manifest. Helpers that are not extensions live in `lib/`, out of the scan.
Disable individual pieces with `pi config`.

---

## `edit` — replaces the built-in edit tool

Same `path` + `edits[]` schema, plus:

- `files: [{ path, edits }]` — many files in one call
- `patch` — Codex `*** Begin Patch` payloads, including add and delete
- Everything is dry run first: a bad edit in the middle writes nothing
- A non-unique `oldText` is an error with the match count, not a silent first hit
  (pass `replaceAll` when you mean it)
- Falls back to whole-line matching when only whitespace or smart quotes drifted
- CRLF files stay CRLF; per-file mutation queue is respected

The diff it prints is laid out against the width the row is actually given,
rather than word-wrapped as prose:

```
278              cachedWidth = undefined;
279-         }               │ 279+         },
280          handleInput(data: string) {
```

Context spans the full width once. Printing it twice, the way a graphical diff
viewer does, is the most expensive thing you can do to a 60-column pane and it
shows nothing. Only the changed lines take columns, and only when every line in
that run fits its column — a long line split in half wraps into ragged fragments
on *both* sides, which reads worse than not splitting at all. So one hunk can go
side by side while the hunk below it stays stacked. Runs that are pure insertions
or pure deletions never split; there is nothing to put opposite them.

Everything else follows from the width on the day: the gutter drops the line
number, then all but the sign, as the pane narrows; long lines hard-wrap at the
column with a `↳` and their original indent instead of reflowing at spaces; the
token that actually changed is picked out with a stronger background than its
row. `PI_DIFF_MODE=split|unified` pins the choice.

Both backgrounds are tints of the theme's `toolDiffAdded` / `toolDiffRemoved`,
sat a fixed distance in luma from the background — upward on a dark terminal,
downward on a light one. A theme naming a hex has already chosen its tint and
keeps it; the kit's own theme names ANSI slots, which are full-strength accents,
so the mix is made from what the terminal reports for that slot and its
background (`lib/slot-colors.ts`) and follows a light/dark flip without a reload.

The layout lives in `lib/split-diff.ts` and is pure, so `npm test` renders every
fixture at 59, 97, and 161 columns — a herdr split, the pane beside it, and the
tab zoomed — and asserts the TUI's one hard contract, that no line is ever wider
than the width it was handed, across three modes and every width from 4 to 200.

## `side-chat` — `/btw`, a side thread under the main chat

Ask a side question while the main task keeps running. The side thread sees
main's context; main never sees the side thread.

- `/btw` (or `alt+s`) toggles side mode. `/btw <text>` enters it and asks.
  `/btw clear` starts the side thread over.
- Entering appends a green `<SIDE-CHAT-STARTED>` line under main's chat, then
  the side turns, drawn like ordinary chat. Main keeps working; its new output
  lands above the marker. The prompt box shows a bold green `[SIDE]` at the left
  of its top edge, and in the folded row when the prompt is empty.
- In side mode a plain submit goes to the side thread. While a side answer runs,
  Enter steers it and the follow-up key queues after it, as on main. Slash
  commands and `!bash` act on main as usual.
- While main compacts (or summarizes a branch for `/tree`), Enter and the
  follow-up key do not send a side submit anywhere: pi would queue it for main
  without an `input` event. The text stays in the editor with a notice; send
  it again when compaction is done. `/` commands and Enter on `!cmd` keep pi's
  behaviour.
- Esc stops a running side answer; otherwise it leaves side mode. It never
  aborts main. Leaving (Esc or `/btw`) removes the marker and the side turns
  from the screen and aborts a side answer still running.
- The side thread lives in memory: it survives toggling, and is dropped on exit
  and on `/new`, `/resume` and `/fork`. Nothing is written to the session file.
- Each side question sees main's context as it is at submit, cut at the last
  complete point (no tool call without its result, no half-written reply), then
  the side turns so far, then the question. Same model as main, at main's current
  thinking level.
- Only `read` and `web_search` run, at most 8 tool rounds per side question —
  each round re-reads main's whole prefix, so cost grows with rounds and 8 covers
  a few reads and a search. Every other tool call is refused, and the side
  question's wrapper says so.

**How the cache stays cheap.** A side request is main's last request, copied:
`wire` publishes main's exact last provider payload, and its side branch sends a
clone of it with only `messages` replaced. `system`, `tools`, `thinking`, TTLs
and headers (main's session id, billing header and identity included) are main's
bytes, so the tools and system cache entries are main's. The side's messages
start with main's transcript, byte-equal to main's up to main's message
breakpoint. Four breakpoints: system and last tool (main's), an anchor on the
block main had its message breakpoint on — a cache read of main's whole prefix —
and one on the side's last block, which writes only the side turns. Each side
user message is wrapped identically on every request (the wrapper is applied at
request time, never stored), so a side follow-up reads the earlier side turns
too. Tools always come from main's payload, since tools sit before messages in
the prefix and any difference would invalidate everything after them; execution
is restricted separately.

The side thread runs in one long-lived child session holding only side turns,
loaded with an explicit extension list (`wire`, `transcript`, `pi-web-search`
and the side thread's own guard), so none of the kit's other extensions run in
it. `lib/side-mode.ts` holds which main sessions have side mode on; `zen-chrome`
draws `[SIDE]` from it, and `agent-engine` and `skill-mentions` ignore a submit
it claims, because pi runs `input` handlers in unsorted load order and a side
submit must not interrupt main's waits or load a skill into main.

Declared limits:

- The side request reads cold (no anchor) when main has sent no request in this
  process, main is not an `anthropic-messages` model, the side model differs
  from main's last request, or main's transcript no longer matches that request's
  prefix (compaction, tree navigation). Wire says so once (`wire:side-prefix`).
- On models without managed effort, the side request's `thinking` is main's as of
  its last request, not the current level.
- Side spend is not in `/stats`: `agent-dock` does not run in the side session.
- Inline (non-fullscreen) TUI mode redraws the whole screen on toggle.
- `alt+s` needs the terminal to send Option as Meta on macOS.
- pi does not expose `isCompacting` to extensions, so the hold follows its
  compaction and tree events. Two short gaps remain where a side submit still
  queues for main: while pi resolves the summarization key, before
  `session_before_compact`, and after `session_compact` until pi clears its
  flag. With `shift+enter` bound to submit, pi's `\`+Enter submit is not held.
- A tool the side session does not register gets pi's generic `not found`; the
  wrapper tells the model why.

## `continue-session` — handoff v2, the model continues itself in a new session

At 250k context tokens a plain-text nudge lands at the tail of the context,
in Joel's words: *"Write a handoff now, or when it suits the ongoing work.
Start winding down; write it when relevant without destroying the work in
flight."* At 270k a second, imperative one: *"Do this now. As soon as
possible. Don't start new work."* Each is said exactly once, where the phase
changes; nothing repeats, and neither starts a turn. At 300k the run is
aborted — and because one step (a subagent's report, a large read) can cross
the gate and the stop together, the harness first writes its own handoff from
what it knows and persists it, so the session ends with a record rather than
silence. `/handoff-continue` continues from that record when a human says so.
No tool is involved: the handoff is an assistant message whose first line is
`# Handoff` (Intent / State / Next / Map / Decisions / Open).

When that run settles, the harness appends a generated block — one line per
live agent, unread result and background task (log path); files read
and changed as paths — and starts a **linked new session**
(`ctx.newSession({ parentSession, setup })`) whose first user message is
"Continue session `<old file>`." followed by the document and the block. Same
system prompt, same tools, so the cached prefix is read and only that message
is written; the messages start fresh; the old file is the record and is never
written again. No summariser, no compaction — the 2026-09-03 handoff that died
on pi's `Nothing to compact (session too small)` (last entry a tool result)
has no code path left to die on.

`setup` carries the run across: every agent record, rewritten to the new
session as owner so the names resolve, and the cache-mode choice so the launch
question is not asked again. The engine parks its runtime at the old
session's shutdown and the new session claims it, so a worker mid-job keeps
running and settles into the new file. A plain `/new` parks the same way but
claims nothing, so those runs stop.

Every seat hands off the same way (C18): a child of the engine gets
`ctx.newSession` from `lib/agent-runtime.ts`, which replaces the child's
session in place under pi's own `AgentSessionRuntime`; its record follows it
to the newest file; its parent reads its final answer, not its document.
Thresholds are fitted to each model's window (`WINDOW_SHARE`).

The way back to the raw history is a script, not a tool:
`bin/pi-recall.mjs <file> list | grep <regex> | show <n>`. `/handoff` asks for
the document now.
`PI_HANDOFF_THRESHOLDS=30000,50000,70000` shrinks the ladder to watch a cycle
in a small session. pi's own auto-compaction stays off in settings.
`test/continue-session.mjs` drives the whole switch on real pi sessions;
`test/continue-session-live.mjs` pins the cache read on a real model.

## `context` — where the context window went

`/context usage` and `/context injections`. Started as `pi-context-view`; mine now.

Capture is passive: the first real turn of a runtime freezes the Initial
snapshot. Before one has run — a fresh session, and the first `/context` after
every resume, reload or fork — the views rebuild the prompt and tool figures
from pi's own options and say `Extension additions were not observed`. Usage
numbers are unaffected either way; only the message-level injection list waits,
and nothing in this kit adds to `context`, so today that list is empty.

It used to fill that window with a *silent probe*: an empty user message sent to
start an agent run, aborted at `turn_start`. It measured a quantity that is
always zero and raised pi's entire run lifecycle to do it, which six extensions
read as a real turn — the visible symptom being `zen-chrome`'s hidden
`Working...` row coming back for the rest of the session. Retired in issue 18,
along with 300 lines of state machine; `test/context-view.mjs` keeps it retired.
What survives is a read-only filter that keeps probe messages already on disk
out of resumed sessions, and ages out with them.

## `skills` — which skills the model may reach for

`/skills`. A skill is always invocable by hand as `/skill:name`; what this
toggles is the other half — whether pi *advertises* it to the model, which is
one `disable-model-invocation` line in the file's frontmatter and about forty
tokens of name and description in every request. Twenty-eight skills is a
paragraph of standing context, so the question is worth answering in ten
seconds rather than across twenty-eight files.

Space toggles the row, `ctrl+s` writes, `ctrl+r` discards, `esc` cancels.
Typing filters. The glyph says what the draft wants and the `•` marker says
that draft differs from disk, because a dialog showing only one of them hides
either the pending edit or the current truth. **Declared limit: the filter
takes no spaces** — space is the toggle on every row, always, and a toggle key
that changes meaning depending on whether a text box is empty is a toggle key
that gets mis-pressed.

Three facts make it small. pi has already discovered and parsed every
`SKILL.md` and hands the complete set over as `getSystemPromptOptions().skills`
— muted ones included, each with its `filePath` and flag — so there is no
directory scan and no frontmatter *reader* here; a second one could only ever
disagree with the one that counts. The file stays the only state, so
frontmatter and behaviour cannot drift apart. And `ctx.reload()` exists, so
applying is one keystroke instead of two steps with a note in between.

Each file is re-read at apply time rather than snapshotted when the dialog
opened. That is the stronger guarantee, not the weaker one: an edit made in
another window meanwhile survives, because the patch lands on the newest bytes
instead of being refused against stale ones. The write is a same-directory temp
file, fsync, rename, with the original mode carried over.

The path is resolved through symlinks first, and on this machine that is not a
detail. `~/.agents/skills` *is* a symlink into `pi/kit/skills`, so pi reports
every skill's `filePath` through it. `rename` replaces the name it is handed:
aimed at a symlink it swaps the link for a regular file and severs the
checkout, leaving two copies to drift. Resolving first puts the temp file
beside the real file, on the real file's filesystem. `test/skills.mjs` pins
both shapes — a linked directory and a linked file — and fails loudly without
the resolve. A failure names the resolved file too, because that is the one
you would have to go and fix.

## `notify` — desktop ping when pi is waiting

Fires on `agent_settled`, skips turns under 12s. Picks OSC 777, kitty OSC 99, or
osascript by terminal. `/notify test|mute|unmute`,
`PI_NOTIFY_MODE`, `PI_NOTIFY_MIN_SECONDS`.

## `session-mode` — one question at launch

Two ways a session can run, asked once, before anything is cached:

| pick | cache | keep-warm ping |
|---|---|---|
| Short | Anthropic's 5m, cheapest writes | no |
| Long | 1h, writes at 2x | every 55m while idle, until 2h idle |
| *(headless — not offered)* | 5m | every 4:30 from each request, while in flight or a child is live |

Enter takes Short. The choice persists in the session and comes back on resume.

Anything without a UI — `pi -p`, scripts, and **every subagent** — is not asked,
and is not given the hour either: it takes the cheap 5-minute window and a **gap
ping** that keeps the window from closing while the seat is working. That is
decided before any persisted choice is read, so a `pi -p --resume` of a session
picked at a TUI cannot inherit the idle-driven schedule.

The hour used to be the answer here, bought against a real finding: Anthropic
starts the retention clock when the writing request *begins*, so a 30–40k-token
thinking turn streaming for 250–335 seconds can spend its own 5-minute window
(issue 26). The finding stands; the insurance was priced against the wrong
operating point. Across 21 sessions of wire trace, 376 request gaps on
high-thinking build seats had a median of 7s, a p99 of 69s and a **maximum of
134s** — not one reached half the window — and replaying that corpus cost
**$103.93 at 5m against $117.61 at 1h**, because the 1h premium is simply 0.75x
the final context on every session. 1h only wins past 30–41 minutes of
cumulative silent stalling, and the watchdog kills any child silent for 15
minutes (issue 33). So: cheap window, pinged.

No mid-session switch, and no plain 1h without pings *for a session with a human
at it*. The cached prefix is the tools array plus the system prompt, so turning
any tool on at turn 40 re-writes the whole window, about a dollar at 60k tokens,
and a 1h cache with nothing refreshing it dies at the first long pause anyway.
The combinations I would never pick are not offered, which is also why there is
no `/cachemode` any more.

The launcher decides retention and nothing else. It used to carry a third
choice that kept a vendor workflow tool active, and the gate behind it withdrew
that tool at `session_start` on every other session. Both are gone (map C17):
every seat carries the identical tools array, so there is nothing to opt into
and no tool for this extension to take away.

A keep-warm ping replays the last provider payload byte for byte and aborts
after the first bytes come back. Identical prefix, so the read hits and the TTL
restarts for a cache read plus a handful of output tokens. Nothing lands in the
session, so it cannot pollute the cache it is refreshing.

The mechanism is `lib/ping.ts`; this extension owns only the *policy*. Two
schedules over one mechanism, and they differ where the sessions differ. An
interactive Long session pings only while idle, because its own requests keep
the cache warm the rest of the time. A headless seat re-arms at every request
**start** and fires at 4:30 whether or not a request is in flight, because the
gap that kills it is *inside* a streaming turn or a 600-second bash call, not
between turns — and a ping concurrent with a request is safe, since that
request's entry was written when it began and the ping is what refreshes it.

It pings only while a request is certain to follow: a turn in flight (a stream,
a tool call, a wait on its own children) or a child agent still live after the
turn ends. Then there is no round count, because every ping pays. The moment the
seat settles with no live child, the chain stops. A settled subagent has
reported, and resumes are rare. A ping costs the prefix at the read price and a
rewrite at the write price, so pinging only pays if the resume comes within
(write − read) / read pings. A resume re-arms the chain through its first
request and pays one rewrite. `bin/ping-economics.mjs` prints the break-even per
model, the resume count and the cost of pings after a seat's last request, from
the traces and pi's model table.

One ceiling remains, against a seat stuck "in flight" by bookkeeping or with
the watchdog off: 8 rounds with nothing observable happening and no child to
wait on. That is the longer of the two bounds on a seat's own silent work — a
subagent `bash` call is killed at its 30-minute timeout (`lib/bash.ts`), and
anything else is aborted at the watchdog's 15-minute deadline
(`lib/silence-deadline.ts`) — plus one round of margin. A round that fails
retries once, and a second failure stops the chain until the next request.

**The payload a ping replays comes from `wire`, and that was a bug for the whole
life of the feature.** pi chains `before_provider_request` in loader order and
takes the last return value, and `session-mode` sorts before `wire` — so the
payload this extension captured as its own `event.payload` was pi's raw `system`
array and pi's unpoliced `tools`. Anthropic keys the cache
`tools → system → messages`, which makes that a guaranteed total miss *and* a
full-price write of a second entry. Now `wire` publishes the target on a
per-session seam, because `wire` is the handler that produces the final bytes.
A test pins that only two kit extensions register the hook — which is a check,
not a proof: it cannot see a vendor package or a user-global extension. No
package in `settings.packages` registers it today (pi-web-search hooks
`model_select`, `session_start` and `session_tree`). A vendor that starts
rewriting `before_provider_request` would have to be sorted below the kit, and
the test above is the only warning there is.

The envelope around that payload is not rebuilt either — it is not built at all.
A ping is a real pi-ai request with the payload pinned: `provider.stream(model,
…, { onPayload: () => bytes })`. pi-ai builds the client — betas, auth carrier,
protocol version, URL — from the same model the request used, and *then* asks
for the payload, so a payload field can no longer outrun the header that
licenses it. That was the last defect: `model.compat.allowedFallbackModels` puts
a `fallbacks` field in the payload whose licence is an `anthropic-beta` value
only the SDK client adds, and the hand-built envelope carried one half. 26
rejections across thirteen sessions, and the trace said only `rejected (400)`.
Auth is still re-resolved per ping through `modelRegistry`, which refreshes an
OAuth token that aged out while the session idled, and anything credential-shaped
in the captured bag is dropped first, so a ping cannot go out with a stale one.
Headers are captured with the payload as one unit, so a turn on another provider
cannot pair its envelope with this session's Anthropic request. When pings do
stop, the status bar drops back to a countdown rather than keep showing the wide
window.

A ping now also reports what it cost. It aborts on the first content event, by
which time `message_start` has been folded in, so the trace records `read`,
`write` and which model served it. `write > 0` means the replay did not match
the entry it was replaying — the one cache break this harness can see the day it
happens instead of reconstructing it from a bill.

It publishes `{ mode, warmUntil }` on `globalThis`, and zen-chrome renders it —
see below. `warmUntil` is anchored to the provider request that wrote the cache
and to the TTL that request actually carried, not to when the run finished, so
the countdown cannot promise a window the provider never granted.

When a miss needs explaining, it has already been explained: `wire` traces every
request (see below), including the TTL each payload asked for next to the warmth
the status bar was still claiming when it went out.

## `zen-chrome` — the prompt is a box

Closes the editor into a rounded box, frames sent messages in the same box,
moves the footer onto its edges, and rolls a wave along the border while the
agent works. The top edge carries the model name; the cache reading is one
number, how long until this prefix is cold — `❄12m`, a bare `❄` once it is.

While the prompt is empty the box folds to one row carrying the path, branch,
model, turn timer, background tasks, cache and context, in that priority order.
When one row cannot hold them all it wraps to two; past two rows the lowest
priority readings drop first. In side mode (`/btw`) the top edge and the folded
row both lead with a bold green `[SIDE]`, which is never dropped before the path.

The bottom edge carries the git branch, any background agents still running, how
long the current turn has been running, and the context gauge:

```
╰─ main ─────────────── 2 tasks ↓ ───── 1m 12s ████⣿⣿⣿⣿⣿⣿⣿⣿ 31.4% ─╯
```

The elapsed time appears only once a turn has run for thirty seconds, so short
turns leave no trace at all, and it freezes where it is when the turn settles —
so "how long did that take?" is still answerable after you stopped watching,
without spending a transcript row on it. The next message clears it: a number in
a live-looking frame must never describe a turn that already finished.

The task count comes from `agent-dock` (below) as a status, and this is the one
place it is drawn — the footer row hides that key, because one fact on screen
twice is one fact too many. It is a *middle* label, let into the dashes and
hanging off the right-hand cluster at a fixed distance, so it does not slide
sideways every time a branch name changes length.

As the pane narrows the labels go in a stated order — **timer, then tasks, then
the branch is squeezed, then the gauge** — and each vanishes whole rather than
truncating, because half a duration or a `2 ta…` is worse than none. The timer
goes first as the least earned label in the frame; the count outranks it because
an agent still running is work in flight rather than a fact about waiting; the
gauge outlives everything, since it is the only thing on screen that says
compaction is coming.

The clock behind it is `lib/turn-clock.ts`, and zen-chrome is its only writer,
gated to the session wearing the frame so a subagent cannot overwrite the number
in front of you. `notify` reads that same clock, so
the duration in the desktop ping is the duration you watched. A turn is
`before_agent_start` to `agent_settled`; `agent_start` fires once per *attempt*,
which is why an auto-retry or an auto-compaction used to restart the wave
mid-turn and would have restarted the number with it.

The wave costs a full TUI render every 33ms for as long as a turn lasts. On a
terminal compositing a blurred translucent background that is not free, and it is
the only thing in this setup asking for a steady frame rate, so it is the first
thing to turn off when streaming is not smooth: `PI_ZEN_WAVE=off` stops the
animation. The elapsed time keeps ticking either way, at 1 Hz — one line of text
a second is not the cost that flag exists to avoid, and the quiet mode is
precisely the one that would otherwise have no running indicator at all.

What the wave looks like is a choice of two, made with `/glow` and kept between
sessions: **one**, every lamp on the same hue so the whole frame is one colour
at any instant, the hue drifting along the arc; or **two**, the lamps spread
over part of the arc so two neighbouring hues meet on the frame with the
gradient between them running the whole way round. Both are a few lamps far
apart on a dim rail, which is what makes light read as light — a line that is
evenly bright everywhere has nothing to glow against. Neither is the full
rainbow this started as: a hue crossing the whole arc in one rule changes by
tens of degrees per cell, and a cell is a flat colour, so what it draws is a row
of differently coloured dashes rather than a gradient.

The choice is a preference and not a setting — it changes nothing but how the
chrome looks — so it lives in the kit's state root
(`$XDG_STATE_HOME/pi-kit/glow`), outside git, and a second machine on the same
dotfiles gets the default until someone there picks. `/glow` with no argument
says which is on.

## `agent-engine` — the owned agent engine

The harness's own (orchestration map C1; ticket 19 has the build, ticket 20
removed the vendor package it replaced). Five tools under Claude Code's names, because Claude models are
trained on them: `Agent`, `SendMessage`, `ListAgents`, `TaskOutput`,
`TaskStop`. Registered on every seat with the same text — so the depth cap (4),
an unknown type and a thinking level that does not exist are refusals when the
tool runs, never a missing tool — and cut from the wire on a worker seat, which
delegates to nobody (`lib/tool-policy.ts`). The words are in `lib/agent-tool-text.ts` and `lib/agent-role-tails.ts`, every rule
stated once on the tool where the seat acts on it and never naming a tool the
reading seat might not carry (so `edit`/`write` carry no delegation text); the types
come off `~/.pi/agent/agents/*.md` (`lib/agent-types.ts`) and are rendered
into the `Agent` description at session start, `(model, thinking)` where
Claude Code prints `(Tools: …)`, and their names are the `subagent_type` enum.

A child is an in-process pi session (`createAgentSession`), run by
`lib/agent-runtime.ts`: a worker or lead on its parent's owned prompt bytes
(so its first request reads the parent's tools+system cache entry), or on its
type's body when the file has one; the role tail goes in its first *user*
message, never a system block (ticket 02 measured the difference: one system
block costs every message of the prefix). Any model; 5m cache and the
headless gap ping. Thinking is `medium` or `high` and nothing else — a spawn
that asks for another level is refused rather than clamped (ticket 29 §4).

The registry (`lib/agent-registry.ts`) is custom entries in the seat's own
session file, one per status change, latest wins per name; it survives
`/resume`, `/fork` and handoff, and a record whose owner is another session
is not this seat's. `SendMessage` to a finished or lost agent reopens its transcript and runs it again under the
same name with a fresh task id — Claude Code's "a send resumes it from its
transcript".

Delivery, once (C7): a finished child does not wake the main seat; its
result waits, the dock shows ✓, and everything settled by the time the next
turn starts is injected as one `subagent-notification` message at
`before_agent_start`. `wake: true` opts one agent in; a headless parent is
always woken, because nobody types its next turn — which is also how a
lead's run terminates: a child is done when its session is idle *and* it
owns no live agents. `TaskOutput` is the explicit wait and returns each
reply whole, once; it returns early with `interrupted by Joel — N of M
done` the moment Joel types (pi's `input` event, `lib/agent-wait.ts`), the
children untouched and Joel's message going on as the steer pi was queuing.

Cache through a wait (ticket 10): `session-mode` counts `Agent` and
`TaskOutput` as engine waits — the keep-alive chain runs through them as if
the seat were idle, anchored on the request that wrote the entry, and the
headless gap chain's round cap is lifted for their duration. The watchdog
exempts the same two tools by import.

Worktree isolation (C19): `isolation: "worktree"` checks out branch
`agent/<name>` under `$TMPDIR/pi-agent-worktrees/`; the child commits there;
the directory is removed only when clean, the branch never deleted, and the
result says which (`lib/agent-worktree.ts`).

The dock and the rows are untouched: the four `subagents:*` events carry the
same fields, the `Agent` tool keeps `description` / `subagent_type` in and
`{displayName, description, subagentType, toolUses, tokens, status, agentId}`
out, and `subagents:rpc:stop` is answered on its reply channel. Children this
engine makes load the seat's extension set minus the vendor package;
`PI_AGENT_CHILD_EXTENSIONS` (a `:`-separated path list) replaces that set,
which is how the suite runs children on the engine alone.

## `workflow` — one child per item, only the return value comes back

The `Workflow` tool (orchestration map C17/C20; ticket 23): Claude Code's
tool, with its explicit-opt-in gate replaced by ours — the description says
when a workflow fits (the same job on many things; fix until the system is
green) and the ladder in the prompt decides. The description is Claude
Code's text minus the gate and the inline example, ~400 tokens
(`lib/workflow-tool-text.ts`); the script API lives in
`skills/workflow-authoring/SKILL.md`, which is Claude Code's authoring
reference minus its quality patterns and its five shapes, plus one line —
*one child per item, one pass; tests are the check* — and the
fix-until-green script.

A script is plain JavaScript opening with `export const meta = {...}`, read
as a pure literal (`lib/workflow-meta.ts`: a tokenizer, no parser; a
variable, call, spread or interpolation is refused with the rule) before
anything runs. The body runs in a `node:vm` context
(`lib/workflow-sandbox.ts`) holding `agent`, `pipeline`, `parallel`,
`phase`, `log`, `console`, `setTimeout`/`clearTimeout`, `args` and
ECMAScript's built-ins — no `process`, no `require`, no `eval` or
`new Function` (the context compiles no string), no `import()` (the word is
refused before the run). The script never holds a host object: its hooks
are made inside the context by a prelude that reaches the host through one
bridge in its closure, and every result, array, promise and error it gets
back is re-created there. The host never runs on the script's stack: a hook
call is queued and handed over a microtask later, so a script that calls a
hook at its stack limit overflows in its own realm, never half way through
host code. The clock and the RNG throw on every path to
them — `Date.now()`, `Date()`, argless `new Date()` however the constructor
is reached, `Math.random()`, `Temporal.Now` bar its `timeZoneId()`, an
`Intl.DateTimeFormat` `format()` with no date; a date from explicit
arguments is fine. The
built-ins that call back on the host's or the GC's schedule are deleted
before the script runs — `Atomics`, `FinalizationRegistry`,
`SharedArrayBuffer`, `WeakRef`, and `WebAssembly`, whose `Memory` hands out
a `SharedArrayBuffer` even with code generation off. The host's time zone
and default locale stay readable, so a resume on a host set otherwise may
take another branch, whose calls miss the journal and run again. A promise
the script leaves rejected is a failure of its run, not the seat's crash:
until the run settles, one process listener claims a rejection whose
promise descends from the context's `Object.prototype` and hands any other
back to Node's own handling. Out of reach: a promise the script re-parents
onto `null`, or behind a proxy whose `getPrototypeOf` trap throws; Node
handles its rejection as the seat's own. Isolation, not security: the author is our
own model. The limit, shared with Claude Code:
the 30 s timeout covers only the script's synchronous start, so a loop that
never awaits after that, or awaits only already-settled values, freezes the
seat; only a worker thread could stop it, and the script runs in-process.

`lib/workflow-runtime.ts` owns the scheduler and the failure table. All
throttling is in `agent()` — a semaphore of `min(16, CPUs−2)` that hands a
freed slot straight to the next waiter, a lifetime cap of 1000, the journal
— so `pipeline` (each item through every stage on its own, no barrier) and
`parallel` (a barrier that never rejects) stay naive. A child that dies,
stalls or never fits its schema is `null`, and the run goes on; a throwing
stage or thunk is `null`; a stage that returns `null` ends its item, so a
dead child's `null` never reaches the next stage. A cap, a bad schema or a
stop ends the run the moment a hook throws it, decided
on the host's own error: a script that catches it cannot fold it into a dud
or keep going, and once a run has ended every hook it calls parks, never
settling; so does an `agent()` still queued for a slot. A spawn the engine
refuses, such as an unknown type, and a bug in the script are the script's
own errors, as in Claude Code: that `agent()` throws, and a thunk or stage
it was in is `null`.
More than 4096 items in one call is an error, never a truncation.

The journal (`lib/workflow-journal.ts`) is one JSONL line per finished
`agent()`, in finish order, written before `agent()` returns: a result, or
a `failed` line for a child that died. A call's key is sha256 of the prompt
and the options that change what the child does (`label`/`phase`
excluded), but a key alone cannot serve it — a call may depend on a file an
earlier agent wrote, not on text. So a result line also records `after`,
how many lines the run had written when that agent started (as the
engine sent its first prompt, whatever held it back), and
`resumeFromRunId` serves a result only into the world it started in: the
first unused prior result with the key whose first `after` prior lines
have all been replayed, and only until an agent has run live and finished.
The first edited call runs live, and so does everything that starts after
it finishes; a death re-runs itself and every agent that started after it,
never those that started before; a pipeline whose stages finished out of
order replays whole; a hit is journalled again with its prior `after`
mapped onto the new run's lines, so a resumed run resumes too, and two calls
that never depended on each other replay in either order. A line with no `after`, from an older journal, is
never served. Claude Code chains keys in call order and turns the cache off
at the first miss: safe, but a reordered stage misses on resume. The result
opens with `[resumed from <runId> — N cached]`. Same-session only; a prior
run still going is stopped first; a resume that names no `args` runs on the
prior run's, so the resume call a result prints works as printed.

`agent(prompt, {schema})` (`lib/workflow-structured-output.ts`): the
child's prompt gets the schema and an instruction to call `StructuredOutput`
once, last. That tool is registered on every seat, goes on the wire only for a
workflow child, and refuses anywhere else; inside one it validates with typebox's `Value` against the
contract the parent declared on a process-wide seam before spawning (keyed
by parent session and child name, so no call can precede its contract). A
mismatch is an error tool result carrying the validator's messages — the
model retries in the same run; a turn that ends with no call is one attempt
too, and the child is resumed from its transcript with a nudge; the third
failure rejects the contract, and that `agent()` is `null` with the
validator's last errors on its `agent-failed` event.

The run is a registry entry of type `workflow` (`extensions/workflow.ts`),
spawning through the engine's runtime off `lib/agent-runtime-seam.ts`; so
`ListAgents` lists it, `TaskOutput` waits on it, `TaskStop` and the dock
stop it through the stopper it registers under its task id (the engine's
`stop` falls back to that map for a record it has no session for), and a
parent's cascade reaches it because it is marked live under the seat. Its
children are records flagged `workflowChild`: the tail carries ticket 12's
line, the prompt carries Claude Code's two-paragraph contract, and the
result is marked read at settle — never delivered, never waking anyone —
so only the return value reaches the conversation, draining into the next
turn like any result (`wake: true` as on `Agent`; always on a headless
seat). `<sessionDir>/workflows/<runId>/` holds `script.js` (every
invocation, including `scriptPath` ones), `journal.jsonl` and `run.json`;
`~/.pi/agent/workflows/<name>.js` is a saved workflow. `/workflows` prints
the live tree. Deferred to ticket 25: budget, nesting, retry-one-agent.

A stalled child is started again. The watchdog stops a child that streams no
token, starts no tool call and ends no turn for `stallMs` (default 180 s), and
its clock stops while any of the child's tool calls is running: a test suite
or a build is work, and a tool that never returns is left to its own timeout
(bash has one). So a stall is a hung stream, and the remedy is a fresh start
with the same prompt: three attempts in all, each restart written to the run
log, and after the third the slot is `null` with `stalled on all 3 attempts
(no progress for Ns each)`.

Provider limits are pi's to retry, and it does: an overload, a rate limit, a
5xx or a dropped connection is retried, by pi's default `retry` settings
three times with backoff from 2 s capped at 60 s (pi-coding-agent
`dist/core/agent-session.js` `_handlePostAgentRun` → `_prepareRetry`,
classified by pi-ai's `isRetryableAssistantError` in `dist/utils/retry.js`),
so a child dies of one only after those. A quota or usage limit is excluded from that retry and ends
the child at once, with the provider's words as its error. The engine gets no
reset time as data — at most a provider's sentence, such as Codex's `Try again
in ~N min.` — so a run does not pause for a reset: the child's slot is `null`,
and the result names the failure in the provider's words and says to resume
after the reset.

The result the parent reads is the value — whole up to 8 000 chars, otherwise
its path, shape and first 2 000 chars — then `[agents: N run (F failed, S
skipped, U unfinished), C cached]` once any agent was called, then
`[failures: N]` with one line per failed or skipped agent, dropped pipeline
item, dropped parallel task and promise the script left rejected, the first
20 and a pointer to `run.json`'s `failures` for the rest; then, when
anything failed or the run did not complete, the `[resume]` call. A run that errors or is stopped carries the
same lines under its error. The run store (`lib/workflow-runs.ts`) folds every
failure as it happens, and the result and `run.json` read it there.

## `agent-dock` — background agents, counted in the rule

```
╰─ main ────────────── 2 tasks ↓ ───── 31.4% ─╯
```

How many agents this session is waiting on, and one key to manage them. Nothing
at zero tasks, no hint row anywhere, and no widget with anything in it — the
arrow in the label is the whole affordance. One `↓` at an empty prompt opens a
modal with one row per agent: `↑↓` selects, Enter reads that agent's answer,
`x` stops it, Esc closes. A row reads `● worker opus Research: prices` — the type,
then the model in the same word the top rule uses, then the
description. The model is blank today: the lifecycle events never carry it, and
nothing publishes a live child session to read it off since the vendor's manager
registry went (ticket 20).

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

## `transcript` — tool calls as receipts, not output

```
┊  the wrap has to happen after the render, not before

   Two things changed. Here is the first.

● Read(lib/split-diff.ts)
  ⎿  Read 412 lines

● Grep(renderCall in kit/)
  ⎿  Found 7 matches

● Bash(npm test)
  ⎿  > pi-kit@0.1.0 test · 2.4s
     > node test/run.mjs
     suite
     … +37 lines (ctrl+o to expand)

● Bash(cat nope.ts)
  ⎿  cat: nope.ts: No such file or directory
     Command exited with code 1
```

Claude Code's grammar, ported. Dot in column 0, name in column 2, argument in
parentheses, and a five-column `⎿` gutter under it carrying what came back.
Nothing is positional beyond those two columns, so a long tool name or a narrow
pane degrades instead of breaking a grid.

pi's own row is a `Spacer`, a padded `Box`, the call, and ten lines of whatever
the tool printed: four blank lines around one line of signal, whether the call
returned two hundred lines or nothing. Ten calls in a turn is forty blank lines.
The only thing separating a call that failed from one that worked is the box's
background, and the jarvis themes set all three of those to transparent, so the
state was invisible and the noise was not.

**The dot carries the state and never moves.** Dim while the call is in flight,
`success` when it settles, `error` when it fails. Claude Code blinks its pending
dot every 600ms; this one does not. Their renderer is a cell-grid compositor with
dirty tracking, pi's is not, and `ghostty/shaders/subtle-crt.glsl` already tints
glyphs by their row over a blurred translucent background, so a repaint
recomposites the blur to say something colour already said.

**Every settled call gets a result line.** That pairing is the whole readability
win, and it is what makes a row read as a receipt rather than a label. The number
in it is bold and the unit is not: `Read 412 lines`, `Found 7 matches`, `Listed
31 entries`, `Wrote 3 lines`.

**Counts never come from reading the output.** `find` emits one path per line,
`ls` one entry per line, `grep` ripgrep's `file:line:text` where context lines use
`-` and so cannot be miscounted, `read` the file verbatim, and `write` is counted
from the content it was handed rather than the `Successfully wrote N bytes` line
it prints back. `bash` is not countable — its output is whatever the command
decided to print — so it shows the output itself instead.

**Which end of that output depends on whether the call is still going.** Running,
the row tails: the last line is where the command has got to, and a row showing
the first three lines of a build would sit on the banner for two minutes.
Settled, the row shows the *head* — three lines, then `… +37 lines (ctrl+o to
expand)` — because the answer starts at the top and the last line of a finished
command is usually a blank or something the exit code already said. Both ends
come out of one function, `outputPreview`, so they cannot drift into two ideas
of what a line of output is, and the key in that hint is read from pi's
keybinding registry rather than written down, so rebinding `app.tools.expand`
renames every hint in the transcript. Three is Claude Code's `MAX_LINES_TO_SHOW`.
A blank line never takes one of those three rows — three lines of a build log
spent on paragraph breaks say nothing — but it is still counted in what is left,
so `+N lines` is the number of lines below the last one on screen.

A count is computed once, when the result settles, and kept on `context.state`.
Not on `details`: that is a typed contract the UI and session logic read, and pi's
docs say an override has to match it.

**What is on screen is what is happening.** Not seven rows that fold up at the
end — that is a screen that jumps every time the agent stops — and not a
past-tense line that grows a clause every time a result lands, which narrates
the past while the work is still running. A run says what it is *doing*, and
what it has already done says nothing at all until the run is over:

```
❯ read the three files, grep for two things, list nested, run the two pings

● Searching for 2 patterns, reading 3 files, listing 1 directory, running 2
  shell commands…
```

One line for the whole batch, wearing the dot and the gutter of whichever call
is still speaking:

```
● Running 2 shell commands…
  ⎿  $ ping -c 25 127.0.0.1 > /dev/null
```

Both tenses count every call in the group, never the in-flight subset, so a
landing result takes no number down and settling puts none back.

The moment the last of them lands, all of it is replaced, in the same columns,
by the past tense over everything that folded:

```
  Searched for 2 patterns, read 3 files, listed 1 directory, ran 2 shell
  commands
```

The dot goes and no word moves: the two-space indent is exactly the dot and its
space. Nothing else moves either, because each call folded the moment its own
result arrived. This is Claude Code's behaviour, sampled off a pane two seconds
apart through a mixed batch rather than guessed at — work that finishes while
its own message is still running leaves nothing on screen, not a row and not a
clause — and pi needs it more than Claude Code does, since pi creates every row
of a batch as the arguments stream, seconds before any of them runs.

The same grammar as a result line — bold count, plain unit — with only the first
clause capitalised and the whole thing muted, because it is a receipt for work
you have stopped caring about. `read` counts files, `bash` shell commands,
`grep` patterns, `find` and `ls` both directories, since both enumerate paths
and one clause is better than two numbers to add up. What it counts is *calls*,
not what they returned: `Read 2 files` is two rows that each said `Read 412
lines` on their own. `ctrl+o` puts them all back, and so does a click on the
line, which is the only thing a folded group leaves to click — in either tense,
so clicking a batch mid-flight opens the calls that have not come back yet.

**A lone call is its own row while it runs, and one line once it is over.**
While you are waiting, pi knows the command and the path and `Running 1 shell
command…` says less than either, so nothing is folded away from work in flight.
When it settles it becomes `Ran 1 shell command` like any other group — Claude
Code's own rule, and what makes three silent shell commands in three messages
leave one line instead of three rows. `ctrl+o` or a click opens it again.

**It is the one line that wraps.** Every header in the transcript is clipped,
because a header that can grow is a header you have to read to skip. This is a
sentence with a clause per tool, and clipping it drops the last clause, which is
the one thing on the line that cannot be guessed: a four-clause turn on an
80-column pane read `…ran 2 shell comm…` until it wrapped instead. Claude Code
wraps it to the same indent too.

**The live line carries a clock; the settled line does not.** Claude Code
ticks one on its running row (`Listing nested directory contents · 24s`) and so
does this (`Running 2 shell commands · 3.0s…`), owned by the group and painted
on the speaking row alone, so a silent command is visibly alive. The repaint
costs nothing new: the prompt frame already redraws its own clock once a second
for the whole turn. A settled line says what happened, never how long it took;
a settled row still shows `· 2.4s`, which is the number you can act on.

**A row that would still tell you something keeps it.** Anything that changed
something (`write`, `edit`), a call that failed, a call that was cut off
— hollow dot, no result, sitting where it stopped — a result carrying a picture
pi is going to draw anyway, and any tool with no verb in the table, MCP
included. Being in flight is only invisible while the run is live: once it is
over, a call that never came back was interrupted, and that is the record of
what happened — `esc` through a batch of three brings all three rows back with
their aborted results. Claude Code collapses failures too and
leaves the model's prose to explain them; this extension exists because a failed
call was invisible in pi's own rows, so hiding one behind `Ran 1 shell command`
is the one piece of the grammar not worth copying. A row that stays also breaks
the run, so a line only ever counts rows that were actually above it:

```
  Read 1 file, searched for 1 pattern

● Bash(cat nope.txt)
  ⎿  cat: nope.txt: No such file or directory
     Command exited with code 1

  Listed 1 directory

● Write(d.txt)
  ⎿  Wrote 1 line
```

**Adjacent means nothing was printed in between.** pi adds the whole assistant
message to the chat when the message starts and appends its tool rows after it,
so a message that says anything says it *above* its own calls whatever the order
of its content blocks: text ends a group and starts the next. So do a user
message, a compaction summary and an extension's own entry. A model change
prints nothing, so it does not.

**Thinking never breaks a group**, hidden or not — Claude Code skips thinking
blocks when it groups too. With `hideThinkingBlock` on, which is how this
harness runs, a reasoning model puts a block in front of nearly every message,
so counting one as prose made nearly every message a group of one: the rollup
line switched itself off for exactly the models that call the most tools.

**One planner, however many extensions borrow it.** pi loads each extension
file with its own jiti and no module cache, so `extensions/bash.ts`, which wears
this extension's receipt, holds its own copy of every module in it. The seats,
the redraw callbacks, the pending results and the clock therefore live on the
process (`transcript/planner-state.ts`, keyed `Symbol.for("pi.kit.transcript
.state")`) rather than at module scope. With a map per copy, bash rows never
folded and a group led by one hid its members with no line to replace them —
output silently lost, and every test green, because the suite loads the kit
through a single jiti. `test/transcript-two-jitis.mjs` loads it through two.

**The grouping is read off the session, never guessed at.** `group.ts` is a pure
function from pi's own context entries to a list of groups, and it only ever
reads what has already happened: which calls a message made, in what order,
which have come back, and what was printed between them. It runs as each result
lands, again when the run settles, and again after a compaction, a fork or a
walk of the tree, since those rebuild every row from the session and the row
that was leading a group may be the one that just left the context. The same
function over the same entries is the whole of resume: a session loaded from
disk is a transcript of runs that all settled long ago, and the planner cannot
tell the difference.

Two facts reach it before the session has them, because pi tells extensions
first and writes afterwards: the message being streamed, whose rows are on
screen the moment its arguments arrive, and a result, which for a parallel batch
is not written down until the last call in the batch returns. Both are handed to
the planner directly rather than waited for.

That distinction is the difference between this and the version that was
deleted. An earlier one merged runs of the same tool onto one line by guessing at
`message_start` whether more calls were coming, and needed four hundred lines of
batch registry, revision stamps, resume seeding and abort quiescing to hold the
guess up — for a merge that fired on maybe a third of turns. Keyed on a turn
that has already happened, the same effect is one pure function, one map from
call id to seat, and no bookkeeping at all.

What draws the line is one row of the group: an extension cannot add a component
to the chat container, so the line has to come out of a row that is already
there. Every other row in the group renders nothing at all, and a row with
`renderShell: "self"` whose renderers produce no lines disappears completely —
no spacer, no blank, no gap. Which row it is follows the work: the first call
still in flight while the run is going, the first call of all once it is over.
Those are always the same place on screen, because everything before either of
them is folded and a folded row is zero lines tall, so a batch hands the screen
from one call to the next and finally to its own past tense without a word
moving. That row speaks for the group in the other direction too: it is the row
a pointer can reach, so opening it opens the rows behind it, which are zero
lines tall and can never be clicked.

`PI_TRANSCRIPT_ROLLUP=off` keeps every row forever.

**A search that found nothing says so in words.** `No matches`, `No files found`,
`Empty directory`, in the warning colour. `Found 0 matches` reads as an amount,
and a failed search is not an amount.

**Durations under 500ms are not shown.** Claude Code shows no per-call duration
at all. This appends `· 2.4s` to the result line once the wait was long enough
that you felt it, and drops it again on a pane too narrow to carry both, so the
column stays quiet and a slow call stands out.

**The header is one line for every tool but the shell.** The argument is clipped
rather than wrapped, because a header that can grow is a header you have to read
to skip. Which end goes depends on which half identifies the call: a path keeps
its filename, a command keeps its program. `ctrl+o` wraps the whole thing and
opens the payload under it.

A shell command gets **two rows and 160 columns** — Claude Code's own
`MAX_COMMAND_DISPLAY_LINES` and `MAX_COMMAND_DISPLAY_CHARS`. It is the one
argument whose tail routinely carries the point, the redirect and the flag and
the path being written, so one clipped line drops exactly the half you would
have read second. The continuation sits under the open parenthesis, not under
the name, so it reads as more of the same call rather than a second one. Past
160 columns a header has stopped identifying a call and started reprinting it,
however wide the pane; `ctrl+o` still wraps the whole command.

**Paths are clickable, and the click lands in nvim.** An argument that is a path
gets an OSC-8 hyperlink, checked once per row and only once the file is really
there. A grep pattern that happens to look like a filename is not a path and
never gets one.

The link is not `file://`. macOS opens a file URL with whatever LaunchServices
thinks owns the extension, which here is QuickTime Player for `.ts`, TextEdit
for `.md` and a browser for `.json`, and a file URL has nowhere to put a line
number. So the rows link a scheme of their own:

```
pi-open:///Users/joel/dotfiles/pi/kit/extensions/transcript/row.ts?line=42
```

`~/Applications/Pi Open.app` claims `pi-open:` and runs `~/dotfiles/bin/pi-open`,
which splits the herdr pane that was clicked and opens nvim there — or reuses
the nvim it opened last time, over that nvim's own RPC socket, so ten clicks do
not make ten panes. Outside herdr it opens a Ghostty window instead. The line
comes from the call: `read` knows its `offset` before it runs, and `edit` learns
its `firstChangedLine` from the result and hands it to the header through the
state both render slots share.

`PI_TRANSCRIPT_OPEN=file` restores the old `file://` links, `off` drops links
altogether, and the default is `pi-open` only where that handler is installed.

**In fullscreen mode, clicking a row opens it.** Not through the extension API —
`ToolRenderContext` carries no pointer and `Component` has `handleInput` for
keyboard and nothing else — but `TuiAltScreen` is exported, it already parses
SGR mouse events for selection and scrolling, and it keeps the frame it last
laid out on `currentLayout`. A layout box knows its component, its rect and its
clip. That is hit testing, sitting there unused by anything but the scrollbar.

What the layout has no box for is a message: `Container` has no layout node, so
the whole transcript is one leaf box full of lines. So a click resolves in two
hops. The scroll box gives the document line — its content child's `rect.y` is
already translated by the scroll offset, so `y - rect.y` is the line under the
pointer. Then the document's children are measured in order until that line
falls inside one, descending through plain containers and stopping at the first
whose children do not add up to its own height, since past that the line numbers
no longer line up and a click that guesses is worse than a click that does
nothing. Measuring is rendering, and every component in a row caches its lines,
so a click costs a walk and no layout.

pi's own handler runs first and keeps its answer, so selection, scrolling, links
and search behave exactly as before. What is left over — a left button, pressed
and released on the same row, no drag, no hyperlink under it, not the second
click of a double — toggles that row's `setExpanded`, which on a collapsed
group's one line means opening the whole group. One wrapper on
`handleViewportInput`, the same seam `zen-chrome/user-message.ts` uses on
`UserMessageComponent.render`, put back on `session_shutdown`.
`PI_TRANSCRIPT_CLICK=off` skips it.

In regular mode there is nothing to hook: pi never turns mouse reporting on, so
the terminal owns the pointer — which is what gives you native selection and
real scrollback — and a row that has scrolled into the terminal's own scrollback
is not pi's to repaint. Switch modes in `/settings` to try the other trade.

`test/click.mjs` drives it with no terminal and no mouse: real layout engine,
real `ToolExecutionComponent`, real `TuiAltScreen` over a stub terminal, and the
click is the escape sequence, which is all a click ever is.

**A call that was cut off stops saying it is running.** An interrupted row never
reaches `renderResult`, so its dot would stay dim forever — indistinguishable
from a call still in flight. On `agent_settled`, when nothing is in flight by
definition, every row still drawing as running turns hollow: `○`, dim, no result
line. It is the one state that changes the glyph rather than its colour, because
it is the one that has to be told apart from another dim dot.

**A failure keeps its output**, twelve lines of it, with the head elided rather
than the tail, because a stack trace ends with the reason and the reason is what
you looked for. `ctrl+o` shows all of it.

**An image is drawn by pi, not here.** `ToolExecutionComponent` adds inline
images as its own children, so a result slot that draws them too puts the same
screenshot on screen twice. The row says `Read image (2.4 MB)` and gets out of
the way. Under tmux, where `getCapabilities()` reports no image support, it falls
back to pi's own `imageFallback` line naming the format and size, since that is
then the only thing on screen.

**`edit` is in the same system.** It gets the header and keeps its own body
under the gutter: a diff under `● Edit(line.ts)` with `1 file, +12 −4` above it.
A diff floating at column zero beneath a header at column two reads as two
separate things. MCP tools are not reachable
— `pi-mcp-adapter` registers them itself — so that seam stays, and the fix for it
is a PR to the adapter rather than a wrapper fighting it over tool registration.

**Rows draw their own shell.** pi's default is a `Box` with a column of padding,
a blank line above and below, and a background the jarvis themes make
transparent; a two-line receipt inside it is five lines of mostly nothing.
`renderShell: "self"` gives one blank line above each row, which is the margin
Claude Code puts between its own groups. No prototype patch: the previous version
monkey-patched `ToolExecutionComponent.render` to strip a blank line, and that
went with the merging.

**Layout happens in `render(width)`, and is cached there.** Neither render slot
is handed a width, so every decision about what fits has to wait for the frame.
zen-chrome asks the TUI for a frame every 33ms while the agent works, and that
walks every component on screen, so each row keys its lines on the width and a
stamp of its own fields and hands back the same array until something moves.

`node test/preview-transcript.mjs [width]` draws a screen of real rows through
pi's own `ToolExecutionComponent` with the real theme, which is the only thing
that proves what lands on screen.

Each built-in is re-registered under its own name with pi's definition spread
through it, so only the two render slots change and `execute`, the schema and the
prompt text stay the built-in's own. `powershell` is claimed only on Windows:
registering a tool is what makes it callable, and pi gates that one by platform.

`PI_TRANSCRIPT=off` restores pi's rows everywhere, including `edit`.
`PI_TRANSCRIPT_ROLLUP=off` keeps every
row of a settled turn. `PI_TRANSCRIPT_OPEN=file|off` changes where a click on a
path goes, and `PI_TRANSCRIPT_CLICK=off` stops rows from opening when clicked.

## `agent-rows` — subagents in the same receipts as everything else

```
● 3 background agents launched (↓ to manage)
  ├─ Explore  where the parser lives
  ├─ Agent    write the missing tests
  └─ Agent    audit the error paths

● Agent(where the parser lives)
  ⎿  Done · 45 tools · 142.1k tokens · 11m 21s

● Result(where the parser lives)
  ⎿  The parser is in src/lex/parse.ts
     It is called from two places.
     Both of them are in the CLI.
     … +18 lines (ctrl+o to expand)
```

An agent's answer is output with no honest count, so it is shown the way the
transcript shows every other one: three lines and a count of the rest, out of
the same `outputPreview`. A row showing a preview has no body under it, which
is what used to print its first line twice the moment `ctrl+o` opened it.

Two surfaces in two grammars without this. A tool pi has no renderer for draws
as `▸ Agent  desc` inside pi's padded box — three blank lines a row — and a
custom message with no renderer draws four more in a shape no other row uses. A
turn that launched five agents and collected two of them spent about forty lines
saying so.

**Nothing here changes what the model sees.** The engine keeps the tool —
execute, parameter schema, description, prompt guidelines — and keeps the
`<task-notification>` text of the completion message. That is not restraint, it
is the design: the only other way to own a row is to register the tool, pi
resolves **one definition per name and the first registration wins, whole**, and
taking `Agent` that way would mean re-implementing a tool whose behaviour lives
in `lib/agent-runtime.ts`, for two lines of paint.

So the rows are *claimed* instead. `ToolExecutionComponent` — pi's own tool row,
exported from the package root — asks for its render slots by method on every
frame, so `lib/claim-tool-rows.ts` patches those four methods once and consults a
registry keyed by tool name. Same seam and same style as the transcript's
`click.ts`. The claim is checked against pi's shape when it is made, not when a
frame is drawn, so a pi release that renames a method fails `test/agent-rows.mjs`
instead of silently handing every row back.

`registerMessageRenderer` is first-wins, and the kit registers the only
renderer for `subagent-notification` — the message comes from the kit's own
engine, so there is no second candidate and no load order to lose.

**Several launches in one message are one line.** A run of consecutive `Agent`
calls inside one assistant message is a batch; the first row draws the line and
the tree, and the rest draw nothing, which is the transcript's own mechanism and
its own rules — `ctrl+o` and a click on the line open it. A batch **dissolves**
the moment a member turns out not to be a background launch: a blocking call
returns the agent's whole answer and a failure is the record of what went wrong,
and neither is a name in a list.

`PI_AGENT_ROWS=off` gives every one of these rows back to pi's own drawing, and
`PI_TRANSCRIPT=off` does too — they are the transcript's components, so they
follow the transcript's switch.

## `prose-links` — a path in a message opens in nvim, not TextEdit

The rows above link `pi-open:`. Prose did not, and it is rendered by pi rather
than by anything here: a markdown link's target is written to the terminal
verbatim, so `[README](/Users/joel/…/README.md)` reaches macOS as a bare path
and LaunchServices opens it in whatever owns `.md`. With a window manager that
follows focus, clicking a path in the terminal then drags you into the room
TextEdit's window happens to be in.

`pi.registerMarkdownTransformer` is the seam — it sees user text, assistant
text and thinking, before pi renders any of it. Targets naming a local file
(`/abs`, `~/`, `file://`) are rewritten through the transcript's own `linkTo`,
so both kinds of click land in the same nvim and `PI_TRANSCRIPT_OPEN` governs
both. `:42`, `#L42` and `?line=42` all arrive as a line number.

Everything else is left exactly as written: other schemes, relative targets,
anchors, and anything inside a code span or a fenced block — a `](…)` in those
is text being shown, not a link being made. Streaming updates are skipped; the
finalized message is transformed again, and that is the one under the mouse.

Display only. The session and the model context keep the original text.

## `quiet-thinking` — hidden thinking draws nothing

With the thinking block hidden, pi still spends two lines on every reasoning
run: a blank line and the word `Thinking...`. On a thinking model that is a
stub above every message and above most tool batches, saying what the spinner
already said and pushing the work off the top of the pane.

Both lines come from one method. `AssistantMessageComponent.updateContent`
counts a thinking block as visible content, which buys the leading blank, and
then draws the label for each run of them. `ctx.ui.setHiddenThinkingLabel("")`
is not the fix: `theme.fg` wraps even an empty string in escape codes, so pi's
`Text` is handed something non-empty and draws a line anyway — the word goes
and its line stays, which is **two** blank lines instead of one and a word. pi
also resets that label whenever it rebinds a session, so the setting would not
survive a `/reload`.

So the fix is upstream of the drawing: one wrapper on `updateContent` hands the
original a message with the thinking content filtered out, and the component
never sees a thinking block while it is hiding them. No blank, because nothing
visible is left to space; no label, because the branch that draws it is never
reached. Every other branch of that method — text, tool calls, `length`,
`aborted`, `error` — runs on pi's own code over pi's own content, and with the
block *shown* the message is passed through untouched and pi renders it byte
for byte as it always did. Same seam and same style as `transcript/click.ts`.

The unfiltered message is parked on the component under a global symbol, so
turning the block back on mid-session shows the reasoning that was hidden, and
a `/reload` — which builds a new copy of this module with new module state, but
leaves the components on screen alive — finds it there.

**Declared limit: thinking draws nothing, including when it sits between two
runs of prose in one message.** Those two runs then close up, because the blank
line under them was the thinking block's own. A rule with a "sometimes it
leaves a blank" clause is a rule you have to read the reasoning to predict.

`test/quiet-thinking.mjs` pins the four facts about pi the wrapper depends on —
the method name, the flag name, that an unpatched pi really does draw the blank
and the label, and that an empty label draws two blanks — and fails naming the
file in pi's dist that moved, because a wrapper whose seam has been renamed
goes quietly inert. `PI_QUIET_THINKING=off` restores pi's `Thinking...`.

## `quiet-commands` — fewer things in autocomplete

Hides `/trust`, `/changelog`, `/import`.

## `always-trust` — no trust prompt

Trusts every project through the `project_trust` hook.

## `watchdog` — nothing waits forever

pi has no tool-execution timeout, and pi-ai's SSE reader has no meaningful-event
deadline. Both fail the same way: the agent is mid-run and nothing happens. An
`Explore` child once grepped all of `$HOME`, sat in one tool batch for 42.5
minutes, ignored steering, and reported itself `running` throughout.

So this watches one thing — silence between `agent_start` and `agent_settled` —
and not one thing per hole. Any observable event resets the clock; a streaming turn
touches it per token and never churns a timer, and an idle session holds none.

After **15 minutes** of silence an unattended session aborts itself. The number
comes from 6,584 real tool batches across 275 sessions: p99 3.0m, p99.9 6.7m,
slowest legitimate 10.1m. Aborting at 5m would have killed 18 real batches; 12m
is the smallest bound that kills none; 15m keeps 1.5x headroom, because a late
kill wastes a slot and an early one destroys work that was succeeding. It lives
in `lib/silence-deadline.ts` rather than here, because `session-mode` caps a
headless seat's keep-warm pings against the same span and the two have to move
together.

Tools bounded by something other than this clock are exempt. The engine's wait
(`TaskOutput`) runs 21 minutes quite legitimately, and the child it is waiting
on runs this same watchdog. `bash` is the kit's own tool and bounds itself: every call has a
timeout, and on the main seat reaching it moves the command to the background
(see `bash` below). A silent bash is a quiet command, not a wedge, and warning
about it every five minutes was noise the human had already read on the tool's
own `Elapsed` line.

Under a TUI it warns instead of aborting: a human can already see a stuck
spinner and press Esc, and taking a fifteen-minute turn away from them because a
build was slow is worse than the hang. The warning is one toast, and it names no
deadline, because none is coming — "silent for 20m (deadline 15m)" was a lie the
human watched expire. Everywhere else — subagents, `print`, `rpc` — nobody is
watching, so it aborts.

The abort is not silent. It rewrites the failed turn's `errorMessage` to name
the watchdog and the tool, and normalises `stopReason` to `error`, which is what
a parent reads: it gets `Agent failed: watchdog: aborted after 15m…` instead of
a partial answer that looks finished.

`PI_WATCHDOG_MS` sets the deadline, `PI_WATCHDOG_MODE=abort|warn|off` overrides
the TUI rule. Zero prompt surface — no tools, no commands, no system text.

## `bash` — the kit's own shell, in Claude Code's shape

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
streaming partial render with the ticking `Elapsed` line. `extensions/bash.ts`
supplies `exec` from a `Run` built per call and registers the result under the
built-in's name, which replaces it. The words, the numbers and the schema are
`lib/bash.ts`.

A command's life:

| | |
|---|---|
| no `timeout` passed | **120 s** of foreground |
| the model may request | up to **600**, and is told so |
| hard ceiling, clamped | **1800** (30 min) |
| the timeout arrives | the command is **moved to the background**, not killed |
| `run_in_background: true` | the same move at t=0 |
| `ctrl+b` | the same move, now, for every running command |
| Esc | still a kill |

Every run logs from the start — stdout and stderr go to pi's accumulator *and*
to a `0600` file under the kit's state dir — so a move loses nothing. The
result the model gets is pi's own output so far plus one sentence: still
running as task N, output continues at the log, you will be notified. When the
process exits, a `<background-task-notification>` arrives through
`pi.sendMessage` as a follow-up that triggers a turn, so it wakes an idle
session and queues behind a busy one. A background task whose log has not
grown for 45 s and whose tail looks like a y/n prompt sends one stall notice
naming the process group to kill. Under tmux the hint says `ctrl+b ctrl+b`,
because the prefix eats the first press.

A child seat keeps the kill: a subagent's session ends with its task, so a late
notification has nowhere to land. There the timeout is pi's timeout in pi's
words, `run_in_background` is not in the schema, and a call that passes it
anyway is refused with the remedy. The seat is known at `before_agent_start`,
and re-registering the tool there replaces the definition before the first
request goes out. Nothing outlives the session: shutdown kills every process
group it started; herdr owns anything meant to last.

The rows are the transcript's: two extensions cannot claim one tool name, so
this one registers bash and wears `transcript/receipt.ts`, whose live line
carries the offer (`⎿  building…  +12 lines · ctrl+b to background`) and
gives it up first on a narrow pane. With `PI_TRANSCRIPT=off` pi's own render
stands, with the same hint under it.

`PI_KIT_BACKGROUND_DIR` moves the logs. `ctrl+b` is released from the
editor's cursor-left binding in `pi/keybindings.json` (`left` remains), so pi
does not report a conflict at startup.

## `tool-policy` — no scan starts at `/`

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

`tool_call` fires before any tool's `execute`, owned or built-in, so the guard
covers the kit's own `bash` as well as pi's `grep`/`find`; bash's deadline is
that tool's own business.

`lib/tool-policy.ts` also holds the standing tool set: **a seat with `bash` loses
`grep`, `find` and `ls`**, applied both to `payload.tools` at the wire and to
the `selectedTools` the owned prompt derives its guidelines from, so a seat is
never told to prefer a tool its payload no longer carries. The
predicate is bash-presence, not a seat name — a seat is exactly as dangerous
as its shell. Explore-shaped seats have no bash and keep all three, which is
the whole reason they have no bash. The cut is worth ~51 effective tokens a
request and is not a token ruling: it moves the work onto the one tool that
takes a timeout.

## `herdr-agent-state` — herdr integration

Reports session state to the surrounding herdr pane. Paired with `skills/herdr`,
which is inert unless `HERDR_ENV=1`.

## `model-catalog` — the releases this process is allowed to have

pi ships the whole Anthropic catalog in-process, so `claude-opus-4-5` is one
Ctrl+P away from any seat and a `defaultModel`, a `--model`, a session header or
an agent type's frontmatter written weeks ago can put one there silently. This
extension registers pi's own Anthropic provider back over the built-in one with
`getModels()` cut to the newest release per family (`lib/model-family.ts`'s
`newestPerFamily`): four ids, no superseded release, no dated pin. Every read of
a model goes through that one function — `/model`, `--model`, Ctrl+P, a resumed
session and an engine child alike — so an older release is not something a seat
can be put on rather than something it is warned about afterwards. Auth, OAuth
and streaming stay pi-ai's own, by spread. `wire` asserts the same fact on the
request itself: a model the registry cannot find throws.

## `wire` — everything this harness puts on the Anthropic wire

Replaces `pi-claude-oauth-adapter` and the old `restore-project-context`
workaround. pi builds its vanilla prompt however it likes; this extension
rebuilds the entire `system` array per request in `before_provider_request`
from the structured `systemPromptOptions` captured at `before_agent_start` —
replace, never strip, so pi text the builder doesn't map can never leak onto
the wire. The builder itself lives in `lib/owned-prompt.ts`: pi's exact
skeleton (guidelines, append, project context, skills, cwd framing) minus the
pi-docs block, which moved to the `self-modify` skill, and minus the
*Available tools* list, which pi's own docs call opt-in decoration while
`payload.tools` carries every name, description and schema in full — 954
characters (~238 tokens) of restatement, deleted. Context
files are deduped by `realpathSync` so a symlinked context file
(`~/.pi/agent/AGENTS.md` -> `~/dotfiles/pi/AGENTS.md`) can never reach the
wire twice.

It owns `payload.tools` for the same reason it owns `system`: one request
shape, one owner. Both edits are static — the standing cut and the Agent
schema trim, from `lib/tool-policy.ts` — so the tool prefix changed once, at
the release that landed them, and never again per request. Bash is not
rewritten here: the kit registers the tool with the text that is true for its
seat, so the wire carries what it says.

On Anthropic OAuth requests the array opens with the `x-anthropic-billing-
header:` attribution block, then the `You are Claude Code, Anthropic's official
CLI for Claude.` identity block, then the owned prompt — the order the Claude
Code 2.1.251 binary itself builds. `options.customPrompt` (subagent prompts) is
honored with pi's own branch semantics.

The same extension owns the client-identifying headers, because one request
shape needs one owner: `before_provider_headers` overrides pi-ai's stale
`claude-cli/2.1.75` user-agent with the one resolved version and adds
`X-Claude-Code-Session-Id`, and `after_provider_response` captures each
response's `request-id` so the next request can carry it as `cc_prev_req`.
Every Claude Code wire fact — salt, hash formula, identity line, header names —
lives in `lib/claude-code.ts` and is pinned by tests against the installed
`claude` binary, so a Claude Code release that changes the shape of the wire
fails the suite instead of drifting silently. The version itself is not pinned:
it is read off that same binary once at load, so it cannot fall behind it. Subagent turns additionally declare `cc_is_subagent=true`
plus both agent-id headers, or none of the three: a half-declared subagent is
unrepresentable. pi-ai natively covers the rest of the OAuth surface (bearer
auth, oauth beta headers, tool-name casing).

### Instruction text changes only with its pins

Three texts reach a seat: `pi/AGENTS.md` (cross-repo working doctrine), the
role tails in `lib/agent-role-tails.ts` (what a child is told it is), and the
skeleton plus `pi/APPEND_SYSTEM.md` (harness identity and voice). All three sit
in the cached prefix — the tails in the child's first user message, which is
the one place a tail can go without costing the parent's system block — which
makes them cheap to hold and expensive to churn.

So: **instruction text changes only in a commit that also updates the checks
that pin it**, and nothing moves it mid-session. Every wording change trips a
composition test — the drift guard in `test/smoke.mjs` states the owned prompt
as a transform of pi's own bytes, and `test/tool-policy.mjs` pins the
guideline set per seat — so a change has to be acknowledged where the reason
for it is written down, and casual tuning is impossible by accident rather
than by discipline.

### One writer per shared surface

The rule generalises past the wire, and it has cost twice now, so it is written
down. **No extension writes another extension's UI state — publish the fact,
never poke the flag.**

pi's UI setters are write-only and absolute: `setWorkingVisible(visible)` has no
getter, so a second writer cannot save what it is about to overwrite and cannot
restore it. It can only guess, and its guess is pi's default rather than the
owner's choice — which is how `/context` used to un-hide `zen-chrome`'s
`Working...` row permanently (issue 18). Correct save/restore is not merely
unwritten there, it is unbuildable, so exactly one extension owns each setter.
An extension that needs another's behaviour to change publishes the fact that
should change it — the `globalThis` seam `lib/side-mode.ts` and
`lib/cache-window.ts` use — and the owner decides.

Same shape as `before_provider_request` above, where one request needs one
owner because two handlers rebuilding the payload cannot see each other's work
(issue 12).

Per-request rebuilding leaves no turn-level strip/repair state to desync, so
notification-triggered turns carry byte-identical prompts across requests —
the cache-forking Bug B class is gone by construction. Schema drift in
`BuildSystemPromptOptions` is caught at capture time and reported loudly;
requests are never failed mid-flight because pi swallows handler throws.

`/prompt` dumps the exact blocks and per-tool schema sizes last sent to the
provider — the audit tool for any prompt or token work.

### The cache trace

Because `wire` is the only thing holding the final payload, it is also where the
cache trace runs (`lib/wire-trace.ts`). Every request is fingerprinted — a hash
per system block, per tool and per message, the breakpoint positions, the TTL
asked for — and every response's usage is paired back to it on `message_end`,
which is where usage arrives; `after_provider_response` carries status and
headers only.

The point is the third step. After a request settles the provider holds exactly
`cacheRead + cacheWrite` tokens of prefix, so the next request in the session
should read that number back. When it reads less, the trace diffs the two
fingerprints and names the culprit — Anthropic keys the cache
`tools → system → messages`, so the *earliest* section whose bytes moved is the
cause and nothing later can be. Appending messages is not a change, which is
what makes the result decisive: an all-append diff paired with a collapsed read
proves the loss is not in our bytes. Thinking blocks are hashed with their text
and their signature apart, because the models summarise their own reasoning and
a re-summarised block is a different defect from anything the harness can cause.

A short read is not always a break. When the request's own prompt —
`input + cacheRead + cacheWrite` — is *smaller* than the prefix, it could not
have re-sent that prefix, so nothing was paid for twice: the conversation got
shorter and the prefix was **retired**. That is what a handoff looks like from
here, and the rule needs no special case for handoff, compaction or trim. It is
recorded as `t:"retire"` and nobody is notified, because nothing went wrong.

Every response's quota reading rides on the `t:"use"` record beside the token
counts: the five `anthropic-ratelimit-unified-*` headers, read by
`lib/quota-meter.ts` off `after_provider_response`. Tokens are what was spent;
utilization is what it cost the subscription, and the ratio between them is the
only way to learn weights Anthropic does not publish. Nothing about it renders
unprompted: `/quota` prints the last reading — `5h 34% · 7d 61%` plus the resets
and the binding claim — and the bottom rule stays quiet (C15).

Keep-warm pings get their own record (`t:"ping"`), filed against the request
they replayed. A ping skips every hook, so without one the trace would show a
gap the size of the ping interval and no reason the cache survived it.

Always on, and that is a measurement rather than a taste: a subagent session
builds its own extension set from the manifest and never sees a parent's `-e`
flag, so an opt-in instrument is blind to exactly the sessions that break most.
The standing cost is 0.27 ms of hashing per request on a 350 KB payload and
~200 bytes of disk, because per-message hashes are held in memory for the diff
and only written when there is a break to explain.

Traces live in `$XDG_STATE_HOME/pi-kit/wire-trace` (`~/.local/state/...`),
directory `0700`, files `0600`, pruned after a week — not world-readable `/tmp`,
where the hand-rolled probes this replaces left whole conversations at mode 644.
Content never reaches disk unless `PI_WIRE_TRACE=full` is set, and then only the
two payloads that straddle a break. `/trace` prints the file's path and the last
break it classified; a break also arrives as a one-line notice when it happens.

The recorder is total by construction. It runs inside the handler whose *return
value is the request*, and pi drops that return value if the handler throws — so
a recorder that could throw could strip the owned prompt off the wire and break
the cache it exists to watch. It cannot.

## `skills/`

Twenty-eight of them, from `coding-standards` (always read before TypeScript work)
to `mermaid` (validate a diagram before shipping it). `~/.agents/skills` is a
symlink here, so the dormant harnesses see the same set.

---

## History: two of these used to be patches

`~/.pi/patches` held a patcher that rewrote the installed `dist/` after every
upgrade, kept alive by a shim on `PATH`. It is gone. Six of its seven operations
were rebuilding the footer, which `ctx.ui.setFooter` and
`ctx.ui.setEditorComponent` do properly, and the seventh only emptied
`builtInExtensions` to remove `/llama`, which turned out not to be worth a
patcher.

Two things genuinely cannot be done through the API.

**Built-in slash commands cannot be unregistered.** Each is dispatched by a
hardcoded name check that runs before extension commands. `quiet-commands.ts`
therefore hides them from autocomplete rather than disabling them; typing
`/trust` in full still works.

**User and assistant messages have no render hook.**
`registerMarkdownTransformer` is the only seam, and it hands the text back to
pi's Markdown renderer, which rewraps and restyles it, so a border drawn there
drifts out of true the moment a message contains `**bold**`.
`zen-chrome/user-message.ts` and `transcript/thinking.ts` therefore wrap `render`
on the exported `UserMessageComponent` and `AssistantMessageComponent` at session
start and put them back on `session_shutdown`. Neither reads anything private:
each asks the original for a narrower render and decorates the lines that come
back, and every failure path returns that untouched render.
