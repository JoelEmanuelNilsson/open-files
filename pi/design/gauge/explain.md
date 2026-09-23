# Explain — every term, box and number the page shows

One entry per thing. Each answers: what it is, why that name, where it
lives, what it costs, how it can go wrong.

---

## the gauge

**What** The twelve-cell bar at the right end of the prompt box's bottom
rule, with a percentage after it: `████⣿⣿⣿⣿⣿⣿⣿⣿ 31.4%`.

**Why that name** It is a gauge in the fuel sense: a bounded tank, drawn
full to empty. The code calls it `contextBar`.

**Where** `pi/kit/extensions/zen-chrome/chrome.ts`, function `contextBar`.
Rendered by `ChromeState.context` in `index.ts` of the same folder.

**Size** 12 cells plus a space and up to five characters of label: 18
columns of a rule that is typically 80 to 200 wide.

**How we work on it** `./preview.sh` in the same folder renders the whole
chrome at many widths without booting a terminal. `./test.sh` animates it.

**What can go wrong** Nothing dangerous. It is painted inside a try/catch
because a render must never throw. Its only failure mode is being wrong
about what it claims, which is the subject of this page.

---

## compaction

**What** The step where the agent throws away most of the conversation and
replaces it with a summary, because the context window is about to overflow.

**Why it matters here** The gauge exists to warn that compaction is coming.

**Where** pi core. Configured in `~/.pi/agent/settings.json`.

**State** `{"enabled": false}`. It is switched off in this harness. The
`handoff` extension replaces it: the model writes its own summary on demand
instead of a summariser doing it by surprise.

**So what** The gauge is the alarm for a fire that cannot start.

---

## context window

**What** The number of tokens the model can hold in one request.

**Where** pi's own bundled catalog, `pi-ai/dist/providers/data/anthropic.json`,
`"anthropic-messages"."claude-opus-5".contextWindow`.

**Size** 1,000,000 tokens.

**So what** Joel's sessions top out around 350,000 tokens, which is 35% of
that. The gauge's warning colour starts at 70% and its alarm at 90%. Four of
its twelve cells is the most it will ever fill, and it will never change
colour.

---

## the 5-hour window

**What** Anthropic's short usage claim on a Claude subscription. Every
request spends from a budget that refills on a fixed five-hour boundary.

**Why that name** It is what the header calls it: `5h`.

**Where** Response header `anthropic-ratelimit-unified-5h-utilization`, on
every Claude OAuth response. Free — no extra request.

**Size** A single float. `0.67` means 67% of the window is spent.

**How we would work on it** Read it in `after_provider_response`, which
`wire.ts` already handles for OAuth requests, and publish it on `globalThis`
the way `session-mode` already publishes the cache window for `zen-chrome`
to draw.

**What can go wrong** The header is missing on non-Anthropic providers and
on API-key requests, so the bar must have a nothing-to-say state. It is also
stale between responses, which matters for the pace reading: elapsed time
keeps moving while spend does not, so an idle session drifts slowly toward
looking thrifty. That is the honest reading, not a bug.

**Open** Whether `0.67` means 67% or 0.67%. Two probes two minutes apart
moved it 0.66 → 0.67 under ordinary work, which only makes sense as a
fraction. One check against Claude Code's `/usage` settles it.

---

## the 7-day window

**What** The weekly claim. Same header family, `7d`.

**So what** It moves slowly and is the one that ends a week early. It also
carries the Opus cutoff: `fallback-percentage: 0.5` means the plan drops
Opus to Sonnet at half the weekly budget.

**Open** Whether the bar should ever show it, or whether the server's own
`representative-claim` header — which names the window currently binding —
should pick.

---

## utilization

**What** The fraction of a window already spent. `0.67`.

**Where** `anthropic-ratelimit-unified-5h-utilization`.

**So what** At 22:35 on 2 September it read 0.67 while the window was 45%
through its five hours. Two thirds of the budget for less than half the
time.

---

## elapsed

**What** How far through the five hours the clock is, computed from the
reset header: five hours before `5h-reset` is when the window opened.

**Where** Derived, not sent. `anthropic-ratelimit-unified-5h-reset` is an
epoch second.

**So what** It is the pace line. Spend below it is banked; spend above it is
borrowed from the end of the window.

---

## pace

**What** Spend divided by elapsed. Below 1.0 the budget outlasts the clock.
Above 1.0 it runs out early.

**Why that name** From running: a pace band tells you whether you are ahead
of or behind the time you are chasing, without arithmetic.

**Reading at 22:35** 0.67 / 0.452 = 1.48. Holding that, the budget empties
at about 23:42, an hour and a half before it refills at 01:20.

**What can go wrong** Early in a window the divisor is tiny, so one request
reads as a wild pace. The bar should say nothing about pace for the first
few minutes of a window rather than scream.

---

## the pace bar

**What** The proposed replacement, in the same twelve cells. Solid cells are
spend. Over the clock, the fill changes colour at it — the colour change is
the mark, and no cell is spent on a glyph. Under the clock, one cell out in
the dot field goes violet: a cell that was holding nothing anyway.

**Why a bar and not a number** Two numbers and a division is arithmetic. Two
edges and the gap between them is a glance. That gap is the whole reading.

**What it costs** Nothing on the wire. One header read per response, one
value on `globalThis`, the same twelve columns already spent.

**What can go wrong** It is only as fresh as the last response. Between
turns the clock creeps and the spend does not, so the bar slowly flatters
you while you think. Acceptable: the direction of that error is safe.

---

## the swarm strip

**What** A second proposal, unrelated to the gauge: replace the `2 tasks ↓`
text in the rule's middle slot with one glyph per background agent, each
lit while it runs and frozen on settle.

**Where it would live** `pi/kit/lib/agent-task-count.ts` produces the text;
`ChromeState.tasks` in `zen-chrome/index.ts` places it.

**Why it is not the gauge's replacement** The count is usually zero to
three. Twelve cells of mostly nothing is worse than the four characters it
already costs. It belongs in the slot that already appears and disappears
with the agents.

**Open** Whether the glyphs are worth it at all over `2 tasks ↓`, given
that neither says anything about progress — agents report only start and
settle.

---

## representative-claim

**What** A header naming which window is currently the binding one:
`five_hour` or `seven_day`.

**So what** It removes a design argument. The bar does not have to guess
which limit to show; the server says.

---

## after_provider_response

**What** The pi extension hook that fires when an HTTP response arrives,
before its body is read. It carries the status code and the headers.

**Where** `pi/kit/extensions/wire.ts` line 366 already listens to it, for
OAuth requests only, to remember the request id.

**So what** The data for the pace bar arrives at a door the harness already
opens.

---

## the drop order

**What** As the terminal narrows, the bottom rule gives up labels in a fixed
order: the turn timer first, then the task count, then the branch is
squeezed, and the gauge is the last thing standing.

**Where** `bottomRule` in `pi/kit/extensions/zen-chrome/chrome.ts`.

**So what** Whatever occupies those twelve cells is, by construction, the
most important thing in the frame. That is an argument for putting the
binding resource there, or for giving the slot up entirely.

---

## delete it

**What** The baseline option: drop the twelve cells, keep the percentage as
plain text, and give the rule eighteen quieter columns.

**Why it is on the page** Any replacement has to beat doing nothing. A
quieter frame is a real gain, and it costs no code that can go wrong.

**What it trades** The one visual that survives a narrow pane. And the
percentage it keeps is a percentage of a limit that does not bind.
