# `zen-chrome` — the prompt is a box

Closes the editor into a rounded box, frames sent messages in the same box,
moves the footer onto its edges, and rolls a wave along the border while the
agent works. The top edge carries the model name; the bottom rule carries one cache
number, how long until the prefix is cold if nothing more is sent — `❄12m`, a bare `❄`
once it is (`lib/wire/cache-touch.ts`): one entry lifetime after the last warm the wire's
warmer will send before its 30-minute limit, or after the last request or warm sent
when the warmer will not warm the seat (stopped, idle child seat, non-Anthropic).

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

The task count comes from `agent-dock` as a status, and this is the one
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

The clock behind it is `lib/session/turn-clock.ts`, and zen-chrome is its only writer,
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

The wave is a few lamps of one hue far apart on a dim rail, so the whole frame
is one colour at any instant, the hue drifting along the arc. Light reads as
light because a line that is evenly bright everywhere has nothing to glow
against.

## Where the code is

| file | what it answers |
|---|---|
| `index.ts` | the entry: the box's readings (`ChromeState`), the framed editor (`ChromeEditor`), the wake, and the event wiring that writes the turn clock |
| `prompt-box-rules.ts` | the bottom rule and its drop order, the context reading, the cwd label, the ghost |
| `fold.ts` | when the empty prompt folds, and how its readings pack into one or two rows |
| `status-footer.ts` | the footer row of other extensions' statuses |
| `rule-tickers.ts` | the timers that redraw the cache countdown and the turn timer |
| `level-flash.ts`, `task-count-glow.ts` | the light on the model label after a level change, and on the task count |
| `box-wake.ts` | the wake timeline a session opens with, and its grey-out |
| `animation-clock.ts` | the one frame timer every animation shares |
| `dock-layout-rows.ts` | the rows pi's layout reserves around the box |
| `user-message.ts`, `user-message-box.ts` | sent messages framed in the same box |
| `layout-preview.sh`, `light-preview.sh` | hand-run previews: the layout at many widths, and the animated light |

Shared with other extensions, under `lib/ui/`: `labelled-rule.ts` (the rule
primitives), `prism-light.ts` (the light and its frame rates), `sgr-cells.ts`,
`rgb-color.ts` and `terminal-slot-colors.ts`; under `lib/models/`: `model-label.ts`.
