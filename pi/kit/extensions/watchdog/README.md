# `watchdog` — nothing waits forever

Paths are relative to `pi/kit/`.

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
in `lib/session/silence-deadline.ts` rather than here.

Tools bounded by something other than this clock are exempt. The engine's wait
(`TaskOutput`) runs 21 minutes quite legitimately, and the child it is waiting
on runs this same watchdog. `bash` is the kit's own tool and bounds itself: every call has a
timeout, and on the main seat reaching it moves the command to the background
(see [`bash`](../bash/README.md)). A silent bash is a quiet command, not a wedge, and warning
about it every five minutes was noise the human had already read on the tool's
own `Elapsed` line.

Under a TUI it warns instead of aborting: a human can already see a stuck
spinner and press Esc — which always works, because every kit tool call ends
within 2 s of its abort (`lib/tools/tool-abort-bound.ts`) — and taking a fifteen-minute turn away from them because a
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

## Where the code is

- `index.ts` — wires pi's events to the clock, records the abort, rewrites the failed message.
- `silence-watchdog.ts` — the pure silence clock, the self-bounded tools and the mode rule.
- `watchdog-message.ts` — the warning and abort texts, and the failed-assistant shape.
