# `wire` — everything this harness puts on the Anthropic wire

Replaces `pi-claude-oauth-adapter` and the old `restore-project-context`
workaround. pi builds its vanilla prompt however it likes; this extension
rebuilds the entire `system` array per request in `before_provider_request`
from the structured `systemPromptOptions` captured at `before_agent_start` —
replace, never strip, so pi text the builder doesn't map can never leak onto
the wire. The builder itself lives in `lib/wire/owned-prompt.ts`: pi's exact
skeleton (guidelines, append, project context, skills, cwd framing) minus the
pi-docs block, which moved to the `self-modify` skill, and minus the
*Available tools* list, which pi's own docs call opt-in decoration while
`payload.tools` carries every name, description and schema in full — 954
characters (~238 tokens) of restatement, deleted. Context
files are deduped by content, so a symlinked context file
(`~/.pi/agent/AGENTS.md` -> `~/dotfiles/pi/AGENTS.md`) can never reach the
wire twice, and neither can two paths with identical text.

It owns `payload.tools` for the same reason it owns `system`: one request
shape, one owner. The only edit is the canonical order, so the tool prefix
never changes per request. Bash is not
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
lives in `lib/wire/claude-code.ts` and is pinned by tests against the installed
`claude` binary, so a Claude Code release that changes the shape of the wire
fails the suite instead of drifting silently. The version itself is not pinned:
it is read off that same binary once at load, so it cannot fall behind it. Subagent turns additionally declare `cc_is_subagent=true`
plus both agent-id headers, or none of the three: a half-declared subagent is
unrepresentable. pi-ai natively covers the rest of the OAuth surface (bearer
auth, oauth beta headers, tool-name casing).

## Instruction text changes only with its pins

Three texts reach a seat: `pi/AGENTS.md` (cross-repo working doctrine), the
role tails in `lib/agents/agent-role-tails.ts` (what a child is told it is), and the
skeleton plus `pi/APPEND_SYSTEM.md` (harness identity and voice). All three sit
in the cached prefix — the tails in the child's first user message, which is
the one place a tail can go without costing the parent's system block — which
makes them cheap to hold and expensive to churn.

So: **instruction text changes only in a commit that also updates the checks
that pin it**, and nothing moves it mid-session. Every wording change trips a
composition test — the drift guard in `test/wire/owned-prompt.test.mjs` states the owned prompt
as a transform of pi's own bytes, and `test/wire/prompt-render.test.mjs` pins the
guideline set per seat — so a change has to be acknowledged where the reason
for it is written down, and casual tuning is impossible by accident rather
than by discipline.

## One owner per request

`before_provider_request` has one owner because two handlers rebuilding the
payload cannot see each other's work (issue 12). The kit-wide form of that rule
is [one writer per shared surface](../../README.md#one-writer-per-shared-surface).

Per-request rebuilding leaves no turn-level strip/repair state to desync, so
notification-triggered turns carry byte-identical prompts across requests —
the cache-forking Bug B class is gone by construction. Schema drift in
`BuildSystemPromptOptions` is caught at capture time and reported loudly;
requests are never failed mid-flight because pi swallows handler throws.

`/prompt` dumps the exact blocks and per-tool schema sizes last sent to the
provider — the audit tool for any prompt or token work.

## The cache trace

Because `wire` is the only thing holding the final payload, it is also where the
cache trace runs (`extensions/wire/wire-trace.ts`). Every request is fingerprinted — a hash
per system block, per tool and per message, the breakpoint positions, the TTL
asked for — and every response's usage is paired back to it on `message_end`,
which is where usage arrives; `after_provider_response` carries status and
headers only.

The point is the third step. After a request that wrote to the cache settles, the
provider holds `cacheRead + cacheWrite` tokens of prefix; a request that wrote
nothing added no entry, even when it was billed a read of its whole prompt, so
the prefix held before it still stands (evidence/41). The next request in the
session should read that number back. When it reads less, the trace diffs the two
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
`extensions/wire/quota-meter.ts` off `after_provider_response`. Tokens are what was spent;
utilization is what it cost the subscription, and the ratio between them is the
only way to learn weights Anthropic does not publish. Nothing about it renders
unprompted: `/quota` prints the last reading — `5h 34% · 7d 61%` plus the resets
and the binding claim — and the bottom rule stays quiet (C15).

The wire keeps the prompt cache warm itself (`cache-warmer.ts`): 4m30s after a seat's
last request or warm on a 5-minute entry, it replays the last request with
`max_tokens: 1` and files it as `t:"warm"` (no sequence number, no pairing with a
response; it restarts the clock the expiry verdict measures from) and as a
`cache_warm` session entry with its usage. The main seat is warmed always, a child
only while it owns a live agent or background task, never later than 30 minutes
after the last real request, and not at all with `cacheWarming: "off"`. A failed
warm stops warming and says why in one notice. A warm also never goes out for an
entry that has already expired (a machine that slept, a reload that landed late):
it would write the whole prefix again for a request nobody made. And a replaced
transcript — a compaction, a tree navigation — drops the request the warm would
replay and the countdown with it, so nothing warms the old prefix (a 483k-token
read at 13:13 UTC on 2026-10-11, four minutes after its compaction); the next
real request starts the schedule again. pi's own warmer is told to stop for
Anthropic requests: it drops the run whenever a message object in the request's
context is rebuilt (`dist/core/sdk.js:214-224`), and pi rebuilds compaction
summaries and custom messages at every turn end (`dist/core/session-manager.js:179-190`,
`dist/core/agent-session.js:515,636-638`), so it never warmed an idle main seat.

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

## The request size budget

A request over the provider's size limit is not a failed turn but a dead seat:
on 2026-09-25 a worker read 27 screenshots, 1.2 MB of base64 each,
and Anthropic answered `413 request_too_large` to that request and to every
resume after it, because every resume re-sent the same images. Anthropic's
limit is 32 MB per Messages request, which pi's catalog declares on every Claude
model as `inputLimits.maxRequestBytes` (33554432), beside `images.maxPerRequest`
(600, 100 for Haiku).

Two things keep a seat under it, in two places:

- **Smaller images at the source.** `model-catalog` caps each Claude model's
  `inputLimits.images.resize`, which pi applies to every new image — `read`,
  prompt attachments, tool results — before it enters the conversation: 1568 px
  on a standard-tier model (Haiku 4.5), where Anthropic downscales anyway; 2000
  px from Claude 4.7 on, which is processed up to 2576 px but refused past 2000
  px in a request of more than 20 images; and 1 MiB of base64. The byte cap does
  the work: pi keeps a PNG whenever it fits under `maxBytes`, and its 4.5 MiB
  default fits nearly every screenshot. A 1600×900 screenshot goes from
  1,769,084 bytes of PNG to 385,348 of JPEG. Images already in a transcript stay
  as they were encoded.
- **A budget on the whole request.** `extensions/wire/request-image-budget.ts`
  measures the conversation on pi's `context` event, before every request. Past
  three quarters of the declared size (or past the image count), the oldest
  images become one line of text naming the file or message each came from,
  until the conversation is under half. Half, not just under the line, because
  the cut moves the cached prefix from the oldest image on: it happens once, and
  then not again for another quarter of the limit.

The cut is recorded at the next `turn_end` as pi's own `context_edit` entries,
one per edited message. The session file keeps every original image; the edit
records what the model was shown instead, so `/prompt`, the next request and the
next resume all send the same stubs, and the transcript still says what was
read. It is made on pi's messages rather than on the Anthropic payload in
`before_provider_request` because pi-ai converts a recorded edit like any other
message: cut there, the request-local cut and the recorded one are the same
bytes by construction, where a payload-level cut would differ wherever pi-ai
collapses a text-only tool result into one string, and the prefix would move a
second time. Between the request that cuts and the `turn_end` that records it,
the decision is held in memory, keyed by image data; a seat that dies in between
makes the same cut again from the same transcript.

This cut is made in our own code even though, on Opus 5.5, editing an earlier
`tool_result` invalidates every later thinking block: the server-side edit below
runs after the request is accepted, so it cannot bring an oversized request under
the limit, and a seat that is refused with a 413 cannot continue at all.

Limits, declared: a model with no `maxRequestBytes` (the Codex catalog) is not
budgeted, and the budget counts the conversation, not `system` and `tools`, which
are a few hundred KB against an 8 MB margin. `test/wire/request-image-budget.test.mjs`
resumes a 30-screenshot transcript through a real seat.

## No server-side tool-result clearing

Engine children asked Anthropic to clear old tool results on the server until
2026-09-29, when it was removed: the server's undocumented counting rule drifted,
and each drift re-wrote 73k–227k tokens of cache. Clearing in our own code is not
possible on Opus 5.5, because it invalidates every later thinking block.

## `model-catalog` — the releases this process is allowed to have

pi ships the whole Anthropic catalog in-process, so `claude-opus-4-5` is one
Ctrl+P away from any seat and a `defaultModel`, a `--model`, a session header or
an agent type's frontmatter written weeks ago can put one there silently. This
extension registers pi's own Anthropic provider back over the built-in one with
`getModels()` cut to the newest release per family (`lib/models/model-family.ts`'s
`newestPerFamily`): four ids, no superseded release, no dated pin. Every read of
a model goes through that one function — `/model`, `--model`, Ctrl+P, a resumed
session and an engine child alike — so an older release is not something a seat
can be put on rather than something it is warned about afterwards. Auth, OAuth
and streaming stay pi-ai's own, by spread. The same
registration caps each Claude model's image resize; see
[the request size budget](#the-request-size-budget).

Every reasoning model, Anthropic and Codex, loses `off`, `minimal` and `low`
(`withoutLowThinking`): it offers medium and up. pi's clamp searches upward
before downward, so any of the three asked for runs at medium, never lower. The
`Agent` schema and workflow `agent()` offer medium to xhigh only.
`max` stays on every model that ships it, for the hardest jobs only; the rule
lives in the `Agent` tool's `thinking` guidance (`AGENT_THINKING_RULE`).
